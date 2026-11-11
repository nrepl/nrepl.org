// The REPL's editor: CodeMirror, with nextjournal's clojure-mode for
// Clojure's colors, its brackets closing as they open, and its structural
// editing (slurp, barf, kill...). assets/js/playground.js brings the REPL's
// own keys, and they go first. The editor asks the server about the code
// as an editor plugged into nREPL does, for the arguments of the call the
// cursor's in (eldoc) and the docs of the symbol under the mouse (lookup).
// Its Clojure parser also reads the messages typed in on the playground's
// page (readMessage).
import { EditorView, ViewPlugin, drawSelection, hoverTooltip, keymap, placeholder, repositionTooltips, showTooltip } from "@codemirror/view";
import { Compartment, EditorState, Prec, StateEffect, StateField, Transaction } from "@codemirror/state";
import { HighlightStyle, ensureSyntaxTree, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { history, historyKeymap } from "@codemirror/commands";
import { highlightCode, tags } from "@lezer/highlight";
import { builtin_keymap, default_extensions, paredit_keymap, syntax } from "@nextjournal/clojure-mode";

// The REPL's window is dark in either theme, with the wire windows' colors
// (see main.css).
var theme = EditorView.theme({
  "&": { color: "var(--w-t)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit" },
  ".cm-content": { padding: "0", caretColor: "var(--w-t)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--w-t)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    background: "rgba(60, 178, 255, 0.25)"
  },
  ".cm-placeholder": { color: "var(--w-dim)" },
  ".cm-matchingBracket": { color: "var(--w-server)", fontWeight: "700" },
  ".cm-nonmatchingBracket": { color: "var(--w-err)" },
  ".cm-tooltip": {
    maxWidth: "min(36rem, calc(100vw - 2rem))",
    color: "var(--w-text)",
    background: "var(--w-bar)",
    border: "1px solid var(--w-line)",
    borderRadius: "6px"
  },
  ".cm-docs, .cm-arguments": { padding: "0.3rem 0.6rem", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  ".cm-docs": { maxHeight: "16rem", overflow: "auto" },
  ".cm-docs-name": { color: "var(--w-t)" },
  ".cm-docs-kind": { color: "var(--w-dim)" },
  ".cm-docs-doc": { marginTop: "0.3rem" },
  ".cm-arguments": { color: "var(--w-dim)" },
  ".cm-arguments-name": { color: "var(--w-client)" },
  ".cm-arguments-current": { color: "var(--w-t)", fontWeight: "700" },
  "&:not(.cm-focused) .cm-arguments": { display: "none" }
}, { dark: true });

var highlighting = HighlightStyle.define([
  { tag: [tags.atom, tags.null], color: "var(--w-k)" },
  { tag: [tags.string, tags.regexp], color: "var(--w-s)" },
  { tag: tags.number, color: "var(--w-n)" },
  { tag: tags.keyword, color: "var(--w-client)" },
  { tag: tags.definition(tags.variableName), color: "var(--w-server)" },
  { tag: tags.comment, color: "var(--w-dim)", fontStyle: "italic" }
]);

// clojure-mode's Tab indents, but the REPL's completes. Its Mod-1 and Mod-2
// grow and shrink the selection, but they're the browser's keys for its
// first tabs.
var taken = ["Tab", "Mod-1", "Mod-2"];
var paredit = paredit_keymap.filter(function (binding) { return taken.indexOf(binding.key) < 0; });
// Shift+Enter starts a new line where Enter would send the code.
var newline = paredit_keymap.find(function (binding) { return binding.key === "Enter"; }).run;

function enclosing(node, name) {
  while (node && node.name !== name) node = node.parent;
  return node;
}

// Clojure, or a line typed for code that reads input, which is just text.
var clojure = [
  default_extensions,
  keymap.of([{ key: "Shift-Enter", run: newline }].concat(paredit))
];
var mode = new Compartment();

function modeFor(code, text) {
  return [code ? clojure : [], placeholder(text)];
}

function element(tag, className, text) {
  var node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

// A var's or a special form's name, as the server's replies have them
function qualified(x) {
  return x.ns ? x.ns + "/" + x.name : x.name;
}

// What a call can start with, and what isn't one of its arguments
var heads = ["Operator", "DefLike", "NS"];
var skipped = ["LineComment", "Discard"];

// The call the cursor at `pos` is in: the symbol it calls, and which of
// its arguments the cursor is on, or -1 on the symbol.
function callAt(state, pos) {
  for (var node = enclosing(syntaxTree(state).resolveInner(pos, -1), "List"); node; node = enclosing(node.parent, "List")) {
    if (node.lastChild.name === ")" && pos >= node.to) continue;
    var head = node.firstChild.nextSibling;
    if (!head || heads.indexOf(head.name) < 0) return null;
    var index = -1;
    if (pos > head.to) {
      index = 0;
      for (var arg = head.nextSibling; arg && arg.to < pos; arg = arg.nextSibling) {
        if (skipped.indexOf(arg.name) < 0 && !arg.type.isError) index++;
      }
    }
    return { sym: state.sliceDoc(head.from, head.to), index: index };
  }
  return null;
}

// An eldoc reply's arglists, with the argument at `index` picked out
function argumentsDom(reply, index) {
  var dom = element("div", "cm-arguments");
  dom.append(element("span", "cm-arguments-name", qualified(reply)));
  reply.eldoc.forEach(function (args) {
    // A special form's arglists are its forms, which start with a name.
    if (reply.type === "special-form") args = args.slice(1);
    var rest = args.indexOf("&");
    var current = rest >= 0 && index >= rest ? rest + 1 : index;
    dom.append(" [");
    args.forEach(function (arg, i) {
      if (i) dom.append(" ");
      dom.append(i === current ? element("span", "cm-arguments-current", arg) : arg);
    });
    dom.append("]");
  });
  return dom;
}

// The hint goes under the cursor's row, which on a wrapped line isn't
// the line's first.
function argumentsView(view, hint) {
  return {
    dom: argumentsDom(hint.reply, hint.index),
    getCoords: function (pos) {
      var start = view.coordsAtPos(pos, 1);
      var cursor = view.coordsAtPos(view.state.selection.main.head);
      return start && cursor ? { left: start.left, right: start.right, top: cursor.top, bottom: cursor.bottom } : start;
    },
    update: function (update) {
      if (update.selectionSet) repositionTooltips(update.view);
    }
  };
}

// The arguments of the call the cursor's in, from when the server says
// what they are until the cursor leaves the call: the symbol, the argument
// the cursor's on, the start of its line and the eldoc reply
var gotArguments = StateEffect.define();

function argumentsHint(state, call, reply) {
  var line = state.doc.lineAt(state.selection.main.head).from;
  return { sym: call.sym, index: call.index, line: line, reply: reply };
}

var argumentsField = StateField.define({
  create: function () { return null; },
  update: function (hint, tr) {
    tr.effects.forEach(function (effect) {
      if (effect.is(gotArguments)) hint = effect.value;
    });
    if (!hint || !(tr.docChanged || tr.selection)) return hint;
    var call = callAt(tr.state, tr.state.selection.main.head);
    if (!call || call.sym !== hint.sym) return null;
    var updated = argumentsHint(tr.state, call, hint.reply);
    return updated.index === hint.index && updated.line === hint.line ? hint : updated;
  },
  provide: function (field) {
    return showTooltip.from(field, function (hint) {
      return hint && { pos: hint.line, create: function (view) { return argumentsView(view, hint); } };
    });
  }
});

// Asks for the arguments of a call once the cursor rests in it, but not
// while the symbol it calls is being typed.
function eldoc(ask) {
  return [argumentsField, ViewPlugin.define(function (view) {
    var timer = null;
    return {
      update: function (update) {
        if (!update.docChanged && !update.selectionSet) return;
        clearTimeout(timer);
        if (update.state.field(argumentsField)) return;
        var call = callAt(update.state, update.state.selection.main.head);
        if (!call || (call.index < 0 && update.docChanged)) return;
        timer = setTimeout(function () {
          ask("eldoc", call.sym).then(function (reply) {
            var now = callAt(view.state, view.state.selection.main.head);
            if (reply.eldoc && now && now.sym === call.sym) {
              view.dispatch({ effects: gotArguments.of(argumentsHint(view.state, now, reply)) });
            }
          });
        }, 300);
      },
      destroy: function () { clearTimeout(timer); }
    };
  })];
}

// A lookup reply's info: the name, how it's called and its docs
function docsDom(info) {
  var dom = element("div", "cm-docs");
  var name = element("div", "cm-docs-name", qualified(info));
  var kind = info["special-form"] ? "special form" : info.macro ? "macro" : "";
  if (kind) name.append(element("span", "cm-docs-kind", "  " + kind));
  dom.append(name);
  var forms = info["arglists-str"] || info["forms-str"];
  if (forms) dom.append(highlighted(forms));
  if (info.doc) dom.append(element("div", "cm-docs-doc", info.doc));
  return dom;
}

var symbols = ["Symbol", "DefLike", "NS"];

function lookup(ask) {
  return hoverTooltip(function (view, pos, side) {
    var node = syntaxTree(view.state).resolveInner(pos, side);
    if (symbols.indexOf(node.name) < 0) return null;
    return ask("lookup", view.state.sliceDoc(node.from, node.to)).then(function (reply) {
      var info = reply.info;
      if (!info || !info.name) return null;
      return { pos: node.from, end: node.to, above: true, create: function () { return { dom: docsDom(info) }; } };
    });
  }, { hoverTime: 400 });
}

// An editor for code in `parent`, labelled by the element with the id
// `label`, with the placeholder `text`. `keys` are CodeMirror key bindings,
// which go before the editor's own. With `ask(op, sym)`, which sends the
// server the op about the symbol and gives a promise of its reply, it
// shows what the server says about the code.
export function createEditor(parent, label, text, keys, ask) {
  return new EditorView({
    parent: parent,
    state: EditorState.create({
      extensions: [
        Prec.highest(keymap.of(keys)),
        mode.of(modeFor(true, text)),
        // Out of the mode, so its styles stay for highlighted()
        syntaxHighlighting(highlighting),
        // While it reads input, there's no syntax tree, and nothing to ask.
        ask ? [eldoc(ask), lookup(ask)] : [],
        keymap.of(builtin_keymap.concat(historyKeymap)),
        history(),
        drawSelection(),
        theme,
        EditorView.lineWrapping,
        // Password managers don't go by autocomplete="off", only by their
        // own attributes.
        EditorView.contentAttributes.of({
          "aria-labelledby": label,
          "data-1p-ignore": "",
          "data-lpignore": "true",
          "data-bwignore": ""
        })
      ]
    })
  });
}

// Code, in Clojure, or a line of input, with the placeholder `text`.
export function setMode(view, code, text) {
  view.dispatch({ effects: [mode.reconfigure(modeFor(code, text)), gotArguments.of(null)] });
}

// Drops the arguments shown, once code's run that could have changed them.
export function forgetArguments(view) {
  view.dispatch({ effects: gotArguments.of(null) });
}

var clojureParser = syntax().parser;

// `code` colored as the editor colors it, for the REPL's log
export function highlighted(code) {
  var shown = document.createDocumentFragment();
  highlightCode(code, clojureParser.parse(code), highlighting, function (text, classes) {
    var span = text;
    if (classes) {
      span = document.createElement("span");
      span.className = classes;
      span.textContent = text;
    }
    shown.append(span);
  }, function () {
    shown.append("\n");
  });
  return shown;
}

// A message typed in, which is EDN, as bencode carries it: strings,
// integers, and lists and maps of them, with keywords and symbols as
// strings

var brackets = ["(", ")", "[", "]", "{", "}"];

// The forms in `node`, but for its brackets, comments and discarded forms
function forms(node) {
  var found = [];
  for (var child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.isError) throw new Error("The message isn't finished.");
    if (brackets.indexOf(child.name) < 0 && skipped.indexOf(child.name) < 0) found.push(child);
  }
  return found;
}

function readForm(node, text) {
  var source = text.slice(node.from, node.to);
  switch (node.name) {
    case "String":
      try {
        // Clojure's escapes are JSON's, but a string can have a line break
        // in it.
        return JSON.parse(source.replace(/[\u0000-\u001f]/g, function (c) {
          return "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
        }));
      } catch (e) {
        throw new Error("Can't read the string " + source + ".");
      }
    case "Number":
      if (!/^[-+]?\d+$/.test(source)) throw new Error("Bencode's numbers are integers, which " + source + " isn't.");
      var n = parseInt(source, 10);
      if (!Number.isSafeInteger(n)) throw new Error(source + " is past 2^53, where the page's numbers lose digits.");
      return n;
    case "Keyword":
      return source.slice(1);
    case "Symbol":
    case "DefLike":
    case "NS":
      return source;
    // Symbols at the start of a list, as the parser has them
    case "Operator":
    case "VarName":
    case "DocString":
      return readForm(node.firstChild, text);
    case "Vector":
    case "List":
      return forms(node).map(function (form) { return readForm(form, text); });
    case "Map":
      var entries = forms(node);
      if (entries.length % 2) throw new Error("A map needs a value for each key.");
      var map = Object.create(null);
      for (var i = 0; i < entries.length; i += 2) {
        var key = readForm(entries[i], text);
        if (typeof key !== "string") throw new Error("Bencode's map keys are strings, and not " + text.slice(entries[i].from, entries[i].to) + ".");
        map[key] = readForm(entries[i + 1], text);
      }
      return map;
    default:
      throw new Error("Bencode has strings, integers, lists and maps, and " + source + " isn't one.");
  }
}

// The message in `text`, a map, or an error saying why it isn't one
export function readMessage(text) {
  var top = forms(clojureParser.parse(text).topNode);
  if (top.length !== 1 || top[0].name !== "Map") throw new Error("A message is a map, like {:op \"describe\"}.");
  return readForm(top[0], text);
}

// Whether the code leaves a form open: clojure-mode's parser puts an empty
// error node where its closing bracket or quote should be.
export function unfinished(state) {
  var open = false;
  var tree = ensureSyntaxTree(state, state.doc.length, 1000);
  if (tree) {
    tree.iterate({
      enter: function (node) {
        if (node.type.isError && node.from === node.to) open = true;
        return !open;
      }
    });
  }
  return open;
}

// clojure-mode tidies the lines a change touches, unless it's typed or
// marked "noformat", and what these two put in stays as it is.

// Puts `text` in at `at`, with the cursor after it.
export function insertCode(view, at, text) {
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: "noformat"
  });
}

// Replaces the code with `text`, with the cursor at its end. It's no edit
// to undo.
export function setCode(view, text) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
    annotations: Transaction.addToHistory.of(false),
    userEvent: "noformat"
  });
}

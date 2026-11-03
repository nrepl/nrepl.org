// The REPL's editor: CodeMirror, with nextjournal's clojure-mode for
// Clojure's colors, its brackets closing as they open, and its structural
// editing (slurp, barf, kill...). assets/js/playground.js brings the REPL's
// own keys, and they go first.
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
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
  ".cm-nonmatchingBracket": { color: "var(--w-err)" }
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

// A quote typed in a string: at its end, it steps over the one closing it,
// as in paredit, and after a backslash, it's the quote being escaped.
// clojure-mode escapes every quote typed in a string, even those.
function quoteInString(view) {
  var range = view.state.selection.main;
  if (!range.empty) return false;
  var head = range.head;
  var tree = syntaxTree(view.state);
  var quote = tree.resolveInner(head, 1);
  if (quote.name === "\"" && quote.parent.name === "String" &&
      quote.to === quote.parent.to && quote.from > quote.parent.from) {
    view.dispatch({ selection: { anchor: quote.to }, userEvent: "select" });
    return true;
  }
  var string = enclosing(tree.resolveInner(head, -1), "String");
  if (!string || /\\*$/.exec(view.state.sliceDoc(string.from + 1, head))[0].length % 2 === 0) return false;
  view.dispatch({ changes: { from: head, insert: "\"" }, selection: { anchor: head + 1 }, userEvent: "input.type" });
  return true;
}

// Clojure, or a line typed for code that reads input, which is just text.
var clojure = [
  default_extensions,
  Prec.highest(keymap.of([{ key: "\"", run: quoteInString }])),
  keymap.of([{ key: "Shift-Enter", run: newline }].concat(paredit))
];
var mode = new Compartment();

function modeFor(code, text) {
  return [code ? clojure : [], placeholder(text)];
}

// An editor for code in `parent`, labelled by the element with the id
// `label`, with the placeholder `text`. `keys` are CodeMirror key bindings,
// which go before the editor's own.
export function createEditor(parent, label, text, keys) {
  return new EditorView({
    parent: parent,
    state: EditorState.create({
      extensions: [
        Prec.highest(keymap.of(keys)),
        mode.of(modeFor(true, text)),
        // Out of the mode, so its styles stay for highlighted()
        syntaxHighlighting(highlighting),
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
  view.dispatch({ effects: mode.reconfigure(modeFor(code, text)) });
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

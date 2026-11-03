// The playground, in the "Try it" section and on a page of its own: a REPL
// talking to nrepl-sci, an nREPL server that runs in Web Workers. The worker
// takes and returns the bencode of each message, and everything that goes
// back and forth shows in the wire windows (on the front page, the one in
// the text and site.js's copy in the second window), laid out like the
// exchanges capture/ records. The code's typed in a CodeMirror editor (see
// assets/js/playground-editor.js).
import { createEditor, forgetArguments, highlighted, insertCode, setCode, setMode, unfinished } from "./playground-editor.js";

(function () {
  "use strict";

  var section = document.querySelector("[data-playground]");
  if (!section) return;

  var textEncoder = new TextEncoder();
  var textDecoder = new TextDecoder();

  // Code can wait for input, and be stopped without starting over, only
  // when the page is cross-origin isolated.
  var isolated = self.crossOriginIsolated === true;

  // Bencode

  function encode(x) {
    if (typeof x === "number") return "i" + x + "e";
    if (typeof x === "string") return textEncoder.encode(x).length + ":" + x;
    if (Array.isArray(x)) return "l" + x.map(encode).join("") + "e";
    return "d" + Object.keys(x).sort().map(function (k) { return encode(k) + encode(x[k]); }).join("") + "e";
  }

  // The message in `bytes`, and its bencode as [class, text] tokens.
  function parse(bytes) {
    var tokens = [];
    var i = 0;
    function read() {
      var b = bytes[i];
      if (b === 0x69) {
        var end = bytes.indexOf(0x65, i);
        var n = Number(textDecoder.decode(bytes.subarray(i + 1, end)));
        tokens.push(["p", "i"], ["n", String(n)], ["p", "e"]);
        i = end + 1;
        return n;
      }
      if (b === 0x6c || b === 0x64) {
        tokens.push(["p", String.fromCharCode(b)]);
        i++;
        var items = [];
        while (bytes[i] !== 0x65) items.push(read());
        tokens.push(["p", "e"]);
        i++;
        if (b === 0x6c) return items;
        var dict = {};
        for (var k = 0; k < items.length; k += 2) dict[items[k]] = items[k + 1];
        return dict;
      }
      var colon = bytes.indexOf(0x3a, i);
      var length = Number(textDecoder.decode(bytes.subarray(i, colon)));
      var s = textDecoder.decode(bytes.subarray(colon + 1, colon + 1 + length));
      tokens.push(["n", length + ":"], ["t", s]);
      i = colon + 1 + length;
      return s;
    }
    return { msg: read(), tokens: tokens };
  }

  // EDN, laid out as capture/capture.clj does it, which the two have to
  // keep doing alike

  var lead = ["op", "code", "prefix", "sym", "stdin", "interrupt-id", "new-session",
              "out", "err", "value", "ns"];
  var tail = ["status", "id", "session"];
  var routing = { id: true, session: true };
  var width = 54;

  // A message's keys go the usual ones first and the ones that route it
  // last, and anything else's in order.
  function sortKeys(m, top) {
    var keys = Object.keys(m).sort();
    if (!top) return keys;
    function has(k) { return keys.indexOf(k) >= 0; }
    function other(k) { return lead.indexOf(k) < 0 && tail.indexOf(k) < 0; }
    return lead.filter(has).concat(keys.filter(other), tail.filter(has));
  }

  function dimmed(tokens) {
    return tokens.map(function (t) { return [t[0] && t[0] + " r", t[1]]; });
  }

  function joined(parts) {
    var out = [];
    parts.forEach(function (part, i) {
      if (i) out.push(["", " "]);
      out.push.apply(out, part);
    });
    return out;
  }

  function flat(x, top) {
    if (Array.isArray(x)) {
      return [["p", "["]].concat(joined(x.map(function (v) { return flat(v, false); })), [["p", "]"]]);
    }
    if (typeof x === "object") {
      return [["p", "{"]].concat(joined(sortKeys(x, top).map(function (k) {
        var tokens = [["k", ":" + k], ["", " "]].concat(flat(x[k], false));
        return top && routing[k] ? dimmed(tokens) : tokens;
      })), [["p", "}"]]);
    }
    if (typeof x === "string") return [["s", JSON.stringify(x)]];
    return [["n", String(x)]];
  }

  function length(tokens) {
    return tokens.reduce(function (n, t) { return n + t[1].length; }, 0);
  }

  // `x` as lines of tokens, starting at column `col`.
  function lay(x, col, top) {
    var one = flat(x, top);
    if (typeof x !== "object" || col + length(one) <= width) return [one];
    var map = !Array.isArray(x);
    var items = map
      ? sortKeys(x, top).map(function (k) { return [k, x[k]]; })
      : x.map(function (v) { return [null, v]; });
    var inner = col + 1;
    var lines = [];
    items.forEach(function (item, i) {
      var k = item[0];
      var entry;
      if (k === null) {
        entry = lay(item[1], inner, false);
      } else {
        var key = [["k", ":" + k], ["", " "]];
        entry = lay(item[1], inner + length(key), false);
        entry[0] = key.concat(entry[0]);
      }
      if (top && routing[k]) entry = entry.map(dimmed);
      entry[0] = [i === 0 ? ["p", map ? "{" : "["] : ["", " ".repeat(inner)]].concat(entry[0]);
      lines.push.apply(lines, entry);
    });
    lines[lines.length - 1].push(["p", map ? "}" : "]"]);
    return lines;
  }

  // The wire windows

  // How many messages each window keeps, and lines the REPL keeps
  var keep = 500;

  var templates = {};
  section.querySelectorAll("template[data-msg]").forEach(function (template) {
    templates[template.dataset.msg] = template.content.firstElementChild;
  });

  function spans(parent, tokens) {
    tokens.forEach(function (t) {
      if (t[0]) {
        var span = document.createElement("span");
        span.className = t[0];
        span.textContent = t[1];
        parent.appendChild(span);
      } else {
        parent.appendChild(document.createTextNode(t[1]));
      }
    });
  }

  function build(from, parsed) {
    var li = templates[from].cloneNode(true);
    var edn = li.querySelector(".edn code");
    lay(parsed.msg, 0, true).forEach(function (line, n) {
      if (n) edn.appendChild(document.createTextNode("\n"));
      spans(edn, line);
    });
    spans(li.querySelector(".bencode code"), parsed.tokens);
    return li;
  }

  // Code that prints sends a message a line, faster than the page could
  // lay each one out, so what's new shows a frame at a time.
  var shown = [];
  var lists = null;
  var scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(render);
  }

  function show(from, parsed) {
    shown.push([from, parsed]);
    schedule();
  }

  function render() {
    scheduled = false;
    // site.js's copy is there by the time anything's shown.
    lists = lists || document.querySelectorAll("[data-playground-wire] .msgs");
    var items = shown.splice(0).slice(-keep).map(function (m) { return build(m[0], m[1]); });
    if (items.length) {
      lists.forEach(function (list, n) {
        // Messages someone scrolled back to read stay put.
        var following = list.scrollHeight - list.scrollTop - list.clientHeight < 2;
        var fragment = document.createDocumentFragment();
        items.forEach(function (li) { fragment.appendChild(n ? li.cloneNode(true) : li); });
        list.appendChild(fragment);
        while (list.childElementCount > keep) list.firstElementChild.remove();
        if (following) list.scrollTop = list.scrollHeight;
      });
    }
    // The editor's questions don't move the REPL's text, only what it prints.
    if (printed) {
      printed = false;
      while (log.childElementCount > keep) log.firstElementChild.remove();
      log.scrollTop = log.scrollHeight;
    }
  }

  // The REPL

  var log = section.querySelector(".repl-log");
  var codeBox = section.querySelector(".repl-code");
  var prompt = section.querySelector(".prompt");
  var interruptButton = section.querySelector(".interrupt");
  var placeholder = codeBox.dataset.placeholder;

  var worker = null;
  var started = null;
  var session = null;
  var ns = "user";
  var nextId = 0;
  var handlers = {};
  // The id of the eval running, or true while it waits for the server
  var running = null;
  var reading = false;
  var history = [];
  var back = 0;
  var draft = "";
  var printed = false;
  // What the editor asks the server about a symbol, an op at a time (see
  // ask), until code runs, which can change the answers
  var answers = {};

  function print(kind, text) {
    printed = true;
    var last = log.lastElementChild;
    if (last && last.className === kind && kind !== "input") {
      last.append(text);
      if (last.childNodes.length > keep) last.firstChild.remove();
    } else {
      var pre = document.createElement("pre");
      pre.className = kind;
      pre.append(text);
      log.appendChild(pre);
    }
    schedule();
  }

  // What was sent, after the prompt it was typed at
  function echo(at, sent) {
    var line = document.createDocumentFragment();
    var atPrompt = document.createElement("span");
    atPrompt.className = "prompt";
    atPrompt.textContent = at;
    line.append(atPrompt, " ", sent, "\n");
    return line;
  }

  var editorReading = false;

  function setPrompt() {
    prompt.textContent = reading ? "stdin>" : ns + "=>";
    if (reading !== editorReading) {
      editorReading = reading;
      setMode(editor, !reading, reading ? "Type a line, Enter sends it" : placeholder);
    }
    interruptButton.hidden = typeof running !== "string";
  }

  function code() {
    return editor.state.doc.toString();
  }

  // Sends `msg` with an id, and the session once there is one, calling
  // `handle` with each reply until done.
  function send(msg, handle) {
    var id = String(++nextId);
    msg.id = id;
    if (session) msg.session = session;
    if (handle) handlers[id] = handle;
    var bytes = textEncoder.encode(encode(msg));
    show("client", parse(bytes));
    worker.postMessage(bytes, [bytes.buffer]);
    return id;
  }

  function receive(event) {
    var reply = parse(event.data);
    show("server", reply);
    var msg = reply.msg;
    var handle = handlers[msg.id];
    if (!handle) return;
    if ((msg.status || []).indexOf("done") >= 0) delete handlers[msg.id];
    handle(msg);
  }

  // Starts the server, the first time it's needed, with a session for the
  // REPL. If it doesn't start, the next try starts it over.
  function start() {
    if (started) return started;
    started = new Promise(function (resolve, reject) {
      worker = new Worker(section.dataset.worker);
      worker.onmessage = receive;
      worker.onerror = function () { reject(); };
      send({ op: "clone" }, function (reply) {
        if (reply["new-session"]) resolve(reply["new-session"]);
        else if ((reply.status || []).indexOf("done") >= 0) reject(reply.err);
      });
    });
    started.then(function (id) { session = id; }, function (err) {
      print("err", (err || "The server didn't start.").trim() + "\n");
      worker.terminate();
      worker = null;
      started = null;
      handlers = {};
      answers = {};
      running = null;
      setPrompt();
    });
    return started;
  }

  function whenReady(f) {
    start().then(f, function () {});
  }

  function evaluate(code) {
    print("input", echo(ns + "=>", highlighted(code)));
    history.push(code);
    back = history.length;
    draft = "";
    running = true;
    whenReady(function () {
      running = send({ op: "eval", code: code }, function (reply) {
        if ("out" in reply) print("out", reply.out);
        if ("err" in reply) print("err", reply.err);
        if ("value" in reply) print("value", reply.value + "\n");
        if (reply.ns) ns = reply.ns;
        var status = reply.status || [];
        if (status.indexOf("need-input") >= 0) reading = true;
        if (status.indexOf("interrupted") >= 0) print("note", "Interrupted\n");
        if (status.indexOf("done") >= 0) {
          running = null;
          reading = false;
          answers = {};
          forgetArguments(editor);
        }
        if (reply.status || reply.ns) setPrompt();
      });
      setPrompt();
    });
  }

  // The editor's question about a symbol, an op such as eldoc (see
  // assets/js/playground-editor.js), as a promise of the reply. It doesn't
  // start a server that failed to start; sending code does.
  function ask(op, sym) {
    if (!started) return Promise.resolve({});
    var key = op + " " + ns + " " + sym;
    if (!answers[key]) {
      answers[key] = new Promise(function (resolve) {
        whenReady(function () { send({ op: op, sym: sym, ns: ns }, resolve); });
      });
    }
    return answers[key];
  }

  // Sends a line of input, or the end of it, to the code reading it.
  function sendInput(stdin, kind, text) {
    print(kind, text);
    send({ op: "stdin", stdin: stdin });
    reading = false;
    setPrompt();
  }

  // The longest start all the strings share.
  function common(strings) {
    return strings.reduce(function (a, b) {
      var i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return a.slice(0, i);
    });
  }

  // The symbol right before the cursor, if there's one to complete.
  function completable() {
    var selection = editor.state.selection.main;
    if (!selection.empty) return null;
    var match = editor.state.doc.sliceString(0, selection.head).match(/[^\s()[\]{}"'`,;@^~]+$/);
    return match && match[0];
  }

  function complete(prefix) {
    var doc = editor.state.doc;
    var at = editor.state.selection.main.head;
    whenReady(function () {
      send({ op: "complete", prefix: prefix, ns: ns }, function (reply) {
        var candidates = (reply.completions || []).map(function (c) { return c.candidate; });
        // The code can change while the server's busy with something else.
        if (!candidates.length || editor.state.doc !== doc || editor.state.selection.main.head !== at) return;
        var completion = candidates.length === 1 ? candidates[0] + " " : common(candidates);
        if (completion.length > prefix.length) insertCode(editor, at, completion.slice(prefix.length));
        if (candidates.length > 1) {
          print("note", candidates.slice(0, 40).join("  ") + (candidates.length > 40 ? "  …" : "") + "\n");
        }
      });
    });
  }

  function submit() {
    var text = code();
    if (reading) {
      setCode(editor, "");
      sendInput(text + "\n", "input", echo("stdin>", text));
    } else if (!running && text.trim()) {
      setCode(editor, "");
      evaluate(text.trim());
    }
  }

  // Up on the code's first line, or Down on its last, goes through what
  // was sent before.
  function browse(up) {
    return function (view) {
      if (reading || !history.length) return false;
      var doc = view.state.doc;
      var selection = view.state.selection.main;
      var atEdge = up
        ? doc.lineAt(selection.from).number === 1
        : doc.lineAt(selection.to).number === doc.lines;
      if (!atEdge) return false;
      // What's being written comes back past the newest entry.
      if (back === history.length) draft = code();
      back = Math.max(0, Math.min(history.length, back + (up ? -1 : 1)));
      setCode(view, back < history.length ? history[back] : draft);
      return true;
    };
  }

  // The REPL's keys. Each one that doesn't apply leaves the key to the
  // editor.
  var keys = [
    // Enter sends the code once its forms close, wherever the cursor is, as
    // CIDER's REPL does. Brackets close as they open, so a new line takes
    // Shift+Enter, unless something's left open.
    { key: "Enter", run: function () {
      if (!reading && unfinished(editor.state)) return false;
      submit();
      return true;
    } },
    // Anywhere there's nothing to complete, Tab moves on, so the REPL
    // doesn't trap the keyboard.
    { key: "Tab", run: function () {
      var prefix = !reading && completable();
      if (!prefix) return false;
      complete(prefix);
      return true;
    } },
    // The end of the input, as in a terminal
    { key: "Ctrl-d", run: function () {
      if (!reading || editor.state.doc.length) return false;
      sendInput("", "note", "End of input\n");
      return true;
    } },
    { key: "ArrowUp", run: browse(true) },
    { key: "ArrowDown", run: browse(false) }
  ];

  var editor = createEditor(codeBox, prompt.id, placeholder, keys, ask);

  // A click anywhere in the REPL but on its text, or a button, puts the
  // cursor in the code, as in a terminal.
  section.querySelector(".repl").addEventListener("click", function (event) {
    if (event.target.closest("pre, button") || !getSelection().isCollapsed) return;
    editor.focus();
  });

  // The server takes a moment to start, so it starts as soon as it might
  // be needed.
  editor.contentDOM.addEventListener("focus", function () { start(); });

  interruptButton.addEventListener("click", function () {
    if (typeof running === "string") send({ op: "interrupt", "interrupt-id": running });
  });

  section.querySelectorAll("[data-example]").forEach(function (button) {
    // Without isolation, read-line just throws.
    if (button.hasAttribute("data-input") && !isolated) {
      button.hidden = true;
      return;
    }
    button.addEventListener("click", function () {
      if (running) return;
      evaluate(button.dataset.example);
      editor.focus();
    });
  });
})();

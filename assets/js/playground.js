// The playground, in the "Try it" section and on a page of its own: a REPL
// talking to nrepl-sci, an nREPL server that runs in Web Workers. The worker
// takes and returns the bencode of each message, and everything that goes
// back and forth shows in the wire windows (on the front page, the one in
// the text and site.js's copy in the second window), laid out like the
// exchanges capture/ records. The code's typed in a CodeMirror editor (see
// assets/js/playground-editor.js). On the playground's page, each of the
// REPL's sessions has a tab, and messages can be typed in and sent as they
// are.
import { createEditor, forgetArguments, highlighted, insertCode, readMessage, setCode, setMode, unfinished } from "./playground-editor.js";

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
    // As nrepl-sci does, a key with nothing for its value is left out.
    var keys = Object.keys(x).sort().filter(function (k) { return x[k] != null; });
    return "d" + keys.map(function (k) { return encode(k) + encode(x[k]); }).join("") + "e";
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
  // Whether what's shown next has a message sent for something someone
  // did, rather than one the editor asked on its own
  var sentByHand = false;

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
        // Messages someone scrolled back to read stay put, unless they've
        // just sent something.
        var following = sentByHand || list.scrollHeight - list.scrollTop - list.clientHeight < 2;
        var fragment = document.createDocumentFragment();
        items.forEach(function (li) { fragment.appendChild(n ? li.cloneNode(true) : li); });
        list.appendChild(fragment);
        while (list.childElementCount > keep) list.firstElementChild.remove();
        if (following) list.scrollTop = list.scrollHeight;
      });
    }
    sentByHand = false;
    // The editor's questions don't move the REPL's text, only what it prints.
    if (printed) {
      printed = false;
      current.log.scrollTop = current.log.scrollHeight;
    }
  }

  // The REPL

  var repl = section.querySelector(".repl");
  var codeBox = repl.querySelector(".repl-code");
  var prompt = repl.querySelector(".repl-input .prompt");
  var interruptButton = repl.querySelector(".interrupt");
  var placeholder = codeBox.dataset.placeholder;
  // The tabs for the sessions, on the playground's page
  var tabList = repl.querySelector("[role=tablist]");
  var tabTemplate = section.querySelector("template[data-tab]");

  var worker = null;
  var started = null;
  var nextId = 0;
  var handlers = {};
  // What the editor asks the server about a symbol, an op at a time (see
  // ask), until code runs, which can change the answers
  var answers = {};
  // Whether the REPL's text has something new to scroll to
  var printed = false;

  // What was sent from an editor: the entries, how far back in them the
  // editor is, and what was being written before going back
  function newHistory() {
    return { entries: [], back: 0, draft: "" };
  }

  function remember(history, text) {
    history.entries.push(text);
    history.back = history.entries.length;
    history.draft = "";
  }

  // One of the REPL's sessions, with its id once the server's made it, its
  // namespace and text, and its code, sent and being written
  function newTab(log, id, ns) {
    return {
      id: id,
      ns: ns,
      log: log,
      // The id of the eval running, or true while it waits for the server
      running: null,
      reading: false,
      sent: newHistory(),
      // What's in the editor while another tab's shown
      code: "",
      button: null,
      closing: false
    };
  }

  var tabs = [newTab(repl.querySelector(".repl-log"), null, "user")];
  var current = tabs[0];

  function print(tab, kind, text) {
    var log = tab.log;
    var last = log.lastElementChild;
    if (last && last.className === kind && kind !== "input") {
      last.append(text);
      if (last.childNodes.length > keep) last.firstChild.remove();
    } else {
      var pre = document.createElement("pre");
      pre.className = kind;
      pre.append(text);
      log.appendChild(pre);
      while (log.childElementCount > keep) log.firstElementChild.remove();
    }
    if (tab === current) printed = true;
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

  // Shows what a session's up to: in its tab, and in the prompt, the editor
  // and the interrupt button when it's the one shown
  function showState(tab) {
    if (tab.button) tab.button.dataset.state = tab.reading ? "reading" : tab.running ? "running" : "";
    if (tab !== current) return;
    prompt.textContent = tab.reading ? "stdin>" : tab.ns + "=>";
    if (tab.reading !== editorReading) {
      editorReading = tab.reading;
      setMode(editor, !tab.reading, tab.reading ? "Type a line, Enter sends it" : placeholder);
    }
    interruptButton.hidden = typeof tab.running !== "string";
  }

  function code() {
    return editor.state.doc.toString();
  }

  // Sends `msg` as it is. Unless the editor sent it on its own, the wire
  // windows go to the end to show it.
  function post(msg, onItsOwn) {
    var bytes = textEncoder.encode(encode(msg));
    sentByHand = sentByHand || !onItsOwn;
    show("client", parse(bytes));
    worker.postMessage(bytes, [bytes.buffer]);
  }

  // Sends `msg` with an id, calling `handle` with each reply until done.
  // The replies have to come from the session it names, so those to a
  // message typed in with the same id aren't taken for them.
  function send(msg, handle, onItsOwn) {
    var id = String(++nextId);
    msg.id = id;
    if (handle) handlers[id] = { session: msg.session, handle: handle };
    post(msg, onItsOwn);
    return id;
  }

  function receive(event) {
    var reply = parse(event.data);
    show("server", reply);
    var msg = reply.msg;
    var handler = handlers[msg.id];
    if (!handler || handler.session !== msg.session) return;
    if ((msg.status || []).indexOf("done") >= 0) delete handlers[msg.id];
    handler.handle(msg);
  }

  // Starts the server, the first time it's needed, with the REPL's first
  // session. If it doesn't start, the next try starts it over.
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
    // Till then, the first tab is the only one.
    started.then(function (id) {
      current.id = id;
      label(current);
    }, function (err) {
      print(current, "err", (err || "The server didn't start.").trim() + "\n");
      worker.terminate();
      worker = null;
      started = null;
      handlers = {};
      answers = {};
      current.running = null;
      showState(current);
    });
    return started;
  }

  function whenReady(f) {
    start().then(f, function () {});
  }

  function evaluate(code) {
    var tab = current;
    print(tab, "input", echo(tab.ns + "=>", highlighted(code)));
    remember(tab.sent, code);
    tab.running = true;
    whenReady(function () {
      tab.running = send({ op: "eval", code: code, session: tab.id }, function (reply) {
        if ("out" in reply) print(tab, "out", reply.out);
        // What a closed tab's code says last, as when the server starts
        // over without isolation, shows in the tab shown.
        if ("err" in reply) print(tabs.indexOf(tab) >= 0 ? tab : current, "err", reply.err);
        if ("value" in reply) print(tab, "value", reply.value + "\n");
        if (reply.ns) tab.ns = reply.ns;
        var status = reply.status || [];
        if (status.indexOf("need-input") >= 0) tab.reading = true;
        if (status.indexOf("interrupted") >= 0) print(tab, "note", "Interrupted\n");
        // Such as a session that's closed, or a namespace that isn't there
        if (status.indexOf("error") >= 0) {
          var errors = status.filter(function (s) { return s !== "error" && s !== "done"; });
          print(tab, "err", "The server says: " + errors.join(", ") + "\n");
        }
        if (status.indexOf("done") >= 0) {
          tab.running = null;
          tab.reading = false;
          answers = {};
          forgetArguments(editor);
        }
        if (reply.status || reply.ns) showState(tab);
      });
      showState(tab);
    });
  }

  // The editor's question about a symbol, an op such as eldoc (see
  // assets/js/playground-editor.js), as a promise of the reply. It doesn't
  // start a server that failed to start; sending code does.
  function ask(op, sym) {
    if (!started) return Promise.resolve({});
    var tab = current;
    var key = op + " " + tab.ns + " " + sym;
    if (!answers[key]) {
      answers[key] = new Promise(function (resolve) {
        whenReady(function () { send({ op: op, sym: sym, ns: tab.ns, session: tab.id }, resolve, true); });
      });
    }
    return answers[key];
  }

  // Sends a line of input, or the end of it, to the code reading it.
  function sendInput(stdin, kind, text) {
    print(current, kind, text);
    send({ op: "stdin", stdin: stdin, session: current.id });
    current.reading = false;
    showState(current);
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
    var tab = current;
    var doc = editor.state.doc;
    var at = editor.state.selection.main.head;
    whenReady(function () {
      send({ op: "complete", prefix: prefix, ns: tab.ns, session: tab.id }, function (reply) {
        var candidates = (reply.completions || []).map(function (c) { return c.candidate; });
        // The code can change while the server's busy with something else.
        if (!candidates.length || editor.state.doc !== doc || editor.state.selection.main.head !== at) return;
        var completion = candidates.length === 1 ? candidates[0] + " " : common(candidates);
        if (completion.length > prefix.length) insertCode(editor, at, completion.slice(prefix.length));
        if (candidates.length > 1) {
          print(tab, "note", candidates.slice(0, 40).join("  ") + (candidates.length > 40 ? "  …" : "") + "\n");
        }
      });
    });
  }

  function submit() {
    var text = code();
    if (current.reading) {
      setCode(editor, "");
      sendInput(text + "\n", "input", echo("stdin>", text));
    } else if (!current.running && text.trim()) {
      setCode(editor, "");
      evaluate(text.trim());
    }
  }

  // Up on the code's first line, or Down on its last, goes through the
  // history `owner()` gives, if any.
  function browse(up, owner) {
    return function (view) {
      var sent = owner();
      if (!sent || !sent.entries.length) return false;
      var doc = view.state.doc;
      var selection = view.state.selection.main;
      var atEdge = up
        ? doc.lineAt(selection.from).number === 1
        : doc.lineAt(selection.to).number === doc.lines;
      if (!atEdge) return false;
      // What's being written comes back past the newest entry.
      if (sent.back === sent.entries.length) sent.draft = doc.toString();
      sent.back = Math.max(0, Math.min(sent.entries.length, sent.back + (up ? -1 : 1)));
      setCode(view, sent.back < sent.entries.length ? sent.entries[sent.back] : sent.draft);
      return true;
    };
  }

  function historyKeys(owner) {
    return [{ key: "ArrowUp", run: browse(true, owner) }, { key: "ArrowDown", run: browse(false, owner) }];
  }

  // The REPL's keys. Each one that doesn't apply leaves the key to the
  // editor.
  var keys = [
    // Enter sends the code once its forms close, wherever the cursor is, as
    // CIDER's REPL does. Brackets close as they open, so a new line takes
    // Shift+Enter, unless something's left open.
    { key: "Enter", run: function () {
      if (!current.reading && unfinished(editor.state)) return false;
      submit();
      return true;
    } },
    // Anywhere there's nothing to complete, Tab moves on, so the REPL
    // doesn't trap the keyboard.
    { key: "Tab", run: function () {
      var prefix = !current.reading && completable();
      if (!prefix) return false;
      complete(prefix);
      return true;
    } },
    // The end of the input, as in a terminal
    { key: "Ctrl-d", run: function () {
      if (!current.reading || editor.state.doc.length) return false;
      sendInput("", "note", "End of input\n");
      return true;
    } }
  ].concat(historyKeys(function () { return current.reading ? null : current.sent; }));

  var editor = createEditor(codeBox, prompt.id, placeholder, keys, ask);

  // A click anywhere in the REPL but on its text, or a button, puts the
  // cursor in the code, as in a terminal.
  repl.addEventListener("click", function (event) {
    if (event.target.closest("pre, button") || !getSelection().isCollapsed) return;
    editor.focus();
  });

  // The server takes a moment to start, so it starts as soon as it might
  // be needed.
  editor.contentDOM.addEventListener("focus", function () { start(); });

  interruptButton.addEventListener("click", function () {
    if (typeof current.running === "string") {
      send({ op: "interrupt", session: current.id, "interrupt-id": current.running });
    }
  });

  section.querySelectorAll("[data-example]").forEach(function (button) {
    // Without isolation, read-line just throws.
    if (button.hasAttribute("data-input") && !isolated) {
      button.hidden = true;
      return;
    }
    button.addEventListener("click", function () {
      if (current.running) return;
      evaluate(button.dataset.example);
      editor.focus();
    });
  });

  // The sessions' tabs, on the playground's page. + clones the session
  // shown into a new one, and × closes one, while there are two or more.

  function label(tab) {
    if (!tab.button) return;
    tab.button.textContent = tab.id ? tab.id.slice(0, 8) : "session";
    tab.button.title = tab.id ? "Session " + tab.id : "The server makes the session once it starts.";
  }

  function openTabs() {
    return tabs.filter(function (tab) { return !tab.closing; });
  }

  function showClosable() {
    tabList.classList.toggle("one-open", openTabs().length < 2);
  }

  function addTab(tab) {
    var item = tabTemplate.content.firstElementChild.cloneNode(true);
    tab.button = item.querySelector("[role=tab]");
    tab.button.setAttribute("aria-selected", String(tab === current));
    tab.button.addEventListener("click", function () { switchTo(tab); });
    item.querySelector(".close-session").addEventListener("click", function () { closeTab(tab); });
    tabList.appendChild(item);
    showClosable();
    label(tab);
  }

  function switchTo(tab) {
    if (tab === current) return;
    current.code = code();
    current.log.hidden = true;
    current.button.setAttribute("aria-selected", "false");
    current = tab;
    tab.log.hidden = false;
    tab.log.scrollTop = tab.log.scrollHeight;
    tab.button.setAttribute("aria-selected", "true");
    setCode(editor, tab.code);
    showState(tab);
    editor.focus();
  }

  function cloneTab() {
    var from = current;
    whenReady(function () {
      send({ op: "clone", session: from.id }, function (reply) {
        if (!reply["new-session"]) return;
        var log = from.log.cloneNode(false);
        log.hidden = true;
        repl.insertBefore(log, repl.querySelector(".repl-input"));
        var tab = newTab(log, reply["new-session"], from.ns);
        tabs.push(tab);
        addTab(tab);
        switchTo(tab);
      });
    });
  }

  // A tab goes once the server's closed its session, which stops what it's
  // evaluating. Till then it's on its way out, and isn't shown.
  function closeTab(tab) {
    var open = openTabs();
    var i = open.indexOf(tab);
    if (i < 0 || open.length < 2) return;
    tab.closing = true;
    tab.button.parentNode.classList.add("closing");
    showClosable();
    if (tab === current) switchTo(open[i + 1] || open[i - 1]);
    send({ op: "close", session: tab.id }, function (reply) {
      if ((reply.status || []).indexOf("done") < 0) return;
      tabs.splice(tabs.indexOf(tab), 1);
      tab.button.parentNode.remove();
      tab.log.remove();
    });
  }

  if (tabList) {
    addTab(current);
    repl.querySelector(".clone").addEventListener("click", cloneTab);
  }

  // Messages typed in, on the playground's page, sent as they are. Their
  // replies only show in the wire window, and what's wrong with one that
  // isn't a message shows under it.

  var composerBox = section.querySelector(".composer-code");
  var composerError = section.querySelector(".composer-error");
  var messages = newHistory();

  function sendMessage(text) {
    var msg;
    try {
      msg = readMessage(text);
    } catch (e) {
      composerError.textContent = e.message;
      return false;
    }
    composerError.textContent = "";
    remember(messages, text);
    whenReady(function () { post(msg); });
    return true;
  }

  if (composerBox) {
    var composerLabel = section.querySelector(".composer .prompt").id;
    var composer = createEditor(composerBox, composerLabel, composerBox.dataset.placeholder, [
      { key: "Enter", run: function (view) {
        if (unfinished(view.state)) return false;
        var text = view.state.doc.toString().trim();
        if (text && sendMessage(text)) setCode(view, "");
        return true;
      } }
    ].concat(historyKeys(function () { return messages; })));
    composer.contentDOM.addEventListener("focus", function () { start(); });
    section.querySelectorAll("[data-message]").forEach(function (button) {
      button.addEventListener("click", function () {
        sendMessage(button.dataset.message);
        composer.focus();
      });
    });
  }
})();

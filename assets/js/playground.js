// The playground, in the "Try it" section and on a page of its own: a REPL
// talking to nrepl-sci, an nREPL server that runs in Web Workers. The worker
// takes and returns the bencode of each message, and everything that goes
// back and forth shows in the wire windows (on the front page, the one in
// the text and site.js's copy in the second window), laid out like the
// exchanges capture/ records.
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
        var fragment = document.createDocumentFragment();
        items.forEach(function (li) { fragment.appendChild(n ? li.cloneNode(true) : li); });
        list.appendChild(fragment);
        while (list.childElementCount > keep) list.firstElementChild.remove();
        list.scrollTop = list.scrollHeight;
      });
    }
    while (log.childElementCount > keep) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  // The REPL

  var log = section.querySelector(".repl-log");
  var input = section.querySelector("#repl-code");
  var prompt = section.querySelector(".prompt");
  var interruptButton = section.querySelector(".interrupt");
  var placeholder = input.placeholder;

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

  function print(kind, text) {
    var last = log.lastElementChild;
    if (last && last.className === kind && kind !== "input") {
      last.append(text);
      if (last.childNodes.length > keep) last.firstChild.remove();
    } else {
      var pre = document.createElement("pre");
      pre.className = kind;
      pre.textContent = text;
      log.appendChild(pre);
    }
    schedule();
  }

  function setPrompt() {
    prompt.textContent = reading ? "stdin>" : ns + "=>";
    input.placeholder = reading ? "Type a line, Enter sends it" : placeholder;
    interruptButton.hidden = typeof running !== "string";
  }

  // The textarea grows with its code.
  function resize() {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  }

  function setInput(text) {
    input.value = text;
    resize();
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
      running = null;
      setPrompt();
    });
    return started;
  }

  function whenReady(f) {
    start().then(f, function () {});
  }

  function evaluate(code) {
    print("input", ns + "=> " + code + "\n");
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
        }
        if (reply.status || reply.ns) setPrompt();
      });
      setPrompt();
    });
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
    if (input.selectionStart !== input.selectionEnd) return null;
    var match = input.value.slice(0, input.selectionStart).match(/[^\s()[\]{}"'`,;@^~]+$/);
    return match && match[0];
  }

  function complete(prefix) {
    var code = input.value;
    var at = input.selectionStart;
    whenReady(function () {
      send({ op: "complete", prefix: prefix, ns: ns }, function (reply) {
        var candidates = (reply.completions || []).map(function (c) { return c.candidate; });
        // The code can change while the server's busy with something else.
        if (!candidates.length || input.value !== code || input.selectionStart !== at) return;
        var completion = candidates.length === 1 ? candidates[0] + " " : common(candidates);
        if (completion.length > prefix.length) {
          input.setRangeText(completion.slice(prefix.length), at, at, "end");
          resize();
        }
        if (candidates.length > 1) {
          print("note", candidates.slice(0, 40).join("  ") + (candidates.length > 40 ? "  …" : "") + "\n");
        }
      });
    });
  }

  // Whether the brackets in `code` close, so Enter sends it rather than
  // starting a new line.
  function balanced(code) {
    var depth = 0;
    for (var i = 0; i < code.length; i++) {
      var c = code[i];
      if (c === "\\") i++;
      else if (c === ";") while (i < code.length && code[i] !== "\n") i++;
      else if (c === '"') {
        for (i++; i < code.length && code[i] !== '"'; i++) if (code[i] === "\\") i++;
        if (i >= code.length) return false;
      }
      else if ("([{".indexOf(c) >= 0) depth++;
      else if (")]}".indexOf(c) >= 0) depth--;
    }
    return depth <= 0;
  }

  function submit() {
    var text = input.value;
    if (reading) {
      setInput("");
      sendInput(text + "\n", "input", text + "\n");
    } else if (!running && text.trim()) {
      setInput("");
      evaluate(text.trim());
    }
  }

  input.addEventListener("keydown", function (event) {
    if (event.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey && (reading || balanced(input.value))) {
      event.preventDefault();
      submit();
    } else if (event.key === "Tab" && !event.shiftKey && !reading) {
      // Anywhere there's nothing to complete, Tab moves on, so the REPL
      // doesn't trap the keyboard.
      var prefix = completable();
      if (!prefix) return;
      event.preventDefault();
      complete(prefix);
    } else if (event.key === "d" && event.ctrlKey && reading && !input.value) {
      // The end of the input, as in a terminal
      event.preventDefault();
      sendInput("", "note", "End of input\n");
    } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !reading && history.length) {
      var up = event.key === "ArrowUp";
      var atEdge = up
        ? input.value.lastIndexOf("\n", input.selectionStart - 1) < 0
        : input.value.indexOf("\n", input.selectionEnd) < 0;
      if (!atEdge) return;
      event.preventDefault();
      // What's being written comes back past the newest entry.
      if (back === history.length) draft = input.value;
      back = Math.max(0, Math.min(history.length, back + (up ? -1 : 1)));
      setInput(back < history.length ? history[back] : draft);
    }
  });

  input.addEventListener("input", resize);

  // A click anywhere in the REPL but on its text, or a button, puts the
  // cursor in the input, as in a terminal.
  section.querySelector(".repl").addEventListener("click", function (event) {
    if (event.target.closest("pre, button") || !getSelection().isCollapsed) return;
    input.focus();
  });

  // The server takes a moment to start, so it starts as soon as it might
  // be needed.
  input.addEventListener("focus", function () { start(); });

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
      input.focus();
    });
  });
})();

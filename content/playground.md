---
title: Playground
description: >-
  A real nREPL server, running in your browser. Evaluate some ClojureScript
  and watch the messages go back and forth.
layout: playground
isolationNote: >-
  Your browser wouldn't let this page be cross-origin isolated, so code can't
  ask you for input here, and interrupting code starts the server over.
---

This is a real nREPL server, running right here in your browser:
[nrepl-sci](https://github.com/nrepl/nrepl-sci), which evaluates ClojureScript
with [SCI](https://github.com/babashka/sci). The REPL is a small nREPL client,
and next to it is every message it sends the server and every reply it gets
back, as they happen. Tab completes, Shift+Enter starts a new line, and code
can ask you for input with `read-line`. As you write, the editor asks the
server about your code, the way editors hooked up to nREPL do: `eldoc` for
the arguments of the call you're in, and `lookup` for the docs of any symbol
you point at.

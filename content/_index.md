---
tagline: The network REPL Clojure's tooling is built on
intro: >-
  nREPL is a REPL server your editor talks to over a socket. It evaluates code
  in your running program and sends back the results, the output and the
  errors as separate messages, along with completions, documentation and
  whatever else an editor needs to be helpful. CIDER, Calva, Cursive, Conjure
  and most other Clojure tools speak it, and so do servers for a bunch of
  languages that aren't Clojure.
# {version} becomes the latest release
start: >-
  clj -Sdeps '{:deps {nrepl/nrepl {:mvn/version "{version}"}}}' -M -m nrepl.cmdline
startLabel: Start a server in any Clojure project
heroPane: eval
heroCaption: >-
  The simplest exchange there is: the client asks for (+ 1 2), the server
  answers with the value, then says it's done. Every message carries the
  request's id.

steps:
  - >-
    Start a server. With the Clojure CLI it's the command at the top of this
    page, in a Leiningen project it's `lein repl`, and with Babashka
    it's `bb nrepl-server`. The server writes its port to
    `.nrepl-port`, which is how editors find it.
  - >-
    Connect your editor. Most of them will also start the server for you, with
    whatever middleware they need on top: that's `cider-jack-in` in
    CIDER and *Start a Project REPL and Connect* in Calva.
  - >-
    No editor around? nREPL comes with a small client of its own: add
    `--connect --port 7888` to the command above (with your port),
    or try [neorepl](https://github.com/nrepl/neorepl) for a terminal
    REPL with all the bells and whistles.
stepsNote: >-
  Adding nREPL to a project for good, or embedding it in your app?
  [Installation](https://docs.nrepl.org/nrepl/installation.html) and
  [Server](https://docs.nrepl.org/nrepl/usage/server.html) cover it.
outro: Keep hacking!
---

Chas Emerick started nREPL as a personal project in 2010, and later that year
it became one of the first projects in the new Clojure Contrib, as
`tools.nrepl`. It grew up there. REPL-y and `nrepl.el` (CIDER's original name)
were built on it in 2012, and 0.2 brought the design that's still in use today
in 2013.

Contrib turned out to be a tough place for a project that needed to move
quickly, though, and work on nREPL slowed to a crawl. In 2018 Chas handed it
over to the team behind CIDER, and it left Contrib as `nrepl/nrepl`. I've been
maintaining it ever since. The next few years went into the problems that had
piled up and the gaps people kept running into: configuration files, the EDN
transport, sideloading, built-in completion and lookup, Unix domain sockets,
TLS. nREPL 1.0 came out in 2022.

These days nREPL is boring in the best possible way. The protocol has been
stable since 0.2, and the tools people built on it a decade ago still work.
It's looked after by its core team, Michael Griffiths, Oleksandr Yakushev and
myself, with help from
[plenty of contributors](https://github.com/nrepl/nrepl/graphs/contributors).

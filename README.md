# nrepl.org

The source of [nrepl.org](https://nrepl.org), nREPL's landing page. The manual
lives at [docs.nrepl.org](https://docs.nrepl.org) and is built from the
[nrepl](https://github.com/nrepl/nrepl) repo by
[docs.nrepl.org](https://github.com/nrepl/docs.nrepl.org) instead.

The site is built with [Hugo](https://gohugo.io) and deployed to GitHub Pages
on every push to `master`, and weekly on a schedule.

## Editing

Almost everything on the page is plain YAML or markdown:

- `content/_index.md` - the tagline, intro, start command and getting-started
  steps (in the front matter), and the project's history (the body)
- `data/showcase.yaml` - the feature sections, each with the exchange shown
  next to it
- `data/features.yaml` - the "and the rest" links
- `data/clients.yaml` - who speaks nREPL
- `data/news.yaml` - the news archive. Posts tagged nREPL on Meta Redux show up
  on their own when the site is built (`newsFeed` and `newsTag` in
  `hugo.toml`); add a post here to keep it listed after it drops out of the feed
- `data/milestones.yaml` - the history log
- `data/faq.yaml` - the questions
- `data/community.yaml` - help channels and funding options

The latest version and the star count are fetched from the GitHub API at build
time, so a release needs nothing here. `fallbackVersion` in `hugo.toml` is
only used when GitHub can't be reached.

## The exchanges

The messages in the wire windows are real: `capture/` starts an nREPL server,
talks to it over a socket and writes everything that went back and forth to
`data/exchanges.json`, both as EDN and as the bencode that went over the wire.
It also records a Babashka server and the output of starting a server from the
shell. With the Clojure CLI and Babashka around:

```sh
cd capture
clojure -M -m capture
```

Bump the nREPL version in `capture/deps.edn` to re-record against a newer
release.

## The playground

The "Try it" section and the playground's own page (`/playground/`) run
[nrepl-sci](https://github.com/nrepl/nrepl-sci), an nREPL server for SCI that
runs in Web Workers, and show its messages in a wire window as they go back
and forth. The worker comes from the nrepl-sci
release in `playgroundVersion` in `hugo.toml`, fetched when the site is built,
so a new release is a one-line change. If it can't be fetched, the build warns,
which fails the deploy. To try a build that isn't released, put its
`nrepl-sci-worker.js` in `assets/playground/` (it's ignored by git).

Code can only wait for input, and be stopped without the server starting over,
when the page is cross-origin isolated, which takes headers GitHub Pages can't
send. The front page goes without, and hides the example that reads input. The
playground's page gets them from a service worker
(`assets/js/playground-sw.js`, published as `/playground/sw.js`), which adds
them to the page and to the scripts of nrepl-sci's workers, so those have to
stay under `/playground/` too. The first visit installs it and loads the page
again, and a browser that won't isolate the page gets the playground without,
and a note that says so.

## The old docs URLs

The docs used to live here, under `/nrepl/`. Every page they had gets a small
page that sends readers to the same path on docs.nrepl.org, anchor included
(`layouts/_partials/redirects.html`, with the list of paths in
`data/legacy_docs.yaml`), and the 404 page sends anything else under `/nrepl/`
there too. The list never needs to grow: pages added to the docs since the
move never had an address here.

## Running it locally

```sh
brew install hugo   # or see https://gohugo.io/installation/
hugo server
```

Then open <http://localhost:1313>. CI builds with the Hugo version pinned in
`.github/workflows/deploy.yml` and fails on any warning, so check that
`hugo --panicOnWarning` is clean before pushing.

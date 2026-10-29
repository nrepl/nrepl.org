// The page works without any of this: the exchanges show inline, in EDN.
(function () {
  "use strict";

  var root = document.documentElement;

  function remember(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  // Light or dark, overriding the system preference once picked.
  var toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var dark = root.dataset.theme
        ? root.dataset.theme === "dark"
        : matchMedia("(prefers-color-scheme: dark)").matches;
      root.dataset.theme = dark ? "light" : "dark";
      remember("theme", root.dataset.theme);
    });
  }

  // The second window gets a copy of the window of every section marked
  // data-pane. CSS shows it, and hides the copies in the text, on wide
  // screens only.
  var wire = document.querySelector(".wire");
  var sections = [];
  var panes = new Map();
  if (wire) {
    document.querySelectorAll("[data-pane]").forEach(function (section) {
      var figure = section.querySelector(":scope > .wire-figure");
      if (!figure) return;
      var pane = document.createElement("div");
      pane.className = "pane";
      pane.appendChild(figure.cloneNode(true));
      wire.appendChild(pane);
      sections.push(section);
      panes.set(section, pane);
    });
  }

  // EDN or bencode, for every exchange on the page at once.
  function setView(view) {
    root.dataset.view = view;
    document.querySelectorAll("[data-set-view]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.setView === view));
    });
  }
  setView(root.dataset.view === "bencode" ? "bencode" : "edn");

  function flash(button, text) {
    button.textContent = text;
    setTimeout(function () { button.textContent = "copy"; }, 1500);
  }

  document.addEventListener("click", function (event) {
    var viewButton = event.target.closest("[data-set-view]");
    if (viewButton) {
      setView(viewButton.dataset.setView);
      remember("view", viewButton.dataset.setView);
    }
    var copyButton = event.target.closest("[data-copy]");
    if (copyButton && navigator.clipboard) {
      navigator.clipboard.writeText(copyButton.dataset.copy).then(
        function () { flash(copyButton, "copied"); },
        function () { flash(copyButton, "couldn't copy"); });
    }
  });

  // The second window follows the section being read: the last one with a
  // pane whose top is past a line about a quarter of the way down the
  // screen. Sections without a pane of their own (the news, say) keep the
  // one before them, however the reader got there.
  var current = null;
  function follow() {
    if (!sections.length) return;
    var line = window.innerHeight * 0.25;
    var reading = sections[0];
    sections.forEach(function (section) {
      if (section.getBoundingClientRect().top <= line) reading = section;
    });
    var pane = panes.get(reading);
    if (pane === current) return;
    if (current) current.classList.remove("active");
    pane.classList.add("active");
    current = pane;
  }
  var scheduled = false;
  window.addEventListener("scroll", function () {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; follow(); });
  }, { passive: true });
  follow();
})();

// The playground page's service worker, published as /playground/sw.js.
// Code can wait for input, and be stopped without the server starting over,
// only when the page is cross-origin isolated, and that takes headers GitHub
// Pages can't send. So this adds them to the page, and to the scripts of the
// nrepl-sci workers it starts, which live under /playground/ too.

// A new version takes over right away: there's nothing to hand over.
self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  // Everything else goes to the network as if this wasn't here.
  if (request.mode !== "navigate" && request.destination !== "worker") return;
  event.respondWith(fetch(request).then(function (response) {
    // A redirect's headers can't be changed, and don't matter.
    if (response.type === "opaqueredirect") return response;
    var headers = new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });
  }));
});

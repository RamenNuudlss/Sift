// Runs in the page's own JS world. It only watches X's own "About this account"
// requests so Sift can (1) learn X's current query ID when it changes and
// (2) reuse a location X already fetched instead of asking again.
(() => {
  const RE = /\/graphql\/([A-Za-z0-9_-]+)\/AboutAccountQuery/;

  function post(msg) {
    window.postMessage({ __sift: true, ...msg }, location.origin);
  }

  function handleBody(url, body) {
    const m = String(url).match(RE);
    if (!m) return;
    post({ type: "qid", qid: m[1] });
    try {
      const vars = JSON.parse(new URL(url, location.href).searchParams.get("variables") || "{}");
      const result = body?.data?.user_result_by_screen_name?.result;
      const handle = vars.screenName || result?.core?.screen_name;
      if (!handle) return;
      post({ type: "geo", handle, based: result?.about_profile?.account_based_in || "" });
    } catch {}
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const p = origFetch.apply(this, arguments);
    if (url && RE.test(url)) {
      p.then(r => r.clone().json().then(b => handleBody(url, b))).catch(() => {});
    }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (url && RE.test(String(url))) {
      this.addEventListener("load", () => {
        try {
          const body = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          handleBody(String(url), body);
        } catch {}
      });
    }
    return origOpen.apply(this, arguments);
  };
})();

// Runs in the page's own JS world.
//
// X's feed, reply and profile responses already describe every author they
// contain, including the location people put in their profile and (when X
// includes it) their "Account based in" country. Sift reads a *copy* of those
// responses so it doesn't have to spend X's tiny lookup budget (about 50 per
// 15 minutes) on every author. X's requests and responses pass through untouched.
(() => {
  const GQL = /\/i\/api\/graphql\/([A-Za-z0-9_-]{10,40})\/([A-Za-z]+)/;
  let lastQid = "";

  const post = msg => window.postMessage({ __sift: true, ...msg }, location.origin);

  function noteUrl(url) {
    const m = GQL.exec(url);
    if (!m) return null;
    if (m[2] === "AboutAccountQuery" && m[1] !== lastQid) {
      lastQid = m[1];
      post({ type: "qid", qid: m[1] });
    }
    return m[2];
  }

  // Walk a GraphQL response and pull out every user object in it.
  function collect(body) {
    const out = new Map();
    const stack = [[body, 0]];
    while (stack.length) {
      const [o, depth] = stack.pop();
      if (!o || typeof o !== "object" || depth > 60) continue;
      if (Array.isArray(o)) { for (const v of o) stack.push([v, depth + 1]); continue; }
      const handle = o.core?.screen_name || (o.__typename === "User" || o.rest_id ? o.legacy?.screen_name : null);
      if (typeof handle === "string") {
        const based = o.about_profile?.account_based_in;
        const loc = o.location?.location ?? o.legacy?.location ?? "";
        const prev = out.get(handle.toLowerCase());
        if (!prev || (based && !prev.b)) out.set(handle.toLowerCase(), { h: handle.toLowerCase(), b: based || "", l: String(loc || "").slice(0, 120) });
      }
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === "object") stack.push([v, depth + 1]);
      }
    }
    return [...out.values()];
  }

  function handleBody(op, url, body) {
    try {
      const users = collect(body);
      if (op === "AboutAccountQuery") {
        // X's own "About this account" panel: authoritative for that account
        const vars = JSON.parse(new URL(url, location.href).searchParams.get("variables") || "{}");
        const res = body?.data?.user_result_by_screen_name?.result;
        const h = (vars.screenName || res?.core?.screen_name || "").toLowerCase();
        if (h) users.push({ h, b: res?.about_profile?.account_based_in || "", l: "", about: true });
      }
      if (users.length) post({ type: "users", users });
    } catch {}
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      const op = url && noteUrl(url);
      if (op) {
        p.then(res => {
          if (!res.ok) return;
          res.clone().json().then(b => handleBody(op, url, b), () => {});
        }, () => {});
      }
    } catch {}
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const op = url && noteUrl(String(url));
      if (op) {
        this.addEventListener("load", () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            const body = this.responseType === "json" ? this.response
              : (this.responseType === "" || this.responseType === "text") ? JSON.parse(this.responseText) : null;
            if (body) handleBody(op, String(url), body);
          } catch {}
        });
      }
    } catch {}
    return origOpen.apply(this, arguments);
  };
})();

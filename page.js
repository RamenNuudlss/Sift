// Runs in the page's own JS world. It never touches X's requests: it only
// watches the browser's resource-timing list for X's own "About this account"
// call, so Sift can pick up X's current query ID whenever X changes it.
(() => {
  const RE = /\/graphql\/([A-Za-z0-9_-]{10,40})\/AboutAccountQuery/;
  let last = "";

  function check(name) {
    const m = RE.exec(name);
    if (!m || m[1] === last) return;
    last = m[1];
    window.postMessage({ __sift: true, type: "qid", qid: m[1] }, location.origin);
  }

  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) check(e.name);
    }).observe({ type: "resource", buffered: true });
  } catch {}
})();

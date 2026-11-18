(() => {
  "use strict";

  // Public bearer token used by the x.com web client for its own API calls.
  const WEB_BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  const BLOCK_INTERVAL_MS = 5000;
  const BLOCK_DAILY_LIMIT = 100;
  const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000;

  const GEO_INTERVAL_MS = 400;       // minimum gap between location lookups
  const GEO_TIMEOUT_MS = 6000;
  const GEO_HOLD_MS = 5000;          // max time a post waits for its author's location
  const GEO_FALLBACK_PAUSE_MS = 2 * 60 * 1000;
  const GEO_CACHE_MAX = 40000;

  let S = { ...SIFT_DEFAULTS };
  let rules = { kw: [], users: new Map(), countries: new Map() };
  let lastActive = null;
  let scheduled = false;
  const counted = new Set();

  /* ---------------- settings ---------------- */

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function compile() {
    rules.kw = [];
    for (const r of S.keywords) {
      const t = (r.text || "").trim();
      if (!t) continue;
      let re;
      try {
        const m = t.match(/^\/(.+)\/([a-z]*)$/i);
        if (m) {
          const flags = m[2].includes("i") ? m[2] : m[2] + "i";
          re = new RegExp(m[1], flags);
        } else {
          re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(t)}(?=$|[^\\p{L}\\p{N}_])`, "iu");
        }
      } catch { continue; }
      rules.kw.push({ re, rule: r });
    }
    rules.users = new Map(S.users.map(u => [siftNormHandle(u.handle), u]));
    rules.countries = new Map(S.countries.map(c => [c.key, c]));
  }

  const countryRulesOn = () => S.countries.length > 0 || (S.countryMode === "only" && S.hideUnknownCountry);
  const geoWanted = () => countryRulesOn() || S.showFlags;

  /* ---------------- stats ---------------- */

  let pendingStats = { n: 0, blocked: 0, reasons: {} };
  let statsTimer = null;

  function record(reason, statusId) {
    if (statusId) {
      if (counted.has(statusId)) return;
      counted.add(statusId);
    }
    pendingStats.n++;
    pendingStats.reasons[reason] = (pendingStats.reasons[reason] || 0) + 1;
    flushSoon();
  }

  function flushSoon() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(async () => {
      const p = pendingStats;
      pendingStats = { n: 0, blocked: 0, reasons: {} };
      const s = await siftLoadStats();
      s.today += p.n;
      s.total += p.n;
      s.blocked += p.blocked;
      for (const [k, v] of Object.entries(p.reasons)) s.reasons[k] = (s.reasons[k] || 0) + v;
      await chrome.storage.local.set({ siftStats: s });
    }, 800);
  }

  /* ---------------- page detection ---------------- */

  function onForYou() {
    if (location.pathname !== "/home") return false;
    const tabs = document.querySelectorAll('[data-testid="primaryColumn"] [role="tablist"] [role="tab"]');
    if (!tabs.length) return true;
    return tabs[0].getAttribute("aria-selected") === "true";
  }

  function isActive() {
    if (!S.enabled) return false;
    return S.fypOnly ? onForYou() : true;
  }

  function syncTheme() {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/\d+/g);
    let theme = "dark";
    if (m) {
      const [r, g, b] = m.map(Number);
      theme = (0.299 * r + 0.587 * g + 0.114 * b) > 140 ? "light" : "dark";
    }
    document.documentElement.dataset.siftTheme = theme;
  }

  /* ---------------- location cache + lookups ---------------- */

  let qid = SIFT_DEFAULT_QID;
  let geo = {};                       // handle -> { k, n, t }   (k "" = no location)
  let geoDirty = false;
  let geoSaveTimer = null;
  const geoQueue = [];                // newest at the end (looked up first)
  const geoQueued = new Set();
  const geoHoldUntil = new Map();     // handle -> timestamp when posts stop waiting
  let geoPausedUntil = 0;
  let geoBroken = false;              // query id rejected; wait for page.js to learn a new one
  let geoLookups = 0;

  function geoGet(handle) {
    const e = geo[handle];
    if (!e) return undefined;
    const ttl = e.k ? SIFT_GEO_TTL : SIFT_GEO_NONE_TTL;
    if (Date.now() - e.t > ttl) return undefined;
    return e;
  }

  function geoSet(handle, basedIn) {
    const r = siftGeoResolve(basedIn);
    geo[handle] = r ? { k: r.key, n: r.name, t: Date.now() } : { k: "", n: "", t: Date.now() };
    geoQueued.delete(handle);
    geoHoldUntil.delete(handle);
    geoDirty = true;
    clearTimeout(geoSaveTimer);
    geoSaveTimer = setTimeout(saveGeo, 2500);
    refreshHandle(handle);
  }

  async function saveGeo() {
    if (!geoDirty) return;
    geoDirty = false;
    const keys = Object.keys(geo);
    if (keys.length > GEO_CACHE_MAX) {
      keys.sort((a, b) => geo[a].t - geo[b].t);
      for (const k of keys.slice(0, keys.length - GEO_CACHE_MAX)) delete geo[k];
    }
    // merge with what other tabs saved meanwhile
    const { siftGeo } = await chrome.storage.local.get("siftGeo");
    for (const [h, e] of Object.entries(siftGeo || {})) {
      if (!geo[h] || geo[h].t < e.t) geo[h] = e;
    }
    await chrome.storage.local.set({ siftGeo: geo });
  }

  function geoStatus(extra = {}) {
    chrome.storage.local.set({
      siftGeoStatus: { pausedUntil: geoPausedUntil, broken: geoBroken, lookups: geoLookups, at: Date.now(), ...extra }
    });
  }

  function requestGeo(handle) {
    if (geoQueued.has(handle) || geoGet(handle)) return;
    geoQueued.add(handle);
    geoQueue.push(handle);
    geoHoldUntil.set(handle, Date.now() + GEO_HOLD_MS);
    setTimeout(() => releaseHold(handle), GEO_HOLD_MS + 50);
    pumpGeo();
  }

  function canLookup() {
    return !geoBroken && Date.now() >= geoPausedUntil && !!csrf();
  }

  // Stop holding a handle's posts back (lookup slow, paused or failed).
  function releaseHold(handle) {
    if (!geoHoldUntil.has(handle)) return;
    geoHoldUntil.delete(handle);
    refreshHandle(handle);
  }

  function releaseAllHolds() {
    for (const h of [...geoHoldUntil.keys()]) releaseHold(h);
  }

  const GEO_WORKERS = 2;
  let geoWorkers = 0;
  let geoNextAt = 0;
  let geoRemaining = Infinity;
  let geoResetAt = 0;

  // Spread requests evenly over what's left of X's rate-limit window.
  function geoGap() {
    if (Number.isFinite(geoRemaining) && geoResetAt > Date.now() && geoRemaining < 30) {
      return Math.max(GEO_INTERVAL_MS, (geoResetAt - Date.now()) / Math.max(1, geoRemaining - 2));
    }
    return GEO_INTERVAL_MS;
  }

  function pumpGeo() {
    queueMicrotask(() => {
      while (geoWorkers < GEO_WORKERS && geoQueue.length) {
        geoWorkers++;
        geoWorker().finally(() => { geoWorkers--; if (geoQueue.length) pumpGeo(); });
      }
    });
  }

  async function geoWorker() {
    while (geoQueue.length) {
      if (!canLookup()) {
        releaseAllHolds();
        await sleep(Math.min(Math.max(2000, geoPausedUntil - Date.now()), 60000));
        continue;
      }
      const wait = geoNextAt - Date.now();
      if (wait > 0) { await sleep(wait); continue; }
      const handle = geoQueue.pop();
      if (!handle) break;
      if (!geoQueued.has(handle) || geoGet(handle)) { geoQueued.delete(handle); continue; }
      if (!document.querySelector(`article[data-sift-h="${CSS.escape(handle)}"]`)) {
        geoQueued.delete(handle);   // scrolled away; will be re-queued if seen again
        continue;
      }
      geoNextAt = Date.now() + geoGap();
      await lookup(handle);
    }
  }

  async function lookup(handle) {
    const vars = encodeURIComponent(JSON.stringify({ screenName: handle }));
    let res;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), GEO_TIMEOUT_MS);
    try {
      res = await fetch(`/i/api/graphql/${qid}/AboutAccountQuery?variables=${vars}`, {
        credentials: "include",
        signal: ctl.signal,
        headers: apiHeaders({ "content-type": "application/json" })
      });
    } catch {
      clearTimeout(timer);
      geoQueued.delete(handle);
      releaseHold(handle);
      return;
    }

    clearTimeout(timer);
    const remaining = Number(res.headers.get("x-rate-limit-remaining"));
    const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000;
    if (res.headers.has("x-rate-limit-remaining") && Number.isFinite(remaining)) {
      geoRemaining = remaining;
      if (reset) geoResetAt = reset;
    }

    if (res.status === 429) {
      geoPausedUntil = reset > Date.now() ? reset : Date.now() + GEO_FALLBACK_PAUSE_MS;
      geoQueue.push(handle); // retry later
      releaseAllHolds();
      geoStatus();
      return;
    }
    if (res.status === 404 || res.status === 400) {
      // stale query id; page.js will hand us the new one next time X fetches it
      geoBroken = true;
      geoQueued.delete(handle);
      releaseAllHolds();
      geoStatus();
      return;
    }
    if (!res.ok) {
      geoQueued.delete(handle);
      releaseHold(handle);
      return;
    }

    geoLookups++;
    if (Number.isFinite(remaining) && remaining <= 1 && reset > Date.now()) geoPausedUntil = reset;

    try {
      const body = await res.json().finally(() => clearTimeout(timer));
      const result = body?.data?.user_result_by_screen_name?.result;
      if (!result && body?.errors?.length) {
        geoQueued.delete(handle);
        releaseHold(handle);
        return;
      }
      geoSet(handle, result?.about_profile?.account_based_in || "");
    } catch {
      geoQueued.delete(handle);
      releaseHold(handle);
    }
    geoStatus();
  }

  // Messages from page.js (X's own About-this-account requests).
  window.addEventListener("message", e => {
    if (e.source !== window || !e.data || e.data.__sift !== true) return;
    if (e.data.type === "qid" && /^[A-Za-z0-9_-]{10,40}$/.test(e.data.qid)) {
      if (e.data.qid !== qid || geoBroken) {
        qid = e.data.qid;
        geoBroken = false;
        chrome.storage.local.set({ siftQid: qid });
        geoStatus();
        pumpGeo();
      }
    } else if (e.data.type === "geo" && typeof e.data.handle === "string") {
      geoSet(siftNormHandle(e.data.handle), String(e.data.based || ""));
    }
  });

  /* ---------------- tweet parsing ---------------- */

  function getHandle(article) {
    const link = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
    if (!link) return null;
    return siftNormHandle(link.getAttribute("href").split("/")[1]);
  }

  function getStatusId(article) {
    const t = article.querySelector('a[href*="/status/"] time');
    const href = t?.parentElement?.getAttribute("href") || "";
    const m = href.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function getText(article) {
    const parts = [];
    article.querySelectorAll('[data-testid="tweetText"]').forEach(el => parts.push(el.textContent));
    const name = article.querySelector('[data-testid="User-Name"]');
    if (name) parts.push(name.textContent);
    const card = article.querySelector('[data-testid="card.wrapper"]');
    if (card) parts.push(card.textContent);
    return parts.join("\n");
  }

  function isPromoted(article) {
    if (article.querySelector('[data-testid="placementTracking"]')) return true;
    for (const s of article.querySelectorAll("span")) {
      const t = s.textContent;
      if ((t === "Ad" || t === "Promoted") && !s.closest('[data-testid="tweetText"]')) return true;
    }
    return false;
  }

  const isVerified = a => !!a.querySelector('[data-testid="User-Name"] [data-testid="icon-verified"]');

  function isRepost(article) {
    const ctx = article.querySelector('[data-testid="socialContext"]');
    return !!ctx && /repost|retweet/i.test(ctx.textContent);
  }

  function countryHit(handle) {
    const g = geoGet(handle);
    if (!g) return undefined;
    if (S.countryMode === "only") {
      if (!g.k) return S.hideUnknownCountry ? { reason: "country", label: "No location", action: "hide", handle } : null;
      if (S.countries.length && !rules.countries.has(g.k)) {
        return { reason: "country", label: siftGeoLabel(g.k, g.n), action: "hide", handle, key: g.k };
      }
      return null;
    }
    const rule = g.k && rules.countries.get(g.k);
    return rule ? { reason: "country", label: siftGeoLabel(g.k, g.n), action: rule.action, handle, key: g.k } : null;
  }

  // Returns a hit, null, or "wait" when the author's country isn't known yet.
  function evaluate(article, handle) {
    const u = handle ? rules.users.get(handle) : null;
    if (u && u.action === "allow") return null;
    if (u) return { reason: "account", label: `@${handle}`, action: u.action, handle };

    if (S.hidePromoted && isPromoted(article)) return { reason: "promoted", label: "Promoted", action: "hide", handle, quiet: true };

    const text = getText(article);
    for (const { re, rule } of rules.kw) {
      if (re.test(text)) return { reason: "keyword", label: `“${rule.text}”`, action: rule.action, handle };
    }

    if (handle && countryRulesOn()) {
      const c = countryHit(handle);
      if (c) return c;
      if (c === undefined) {
        requestGeo(handle);
        if (S.holdForCountry && geoHoldUntil.has(handle) && canLookup()) return "wait";
      }
    }

    if (S.hideVerified && isVerified(article)) return { reason: "verified", label: "Verified account", action: "hide", handle };
    if (S.hideReposts && isRepost(article)) return { reason: "repost", label: "Repost", action: "hide", handle };
    return null;
  }

  /* ---------------- applying ---------------- */

  function cellOf(el) {
    return el.closest('[data-testid="cellInnerDiv"]') || el.parentElement;
  }

  function flagHTML(key) {
    return /^[A-Z]{2}$/.test(key) ? siftFlag(key) : "";
  }

  function addFlag(article, handle) {
    if (!S.showFlags || !handle) return;
    const g = geoGet(handle);
    if (!g || !g.k) return;
    const time = article.querySelector('[data-testid="User-Name"] a[href*="/status/"] time');
    const anchor = time?.parentElement;
    if (!anchor || anchor.nextElementSibling?.classList.contains("sift-flag")) return;
    const el = document.createElement("span");
    el.className = "sift-flag";
    const label = siftGeoLabel(g.k, g.n);
    el.title = `Account based in ${label}`;
    const f = flagHTML(g.k);
    if (f) el.textContent = f;
    else { el.classList.add("sift-flag-region"); el.textContent = label; }
    anchor.after(el);
  }

  function apply(article, hit, statusId) {
    record(hit.reason, statusId);

    if (hit.action === "block" && S.autoBlock && hit.handle) queueBlock(hit.handle);

    if (S.mode === "remove" || hit.quiet) {
      cellOf(article).classList.add("sift-gone");
      return;
    }

    article.classList.add("sift-hidden");
    const bar = document.createElement("div");
    bar.className = "sift-bar";
    bar.innerHTML = `
      <span class="sift-mark" aria-hidden="true"></span>
      <span class="sift-label">Filtered <span class="sift-why"></span></span>
      <span class="sift-spacer"></span>
      ${hit.handle ? `<button type="button" class="sift-btn" data-act="block">Block</button>` : ""}
      <button type="button" class="sift-btn sift-btn-primary" data-act="show">Show</button>`;
    const why = bar.querySelector(".sift-why");
    const f = hit.key ? flagHTML(hit.key) : "";
    why.textContent = f ? `${f} ${hit.label}` : hit.label;

    bar.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.act === "show") {
        article.classList.remove("sift-hidden");
        article.dataset.siftRevealed = "1";
        bar.remove();
      } else if (btn.dataset.act === "block") {
        btn.disabled = true;
        btn.textContent = "Blocking…";
        const ok = await blockUser(hit.handle);
        btn.textContent = ok ? "Blocked" : "Failed";
        toast(ok ? `Blocked @${hit.handle}` : `Couldn't block @${hit.handle}`);
      }
    });

    article.before(bar);
  }

  function processArticle(article) {
    const id = getStatusId(article) || "x";
    if (article.dataset.sift === id) return;
    if (article.dataset.sift) unapplyArticle(article);
    const handle = getHandle(article);
    article.dataset.sift = id;
    if (handle) article.dataset.siftH = handle;

    if (handle && S.showFlags && !geoGet(handle)) requestGeo(handle);
    addFlag(article, handle);

    if (article.dataset.siftRevealed) return;
    const hit = evaluate(article, handle);
    if (hit === "wait") {
      cellOf(article).classList.add("sift-wait");
      article.dataset.siftWait = "1";
      return;
    }
    if (hit) apply(article, hit, id !== "x" ? id : null);
  }

  // Re-run rules for every visible post by this author (after its location arrives).
  function refreshHandle(handle) {
    if (!lastActive) return;
    document.querySelectorAll(`article[data-sift-h="${CSS.escape(handle)}"]`).forEach(a => {
      if (a.dataset.siftRevealed) { addFlag(a, handle); return; }
      unapplyArticle(a);
      processArticle(a);
    });
  }

  function scanTweets() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach(processArticle);
  }

  function scanWhoToFollow() {
    if (!S.hideWhoToFollow) return;
    document.querySelectorAll('[data-testid="primaryColumn"] [data-testid="cellInnerDiv"]:not([data-sift-w])').forEach(cell => {
      if (cell.querySelector("article")) return;
      const isUserCell = cell.querySelector('[data-testid="UserCell"]');
      const isShowMore = cell.querySelector('a[href^="/i/connect_people"]');
      if (!isUserCell && !isShowMore) return;
      cell.dataset.siftW = "1";
      cell.classList.add("sift-gone");
      const prev = cell.previousElementSibling;
      if (prev && prev.querySelector("h2") && !prev.querySelector("article")) {
        prev.dataset.siftW = "1";
        prev.classList.add("sift-gone");
        record("whoToFollow", null);
      }
    });
  }

  function unapplyArticle(article) {
    article.classList.remove("sift-hidden");
    const prev = article.previousElementSibling;
    if (prev && prev.classList.contains("sift-bar")) prev.remove();
    article.querySelectorAll(".sift-flag").forEach(f => f.remove());
    const cell = cellOf(article);
    cell && cell.classList.remove("sift-gone", "sift-wait");
    delete article.dataset.sift;
    delete article.dataset.siftWait;
  }

  function resetAll() {
    document.querySelectorAll(".sift-bar, .sift-flag").forEach(b => b.remove());
    document.querySelectorAll(".sift-hidden").forEach(el => el.classList.remove("sift-hidden"));
    document.querySelectorAll(".sift-gone, .sift-wait").forEach(el => el.classList.remove("sift-gone", "sift-wait"));
    document.querySelectorAll("[data-sift],[data-sift-w],[data-sift-revealed],[data-sift-wait]").forEach(el => {
      delete el.dataset.sift;
      delete el.dataset.siftW;
      delete el.dataset.siftRevealed;
      delete el.dataset.siftWait;
    });
  }

  function scan() {
    scheduled = false;
    const active = isActive();
    if (active !== lastActive) {
      resetAll();
      lastActive = active;
      if (active) syncTheme();
    }
    if (!active) return;
    scanTweets();
    scanWhoToFollow();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }

  /* ---------------- X API helpers ---------------- */

  function csrf() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? m[1] : null;
  }

  function apiHeaders(extra = {}) {
    return {
      authorization: `Bearer ${WEB_BEARER}`,
      "x-csrf-token": csrf() || "",
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      ...extra
    };
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------------- blocking ---------------- */

  const queue = [];
  let pumping = false;
  let pausedUntil = 0;
  let blockedSet = new Set();
  let blockLog = { day: "", count: 0 };

  async function blockUser(handle) {
    if (!csrf()) return false;
    try {
      const res = await fetch("/i/api/1.1/blocks/create.json", {
        method: "POST",
        credentials: "include",
        headers: apiHeaders({ "content-type": "application/x-www-form-urlencoded" }),
        body: `screen_name=${encodeURIComponent(handle)}`
      });
      if (res.status === 429) { pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS; return false; }
      if (!res.ok) return false;
      blockedSet.add(handle);
      pendingStats.blocked++;
      flushSoon();
      await chrome.storage.local.set({ siftBlocked: [...blockedSet].slice(-5000) });
      return true;
    } catch {
      return false;
    }
  }

  function queueBlock(handle) {
    if (blockedSet.has(handle) || queue.includes(handle)) return;
    queue.push(handle);
    pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      if (Date.now() < pausedUntil) { queue.length = 0; break; }
      const today = siftToday();
      if (blockLog.day !== today) blockLog = { day: today, count: 0 };
      if (blockLog.count >= BLOCK_DAILY_LIMIT) { queue.length = 0; break; }
      const h = queue.shift();
      if (await blockUser(h)) {
        blockLog.count++;
        await chrome.storage.local.set({ siftBlockLog: blockLog });
        toast(`Auto-blocked @${h}`);
      }
      await sleep(BLOCK_INTERVAL_MS);
    }
    pumping = false;
  }

  /* ---------------- toast ---------------- */

  let toastEl = null;
  let toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "sift-toast";
      document.body.appendChild(toastEl);
    }
    syncTheme();
    toastEl.textContent = msg;
    toastEl.classList.add("sift-toast-in");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("sift-toast-in"), 2600);
  }

  /* ---------------- boot ---------------- */

  async function init() {
    S = await siftLoad();
    const st = await chrome.storage.local.get(["siftBlocked", "siftBlockLog", "siftGeo", "siftQid"]);
    blockedSet = new Set(st.siftBlocked || []);
    blockLog = st.siftBlockLog || blockLog;
    geo = st.siftGeo || {};
    if (st.siftQid) qid = st.siftQid;
    compile();
    syncTheme();
    schedule();

    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected"]
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.siftGeo && changes.siftGeo.newValue === undefined) geo = {}; // cache cleared from popup
      if (!changes.sift) return;
      S = { ...SIFT_DEFAULTS, ...changes.sift.newValue };
      compile();
      resetAll();
      lastActive = null;
      schedule();
    });

    window.addEventListener("pagehide", saveGeo);
  }

  init();
})();

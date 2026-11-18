(() => {
  "use strict";

  // Public bearer token used by the x.com web client for its own API calls.
  const WEB_BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  const BLOCK_INTERVAL_MS = 5000;
  const BLOCK_DAILY_LIMIT = 100;
  const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000;

  const GEO_MIN_GAP_MS = 150;          // fastest pace between lookup starts
  const GEO_PARALLEL = 3;              // lookups in flight at once
  const GEO_HOLD_MAX_GAP_MS = 1200;    // only hold posts back while lookups are this quick
  const GEO_TIMEOUT_MS = 6000;
  const GEO_HOLD_MS = 3500;            // longest a post waits for its author's location
  const GEO_FALLBACK_PAUSE_MS = 2 * 60 * 1000;
  const GEO_RESERVE = 3;               // leave a few calls of X's budget unused
  const GEO_CACHE_MAX = 40000;

  let S = { ...SIFT_DEFAULTS };
  let rules = { kw: [], users: new Map(), countries: new Map() };
  let lastActive = null;
  let scheduled = false;
  const counted = new Set();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ================= settings ================= */

  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function compile() {
    rules.kw = [];
    for (const r of S.keywords) {
      const t = (r.text || "").trim();
      if (!t) continue;
      let re;
      try {
        const m = t.match(/^\/(.+)\/([a-z]*)$/i);
        if (m) re = new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i");
        else re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(t)}(?=$|[^\\p{L}\\p{N}_])`, "iu");
      } catch { continue; }
      rules.kw.push({ re, rule: r });
    }
    rules.users = new Map(S.users.map(u => [siftNormHandle(u.handle), u]));
    rules.countries = new Map(S.countries.map(c => [c.key, c]));
  }

  const countryRulesOn = () => S.countries.length > 0 || (S.countryMode === "only" && S.hideUnknownCountry);

  /* ================= stats ================= */

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

  /* ================= page + theme ================= */

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

  // X has three themes: Default (white), Dim (navy) and Lights out (black).
  let themeCheckedAt = 0;
  function syncTheme(force) {
    const now = Date.now();
    if (!force && now - themeCheckedAt < 2000) return;
    themeCheckedAt = now;
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    let theme = "dark";
    if (m) {
      const [r, g, b] = m.map(Number);
      if (0.299 * r + 0.587 * g + 0.114 * b > 140) theme = "light";
      else if (b > 30) theme = "dim";
    }
    if (document.documentElement.dataset.siftTheme !== theme) document.documentElement.dataset.siftTheme = theme;
  }

  // Is an element on screen or within `margin` px of it?
  function nearViewport(el, margin = 600) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    return r.bottom > -margin && r.top < innerHeight + margin;
  }

  /* ================= location cache ================= */

  let qid = SIFT_DEFAULT_QID;
  let geo = {};                        // handle -> { k, n, t }   (k "" = no location)
  let geoDirty = false;
  let geoSaveTimer = null;

  function geoGet(handle) {
    const e = geo[handle];
    if (!e) return undefined;
    if (Date.now() - e.t > (e.k ? SIFT_GEO_TTL : SIFT_GEO_NONE_TTL)) return undefined;
    return e;
  }

  function geoSet(handle, basedIn) {
    if (!handle) return;
    const r = siftGeoResolve(basedIn);
    geo[handle] = r ? { k: r.key, n: r.name, t: Date.now() } : { k: "", n: "", t: Date.now() };
    geoQueued.delete(handle);
    holds.delete(handle);
    geoDirty = true;
    if (!geoSaveTimer) geoSaveTimer = setTimeout(() => { geoSaveTimer = null; saveGeo(); }, 1000);
    refreshHandle(handle);
    schedule();
  }

  async function saveGeo() {
    if (!geoDirty) return;
    geoDirty = false;
    const { siftGeo } = await chrome.storage.local.get("siftGeo");
    for (const [h, e] of Object.entries(siftGeo || {})) {
      if (!geo[h] || geo[h].t < e.t) geo[h] = e;  // keep what other tabs learned
    }
    const keys = Object.keys(geo);
    if (keys.length > GEO_CACHE_MAX) {
      keys.sort((a, b) => geo[a].t - geo[b].t);
      for (const k of keys.slice(0, keys.length - GEO_CACHE_MAX)) delete geo[k];
    }
    await chrome.storage.local.set({ siftGeo: geo });
  }

  /* ================= lookups =================
     Only authors on or near the screen are looked up, nearest first, and the
     pace follows X's own rate-limit headers so the budget lasts the window. */

  const geoQueued = new Set();
  const holds = new Map();             // handle -> time its posts stop waiting
  let geoPausedUntil = 0;
  let geoBroken = false;
  const badQids = new Set();
  let geoLookups = 0;
  let geoRemaining = NaN;
  let geoLimit = NaN;
  let geoResetAt = 0;
  let geoNextAt = 0;
  let geoWorking = false;
  const geoInFlight = new Set();

  function geoStatus() {
    chrome.storage.local.set({
      siftGeoStatus: {
        pausedUntil: geoPausedUntil, broken: geoBroken, lookups: geoLookups,
        remaining: Number.isFinite(geoRemaining) ? geoRemaining : null, resetAt: geoResetAt, at: Date.now()
      }
    });
  }

  // Spend X's budget freely while plenty is left; once it runs low, stretch
  // what remains across the rest of the window so labels never stop entirely.
  function geoGap() {
    if (!Number.isFinite(geoRemaining) || geoResetAt <= Date.now()) return GEO_MIN_GAP_MS;
    const left = geoRemaining - GEO_RESERVE;
    if (left <= 0) return geoResetAt - Date.now() + 1000;
    const lowWater = Math.max(10, Number.isFinite(geoLimit) ? geoLimit * 0.2 : 10);
    if (geoRemaining > lowWater) return GEO_MIN_GAP_MS;
    return Math.max(GEO_MIN_GAP_MS, (geoResetAt - Date.now()) / left);
  }

  const canLookup = () => !geoBroken && Date.now() >= geoPausedUntil && !!csrf();
  // Holding posts only makes sense while lookups come back fast.
  const canHold = () => canLookup() && geoGap() <= GEO_HOLD_MAX_GAP_MS;

  function requestGeo(handle) {
    if (!handle || geoGet(handle) || geoQueued.has(handle)) return;
    geoQueued.add(handle);
    pumpGeo();
  }

  function hold(handle) {
    if (holds.has(handle)) return true;
    if (!canHold()) return false;
    holds.set(handle, Date.now() + GEO_HOLD_MS);
    setTimeout(() => releaseHold(handle), GEO_HOLD_MS + 30);
    return true;
  }

  function releaseHold(handle) {
    if (!holds.delete(handle)) return;
    refreshHandle(handle);
  }

  function releaseAllHolds() {
    for (const h of [...holds.keys()]) releaseHold(h);
  }

  function elementsFor(handle) {
    const h = CSS.escape(handle);
    return document.querySelectorAll(`article[data-sift-h="${h}"], [data-sift-lh="${h}"]`);
  }

  // Next handle to look up: the one closest to the middle of the screen.
  function nextHandle() {
    let best = null;
    let bestDist = Infinity;
    const mid = innerHeight / 2;
    for (const h of [...geoQueued]) {
      if (geoInFlight.has(h)) continue;
      if (geoGet(h)) { geoQueued.delete(h); continue; }
      let dist = Infinity;
      for (const el of elementsFor(h)) {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        dist = Math.min(dist, Math.abs((r.top + r.bottom) / 2 - mid));
      }
      if (dist > innerHeight * 1.5) { geoQueued.delete(h); continue; } // scrolled away; re-queued if it comes back
      if (holds.has(h)) dist -= 100000;   // posts being held back go first
      if (dist < bestDist) { bestDist = dist; best = h; }
    }
    return best;
  }

  async function pumpGeo() {
    if (geoWorking) return;
    geoWorking = true;
    try {
      while (geoQueued.size > geoInFlight.size) {
        if (!canLookup()) {
          releaseAllHolds();
          if (geoBroken || !csrf()) break;              // resumes when page.js reports a new query id
          await sleep(Math.min(Math.max(1000, geoPausedUntil - Date.now()), 30000));
          continue;
        }
        if (geoInFlight.size >= GEO_PARALLEL) { await sleep(40); continue; }
        const wait = geoNextAt - Date.now();
        if (wait > 0) {
          if (wait > GEO_HOLD_MAX_GAP_MS) releaseAllHolds();
          await sleep(Math.min(wait, 5000));
          continue;
        }
        const handle = nextHandle();
        if (!handle) break;
        geoInFlight.add(handle);
        geoNextAt = Date.now() + geoGap();
        lookup(handle).finally(() => {
          geoInFlight.delete(handle);
          if (geoQueued.size > geoInFlight.size) pumpGeo();
        });
      }
    } finally {
      geoWorking = false;
    }
  }

  function failLookup(handle) {
    geoQueued.delete(handle);
    releaseHold(handle);
  }

  async function lookup(handle) {
    const vars = encodeURIComponent(JSON.stringify({ screenName: handle }));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), GEO_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`/i/api/graphql/${qid}/AboutAccountQuery?variables=${vars}`, {
        credentials: "include",
        signal: ctl.signal,
        headers: apiHeaders({ "content-type": "application/json" })
      });
    } catch {
      clearTimeout(timer);
      return failLookup(handle);
    }
    clearTimeout(timer);

    if (res.headers.has("x-rate-limit-remaining")) {
      const rem = Number(res.headers.get("x-rate-limit-remaining"));
      const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000;
      const lim = Number(res.headers.get("x-rate-limit-limit"));
      if (Number.isFinite(rem)) geoRemaining = rem;
      if (Number.isFinite(lim) && lim > 0) geoLimit = lim;
      if (reset > Date.now()) geoResetAt = reset;
    }

    if (res.status === 429) {
      geoPausedUntil = geoResetAt > Date.now() ? geoResetAt : Date.now() + GEO_FALLBACK_PAUSE_MS;
      releaseAllHolds();
      geoStatus();
      return;                                   // stays queued; retried after the pause
    }
    if (res.status === 400 || res.status === 404) {
      geoBroken = true;                         // stale query id; page.js hands us the new one
      badQids.add(qid);
      releaseAllHolds();
      geoStatus();
      return;
    }
    if (!res.ok) return failLookup(handle);

    geoLookups++;
    try {
      const body = await res.json();
      const result = body?.data?.user_result_by_screen_name?.result;
      if (!result && body?.errors?.length) return failLookup(handle);
      geoSet(handle, result?.about_profile?.account_based_in || "");
    } catch {
      failLookup(handle);
    }
    geoStatus();
  }

  // From page.js: X's own "About this account" requests.
  window.addEventListener("message", e => {
    if (e.source !== window || !e.data || e.data.__sift !== true) return;
    if (e.data.type === "qid" && /^[A-Za-z0-9_-]{10,40}$/.test(e.data.qid) && !badQids.has(e.data.qid)) {
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

  /* ================= post parsing ================= */

  // Works for timeline posts, replies and quoted posts (which have no profile links).
  function handleOf(userName) {
    for (const s of userName.querySelectorAll("span")) {
      if (s.children.length) continue;
      const m = s.textContent.trim().match(/^@([A-Za-z0-9_]{1,15})$/);
      if (m) return m[1].toLowerCase();
    }
    const link = userName.querySelector('a[href^="/"]');
    return link ? siftNormHandle(link.getAttribute("href").split("/")[1]) : null;
  }

  // The post's own author (not a quoted one).
  function mainUserName(article) {
    for (const un of article.querySelectorAll('[data-testid="User-Name"]')) {
      const quote = un.closest('div[role="link"]');
      if (!quote || !article.contains(quote)) return un;
    }
    return article.querySelector('[data-testid="User-Name"]');
  }

  function getStatusId(article) {
    const t = article.querySelector('a[href*="/status/"] time');
    const m = (t?.parentElement?.getAttribute("href") || "").match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function getText(article) {
    const parts = [];
    article.querySelectorAll('[data-testid="tweetText"]').forEach(el => parts.push(el.textContent));
    const name = mainUserName(article);
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

  const isVerified = a => !!mainUserName(a)?.querySelector('[data-testid="icon-verified"]');

  function isRepost(article) {
    const ctx = article.querySelector('[data-testid="socialContext"]');
    return !!ctx && /repost|retweet/i.test(ctx.textContent);
  }

  /* ================= rules ================= */

  function countryHit(handle) {
    const g = geoGet(handle);
    if (!g) return undefined;
    const cont = siftContinentOf(g.k);
    const label = cont && !g.k.startsWith("r:") ? `${siftGeoLabel(g.k, g.n)} · ${siftContinentName(cont)}` : siftGeoLabel(g.k, g.n);
    const rule = g.k ? rules.countries.get(g.k) || (cont && rules.countries.get("c:" + cont)) : null;
    if (S.countryMode === "only") {
      if (!g.k) return S.hideUnknownCountry ? { reason: "country", label: "No location", action: "hide", handle } : null;
      if (S.countries.length && !rule) return { reason: "country", label, action: "hide", handle, key: g.k };
      return null;
    }
    return rule ? { reason: "country", label, action: rule.action, handle, key: g.k } : null;
  }

  // A hit, null, or "wait" when the author's country is still loading.
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
        if (S.holdForCountry && nearViewport(article, 1200) && hold(handle)) return "wait";
      }
    }

    if (S.hideVerified && isVerified(article)) return { reason: "verified", label: "Verified account", action: "hide", handle };
    if (S.hideReposts && isRepost(article)) return { reason: "repost", label: "Repost", action: "hide", handle };
    return null;
  }

  /* ================= filtering ================= */

  const cellOf = el => el.closest('[data-testid="cellInnerDiv"]') || el.parentElement;
  const flagOf = key => (/^[A-Z]{2}$/.test(key) ? siftFlag(key) : "");

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
      <button type="button" class="sift-btn" data-act="show">Show</button>`;
    const f = hit.key ? flagOf(hit.key) : "";
    bar.querySelector(".sift-why").textContent = f ? `${f} ${hit.label}` : hit.label;

    bar.addEventListener("click", async e => {
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
    const un = mainUserName(article);
    const handle = un ? handleOf(un) : null;
    article.dataset.sift = id;
    if (handle) article.dataset.siftH = handle;
    if (article.dataset.siftRevealed) return;

    const hit = evaluate(article, handle);
    if (hit === "wait") {
      // Keep the post's space so X's feed keeps loading; just veil it briefly.
      article.classList.add("sift-wait");
      return;
    }
    if (hit) apply(article, hit, id !== "x" ? id : null);
  }

  // Re-run the rules for an author's visible posts once their location is known.
  function refreshHandle(handle) {
    if (!lastActive) return;
    document.querySelectorAll(`article[data-sift-h="${CSS.escape(handle)}"]`).forEach(a => {
      if (a.dataset.siftRevealed) return;
      unapplyArticle(a);
      processArticle(a);
    });
  }

  function scanWhoToFollow() {
    if (!S.hideWhoToFollow) return;
    document.querySelectorAll('[data-testid="primaryColumn"] [data-testid="cellInnerDiv"]:not([data-sift-w])').forEach(cell => {
      if (cell.querySelector("article")) return;
      if (!cell.querySelector('[data-testid="UserCell"], a[href^="/i/connect_people"]')) return;
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
    article.classList.remove("sift-hidden", "sift-wait");
    const prev = article.previousElementSibling;
    if (prev && prev.classList.contains("sift-bar")) prev.remove();
    cellOf(article)?.classList.remove("sift-gone");
    delete article.dataset.sift;
  }

  function resetAll() {
    document.querySelectorAll(".sift-bar").forEach(b => b.remove());
    document.querySelectorAll(".sift-hidden, .sift-wait, .sift-gone").forEach(el => el.classList.remove("sift-hidden", "sift-wait", "sift-gone"));
    document.querySelectorAll("[data-sift],[data-sift-w],[data-sift-revealed]").forEach(el => {
      delete el.dataset.sift;
      delete el.dataset.siftW;
      delete el.dataset.siftRevealed;
    });
  }

  /* ================= location labels ================= */

  function buildLabel(handle, g) {
    const el = document.createElement("span");
    el.className = "sift-loc";
    el.dataset.h = handle;
    el.dataset.k = g.k + "|" + S.flagStyle;
    const name = siftGeoLabel(g.k, g.n);
    const cont = siftContinentOf(g.k);
    el.title = `Account based in ${name}${cont && !g.k.startsWith("r:") ? ` · ${siftContinentName(cont)}` : ""}`;
    const f = flagOf(g.k);
    if (f) {
      const fl = document.createElement("span");
      fl.className = "sift-loc-flag";
      fl.textContent = f;
      el.append(fl);
    }
    if (!f || S.flagStyle !== "flag") {
      const t = document.createElement("span");
      t.className = "sift-loc-name";
      t.textContent = name;
      el.append(t);
    }
    return el;
  }

  // "🇯🇵 Japan" right after the author's name, on every post including quotes and replies.
  function labelAll() {
    document.querySelectorAll('article [data-testid="User-Name"]').forEach(un => {
      const handle = handleOf(un);
      if (!handle) return;
      const row = un.firstElementChild || un;
      let label = un.querySelector(":scope .sift-loc");
      if (un.dataset.siftLh !== handle) {
        label?.remove();
        label = null;
        un.dataset.siftLh = handle;
      }
      const g = geoGet(handle);
      if (!g) {
        if (nearViewport(un)) requestGeo(handle);
        return;
      }
      if (!g.k) { label?.remove(); return; }
      if (label && label.dataset.h === handle && label.dataset.k === g.k + "|" + S.flagStyle && label.parentElement === row) return;
      label?.remove();
      row.appendChild(buildLabel(handle, g));
    });
  }

  /* ================= scan loop ================= */

  function scan() {
    scheduled = false;
    if (!document.body) return;
    const active = isActive();
    if (active !== lastActive) {
      resetAll();
      lastActive = active;
    }
    if (!S.enabled) return;
    syncTheme();
    if (S.showFlags) labelAll();
    if (!active) return;
    document.querySelectorAll('article[data-testid="tweet"]').forEach(processArticle);
    scanWhoToFollow();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }

  /* ================= X API ================= */

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

  /* ================= blocking ================= */

  const blockQueue = [];
  let blocking = false;
  let blockPausedUntil = 0;
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
      if (res.status === 429) { blockPausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS; return false; }
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
    if (blockedSet.has(handle) || blockQueue.includes(handle)) return;
    blockQueue.push(handle);
    pumpBlocks();
  }

  async function pumpBlocks() {
    if (blocking) return;
    blocking = true;
    while (blockQueue.length) {
      if (Date.now() < blockPausedUntil) { blockQueue.length = 0; break; }
      const today = siftToday();
      if (blockLog.day !== today) blockLog = { day: today, count: 0 };
      if (blockLog.count >= BLOCK_DAILY_LIMIT) { blockQueue.length = 0; break; }
      const h = blockQueue.shift();
      if (await blockUser(h)) {
        blockLog.count++;
        await chrome.storage.local.set({ siftBlockLog: blockLog });
        toast(`Auto-blocked @${h}`);
      }
      await sleep(BLOCK_INTERVAL_MS);
    }
    blocking = false;
  }

  /* ================= toast ================= */

  let toastEl = null;
  let toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "sift-toast";
      document.body.appendChild(toastEl);
    }
    syncTheme(true);
    toastEl.textContent = msg;
    toastEl.classList.add("sift-toast-in");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("sift-toast-in"), 2600);
  }

  /* ================= boot ================= */

  async function init() {
    S = await siftLoad();
    const st = await chrome.storage.local.get(["siftBlocked", "siftBlockLog", "siftGeo", "siftQid"]);
    blockedSet = new Set(st.siftBlocked || []);
    blockLog = st.siftBlockLog || blockLog;
    geo = st.siftGeo || {};
    if (st.siftQid) qid = st.siftQid;
    compile();
    syncTheme(true);
    schedule();

    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected"]
    });

    // X doesn't always add DOM while scrolling cached posts; make sure new
    // posts entering the screen get looked up.
    let scrollTimer = null;
    addEventListener("scroll", () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => { scrollTimer = null; schedule(); }, 250);
    }, { passive: true });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.siftGeo && changes.siftGeo.newValue === undefined) geo = {};
      if (!changes.sift) return;
      S = { ...SIFT_DEFAULTS, ...changes.sift.newValue };
      compile();
      resetAll();
      document.querySelectorAll(".sift-loc").forEach(l => l.remove());
      lastActive = null;
      schedule();
    });

    addEventListener("pagehide", saveGeo);
  }

  init();
})();

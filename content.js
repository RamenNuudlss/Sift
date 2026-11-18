(() => {
  "use strict";

  // Public bearer token used by the x.com web client for its own API calls.
  const WEB_BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  const BLOCK_INTERVAL_MS = 5000;
  const BLOCK_DAILY_LIMIT = 100;
  const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000;

  const GEO_TIMEOUT_MS = 6000;
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

  /* ================= location cache =================
     Entry sources:  s:"x"  X's own "Account based in" (authoritative)
                     s:"p"  guessed from the profile location text
     k "" means X reports no location for the account. */

  const GEO_PROFILE_TTL = 7 * 24 * 3600 * 1000;
  let qid = SIFT_DEFAULT_QID;
  let geo = {};
  let geoDirty = false;
  let geoSaveTimer = null;
  const profileTried = new Set();      // handles whose profile text we've already parsed

  function geoGet(handle) {
    const e = geo[handle];
    if (!e) return undefined;
    const ttl = e.s === "p" ? GEO_PROFILE_TTL : e.k ? SIFT_GEO_TTL : SIFT_GEO_NONE_TTL;
    if (Date.now() - e.t > ttl) return undefined;
    return e;
  }

  // What filtering may rely on: X's answer, or the profile guess if allowed.
  function geoUsable(handle) {
    const e = geoGet(handle);
    if (!e) return undefined;
    if (e.s === "p" && !S.useProfileLocation) return undefined;
    return e;
  }

  const isAuthoritative = h => { const e = geoGet(h); return !!e && e.s !== "p"; };

  function geoPut(handle, entry) {
    geo[handle] = { ...entry, t: Date.now() };
    geoDirty = true;
    if (!geoSaveTimer) geoSaveTimer = setTimeout(() => { geoSaveTimer = null; saveGeo(); }, 1000);
    refreshHandle(handle);
    schedule();
  }

  // X's authoritative answer.
  function geoSet(handle, basedIn) {
    if (!handle) return;
    geoQueued.delete(handle);
    const r = siftGeoResolve(basedIn);
    geoPut(handle, r ? { k: r.key, n: r.name, s: "x" } : { k: "", n: "", s: "x" });
  }

  // A profile-location guess; never overrides X's answer.
  function geoGuess(handle, text) {
    if (!handle || profileTried.has(handle)) return;
    profileTried.add(handle);
    if (isAuthoritative(handle)) return;
    const code = siftGuessCountry(text);
    if (!code) return;
    const prev = geoGet(handle);
    if (prev && prev.s === "p" && prev.k === code) return;
    geoPut(handle, { k: code, n: siftGeoLabel(code), s: "p", r: String(text).slice(0, 40) });
  }

  async function saveGeo() {
    if (!geoDirty) return;
    geoDirty = false;
    const { siftGeo } = await chrome.storage.local.get("siftGeo");
    for (const [h, e] of Object.entries(siftGeo || {})) {
      const mine = geo[h];
      // keep what other tabs learned; X's answer beats a guess
      if (!mine || (mine.s === "p" && e.s !== "p") || (mine.s === e.s && mine.t < e.t)) geo[h] = e;
    }
    const keys = Object.keys(geo);
    if (keys.length > GEO_CACHE_MAX) {
      keys.sort((a, b) => geo[a].t - geo[b].t);
      for (const k of keys.slice(0, keys.length - GEO_CACHE_MAX)) delete geo[k];
    }
    await chrome.storage.local.set({ siftGeo: geo });
  }

  /* ================= lookups =================
     X allows ~50 "About this account" lookups per 15 minutes, shared by all
     tabs through the background script. They go to the authors that matter
     most: posts you're about to scroll to (so filtering is ready in time),
     then on-screen authors with no location at all, then confirming guesses. */

  const geoQueued = new Map();         // handle -> { filter: bool }
  let geoBroken = false;
  const badQids = new Set();
  let geoWorking = false;

  function requestGeo(handle, forFilter = false) {
    if (!handle || isAuthoritative(handle)) return;
    const q = geoQueued.get(handle);
    if (q) { if (forFilter) q.filter = true; return; }
    geoQueued.set(handle, { filter: forFilter });
    pumpGeo();
  }

  function elementsFor(handle) {
    const h = CSS.escape(handle);
    return document.querySelectorAll(`article[data-sift-h="${h}"], [data-sift-lh="${h}"]`);
  }

  function nextHandle() {
    let best = null;
    let bestScore = Infinity;
    for (const [h, q] of geoQueued) {
      if (isAuthoritative(h)) { geoQueued.delete(h); continue; }
      let top = Infinity;
      for (const el of elementsFor(h)) {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (Math.abs(r.top - innerHeight / 2) < Math.abs(top - innerHeight / 2)) top = r.top;
      }
      if (top === Infinity || top < -innerHeight || top > innerHeight * 3) { geoQueued.delete(h); continue; }
      let score = Math.abs(top - innerHeight * 0.75);
      if (q.filter && top > innerHeight * 0.5) score -= 200000;  // coming up: filter before it's seen
      if (!geoGet(h)) score -= 100000;                          // nothing known yet
      if (score < bestScore) { bestScore = score; best = h; }
    }
    return best;
  }

  function slot() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: "geo-slot" }, r => resolve(chrome.runtime.lastError ? { wait: 5000 } : r || { wait: 5000 }));
      } catch { resolve({ wait: 10000 }); }
    });
  }

  function report(res) {
    const num = h => { const v = Number(res.headers.get(h)); return res.headers.has(h) && Number.isFinite(v) ? v : undefined; };
    const reset = num("x-rate-limit-reset");
    try {
      chrome.runtime.sendMessage({
        type: "geo-report", status: res.status,
        limit: num("x-rate-limit-limit"), remaining: num("x-rate-limit-remaining"),
        reset: reset ? reset * 1000 : undefined
      }, () => void chrome.runtime.lastError);
    } catch {}
  }

  async function pumpGeo() {
    if (geoWorking) return;
    geoWorking = true;
    try {
      while (geoQueued.size && !geoBroken && csrf()) {
        if (!nextHandle()) break;
        const s = await slot();
        if (!s.ok) { await sleep(Math.min(Math.max(s.wait || 1000, 300), 4000)); continue; }
        const handle = nextHandle();       // the screen may have moved while waiting
        if (!handle) break;
        geoQueued.delete(handle);
        await lookup(handle);
      }
    } finally {
      geoWorking = false;
    }
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
      return;
    }
    clearTimeout(timer);
    report(res);
    if (res.status === 429) return;
    if (res.status === 400 || res.status === 404) {
      geoBroken = true;                        // stale query id; page.js reports the new one
      badQids.add(qid);
      chrome.storage.local.get("siftGeoStatus").then(({ siftGeoStatus }) =>
        chrome.storage.local.set({ siftGeoStatus: { ...(siftGeoStatus || {}), broken: true } }));
      return;
    }
    if (!res.ok) return;
    try {
      const body = await res.json();
      const result = body?.data?.user_result_by_screen_name?.result;
      if (!result && body?.errors?.length) return;
      geoSet(handle, result?.about_profile?.account_based_in || "");
    } catch {}
  }

  // From page.js: authors found in X's own responses, and X's query id.
  window.addEventListener("message", e => {
    if (e.source !== window || !e.data || e.data.__sift !== true) return;
    const d = e.data;
    if (d.type === "qid" && /^[A-Za-z0-9_-]{10,40}$/.test(d.qid) && !badQids.has(d.qid)) {
      if (d.qid !== qid || geoBroken) {
        qid = d.qid;
        geoBroken = false;
        chrome.storage.local.set({ siftQid: qid });
        chrome.storage.local.get("siftGeoStatus").then(({ siftGeoStatus }) =>
          chrome.storage.local.set({ siftGeoStatus: { ...(siftGeoStatus || {}), broken: false } }));
        pumpGeo();
      }
    } else if (d.type === "users" && Array.isArray(d.users)) {
      for (const u of d.users.slice(0, 500)) {
        const h = siftNormHandle(u?.h);
        if (!h) continue;
        if (u.b || u.about) geoSet(h, String(u.b || ""));
        else if (u.l) geoGuess(h, String(u.l));
      }
    }
  });

  /* ================= seen posts =================
     A post you've already looked at is never hidden afterwards, even if its
     author's location arrives later. Late answers only filter posts further
     down the feed that haven't been on screen yet. */

  const SEEN_AFTER_MS = 500;            // on screen this long = you've seen it
  const seenTimers = new WeakMap();
  const seenObserver = new IntersectionObserver(entries => {
    for (const en of entries) {
      const a = en.target;
      if (en.isIntersecting) {
        if (seenTimers.has(a)) continue;
        seenTimers.set(a, setTimeout(() => {
          seenTimers.delete(a);
          if (a.isConnected && nearViewport(a, 0)) {
            a.dataset.siftSeen = "1";
            seenObserver.unobserve(a);
          }
        }, SEEN_AFTER_MS));
      } else if (seenTimers.has(a)) {
        clearTimeout(seenTimers.get(a));
        seenTimers.delete(a);
      }
    }
  }, { threshold: 0.15 });

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
    const g = geoUsable(handle);
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

  // A matching rule, or null.
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
      if (c === undefined || !isAuthoritative(handle)) requestGeo(handle, true);
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

    if (!article.dataset.siftSeen) seenObserver.observe(article);
    const hit = evaluate(article, handle);
    if (hit) apply(article, hit, id !== "x" ? id : null);
  }

  // Re-run the rules for an author's posts once their location is known.
  // Posts already seen are never hidden late; they can only be un-hidden.
  function refreshHandle(handle) {
    if (!lastActive) return;
    document.querySelectorAll(`article[data-sift-h="${CSS.escape(handle)}"]`).forEach(a => {
      if (a.dataset.siftRevealed) return;
      const filtered = a.classList.contains("sift-hidden") || cellOf(a)?.classList.contains("sift-gone");
      if (a.dataset.siftSeen && !filtered) return;
      unapplyArticle(a);
      if (a.dataset.siftSeen) {
        // was filtered; only keep it hidden if a rule still matches
        a.dataset.sift = getStatusId(a) || "x";
        const hit = evaluate(a, handle);
        if (hit) apply(a, hit, null);
        return;
      }
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
    article.classList.remove("sift-hidden");
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
    el.dataset.k = g.k + "|" + g.s + "|" + S.flagStyle;
    const name = siftGeoLabel(g.k, g.n);
    const cont = siftContinentOf(g.k);
    const where = `${name}${cont && !g.k.startsWith("r:") ? ` · ${siftContinentName(cont)}` : ""}`;
    if (g.s === "p") {
      el.classList.add("sift-loc-guess");
      el.title = `${where} — from their profile location “${g.r || name}”. X's “Account based in” hasn't loaded yet.`;
    } else {
      el.title = `Account based in ${where}`;
    }
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
      if ((!g || g.s === "p") && nearViewport(un)) requestGeo(handle);
      if (!g) return;
      if (!g.k) { label?.remove(); return; }
      if (label && label.dataset.h === handle && label.dataset.k === g.k + "|" + g.s + "|" + S.flagStyle && label.parentElement === row) return;
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
    // keep anything learned while storage was loading
    const early = geo;
    geo = st.siftGeo || {};
    for (const [h, e] of Object.entries(early)) {
      if (!geo[h] || geo[h].s === "p" || e.s !== "p") geo[h] = e;
    }
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

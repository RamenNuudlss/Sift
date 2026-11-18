(async () => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  let S = await siftLoad();
  const fmt = new Intl.NumberFormat();

  const save = () => siftSave(S);

  /* ---------- header + stats ---------- */

  function renderStatus() {
    $("#enabled").checked = S.enabled;
    document.body.classList.toggle("off", !S.enabled);
    $("#statusText").textContent = !S.enabled ? "Paused" : S.fypOnly ? "Filtering For You" : "Filtering all of X";
  }

  async function renderStats() {
    const s = await siftLoadStats();
    $("#sToday").textContent = fmt.format(s.today);
    $("#sTotal").textContent = fmt.format(s.total);
    $("#sBlocked").textContent = fmt.format(s.blocked);
  }

  $("#enabled").addEventListener("change", e => {
    S.enabled = e.target.checked;
    renderStatus();
    save();
  });

  /* ---------- tabs ---------- */

  const ink = $(".ink");
  function moveInk(tab) {
    ink.style.width = `${tab.offsetWidth}px`;
    ink.style.transform = `translateX(${tab.offsetLeft}px)`;
  }
  function selectTab(name) {
    $$(".tab").forEach(t => {
      const on = t.dataset.tab === name;
      t.setAttribute("aria-selected", on);
      if (on) moveInk(t);
    });
    $$(".panel").forEach(p => (p.hidden = p.id !== `panel-${name}`));
    try { localStorage.setItem("sift-tab", name); } catch {}
  }
  $$(".tab").forEach(t => t.addEventListener("click", () => selectTab(t.dataset.tab)));

  /* ---------- pickers ---------- */

  function pickValue(which) {
    return $(`.pick[data-for="${which}"] [aria-pressed="true"]`).dataset.v;
  }
  $$(".pick").forEach(p =>
    p.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      $$("button", p).forEach(x => x.setAttribute("aria-pressed", x === b));
    })
  );

  /* ---------- list rendering ---------- */

  const icons = {
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };
  const labels = { hide: "Hide", block: "Block", allow: "Allow", show: "Show" };
  const cycleWords = { hide: "block", block: "hide" };
  const cycleUsers = { hide: "block", block: "allow", allow: "hide" };

  function rowEl(termNode, action, onCycle, onRemove) {
    const li = document.createElement("li");
    li.append(termNode);

    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = `badge ${action}`;
    badge.textContent = labels[action];
    badge.title = "Click to change";
    badge.addEventListener("click", onCycle);

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "remove";
    rm.setAttribute("aria-label", "Remove");
    rm.innerHTML = icons.x;
    rm.addEventListener("click", onRemove);

    li.append(badge, rm);
    return li;
  }

  function renderWords() {
    const list = $("#wordList");
    list.replaceChildren();
    S.keywords.forEach((r, i) => {
      const term = document.createElement("span");
      term.className = "term";
      if (/^\/.+\/[a-z]*$/i.test(r.text)) term.classList.add("regex");
      term.textContent = r.text;
      term.title = r.text;
      list.append(
        rowEl(term, r.action,
          () => { r.action = cycleWords[r.action] || "hide"; save(); renderWords(); },
          () => { S.keywords.splice(i, 1); save(); renderWords(); })
      );
    });
    $("#wordEmpty").hidden = S.keywords.length > 0;
    $("#cWords").textContent = S.keywords.length || "";
  }

  function renderUsers() {
    const list = $("#userList");
    list.replaceChildren();
    S.users.forEach((u, i) => {
      const term = document.createElement("span");
      term.className = "term";
      const at = document.createElement("span");
      at.className = "at";
      at.textContent = "@";
      term.append(at, u.handle);
      list.append(
        rowEl(term, u.action,
          () => { u.action = cycleUsers[u.action] || "hide"; save(); renderUsers(); },
          () => { S.users.splice(i, 1); save(); renderUsers(); })
      );
    });
    $("#userEmpty").hidden = S.users.length > 0;
    $("#cAccounts").textContent = S.users.length || "";
  }

  function showError(id, msg) {
    const el = $(id);
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  /* ---------- add forms ---------- */

  $("#wordForm").addEventListener("submit", e => {
    e.preventDefault();
    const input = $("#wordInput");
    const text = input.value.trim();
    if (!text) return;
    const m = text.match(/^\/(.+)\/([a-z]*)$/i);
    if (m) {
      try { new RegExp(m[1], m[2]); }
      catch { return showError("#wordError", "That regex isn’t valid."); }
    }
    if (S.keywords.some(k => k.text.toLowerCase() === text.toLowerCase())) {
      return showError("#wordError", "You already have that rule.");
    }
    showError("#wordError");
    S.keywords.unshift({ text, action: pickValue("word") });
    input.value = "";
    save();
    renderWords();
  });

  $("#userForm").addEventListener("submit", e => {
    e.preventDefault();
    const input = $("#userInput");
    const handle = siftNormHandle(input.value);
    if (!handle) return;
    if (!/^[a-z0-9_]{1,15}$/.test(handle) || SIFT_RESERVED.has(handle)) {
      return showError("#userError", "That doesn’t look like an X handle.");
    }
    showError("#userError");
    const action = pickValue("user");
    const existing = S.users.find(u => u.handle === handle);
    if (existing) existing.action = action;
    else S.users.unshift({ handle, action });
    input.value = "";
    save();
    renderUsers();
  });

  $("#wordInput").addEventListener("input", () => showError("#wordError"));
  $("#userInput").addEventListener("input", () => showError("#userError"));


  /* ---------- countries ---------- */

  const GLOBE = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.5 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.5-3.6-8.5s1.1-5.9 3.6-8.5z"/></svg>';
  const geoTable = siftGeoTable();
  let geoCache = {};
  let geoStatusInfo = null;

  function flagEl(key) {
    const s = document.createElement("span");
    s.className = "flag";
    if (/^[A-Z]{2}$/.test(key)) s.textContent = siftFlag(key);
    else { s.classList.add("region"); s.innerHTML = GLOBE; }
    return s;
  }

  function seenCounts() {
    const counts = new Map();
    const now = Date.now();
    for (const e of Object.values(geoCache)) {
      if (!e.k || now - e.t > SIFT_GEO_TTL) continue;
      const c = counts.get(e.k) || { key: e.k, name: siftGeoLabel(e.k, e.n), n: 0 };
      c.n++;
      counts.set(e.k, c);
    }
    return [...counts.values()].sort((a, b) => b.n - a.n);
  }

  function addCountry(key, name) {
    if (S.countries.some(c => c.key === key)) return;
    S.countries.unshift({ key, name, action: S.countryMode === "only" ? "hide" : pickValue("country") });
    save();
    renderCountries();
  }

  function renderCountries() {
    document.body.classList.toggle("only", S.countryMode === "only");
    $$("#countryModeSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === S.countryMode));

    const list = $("#countryList");
    list.replaceChildren();
    S.countries.forEach((c, i) => {
      const term = document.createElement("span");
      term.className = "term";
      term.textContent = siftGeoLabel(c.key, c.name);
      const li = rowEl(term, S.countryMode === "only" ? "show" : c.action,
        () => { if (S.countryMode === "only") return; c.action = cycleWords[c.action] || "hide"; save(); renderCountries(); },
        () => { S.countries.splice(i, 1); save(); renderCountries(); });
      li.prepend(flagEl(c.key));
      list.append(li);
    });
    $("#countryEmpty").hidden = S.countries.length > 0;
    $("#countryEmptySub").textContent = S.countryMode === "only"
      ? "Only posts from accounts based in the countries you add here will show. Everything else is filtered."
      : "Posts from accounts X lists as based in a country you add here are filtered out of your feed.";
    $("#cCountries").textContent = S.countries.length || "";

    const seen = seenCounts().slice(0, 14);
    $("#seenWrap").hidden = seen.length === 0;
    const chips = $("#seenChips");
    chips.replaceChildren();
    for (const s of seen) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      const on = S.countries.some(c => c.key === s.key);
      if (on) b.classList.add("on");
      b.title = on ? "Already added" : `Add ${s.name}`;
      const name = document.createElement("span");
      name.textContent = s.name;
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = fmt.format(s.n);
      b.append(flagEl(s.key), name, n);
      b.addEventListener("click", () => addCountry(s.key, s.name));
      chips.append(b);
    }
    renderGeoStatus();
  }

  function renderGeoStatus() {
    const el = $("#geoStatus");
    const total = Object.keys(geoCache).length;
    const parts = [];
    if (total) parts.push(`${fmt.format(total)} account${total === 1 ? "" : "s"} located`);
    const st = geoStatusInfo;
    let warn = "";
    if (st?.broken) warn = "X changed its location lookup. Open “About this account” on any profile once and Sift will pick up the new one.";
    else if (st && st.pausedUntil > Date.now()) {
      const t = new Date(st.pausedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      warn = `X rate limit reached — lookups resume at ${t}. Cached accounts still filter.`;
    }
    el.replaceChildren();
    if (parts.length) el.append(parts.join(" · "));
    if (warn) {
      if (parts.length) el.append(document.createElement("br"));
      const w = document.createElement("span");
      w.className = "warn";
      w.textContent = warn;
      el.append(w);
    }
  }

  // search combobox
  const cInput = $("#countryInput");
  const cResults = $("#countryResults");
  let cMatches = [];
  let cActive = 0;

  function regionOptions() {
    return seenCounts().filter(s => s.key.startsWith("r:")).map(s => ({ key: s.key, name: s.name }));
  }

  function searchCountries(q) {
    const n = siftGeoNorm(q);
    if (!n) return [];
    const all = [...geoTable.list.map(c => ({ key: c.code, name: c.name })), ...regionOptions()];
    const aliasHits = [...geoTable.byName.entries()].filter(([k]) => k.startsWith(n)).map(([, code]) => code);
    const scored = [];
    for (const c of all) {
      const nn = siftGeoNorm(c.name);
      let score = -1;
      if (nn === n || c.key.toLowerCase() === n) score = 0;
      else if (nn.startsWith(n)) score = 1;
      else if (aliasHits.includes(c.key)) score = 2;
      else if (nn.includes(" " + n)) score = 3;
      else if (nn.includes(n)) score = 4;
      if (score >= 0) scored.push([score, c]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
    const seenKeys = new Set();
    return scored.map(s => s[1]).filter(c => !seenKeys.has(c.key) && seenKeys.add(c.key)).slice(0, 8);
  }

  function renderResults() {
    const q = cInput.value.trim();
    cMatches = searchCountries(q);
    cResults.replaceChildren();
    const open = q.length > 0;
    cResults.hidden = !open;
    cInput.setAttribute("aria-expanded", open);
    if (!open) return;
    if (!cMatches.length) {
      const li = document.createElement("li");
      li.className = "r-empty";
      li.textContent = "No matches";
      cResults.append(li);
      return;
    }
    cActive = Math.min(cActive, cMatches.length - 1);
    cMatches.forEach((c, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === cActive);
      const name = document.createElement("span");
      name.className = "r-name";
      name.textContent = c.name;
      li.append(flagEl(c.key), name);
      if (S.countries.some(x => x.key === c.key)) {
        const note = document.createElement("span");
        note.className = "r-note";
        note.textContent = "Added";
        li.append(note);
      }
      li.addEventListener("mousedown", e => { e.preventDefault(); choose(i); });
      li.addEventListener("mousemove", () => { if (cActive !== i) { cActive = i; renderResults(); } });
      cResults.append(li);
    });
  }

  function choose(i) {
    const c = cMatches[i];
    if (!c) return;
    addCountry(c.key, c.name);
    cInput.value = "";
    cActive = 0;
    renderResults();
  }

  cInput.addEventListener("input", () => { cActive = 0; renderResults(); });
  cInput.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); cActive = Math.min(cActive + 1, cMatches.length - 1); renderResults(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cActive = Math.max(cActive - 1, 0); renderResults(); }
    else if (e.key === "Escape") { cInput.value = ""; renderResults(); }
  });
  cInput.addEventListener("blur", () => setTimeout(() => { cResults.hidden = true; }, 100));
  cInput.addEventListener("focus", renderResults);
  $("#countryForm").addEventListener("submit", e => { e.preventDefault(); choose(cActive); });

  $("#countryModeSeg").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    S.countryMode = b.dataset.v;
    save();
    renderCountries();
  });

  async function loadGeo() {
    const st = await chrome.storage.local.get(["siftGeo", "siftGeoStatus"]);
    geoCache = st.siftGeo || {};
    geoStatusInfo = st.siftGeoStatus || null;
    renderCountries();
  }

  /* ---------- options ---------- */

  function renderOptions() {
    $$("[data-opt]").forEach(el => (el.checked = !!S[el.dataset.opt]));
    $$("#modeSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === S.mode));
  }

  $$("[data-opt]").forEach(el =>
    el.addEventListener("change", () => {
      S[el.dataset.opt] = el.checked;
      save();
      renderStatus();
    })
  );

  $("#modeSeg").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    S.mode = b.dataset.v;
    save();
    renderOptions();
    renderCountries();
  });

  /* ---------- import / export ---------- */

  $("#exportBtn").addEventListener("click", () => {
    const data = JSON.stringify({ app: "sift", version: 2, keywords: S.keywords, users: S.users, countries: S.countries, countryMode: S.countryMode }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `sift-rules-${siftToday()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const kw = Array.isArray(data.keywords) ? data.keywords : [];
      const us = Array.isArray(data.users) ? data.users : [];
      for (const k of kw) {
        if (typeof k?.text !== "string") continue;
        if (!S.keywords.some(x => x.text.toLowerCase() === k.text.toLowerCase())) {
          S.keywords.push({ text: k.text, action: k.action === "block" ? "block" : "hide" });
        }
      }
      for (const u of us) {
        const handle = siftNormHandle(u?.handle);
        if (!handle) continue;
        const action = ["hide", "block", "allow"].includes(u.action) ? u.action : "hide";
        const ex = S.users.find(x => x.handle === handle);
        if (ex) ex.action = action; else S.users.push({ handle, action });
      }
      for (const c of Array.isArray(data.countries) ? data.countries : []) {
        if (typeof c?.key !== "string" || !/^([A-Z]{2}|r:[a-z0-9 ]+)$/.test(c.key)) continue;
        if (!S.countries.some(x => x.key === c.key)) {
          S.countries.push({ key: c.key, name: String(c.name || ""), action: c.action === "block" ? "block" : "hide" });
        }
      }
      if (data.countryMode === "only" || data.countryMode === "hide") S.countryMode = data.countryMode;
      await save();
      renderAll();
    } catch {
      alert("Couldn’t read that file.");
    }
    e.target.value = "";
  });

  $("#clearGeo").addEventListener("click", async () => {
    await chrome.storage.local.remove(["siftGeo", "siftGeoStatus"]);
    geoCache = {};
    geoStatusInfo = null;
    renderCountries();
  });

  $("#resetStats").addEventListener("click", async () => {
    await chrome.storage.local.set({ siftStats: { ...SIFT_STATS_DEFAULTS, day: siftToday() } });
    renderStats();
  });

  /* ---------- live updates ---------- */

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.siftStats) renderStats();
    if (changes.siftGeo) { geoCache = changes.siftGeo.newValue || {}; renderCountries(); }
    if (changes.siftGeoStatus) { geoStatusInfo = changes.siftGeoStatus.newValue; renderGeoStatus(); }
    if (changes.sift && JSON.stringify(changes.sift.newValue) !== JSON.stringify(S)) {
      S = { ...SIFT_DEFAULTS, ...changes.sift.newValue };
      renderAll();
    }
  });

  function renderAll() {
    renderStatus();
    renderWords();
    renderUsers();
    renderOptions();
    renderCountries();
  }

  renderAll();
  renderStats();
  loadGeo();
  let startTab = "countries";
  try { startTab = localStorage.getItem("sift-tab") || "countries"; } catch {}
  requestAnimationFrame(() => selectTab(startTab));
})();

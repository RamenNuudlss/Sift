importScripts("shared.js");

const MENU_HIDE = "sift-hide-account";
const MENU_ALLOW = "sift-allow-account";

chrome.runtime.onInstalled.addListener(async () => {
  const { sift } = await chrome.storage.local.get("sift");
  if (!sift) await siftSave({ ...SIFT_DEFAULTS }); // first install only

  chrome.contextMenus.removeAll(() => {
    const common = {
      contexts: ["link"],
      documentUrlPatterns: ["https://x.com/*", "https://twitter.com/*"],
      targetUrlPatterns: ["https://x.com/*", "https://twitter.com/*"]
    };
    chrome.contextMenus.create({ id: MENU_HIDE, title: "Sift: hide this account", ...common });
    chrome.contextMenus.create({ id: MENU_ALLOW, title: "Sift: always show this account", ...common });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_HIDE && info.menuItemId !== MENU_ALLOW) return;
  let handle;
  try {
    const url = new URL(info.linkUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return; // only plain profile links
    handle = siftNormHandle(parts[0]);
  } catch { return; }
  if (!handle || SIFT_RESERVED.has(handle)) return;

  const s = await siftLoad();
  const action = info.menuItemId === MENU_HIDE ? "hide" : "allow";
  const existing = s.users.find(u => u.handle === handle);
  if (existing) existing.action = action;
  else s.users.unshift({ handle, action });
  await siftSave(s);
});

/* ---------- shared location-lookup budget ----------
   X allows about 50 "About this account" lookups per account every 15
   minutes. Every X tab asks here before making one, so tabs can't burn the
   budget in parallel. The first half of a window goes out quickly (so the
   first screen fills in); the rest is spread across the remaining time. */

const BUDGET_RESERVE = 6;          // left for X's own "About this account" panel
const BUDGET_FAST_GAP = 1200;
const BUDGET_DEFAULT_LIMIT = 50;
const BUDGET_WINDOW = 15 * 60 * 1000;

async function budgetState() {
  const { siftBudget } = await chrome.storage.session.get("siftBudget");
  const now = Date.now();
  const b = siftBudget || {};
  if (!b.reset || b.reset <= now) {
    // new window: assume a full budget until X tells us otherwise
    return { limit: b.limit || BUDGET_DEFAULT_LIMIT, remaining: b.limit || BUDGET_DEFAULT_LIMIT, reset: 0, nextAt: 0, pausedUntil: 0 };
  }
  return { limit: BUDGET_DEFAULT_LIMIT, remaining: BUDGET_DEFAULT_LIMIT, nextAt: 0, pausedUntil: 0, ...b };
}

async function budgetSave(b) {
  await chrome.storage.session.set({ siftBudget: b });
  await chrome.storage.local.set({
    siftGeoStatus: { remaining: b.remaining, limit: b.limit, reset: b.reset, pausedUntil: b.pausedUntil, at: Date.now() }
  });
}

function budgetGap(b, now) {
  const left = b.remaining - BUDGET_RESERVE;
  if (left <= 0) return (b.reset || now + BUDGET_WINDOW) - now + 1000;
  if (b.remaining > b.limit / 2) return BUDGET_FAST_GAP;
  const windowLeft = (b.reset || now + BUDGET_WINDOW) - now;
  return Math.max(BUDGET_FAST_GAP, windowLeft / left);
}

let budgetLock = Promise.resolve();
function withBudget(fn) {
  const run = budgetLock.then(fn, fn);
  budgetLock = run.catch(() => {});
  return run;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "geo-slot") {
    withBudget(async () => {
      const b = await budgetState();
      const now = Date.now();
      if (now < b.pausedUntil) return { wait: b.pausedUntil - now };
      if (b.remaining - BUDGET_RESERVE <= 0) return { wait: Math.max(5000, (b.reset || now + 60000) - now) };
      if (now < b.nextAt) return { wait: b.nextAt - now };
      b.remaining -= 1;                       // optimistic; corrected by the report
      if (!b.reset) b.reset = now + BUDGET_WINDOW;
      b.nextAt = now + budgetGap(b, now);
      await budgetSave(b);
      return { ok: true };
    }).then(reply);
    return true;
  }
  if (msg?.type === "geo-report") {
    withBudget(async () => {
      const b = await budgetState();
      const now = Date.now();
      if (Number.isFinite(msg.limit) && msg.limit > 0) b.limit = msg.limit;
      if (Number.isFinite(msg.remaining)) b.remaining = msg.remaining;
      if (Number.isFinite(msg.reset) && msg.reset > now) b.reset = msg.reset;
      if (msg.status === 429) b.pausedUntil = b.reset > now ? b.reset : now + 5 * 60 * 1000;
      b.nextAt = Math.max(b.nextAt, now + budgetGap(b, now));
      await budgetSave(b);
      return { ok: true };
    }).then(reply);
    return true;
  }
});

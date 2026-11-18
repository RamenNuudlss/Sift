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

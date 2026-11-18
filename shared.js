// Shared defaults + storage helpers (loaded by content script, popup and background).
const SIFT_DEFAULTS = {
  enabled: true,
  fypOnly: true,
  mode: "collapse",          // "collapse" | "remove"
  hidePromoted: true,
  hideWhoToFollow: true,
  hideVerified: false,
  hideReposts: false,
  autoBlock: false,
  keywords: [],              // [{ text, action: "hide" | "block" }]
  users: [],                 // [{ handle, action: "hide" | "block" | "allow" }]
  countries: [],             // [{ key: "JP" | "r:europe", name, action: "hide" | "block" }]
  countryMode: "hide",       // "hide" = hide selected, "only" = only show selected
  showFlags: true,           // location label next to every author name
  flagStyle: "full",        // "full" = flag + country, "flag" = flag only
  useProfileLocation: true,  // fall back to profile location text until X's answer is known
  hideUnknownCountry: false
};

const SIFT_DEFAULT_QID = "XRqGa7EeokUU5kppkh13EA";
const SIFT_GEO_TTL = 30 * 24 * 3600 * 1000;
const SIFT_GEO_NONE_TTL = 24 * 3600 * 1000;

const SIFT_STATS_DEFAULTS = {
  day: "",
  today: 0,
  total: 0,
  blocked: 0,
  reasons: {}
};

const SIFT_RESERVED = new Set([
  "home", "explore", "notifications", "messages", "i", "settings", "search",
  "compose", "hashtag", "login", "logout", "signup", "tos", "privacy",
  "jobs", "lists", "communities", "premium_sign_up", "verified-choose"
]);

function siftToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function siftNormHandle(h) {
  return String(h || "").trim().replace(/^@+/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[/?#\s]/)[0].toLowerCase();
}

async function siftLoad() {
  const { sift } = await chrome.storage.local.get("sift");
  return { ...SIFT_DEFAULTS, ...(sift || {}) };
}

async function siftSave(settings) {
  await chrome.storage.local.set({ sift: settings });
}

async function siftLoadStats() {
  const { siftStats } = await chrome.storage.local.get("siftStats");
  const s = { ...SIFT_STATS_DEFAULTS, ...(siftStats || {}) };
  if (s.day !== siftToday()) { s.day = siftToday(); s.today = 0; }
  return s;
}

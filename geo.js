// Country helpers shared by the content script and popup.
// Rules are keyed by ISO-3166 alpha-2 code ("JP") or, for regions X reports
// without a single country ("Europe", "South Asia"), by "r:<lowercased name>".

const SIFT_GEO_EXCLUDE = new Set([
  "AA", "AC", "CP", "DG", "EA", "EU", "EZ", "IC", "TA", "UN", "ZZ",
  // withdrawn codes still known to Intl
  "AN", "BU", "CS", "DD", "DY", "FX", "HV", "NH", "NT", "RH", "SU", "TP", "UK", "VD", "YD", "YU", "ZR"
]);

const SIFT_GEO_ALIASES = {
  "usa": "US", "us": "US", "united states of america": "US", "america": "US",
  "uk": "GB", "great britain": "GB", "britain": "GB", "england": "GB", "scotland": "GB", "wales": "GB", "northern ireland": "GB",
  "turkey": "TR", "turkiye": "TR",
  "korea": "KR", "republic of korea": "KR", "korea republic of": "KR", "north korea": "KP",
  "russia": "RU", "russian federation": "RU",
  "czech republic": "CZ", "czechia": "CZ",
  "uae": "AE", "united arab emirates": "AE",
  "vietnam": "VN", "viet nam": "VN",
  "ivory coast": "CI", "cote d ivoire": "CI",
  "hong kong": "HK", "hong kong sar china": "HK", "macau": "MO", "macao": "MO", "macao sar china": "MO",
  "taiwan": "TW", "palestine": "PS", "palestinian territories": "PS",
  "netherlands": "NL", "holland": "NL",
  "myanmar": "MM", "burma": "MM", "myanmar burma": "MM",
  "dr congo": "CD", "drc": "CD", "democratic republic of the congo": "CD", "congo kinshasa": "CD",
  "republic of the congo": "CG", "congo brazzaville": "CG", "congo": "CG",
  "eswatini": "SZ", "swaziland": "SZ",
  "north macedonia": "MK", "macedonia": "MK",
  "cape verde": "CV", "cabo verde": "CV",
  "iran": "IR", "syria": "SY", "laos": "LA", "moldova": "MD", "bolivia": "BO", "venezuela": "VE", "tanzania": "TZ",
  "brunei": "BN", "vatican": "VA", "vatican city": "VA", "micronesia": "FM",
  "st kitts and nevis": "KN", "saint kitts and nevis": "KN", "st lucia": "LC", "saint lucia": "LC",
  "st vincent and grenadines": "VC", "saint vincent and the grenadines": "VC",
  "timor leste": "TL", "east timor": "TL", "kosovo": "XK"
};

function siftGeoNorm(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the /, "")
    .trim();
}

let _siftGeoTable = null;

// [{ code, name }] for every real country/territory, plus a name -> code lookup.
function siftGeoTable() {
  if (_siftGeoTable) return _siftGeoTable;
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  const list = [];
  const byName = new Map();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (SIFT_GEO_EXCLUDE.has(code)) continue;
      if (code[0] === "Q" && code[1] >= "M") continue;
      if (code[0] === "X" && code !== "XK") continue;
      let name;
      try { name = dn.of(code); } catch { continue; }
      if (!name || name === code) continue;
      if (byName.has(siftGeoNorm(name))) continue; // any other legacy duplicate
      list.push({ code, name });
      byName.set(siftGeoNorm(name), code);
    }
  }
  for (const [alias, code] of Object.entries(SIFT_GEO_ALIASES)) byName.set(siftGeoNorm(alias), code);
  list.sort((x, y) => x.name.localeCompare(y.name));
  _siftGeoTable = { list, byName, names: new Map(list.map(c => [c.code, c.name])) };
  return _siftGeoTable;
}

function siftFlag(code) {
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function siftCodeFromFlag(text) {
  const cps = [...String(text).trim()].map(c => c.codePointAt(0));
  if (cps.length === 2 && cps.every(c => c >= 0x1f1e6 && c <= 0x1f1ff)) {
    return cps.map(c => String.fromCharCode(c - 0x1f1e6 + 65)).join("");
  }
  return null;
}

// Turn X's account_based_in text into { key, name, code }.
function siftGeoResolve(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const t = siftGeoTable();
  const fromFlag = siftCodeFromFlag(raw);
  const code = fromFlag || t.byName.get(siftGeoNorm(raw)) || null;
  if (code) return { key: code, name: t.names.get(code) || raw, code };
  return { key: "r:" + siftGeoNorm(raw), name: raw, code: null };
}

function siftGeoLabel(key, name) {
  if (/^[A-Z]{2}$/.test(key)) return siftGeoTable().names.get(key) || name || key;
  return name || key.slice(2);
}

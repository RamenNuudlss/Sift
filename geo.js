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

const SIFT_CONTINENTS = [
  ["AF", "Africa"], ["AS", "Asia"], ["EU", "Europe"],
  ["NA", "North America"], ["SA", "South America"], ["OC", "Oceania"]
];

// Transcontinental countries use their most common assignment
// (Russia → Europe, Türkiye → Asia, Egypt → Africa, Cyprus → Europe).
const SIFT_CONTINENT_CODES = {
  AF: "DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW",
  AS: "AF AM AZ BH BD BT BN KH CN GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TL TR TM AE UZ VN YE CC CX IO",
  EU: "AL AD AT BY BE BA BG HR CY CZ DK EE FO FI FR DE GI GR GG HU IS IE IM IT JE XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SJ SE CH UA GB VA AX CQ",
  NA: "AI AG AW BS BB BZ BM BQ VG CA KY CR CU CW DM DO SV GL GD GP GT HT HN JM MQ MX MS NI PA PR BL KN LC MF PM VC SX TT TC US VI UM",
  SA: "AR BO BR CL CO EC FK GF GY PY PE SR UY VE GS",
  OC: "AS AU CK FJ PF GU KI MH FM NR NC NZ NU NF MP PW PG PN WS SB TK TO TV VU WF"
};

const _siftContinentOf = new Map();
for (const [cont, codes] of Object.entries(SIFT_CONTINENT_CODES)) {
  for (const c of codes.split(" ")) _siftContinentOf.set(c, cont);
}

// Continent for a rule key ("JP" or "r:west asia"), or null.
function siftContinentOf(key) {
  if (!key) return null;
  if (/^[A-Z]{2}$/.test(key)) return _siftContinentOf.get(key) || null;
  if (!key.startsWith("r:")) return null;
  const r = key.slice(2);
  if (/latin america/.test(r)) return null; // spans two continents
  if (/south america/.test(r)) return "SA";
  if (/north america|central america|caribbean/.test(r)) return "NA";
  if (/africa/.test(r)) return "AF";
  if (/europe/.test(r)) return "EU";
  if (/asia|middle east/.test(r)) return "AS";
  if (/oceania|pacific|australia/.test(r)) return "OC";
  return null;
}

function siftContinentName(code) {
  const c = SIFT_CONTINENTS.find(x => x[0] === code);
  return c ? c[1] : code;
}

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
  if (key.startsWith("c:")) return siftContinentName(key.slice(2));
  return name || key.slice(2);
}

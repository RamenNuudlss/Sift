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

/* ---------- profile-location fallback ----------
   X allows ~50 "Account based in" lookups per 15 minutes, so until X's own
   answer is known Sift falls back to the free-text location people put in
   their profile ("Austin, TX", "London 🇬🇧", "Lagos"). Only clear matches
   count; anything ambiguous returns null. */

const SIFT_US_STATES = "alabama,alaska,arizona,arkansas,california,colorado,connecticut,delaware,florida,georgia,hawaii,idaho,illinois,indiana,iowa,kansas,kentucky,louisiana,maine,maryland,massachusetts,michigan,minnesota,mississippi,missouri,montana,nebraska,nevada,new hampshire,new jersey,new mexico,new york,north carolina,north dakota,ohio,oklahoma,oregon,pennsylvania,rhode island,south carolina,south dakota,tennessee,texas,utah,vermont,virginia,washington,west virginia,wisconsin,wyoming,washington dc,district of columbia";
const SIFT_US_ABBR = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));
const SIFT_CA_ABBR = new Set("BC AB SK MB ON QC NS NB NL PE PEI YT NT NU".split(" "));
const SIFT_CA_PROV = "ontario,quebec,british columbia,alberta,manitoba,saskatchewan,nova scotia,new brunswick,newfoundland,prince edward island";
const SIFT_AU_STATES = "new south wales,nsw,queensland,qld,tasmania,western australia,south australia";
const SIFT_NATIVE_NAMES = "deutschland:DE,españa:ES,espana:ES,italia:IT,brasil:BR,méxico:MX,österreich:AT,schweiz:CH,suisse:CH,polska:PL,nederland:NL,belgique:BE,sverige:SE,norge:NO,danmark:DK,suomi:FI,éire:IE,ελλάδα:GR,россия:RU,україна:UA,日本:JP,中国:CN,한국:KR,대한민국:KR,भारत:IN,مصر:EG,السعودية:SA,türkiye:TR,turkiye:TR,perú:PE,argentina:AR,colombia:CO,nigeria:NG,naija:NG,philippines:PH,pilipinas:PH";

// Large cities people commonly put as their location.
const SIFT_CITIES = "new york:US nyc:US los angeles:US la:US chicago:US houston:US phoenix:US philadelphia:US san antonio:US san diego:US dallas:US austin:US san francisco:US sf:US seattle:US denver:US boston:US atlanta:US miami:US detroit:US nashville:US portland:US las vegas:US orlando:US brooklyn:US manhattan:US washington dc:US dc:US " +
  "toronto:CA montreal:CA vancouver:CA calgary:CA ottawa:CA edmonton:CA " +
  "london:GB manchester:GB birmingham:GB liverpool:GB glasgow:GB edinburgh:GB leeds:GB bristol:GB cardiff:GB belfast:GB " +
  "dublin:IE paris:FR marseille:FR lyon:FR berlin:DE munich:DE hamburg:DE frankfurt:DE cologne:DE amsterdam:NL rotterdam:NL brussels:BE madrid:ES barcelona:ES valencia:ES seville:ES lisbon:PT porto:PT rome:IT milan:IT naples:IT turin:IT vienna:AT zurich:CH geneva:CH stockholm:SE oslo:NO copenhagen:DK helsinki:FI warsaw:PL krakow:PL prague:CZ budapest:HU bucharest:RO athens:GR kyiv:UA kiev:UA moscow:RU st petersburg:RU saint petersburg:RU istanbul:TR ankara:TR " +
  "tokyo:JP osaka:JP kyoto:JP seoul:KR busan:KR beijing:CN shanghai:CN shenzhen:CN guangzhou:CN hong kong:HK taipei:TW singapore:SG manila:PH jakarta:ID bangkok:TH kuala lumpur:MY hanoi:VN ho chi minh city:VN saigon:VN " +
  "mumbai:IN bombay:IN delhi:IN new delhi:IN bangalore:IN bengaluru:IN hyderabad:IN chennai:IN kolkata:IN pune:IN ahmedabad:IN karachi:PK lahore:PK islamabad:PK dhaka:BD kathmandu:NP colombo:LK " +
  "dubai:AE abu dhabi:AE riyadh:SA jeddah:SA doha:QA kuwait city:KW tehran:IR baghdad:IQ tel aviv:IL jerusalem:IL beirut:LB amman:JO cairo:EG " +
  "lagos:NG abuja:NG accra:GH nairobi:KE johannesburg:ZA cape town:ZA durban:ZA addis ababa:ET casablanca:MA tunis:TN algiers:DZ kampala:UG dar es salaam:TZ " +
  "mexico city:MX cdmx:MX guadalajara:MX monterrey:MX sao paulo:BR são paulo:BR rio de janeiro:BR brasilia:BR buenos aires:AR santiago:CL lima:PE bogota:CO bogotá:CO medellin:CO caracas:VE quito:EC montevideo:UY " +
  "sydney:AU melbourne:AU brisbane:AU perth:AU adelaide:AU auckland:NZ wellington:NZ";

let _siftPlaces = null;
function siftPlaces() {
  if (_siftPlaces) return _siftPlaces;
  const m = new Map();
  const add = (list, code) => list.split(",").forEach(n => m.set(siftGeoNorm(n), code));
  add(SIFT_US_STATES, "US");
  add(SIFT_CA_PROV, "CA");
  add(SIFT_AU_STATES, "AU");
  for (const pair of SIFT_NATIVE_NAMES.split(",")) {
    const [name, code] = pair.split(":");
    m.set(siftGeoNorm(name) || name.toLowerCase(), code);
  }
  for (const pair of SIFT_CITIES.match(/[^:]+:[A-Z]{2}/g)) {
    const [name, code] = pair.trim().split(":");
    m.set(siftGeoNorm(name), code);
  }
  m.delete("georgia"); // US state or country: decided below
  _siftPlaces = m;
  return m;
}

// Best-effort country for a free-text profile location, or null.
function siftGuessCountry(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 80) return null;
  const found = new Set();

  // flag emoji anywhere
  const flags = raw.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) || [];
  for (const f of flags) { const c = siftCodeFromFlag(f); if (c) found.add(c); }

  const t = siftGeoTable();
  const places = siftPlaces();
  const pieces = raw.split(/[,/|·•\-–—()\n]+|\s+(?:and|&|x)\s+/i).map(s => s.trim()).filter(Boolean);
  let georgia = false;
  for (const piece of pieces) {
    if (/^[A-Z]{2,3}$/.test(piece) && pieces.length > 1) {
      if (SIFT_US_ABBR.has(piece)) { found.add("US"); continue; }
      if (SIFT_CA_ABBR.has(piece)) { found.add("CA"); continue; }
    }
    const clean = piece.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "").trim();
    const n = siftGeoNorm(clean) || clean.toLowerCase();
    if (!n) continue;
    if (n === "georgia") { georgia = true; continue; }
    const code = places.get(n) || t.byName.get(n);
    if (code) found.add(code);
  }
  // "Atlanta, Georgia" is the US state; "Georgia" or "Tbilisi, Georgia" is the country
  if (georgia) found.add(found.has("US") ? "US" : "GE");
  if (!found.size) {
    // whole string, e.g. "new york city"
    const n = siftGeoNorm(raw.replace(/\bcity\b/gi, ""));
    const code = t.byName.get(n) || places.get(n);
    if (code) found.add(code);
  }
  return found.size === 1 ? [...found][0] : null;
}

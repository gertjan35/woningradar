// Kernlogica van WoningRadar: straten in de buurt vinden (PDOK),
// zoekresultaten uitlezen (adres + prijs) en filteren op afstand.
// Werkt zowel in de browser als in Node (voor de tests).

const PDOK = "https://api.pdok.nl/bzk/locatieserver/search/v3_1";

/** Afstand in meters tussen twee coördinaten. */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** "POINT(6.60 53.29)" -> {lat, lon} */
export function parsePoint(wkt) {
  const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(wkt || "");
  return m ? { lon: parseFloat(m[1]), lat: parseFloat(m[2]) } : null;
}

/**
 * Alle adressen binnen `radius` meter van de positie (max. 50 per keer).
 * Geeft {current, streets, addresses} terug:
 *  - current: straat/plaats van het dichtstbijzijnde adres
 *  - streets: unieke [{straat, plaats}] binnen de straal
 *  - addresses: [{straat, nummer, plaats, afstand}]
 */
export async function nearbyAddresses(lat, lon, radius, fetchFn = fetch) {
  const fl = encodeURIComponent("straatnaam huisnummer woonplaatsnaam weergavenaam afstand");
  const url = `${PDOK}/reverse?lat=${lat}&lon=${lon}&type=adres&distance=${Math.round(radius)}&rows=50&fl=${fl}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`PDOK fout ${res.status}`);
  const docs = (await res.json()).response?.docs ?? [];
  const addresses = docs
    .map(toAddress)
    .filter(Boolean)
    .sort((a, b) => a.afstand - b.afstand);
  const seen = new Map();
  for (const a of addresses) {
    const key = `${a.straat}|${a.plaats}`;
    if (!seen.has(key)) seen.set(key, { straat: a.straat, plaats: a.plaats });
  }
  return { current: addresses[0] ?? null, streets: [...seen.values()], addresses };
}

/**
 * PDOK-document -> adres. Gebruikt de losse velden, of anders de
 * weergavenaam ("Julianalaan 12A, 9781EK Bedum").
 */
export function toAddress(d) {
  let straat = d.straatnaam, nummer = d.huisnummer, plaats = d.woonplaatsnaam;
  if (!straat || nummer == null || !plaats) {
    const m = /^(.+?) (\d+)\S*(?: \S+)?, (?:\d{4} ?[A-Z]{2} )?(.+)$/.exec(d.weergavenaam ?? "");
    if (!m) return null;
    [, straat, nummer, plaats] = m;
  }
  return { straat, nummer: Number(nummer), plaats, afstand: Number(d.afstand ?? 0) };
}

/** Coördinaten van één adres via PDOK (voor adressen buiten de top-100). */
export async function geocode(straat, nummer, plaats, fetchFn = fetch) {
  const q = encodeURIComponent(`${straat} ${nummer} ${plaats}`);
  const fl = encodeURIComponent("straatnaam huisnummer centroide_ll");
  const res = await fetchFn(`${PDOK}/free?q=${q}&fq=type:adres&rows=1&fl=${fl}`);
  if (!res.ok) return null;
  const doc = (await res.json()).response?.docs?.[0];
  if (!doc || doc.straatnaam?.toLowerCase() !== straat.toLowerCase()) return null;
  if (Number(doc.huisnummer) !== Number(nummer)) return null;
  return parsePoint(doc.centroide_ll);
}

/** Alleen resultaten van deze sites tellen mee. */
export const SITES = ["funda.nl", "huispedia.nl"];

export function searchQuery(straat, plaats) {
  const sites = SITES.map((s) => `site:${s}`).join(" OR ");
  return `"${straat}" ${plaats} te koop (${sites})`;
}

/** "www.funda.nl" -> "funda.nl" als de link bij een van de SITES hoort, anders null. */
export function siteOf(link) {
  let host;
  try { host = new URL(link).hostname.toLowerCase(); } catch { return null; }
  return SITES.find((s) => host === s || host.endsWith("." + s)) ?? null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Vindt de vraagprijs in een tekst, bijv. "€ 325.000 k.k." -> 325000. */
export function extractPrice(text) {
  const re = /€\s?(\d{1,3}(?:[.\s]\d{3})+|\d{5,})(?:,-)?(\s*(?:k\.k\.|v\.o\.n\.|kosten koper|vrij op naam))?/gi;
  let m;
  while ((m = re.exec(text))) {
    const value = parseInt(m[1].replace(/[.\s]/g, ""), 10);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 20).toLowerCase();
    if (/^\s*(per maand|p\/m|\/\s*m|\/mnd|per mnd)/.test(after)) continue; // huurprijs
    // Alleen de woorden direct voor het bedrag (sinds het vorige bedrag of leesteken).
    const before = text.slice(Math.max(0, m.index - 30), m.index).split(/[€,;|•\n]/).pop().toLowerCase();
    if (/woz|waarde|geschat|indicatie/.test(before)) continue; // geen vraagprijs
    if (value >= 25000 && value <= 50000000) {
      return { value, label: `€ ${value.toLocaleString("nl-NL")}${m[2] ? " " + m[2].trim() : ""}` };
    }
  }
  return null;
}

/** Huisnummers van `straat` die in de tekst voorkomen. */
export function extractNumbers(text, straat) {
  const re = new RegExp(`${escapeRe(straat)}\\s+(\\d{1,5})(?!\\d)`, "gi");
  const nums = new Set();
  let m;
  while ((m = re.exec(text))) nums.add(Number(m[1]));
  return [...nums];
}

/**
 * Zet zoekresultaten (SerpApi organic_results) om naar kandidaat-woningen:
 * [{straat, nummer, plaats, prijs, link, bron}]. Resultaten met meerdere
 * huisnummers (overzichtspagina's), zonder prijs, met "verkocht" of van
 * andere sites dan SITES vallen af.
 */
export function parseResults(results, straat, plaats) {
  const out = [];
  for (const r of results ?? []) {
    const bron = siteOf(r.link);
    if (!bron) continue;
    const text = [r.title, r.snippet, r.rich_snippet ? JSON.stringify(r.rich_snippet) : ""]
      .filter(Boolean)
      .join(" • ");
    if (/\bverkocht\b/i.test(text)) continue;
    if (/\bte huur\b|\bhuurwoning\b|\bhuurprijs\b/i.test(text)) continue;
    // Huispedia toont ook woningen die niet te koop staan.
    if (!/te koop|vraagprijs|k\.k\.|v\.o\.n\./i.test(text)) continue;
    const nums = extractNumbers(text, straat);
    if (nums.length !== 1) continue;
    const prijs = extractPrice(text);
    if (!prijs) continue;
    out.push({ straat, nummer: nums[0], plaats, prijs, link: r.link, bron });
  }
  // Zelfde woning op meerdere sites: houd de eerste.
  const uniq = new Map();
  for (const w of out) {
    const key = `${w.straat}|${w.nummer}|${w.plaats}`.toLowerCase();
    if (!uniq.has(key)) uniq.set(key, w);
  }
  return [...uniq.values()];
}

/**
 * Bepaalt de afstand van elke kandidaat tot de huidige positie en houdt
 * alleen woningen binnen de straal over.
 */
export async function filterByDistance(candidates, pos, radius, addresses, fetchFn = fetch) {
  const kept = [];
  for (const w of candidates) {
    const hit = addresses.find(
      (a) => a.straat.toLowerCase() === w.straat.toLowerCase() &&
             a.plaats === w.plaats && a.nummer === w.nummer,
    );
    let afstand = hit?.afstand;
    if (afstand == null) {
      const p = await geocode(w.straat, w.nummer, w.plaats, fetchFn);
      if (!p) continue;
      afstand = haversine(pos.lat, pos.lon, p.lat, p.lon);
    }
    if (afstand <= radius) kept.push({ ...w, afstand: Math.round(afstand) });
  }
  return kept.sort((a, b) => a.afstand - b.afstand);
}

// --- Zoeken in een cirkel (als de straten zelf niets opleveren) ---

/** Ringen voor het cirkelzoeken: 2×, 4×, 8× de straal, tot `max` meter. */
export function circleRings(radius, max) {
  const rings = [];
  for (let r = radius * 2; r < max; r *= 2) rings.push(r);
  if (max > radius) rings.push(max);
  return rings;
}

/** Punt op `dist` meter van `pos` in richting `bearing` (graden). */
export function offsetPoint(pos, dist, bearing) {
  const b = (bearing * Math.PI) / 180;
  const dLat = (dist * Math.cos(b)) / 111320;
  const dLon = (dist * Math.sin(b)) / (111320 * Math.cos((pos.lat * Math.PI) / 180));
  return { lat: pos.lat + dLat, lon: pos.lon + dLon };
}

/**
 * Postcodegebieden (4 cijfers + plaats) binnen `radius` meter: PDOK wordt
 * gevraagd naar het dichtstbijzijnde adres in het midden en op 8 punten op
 * de halve en de hele cirkel. Geeft [{pc4, plaats}] terug, dichtstbij eerst.
 */
export async function postcodeAreas(pos, radius, fetchFn = fetch) {
  const points = [pos];
  for (const f of [0.5, 1]) for (let b = 0; b < 360; b += 45) points.push(offsetPoint(pos, radius * f, b));
  const fl = encodeURIComponent("postcode woonplaatsnaam afstand");
  const docs = await Promise.all(points.map(async (p) => {
    try {
      const res = await fetchFn(`${PDOK}/reverse?lat=${p.lat}&lon=${p.lon}&type=adres&rows=1&distance=250&fl=${fl}`);
      return res.ok ? (await res.json()).response?.docs?.[0] : null;
    } catch { return null; }
  }));
  const areas = new Map();
  for (const d of docs) {
    const pc4 = d?.postcode?.slice(0, 4);
    if (pc4 && d.woonplaatsnaam && !areas.has(pc4)) areas.set(pc4, { pc4, plaats: d.woonplaatsnaam });
  }
  return [...areas.values()];
}

export function areaQuery(pc4, plaats) {
  const sites = SITES.map((s) => `site:${s}`).join(" OR ");
  return `"${pc4}" ${plaats} te koop (${sites})`;
}

/**
 * Adressen (huisnummer + postcode) in een tekst of link, ongeacht de straat:
 * "Julianalaan 12 9781 EK Bedum" of huispedia.nl/bedum/9781ek/julianalaan/12.
 */
export function extractPostcodeAddresses(text, link = "") {
  const found = new Map();
  const add = (nummer, pc) => {
    const postcode = pc.replace(/\s/g, "").toUpperCase();
    found.set(`${postcode}|${nummer}`, { postcode, nummer: Number(nummer) });
  };
  const re = /(?:^|[^\d€.,])(\d{1,5})[a-zA-Z]?(?:[-\s](?:bis|[a-zA-Z]|\d{1,3}))?,?\s+(\d{4}\s?[A-Z]{2})\b/g;
  let m;
  while ((m = re.exec(text))) add(m[1], m[2]);
  const u = /\/(\d{4}[a-z]{2})\/[^/]+\/(\d{1,5})(?:[^\d]|$)/i.exec(link);
  if (u) add(u[2], u[1]);
  return [...found.values()];
}

/**
 * Zoekresultaten van een postcodegebied -> kandidaten [{postcode, nummer, prijs, link, bron}],
 * met dezelfde filters als parseResults.
 */
export function parseAreaResults(results) {
  const out = new Map();
  for (const r of results ?? []) {
    const bron = siteOf(r.link);
    if (!bron) continue;
    const text = [r.title, r.snippet, r.rich_snippet ? JSON.stringify(r.rich_snippet) : ""]
      .filter(Boolean)
      .join(" • ");
    if (/\bverkocht\b/i.test(text)) continue;
    if (/\bte huur\b|\bhuurwoning\b|\bhuurprijs\b/i.test(text)) continue;
    if (!/te koop|vraagprijs|k\.k\.|v\.o\.n\./i.test(text)) continue;
    const adressen = extractPostcodeAddresses(text, r.link);
    if (adressen.length !== 1) continue; // overzichtspagina of geen adres
    const prijs = extractPrice(text);
    if (!prijs) continue;
    const key = `${adressen[0].postcode}|${adressen[0].nummer}`;
    if (!out.has(key)) out.set(key, { ...adressen[0], prijs, link: r.link, bron });
  }
  return [...out.values()];
}

/** Officieel adres + coördinaten bij postcode + huisnummer (PDOK). */
const postcodeCache = new Map();

export async function geocodePostcode(postcode, nummer, fetchFn = fetch) {
  const key = `${postcode}|${nummer}`;
  if (!postcodeCache.has(key)) {
    const p = lookupPostcode(postcode, nummer, fetchFn);
    postcodeCache.set(key, p);
    p.then((r) => r || postcodeCache.delete(key), () => postcodeCache.delete(key));
  }
  return postcodeCache.get(key);
}

async function lookupPostcode(postcode, nummer, fetchFn) {
  const fl = encodeURIComponent("straatnaam huisnummer postcode woonplaatsnaam centroide_ll");
  const q = encodeURIComponent(`${postcode} ${nummer}`);
  const fq = [`type:adres`, `postcode:${postcode}`, `huisnummer:${nummer}`]
    .map((f) => `&fq=${encodeURIComponent(f)}`).join("");
  const res = await fetchFn(`${PDOK}/free?q=${q}${fq}&rows=1&fl=${fl}`);
  if (!res.ok) return null;
  const doc = (await res.json()).response?.docs?.[0];
  if (!doc || doc.postcode !== postcode || Number(doc.huisnummer) !== Number(nummer)) return null;
  const p = parsePoint(doc.centroide_ll);
  return p && { straat: doc.straatnaam, plaats: doc.woonplaatsnaam, ...p };
}

/**
 * Zet kandidaten uit het cirkelzoeken om naar woningen met straat, plaats en
 * afstand, en houdt alleen die binnen `maxDist` over (dichtstbij eerst).
 */
export async function locateAreaCandidates(candidates, pos, maxDist, fetchFn = fetch) {
  const located = await Promise.all(candidates.map(async (c) => {
    const a = await geocodePostcode(c.postcode, c.nummer, fetchFn);
    if (!a) return null;
    const afstand = Math.round(haversine(pos.lat, pos.lon, a.lat, a.lon));
    return { straat: a.straat, nummer: c.nummer, plaats: a.plaats, prijs: c.prijs,
             link: c.link, bron: c.bron, afstand, cirkel: true };
  }));
  return located.filter((w) => w && w.afstand <= maxDist).sort((a, b) => a.afstand - b.afstand);
}

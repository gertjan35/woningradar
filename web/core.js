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
 * Alle adressen binnen `radius` meter van de positie (max. 100 per keer).
 * Geeft {current, streets, addresses} terug:
 *  - current: straat/plaats van het dichtstbijzijnde adres
 *  - streets: unieke [{straat, plaats}] binnen de straal
 *  - addresses: [{straat, nummer, plaats, afstand}]
 */
export async function nearbyAddresses(lat, lon, radius, fetchFn = fetch) {
  const url = `${PDOK}/reverse?lat=${lat}&lon=${lon}&type=adres&distance=${radius}&rows=100`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`PDOK fout ${res.status}`);
  const docs = (await res.json()).response?.docs ?? [];
  const addresses = docs
    .filter((d) => d.straatnaam && d.huisnummer != null)
    .map((d) => ({
      straat: d.straatnaam,
      nummer: Number(d.huisnummer),
      plaats: d.woonplaatsnaam,
      afstand: Number(d.afstand ?? 0),
    }))
    .sort((a, b) => a.afstand - b.afstand);
  const seen = new Map();
  for (const a of addresses) {
    const key = `${a.straat}|${a.plaats}`;
    if (!seen.has(key)) seen.set(key, { straat: a.straat, plaats: a.plaats });
  }
  return { current: addresses[0] ?? null, streets: [...seen.values()], addresses };
}

/** Coördinaten van één adres via PDOK (voor adressen buiten de top-100). */
export async function geocode(straat, nummer, plaats, fetchFn = fetch) {
  const q = encodeURIComponent(`${straat} ${nummer} ${plaats}`);
  const res = await fetchFn(`${PDOK}/free?q=${q}&fq=type:adres&rows=1`);
  if (!res.ok) return null;
  const doc = (await res.json()).response?.docs?.[0];
  if (!doc || doc.straatnaam?.toLowerCase() !== straat.toLowerCase()) return null;
  if (Number(doc.huisnummer) !== Number(nummer)) return null;
  return parsePoint(doc.centroide_ll);
}

export function searchQuery(straat, plaats) {
  return `"${straat}" ${plaats} koopwoning te koop`;
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
 * huisnummers (overzichtspagina's), zonder prijs of met "verkocht" vallen af.
 */
export function parseResults(results, straat, plaats) {
  const out = [];
  for (const r of results ?? []) {
    const text = [r.title, r.snippet, r.rich_snippet ? JSON.stringify(r.rich_snippet) : ""]
      .filter(Boolean)
      .join(" • ");
    if (/\bverkocht\b/i.test(text)) continue;
    if (/\bte huur\b|\bhuurwoning\b|\bhuurprijs\b/i.test(text)) continue;
    const nums = extractNumbers(text, straat);
    if (nums.length !== 1) continue;
    const prijs = extractPrice(text);
    if (!prijs) continue;
    let bron = "";
    try { bron = new URL(r.link).hostname.replace(/^www\./, ""); } catch {}
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

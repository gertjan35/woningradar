import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPrice, extractNumbers, parseResults, filterByDistance,
  nearbyAddresses, haversine, parsePoint, toAddress, searchQuery, siteOf,
} from "./core.js";

test("prijs met k.k.", () => {
  assert.deepEqual(extractPrice("Vraagprijs € 325.000 k.k."), { value: 325000, label: "€ 325.000 k.k." });
});

test("prijs zonder spatie en v.o.n.", () => {
  assert.equal(extractPrice("€1.250.000 v.o.n.").value, 1250000);
});

test("huurprijs wordt genegeerd", () => {
  assert.equal(extractPrice("€ 1.450 per maand"), null);
  assert.equal(extractPrice("Huur € 25.000 per maand"), null);
});

test("huisnummers", () => {
  assert.deepEqual(extractNumbers("Huis te koop: Julianalaan 12 9781 EK Bedum", "Julianalaan"), [12]);
  assert.deepEqual(extractNumbers("julianalaan 7a en Julianalaan 9", "Julianalaan"), [7, 9]);
  assert.deepEqual(extractNumbers("Julianalaanweg 3", "Julianalaan"), []);
});

const results = [
  { title: "Huis te koop: Julianalaan 12 9781 EK Bedum [funda]", snippet: "Vraagprijs € 325.000 k.k. Woonoppervlakte 120 m²", link: "https://www.funda.nl/koop/bedum/huis-1/" },
  { title: "Julianalaan 12, Bedum", snippet: "€ 325.000 k.k.", link: "https://huispedia.nl/bedum/9781ek/julianalaan/12" },
  { title: "Julianalaan 14 Bedum te koop", snippet: "Vraagprijs € 299.000 k.k.", link: "https://www.jaap.nl/x" },
  { title: "Koopwoningen Julianalaan Bedum", snippet: "Julianalaan 3 € 250.000 k.k., Julianalaan 5 € 300.000 k.k.", link: "https://www.funda.nl/koop/bedum/" },
  { title: "Verkocht: Julianalaan 8 Bedum", snippet: "€ 280.000 k.k.", link: "https://www.funda.nl/8" },
  { title: "Julianalaan 20 Bedum", snippet: "Geen prijs bekend", link: "https://www.funda.nl/20" },
  { title: "Julianalaan 22, Bedum | Huispedia", snippet: "Geschatte waarde € 345.000. WOZ-waarde € 301.000", link: "https://huispedia.nl/bedum/9781ek/julianalaan/22" },
  { title: "Julianalaan 30 Bedum", snippet: "", rich_snippet: { top: { extensions: ["€ 410.000 k.k.", "4 kamers"] } }, link: "https://huispedia.nl/30" },
];

test("zoekresultaten uitlezen: alleen funda/huispedia en alleen te koop", () => {
  const w = parseResults(results, "Julianalaan", "Bedum");
  assert.deepEqual(w.map((x) => [x.nummer, x.prijs.value, x.bron]), [[12, 325000, "funda.nl"], [30, 410000, "huispedia.nl"]]);
});

test("zoekopdracht en sitefilter", () => {
  assert.equal(searchQuery("Julianalaan", "Bedum"), '"Julianalaan" Bedum te koop (site:funda.nl OR site:huispedia.nl)');
  assert.equal(siteOf("https://www.funda.nl/koop/x"), "funda.nl");
  assert.equal(siteOf("https://huispedia.nl/x"), "huispedia.nl");
  assert.equal(siteOf("https://nietfunda.nl/x"), null);
  assert.equal(siteOf("https://jaap.nl/x"), null);
});

test("WOZ of geschatte waarde is geen vraagprijs", () => {
  assert.equal(extractPrice("WOZ-waarde € 301.000"), null);
  assert.equal(extractPrice("Geschatte waarde: € 345.000"), null);
  assert.equal(extractPrice("Geschatte waarde € 345.000, vraagprijs € 339.000 k.k.").value, 339000);
});

const fakeFetch = (routes) => async (url) => {
  const key = Object.keys(routes).find((k) => url.includes(k));
  return { ok: !!key, status: key ? 200 : 404, json: async () => routes[key] };
};

test("afstandsfilter met PDOK-adressen en geocode-fallback", async () => {
  const addresses = [{ straat: "Julianalaan", nummer: 12, plaats: "Bedum", afstand: 40 }];
  const fetchFn = fakeFetch({
    "Julianalaan%2030": { response: { docs: [{ straatnaam: "Julianalaan", huisnummer: 30, centroide_ll: "POINT(6.6036 53.3005)" }] } },
  });
  const w = parseResults(results, "Julianalaan", "Bedum");
  const pos = { lat: 53.2985, lon: 6.6036 };
  const near = await filterByDistance(w, pos, 100, addresses, fetchFn);
  assert.deepEqual(near.map((x) => x.nummer), [12]); // nr 30 ligt ~222 m verderop
  const far = await filterByDistance(w, pos, 300, addresses, fetchFn);
  assert.deepEqual(far.map((x) => x.nummer), [12, 30]);
});

test("nearbyAddresses groepeert straten", async () => {
  const fetchFn = fakeFetch({
    reverse: { response: { docs: [
      { straatnaam: "Schoolstraat", huisnummer: 2, woonplaatsnaam: "Bedum", afstand: 60 },
      { straatnaam: "Julianalaan", huisnummer: 12, woonplaatsnaam: "Bedum", afstand: 5 },
      { straatnaam: "Julianalaan", huisnummer: 14, woonplaatsnaam: "Bedum", afstand: 15 },
    ] } },
  });
  const r = await nearbyAddresses(53.3, 6.6, 100, fetchFn);
  assert.equal(r.current.straat, "Julianalaan");
  assert.deepEqual(r.streets.map((s) => s.straat), ["Julianalaan", "Schoolstraat"]);
});

test("haversine en parsePoint", () => {
  assert.deepEqual(parsePoint("POINT(6.6 53.3)"), { lon: 6.6, lat: 53.3 });
  assert.ok(Math.abs(haversine(53, 6, 53.001, 6) - 111.2) < 1);
});

test("adres uit weergavenaam (standaardantwoord PDOK)", () => {
  assert.deepEqual(toAddress({ weergavenaam: "Julianalaan 12, 9781EK Bedum", afstand: 4.5 }),
    { straat: "Julianalaan", nummer: 12, plaats: "Bedum", afstand: 4.5 });
  assert.deepEqual(toAddress({ weergavenaam: "Van der Veenstraat 3A-2, 9781AB Bedum", afstand: 1 }),
    { straat: "Van der Veenstraat", nummer: 3, plaats: "Bedum", afstand: 1 });
  assert.deepEqual(toAddress({ weergavenaam: "Hoofdweg 120 bis, 9781AB Bedum", afstand: 1 }).nummer, 120);
  assert.equal(toAddress({ weergavenaam: "Bedum" }), null);
});

test("nearbyAddresses met alleen weergavenaam", async () => {
  const fetchFn = fakeFetch({ reverse: { response: { docs: [
    { type: "adres", weergavenaam: "Julianalaan 12, 9781EK Bedum", afstand: 3 } ] } } });
  const r = await nearbyAddresses(53.3, 6.6, 100, fetchFn);
  assert.equal(r.current.straat, "Julianalaan");
});

import {
  circleRings, offsetPoint, extractPostcodeAddresses, parseAreaResults,
  postcodeAreas, areaQuery, locateAreaCandidates,
} from "./core.js";

test("cirkelringen", () => {
  assert.deepEqual(circleRings(100, 1000), [200, 400, 800, 1000]);
  assert.deepEqual(circleRings(100, 0), []);
  const p = offsetPoint({ lat: 53.3, lon: 6.6 }, 500, 90);
  assert.ok(Math.abs(haversine(53.3, 6.6, p.lat, p.lon) - 500) < 2);
});

test("adressen met postcode, ongeacht straatnaam", () => {
  assert.deepEqual(extractPostcodeAddresses("Huis te koop: Schoolstraat 7a 9781 AB Bedum [funda]"),
    [{ postcode: "9781AB", nummer: 7 }]);
  assert.deepEqual(extractPostcodeAddresses("Van der Veenstraat 3-2, 9781AB Bedum"),
    [{ postcode: "9781AB", nummer: 3 }]);
  assert.deepEqual(extractPostcodeAddresses("Huispedia", "https://huispedia.nl/bedum/9781ek/julianalaan/12"),
    [{ postcode: "9781EK", nummer: 12 }]);
  assert.deepEqual(extractPostcodeAddresses("Vraagprijs € 325.000 k.k. 120 m² 9781 Bedum"), []);
});

const areaResults = [
  { title: "Huis te koop: Schoolstraat 7 9781 AB Bedum [funda]", snippet: "Vraagprijs € 289.000 k.k.", link: "https://www.funda.nl/detail/koop/bedum/huis-schoolstraat-7/1/" },
  { title: "Huizen te koop in Bedum 9781", snippet: "Kerkstraat 1 9781 AC € 200.000 k.k. Dorpsweg 4 9781 AD € 250.000 k.k.", link: "https://www.funda.nl/koop/bedum/" },
  { title: "Kerkstraat 9, 9781 AC Bedum | Huispedia", snippet: "Te koop. Vraagprijs € 375.000 k.k.", link: "https://huispedia.nl/bedum/9781ac/kerkstraat/9" },
  { title: "Dorpsweg 2 9781 AD Bedum", snippet: "WOZ-waarde € 240.000", link: "https://huispedia.nl/bedum/9781ad/dorpsweg/2" },
  { title: "Hoofdweg 3 9781 AE Bedum te koop", snippet: "€ 199.000 k.k.", link: "https://www.jaap.nl/x" },
];

test("zoekresultaten van een postcodegebied uitlezen", () => {
  const c = parseAreaResults(areaResults);
  assert.deepEqual(c.map((x) => [x.postcode, x.nummer, x.prijs.value]), [["9781AB", 7, 289000], ["9781AC", 9, 375000]]);
  assert.equal(areaQuery("9781", "Bedum"), '"9781" Bedum te koop (site:funda.nl OR site:huispedia.nl)');
});

test("postcodegebieden en afstand bij cirkelzoeken", async () => {
  const pos = { lat: 53.2985, lon: 6.6036 };
  const fetchFn = async (url) => {
    let docs = [];
    if (url.includes("/reverse")) {
      const lat = Number(/lat=([\d.]+)/.exec(url)[1]);
      docs = [{ postcode: lat > 53.3 ? "9781AB" : "9781EK", woonplaatsnaam: "Bedum" }];
      if (lat < 53.296) docs = [{ postcode: "9782XX", woonplaatsnaam: "Noordwolde" }];
    } else if (url.includes("9781AB")) {
      docs = [{ straatnaam: "Schoolstraat", huisnummer: 7, postcode: "9781AB", woonplaatsnaam: "Bedum", centroide_ll: "POINT(6.6036 53.3010)" }];
    } else if (url.includes("9781AC")) {
      docs = [{ straatnaam: "Kerkstraat", huisnummer: 9, postcode: "9781AC", woonplaatsnaam: "Bedum", centroide_ll: "POINT(6.6036 53.3100)" }];
    }
    return { ok: true, json: async () => ({ response: { docs } }) };
  };
  const areas = await postcodeAreas(pos, 400, fetchFn);
  assert.deepEqual(areas.map((a) => a.pc4).sort(), ["9781", "9782"]);
  const near = await locateAreaCandidates(parseAreaResults(areaResults), pos, 1000, fetchFn);
  assert.deepEqual(near.map((w) => [w.straat, w.nummer, w.afstand]), [["Schoolstraat", 7, 278]]);
});

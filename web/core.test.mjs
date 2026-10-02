import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPrice, extractNumbers, parseResults, filterByDistance,
  nearbyAddresses, haversine, parsePoint,
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
  { title: "Julianalaan 12, Bedum", snippet: "€ 325.000 k.k.", link: "https://www.jaap.nl/x" },
  { title: "Koopwoningen Julianalaan Bedum", snippet: "Julianalaan 3 € 250.000 k.k., Julianalaan 5 € 300.000 k.k.", link: "https://x.nl" },
  { title: "Verkocht: Julianalaan 8 Bedum", snippet: "€ 280.000 k.k.", link: "https://x.nl/8" },
  { title: "Julianalaan 20 Bedum", snippet: "Geen prijs bekend", link: "https://x.nl/20" },
  { title: "Julianalaan 30 Bedum", snippet: "", rich_snippet: { top: { extensions: ["€ 410.000 k.k.", "4 kamers"] } }, link: "https://x.nl/30" },
];

test("zoekresultaten uitlezen", () => {
  const w = parseResults(results, "Julianalaan", "Bedum");
  assert.deepEqual(w.map((x) => [x.nummer, x.prijs.value, x.bron]), [[12, 325000, "funda.nl"], [30, 410000, "x.nl"]]);
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

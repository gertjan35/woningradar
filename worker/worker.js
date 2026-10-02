// Cloudflare Worker: serveert de web-app (map ../web) en stuurt
// zoekopdrachten door naar SerpApi. De API-sleutel blijft op de server.
//
// Geheimen (via `npx wrangler secret put <NAAM>`):
//   SERPAPI_KEY   – je SerpApi-sleutel (verplicht)
//   ACCESS_TOKEN  – toegangscode die de app meestuurt (aanbevolen, zodat
//                   niemand anders je zoektegoed opmaakt)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/search") return env.ASSETS.fetch(request);

    if (env.ACCESS_TOKEN && request.headers.get("x-access-token") !== env.ACCESS_TOKEN) {
      return json({ error: "Onjuiste toegangscode" }, 401);
    }
    const q = url.searchParams.get("q");
    if (!q || q.length > 200) return json({ error: "Parameter q ontbreekt" }, 400);
    if (!env.SERPAPI_KEY) return json({ error: "SERPAPI_KEY is niet ingesteld" }, 500);

    const serp = new URL("https://serpapi.com/search.json");
    serp.search = new URLSearchParams({
      engine: "google", q, google_domain: "google.nl", gl: "nl", hl: "nl",
      num: "20", api_key: env.SERPAPI_KEY,
    });
    const res = await fetch(serp);
    const data = await res.json();
    // SerpApi meldt "geen resultaten" als fout; dat is gewoon een lege lijst.
    if (/returned any results/i.test(data.error ?? "")) return json({ organic_results: [] });
    if (!res.ok || data.error) return json({ error: data.error ?? `SerpApi fout ${res.status}` }, 502);

    // Alleen doorgeven wat de app nodig heeft.
    const organic_results = (data.organic_results ?? []).map(
      ({ title, link, snippet, rich_snippet }) => ({ title, link, snippet, rich_snippet }),
    );
    return json({ organic_results });
  },
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

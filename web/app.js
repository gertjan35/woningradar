import { nearbyAddresses, parseResults, filterByDistance, searchQuery, haversine } from "./core.js";

const $ = (id) => document.getElementById(id);

// --- opslag (per apparaat) ---
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem("wr." + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem("wr." + key, JSON.stringify(value)); } catch {} },
};

const settings = {
  radius: store.get("radius", 100),
  token: store.get("token", ""),
  cacheHours: store.get("cacheHours", 24),
};
let streetCache = store.get("streetCache", {});   // "straat|plaats" -> {t, results}
let found = store.get("found", {});               // "straat|nr|plaats" -> woning
let quota = store.get("quota", { month: "", count: 0 });

let watchId = null;
let lastScanPos = null;
let lastScanTime = 0;
let scanning = false;
let wakeLock = null;

// --- instellingen ---
for (const key of ["radius", "token", "cacheHours"]) {
  $(key).value = settings[key];
  $(key).addEventListener("change", () => {
    settings[key] = key === "token" ? $(key).value.trim() : Number($(key).value);
    store.set(key, settings[key]);
    render();
    if (key === "radius") lastScanPos = null; // opnieuw zoeken bij volgende positie
  });
}

$("reset").onclick = () => {
  streetCache = {}; found = {};
  store.set("streetCache", streetCache); store.set("found", found);
  render();
};

$("notify").onclick = async () => {
  if (!("Notification" in window)) {
    showError("Meldingen werken op iPhone alleen als je de app via Deel → Zet op beginscherm installeert.");
    return;
  }
  const p = await Notification.requestPermission();
  $("notify").textContent = p === "granted" ? "Meldingen staan aan" : "Meldingen geweigerd";
};

$("toggle").onclick = () => (watchId == null ? start() : stop());

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// --- GPS ---
function start() {
  if (!navigator.geolocation) return showError("Deze browser geeft geen locatie door.");
  watchId = navigator.geolocation.watchPosition(onPosition, (e) => showError(gpsError(e)), {
    enableHighAccuracy: true, maximumAge: 10000, timeout: 30000,
  });
  $("toggle").textContent = "Stop";
  $("status").textContent = "Locatie bepalen…";
  keepAwake();
}

function stop() {
  navigator.geolocation.clearWatch(watchId);
  watchId = null;
  $("toggle").textContent = "Start";
  $("status").textContent = "Gestopt.";
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && watchId != null) keepAwake();
});

function gpsError(e) {
  return e.code === 1
    ? "Geen toestemming voor locatie. Zet aan via Instellingen → Privacy en beveiliging → Locatievoorzieningen → Safari-websites → Bij gebruik van app (met Nauwkeurige locatie aan). Sluit daarna de app helemaal af en open hem opnieuw."
    : "Locatie niet beschikbaar (" + e.message + ").";
}

async function onPosition(p) {
  const acc = Math.round(p.coords.accuracy);
  const pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc };
  $("status").textContent = `Nauwkeurigheid ± ${acc} m`;

  const moved = lastScanPos ? haversine(pos.lat, pos.lon, lastScanPos.lat, lastScanPos.lon) : Infinity;
  const minMove = Math.max(25, settings.radius / 2);
  if (scanning || moved < minMove || Date.now() - lastScanTime < 20000) return;

  scanning = true;
  lastScanPos = pos;
  lastScanTime = Date.now();
  try {
    await scan(pos);
    showError("");
    $("status").textContent = `Laatst gezocht om ${new Date().toLocaleTimeString("nl-NL", { timeStyle: "short" })} · ± ${acc} m`;
  } catch (e) {
    showError(e.message);
  } finally {
    scanning = false;
  }
}

// --- zoeken ---
async function scan(pos) {
  // Bij onnauwkeurige GPS kijken we iets ruimer rond, anders mist de app straten.
  const searchRadius = settings.radius + Math.min(pos.acc ?? 0, 200);
  const { current, streets, addresses } = await nearbyAddresses(pos.lat, pos.lon, searchRadius);
  $("street").textContent = current
    ? `${current.straat}, ${current.plaats}`
    : `Geen adres binnen ${searchRadius} m (${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)})`;
  if (!streets.length) return;

  for (const { straat, plaats } of streets) {
    const results = await searchStreet(straat, plaats);
    const candidates = parseResults(results, straat, plaats);
    const near = await filterByDistance(candidates, pos, settings.radius, addresses);
    for (const w of near) {
      const key = `${w.straat}|${w.nummer}|${w.plaats}`;
      const previous = found[key];
      found[key] = { ...w, seen: Date.now() };
      if (!previous || previous.prijs.value !== w.prijs.value) announce(w, previous);
    }
  }
  store.set("found", found);
  render();
}

async function searchStreet(straat, plaats) {
  const query = searchQuery(straat, plaats);
  const key = query; // nieuwe zoekopdracht = nieuwe cache
  const cached = streetCache[key];
  if (cached && Date.now() - cached.t < settings.cacheHours * 3600e3) return cached.results;

  $("status").textContent = `Zoeken: ${straat}…`;
  const res = await fetch("api/search?q=" + encodeURIComponent(query), {
    headers: { "x-access-token": settings.token },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Zoeken mislukt (${res.status})`);

  const month = new Date().toISOString().slice(0, 7);
  quota = { month, count: (quota.month === month ? quota.count : 0) + 1 };
  store.set("quota", quota);

  streetCache[key] = { t: Date.now(), results: data.organic_results };
  // Houd de cache klein.
  const entries = Object.entries(streetCache).sort((a, b) => b[1].t - a[1].t).slice(0, 200);
  streetCache = Object.fromEntries(entries);
  store.set("streetCache", streetCache);
  return data.organic_results;
}

// --- meldingen ---
function announce(w, previous) {
  const title = previous ? `Prijs gewijzigd: ${w.prijs.label}` : `${w.prijs.label}`;
  const body = `${w.straat} ${w.nummer}, ${w.plaats} – ${w.afstand} m (${w.bron})`;

  const popup = $("popup");
  popup.innerHTML = "";
  const strong = document.createElement("div");
  strong.style.fontSize = "18px";
  strong.style.fontWeight = "700";
  strong.textContent = title;
  const line = document.createElement("div");
  line.textContent = body + " ";
  const link = document.createElement("a");
  link.href = w.link; link.target = "_blank"; link.rel = "noopener";
  link.textContent = "Bekijk";
  line.append(link);
  popup.append(strong, line);
  popup.style.display = "block";
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => (popup.style.display = "none"), 12000);
  popup.onclick = (e) => { if (e.target !== link) popup.style.display = "none"; };
  navigator.vibrate?.(200);

  if ("Notification" in window && Notification.permission === "granted") {
    navigator.serviceWorker?.ready
      .then((reg) => reg.showNotification(title, { body, tag: w.link, data: { url: w.link } }))
      .catch(() => {});
  }
}

// --- weergave ---
function render() {
  $("radiusLabel").textContent = settings.radius;
  const month = new Date().toISOString().slice(0, 7);
  $("quota").textContent = `${quota.month === month ? quota.count : 0} zoekopdr. deze maand`;

  // Toon woningen van de afgelopen 7 dagen, nieuwste eerst.
  const items = Object.values(found)
    .filter((w) => Date.now() - w.seen < 7 * 86400e3)
    .sort((a, b) => b.seen - a.seen);

  const list = $("list");
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = '<li class="muted">Nog niets gevonden.</li>';
    return;
  }
  for (const w of items.slice(0, 50)) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = w.link; a.target = "_blank"; a.rel = "noopener";
    a.textContent = `${w.straat} ${w.nummer}, ${w.plaats}`;
    const price = document.createElement("div");
    price.className = "price";
    price.textContent = w.prijs.label;
    const meta = document.createElement("div");
    meta.className = "muted";
    meta.textContent = `${w.afstand} m · ${w.bron} · ${new Date(w.seen).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" })}`;
    li.append(a, price, meta);
    list.append(li);
  }
}

function showError(msg) { $("error").textContent = msg; }

render();

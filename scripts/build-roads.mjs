// Lädt das befahrbare Strassennetz des Kantons Zürich aus OpenStreetMap (Overpass API)
// und schreibt eine kompakte JSON-Datei für die Web-App.
//
// Aufruf:  node scripts/build-roads.mjs public/data/roads.json
// Test:    OVERPASS_FILE=antwort.json node scripts/build-roads.mjs out.json

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'public/data/roads.json';
const REGION = 'Kanton Zürich';
const AREA_FILTER = '["ISO3166-2"="CH-ZH"]["admin_level"="4"]';

// Reihenfolge = Klassen-Index in der Ausgabedatei
export const CLASSES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street',
];

// Kanton Zürich grob als Rechteck, in Kacheln aufgeteilt (kleinere Abfragen = weniger Server-Timeouts)
const BBOX = { s: 47.15, w: 8.35, n: 47.70, e: 8.99 };
const TILES = 3;
const query = (s, w, n, e) => `[out:json][timeout:300];
area${AREA_FILTER}->.a;
way(area.a)(${s},${w},${n},${e})
  ["highway"~"^((motorway|trunk|primary|secondary|tertiary)(_link)?|unclassified|residential|living_street)$"]
  ["area"!="yes"]
  ["access"!~"^(no|private)$"]
  ["vehicle"!~"^(no|private)$"]
  ["motor_vehicle"!~"^(no|private)$"];
out tags geom qt;`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function fetchOverpass() {
  const byId = new Map();
  const dLat = (BBOX.n - BBOX.s) / TILES, dLon = (BBOX.e - BBOX.w) / TILES;
  for (let i = 0; i < TILES; i++) for (let j = 0; j < TILES; j++) {
    const q = query(BBOX.s + i * dLat, BBOX.w + j * dLon, BBOX.s + (i + 1) * dLat, BBOX.w + (j + 1) * dLon);
    const json = await fetchTile(q, `${i * TILES + j + 1}/${TILES * TILES}`);
    for (const el of json.elements) if (el.type === 'way') byId.set(el.id, el);
  }
  if (byId.size < 5000) throw new Error(`Zu wenige Strassen (${byId.size})`);
  return { elements: [...byId.values()] };
}

async function fetchTile(QUERY, label) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        console.log(`Kachel ${label}: ${url} (Versuch ${attempt + 1})`);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'strassenjaeger-build/1.0 (GitHub Actions)',
          },
          body: 'data=' + encodeURIComponent(QUERY),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!Array.isArray(json.elements)) throw new Error('Ungültige Antwort');
        if (json.remark && /error|timeout|runtime/i.test(json.remark)) throw new Error(json.remark);
        console.log(`  ${json.elements.length} Elemente`);
        return json;
      } catch (e) {
        lastErr = e;
        console.warn(`  fehlgeschlagen: ${e.message}`);
      }
    }
    await new Promise(r => setTimeout(r, 20000 * (attempt + 1)));
  }
  throw lastErr;
}

export function convert(osm, generated = new Date().toISOString()) {
  const names = [''];
  const nameIdx = new Map([['', 0]]);
  const ways = [];
  let totalM = 0;

  for (const el of osm.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const hw = (el.tags?.highway || '').replace(/_link$/, '');
    const c = CLASSES.indexOf(hw);
    if (c < 0) continue;
    const name = el.tags.name || el.tags.ref || '';
    let n = nameIdx.get(name);
    if (n === undefined) { n = names.length; names.push(name); nameIdx.set(name, n); }

    // Einbahn: 0 = beide Richtungen, 1 = nur in Zeichenrichtung, 2 = nur entgegen
    const ow = el.tags.oneway;
    let one = 0;
    if (ow === 'yes' || ow === 'true' || ow === '1') one = 1;
    else if (ow === '-1' || ow === 'reverse') one = 2;
    else if (ow !== 'no' && (el.tags.highway === 'motorway' || el.tags.highway === 'motorway_link'
      || el.tags.junction === 'roundabout' || el.tags.junction === 'circular')) one = 1;
    const row = [c | (one << 4), n];
    let px = 0, py = 0, prev = null;
    for (const g of el.geometry) {
      if (!g) continue; // Overpass liefert null für Knoten ausserhalb
      const x = Math.round(g.lon * 1e5), y = Math.round(g.lat * 1e5);
      if (prev && x === px && y === py) continue;
      row.push(x - px, y - py);
      if (prev) totalM += haversine(prev[1], prev[0], g.lat, g.lon);
      px = x; py = y; prev = [g.lon, g.lat];
    }
    if (row.length >= 6) ways.push(row);
  }
  return { v: 2, generated, region: REGION, attribution: '© OpenStreetMap-Mitwirkende (ODbL)',
    classes: CLASSES, totalKm: Math.round(totalM / 100) / 10, names, ways };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function main() {
  const osm = process.env.OVERPASS_FILE
    ? JSON.parse(await readFile(process.env.OVERPASS_FILE, 'utf8'))
    : await fetchOverpass();
  const out = convert(osm);
  await mkdir(dirname(OUT), { recursive: true });
  const text = JSON.stringify(out);
  await writeFile(OUT, text);
  console.log(`${out.ways.length} Strassenabschnitte, ${out.totalKm} km, ${(text.length / 1e6).toFixed(1)} MB → ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}

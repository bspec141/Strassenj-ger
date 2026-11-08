'use strict';
(() => {
// ───────────────────────── Konfiguration ─────────────────────────
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const ROADS_URL = 'data/roads.json';
const CENTER = [8.65, 47.40];

const CLASS_LABEL = ['Autobahn', 'Autostrasse', 'Hauptstrasse', 'Hauptstrasse', 'Verbindungsstrasse',
  'Gemeindestrasse', 'Quartierstrasse', 'Begegnungszone'];
const GROUPS = [
  ['Autobahnen & Autostrassen', [0, 1]],
  ['Hauptstrassen', [2, 3]],
  ['Verbindungs- & Gemeindestrassen', [4, 5]],
  ['Quartierstrassen', [6, 7]],
];

// Lokale Projektion (Meter), genau genug für den Kanton Zürich
const LON0 = 8.65, LAT0 = 47.40, KX = 75489, KY = 111180;
const px = lon => (lon - LON0) * KX, py = lat => (lat - LAT0) * KY;
const ux = x => x / KX + LON0, uy = y => y / KY + LAT0;

const SUB = 25;          // max. Länge eines Teilsegments (m)
const CHUNK = 50;        // Länge eines "Erkundungs-Stücks" (m)
const CELL = 50;         // Rastergrösse Suchindex (m)
const MATCH_R = 20;      // GPS-Punkt muss so nah an der Strasse sein (m)
const MIN_SPEED = 2.2;   // m/s – langsamer = zu Fuss/Stillstand, zählt nicht
const MAX_SPEED = 75;    // m/s – schneller = GPS-Sprung
const MAX_ACC = 40;      // m – ungenauere Punkte ignorieren
const STEP = 8;          // Interpolationsschritt (m)
const MAX_GAP_T = 180e3, MAX_GAP_D = 1500;
const TRIP_GAP = 10 * 60e3;
const COS_HEADING = Math.cos(40 * Math.PI / 180);

// ───────────────────────── Zustand ─────────────────────────
let cfg = loadCfg();
let ROADS = null;        // Rohdaten
let R = null;            // Index (Strassen, Stücke, Segmente, Raster)
let CF = null;           // Float64Array: Zeitpunkt der ersten Befahrung je Stück (0 = nie)
let batches = [];        // gespeicherte Punkt-Pakete
let P = emptyPoints();   // sortierte, deduplizierte Punkte
let tags = {};           // Fahrt-Start → 'car' | 'moto'
let map = null, geo = null, mapReady = false;
let lastSync = 0;
let explore = { excludeWays: new Set(), excludeNames: new Set(), origin: null };

const $ = id => document.getElementById(id);

// ───────────────────────── Hilfsfunktionen ─────────────────────────
function loadCfg() {
  const d = { url: '', token: '', gmApp: true, motorway: false, network: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem('erkunder-cfg') || '{}') }; } catch { return d; }
}
function saveCfg() { try { localStorage.setItem('erkunder-cfg', JSON.stringify(cfg)); } catch {} }

const nf1 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const km = m => (m >= 100000 ? nf0 : nf1).format(m / 1000);
const pct = (a, b) => b > 0 ? nf1.format(100 * a / b) : '0,0';
function dur(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} Min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
const dateFmt = new Intl.DateTimeFormat('de-CH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' });
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} Min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  return `vor ${Math.round(s / 86400)} Tagen`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function lowerBound(arr, n, v) { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
function setLoading(text) {
  if (text == null) { $('loading').classList.add('hidden'); return; }
  $('loading').classList.remove('hidden'); $('loadingText').textContent = text;
}
const tick = () => new Promise(r => setTimeout(r, 0));

// ───────────────────────── IndexedDB ─────────────────────────
const idb = {
  db: null,
  open() {
    return new Promise((res) => {
      try {
        const r = indexedDB.open('erkunder', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('batches', { autoIncrement: true }); r.result.createObjectStore('kv'); };
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => res();
      } catch { res(); }
    });
  },
  run(store, mode, fn) {
    if (!this.db) return Promise.resolve(undefined);
    return new Promise((res) => {
      try {
        const t = this.db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => res(req ? req.result : undefined);
        t.onerror = t.onabort = () => res(undefined);
      } catch { res(undefined); }
    });
  },
  get(k) { return this.run('kv', 'readonly', s => s.get(k)); },
  set(k, v) { return this.run('kv', 'readwrite', s => s.put(v, k)); },
  addBatch(b) { return this.run('batches', 'readwrite', s => s.add(b)); },
  allBatches() { return this.run('batches', 'readonly', s => s.getAll()).then(r => r || []); },
  async clear() { await this.run('batches', 'readwrite', s => s.clear()); await this.run('kv', 'readwrite', s => s.clear()); },
};

// ───────────────────────── GPS-Punkte ─────────────────────────
function emptyPoints() { return { n: 0, t: new Float64Array(0), lat: new Float64Array(0), lon: new Float64Array(0), acc: new Float32Array(0), spd: new Float32Array(0) }; }

function buildPoints(list) {
  let total = 0;
  for (const b of list) total += b.t.length;
  const T = new Float64Array(total), LA = new Float64Array(total), LO = new Float64Array(total),
    AC = new Float32Array(total), SP = new Float32Array(total);
  let k = 0;
  for (const b of list) {
    for (let i = 0; i < b.t.length; i++, k++) {
      T[k] = b.t[i]; LA[k] = b.lat[i]; LO[k] = b.lon[i];
      AC[k] = b.acc[i] == null ? NaN : b.acc[i];
      SP[k] = b.spd[i] == null ? NaN : b.spd[i];
    }
  }
  const idx = new Uint32Array(total);
  for (let i = 0; i < total; i++) idx[i] = i;
  idx.sort((a, b) => T[a] - T[b]);
  const out = { n: 0, t: new Float64Array(total), lat: new Float64Array(total), lon: new Float64Array(total),
    acc: new Float32Array(total), spd: new Float32Array(total) };
  let last = -Infinity;
  for (let j = 0; j < total; j++) {
    const i = idx[j];
    if (T[i] === last || !Number.isFinite(T[i])) continue;
    last = T[i];
    const n = out.n++;
    out.t[n] = T[i]; out.lat[n] = LA[i]; out.lon[n] = LO[i]; out.acc[n] = AC[i]; out.spd[n] = SP[i];
  }
  return out;
}

// ───────────────────────── Strassennetz ─────────────────────────
function buildRoads(data) {
  const W = data.ways.length;
  const wayClass = new Uint8Array(W), wayOne = new Uint8Array(W), wayName = new Uint32Array(W), wayLen = new Float32Array(W);
  const wayVert0 = new Uint32Array(W + 1);
  const vKey = [], vX = [], vY = [], vSeg = [];
  const wayChunk0 = new Uint32Array(W + 1);
  const lines = new Array(W);
  const sax = [], say = [], sbx = [], sby = [], segChunk = [];
  const chunkWay = [], chunkLen = [], chunkSeg0 = [];
  const classLen = new Float64Array(data.classes.length);
  const wayZH = new Uint8Array(W);
  let outerLen = 0;

  for (let w = 0; w < W; w++) {
    const row = data.ways[w];
    const cls = row[0] & 15;
    wayClass[w] = cls; wayOne[w] = (row[0] >> 4) & 3; wayName[w] = row[1];
    wayZH[w] = data.v >= 3 ? (row[0] >> 6) & 1 : 1;
    wayVert0[w] = vKey.length;
    wayChunk0[w] = chunkWay.length;
    const coords = [], X = [], Y = [];
    let ix = 0, iy = 0;
    for (let i = 2; i < row.length; i += 2) {
      ix += row[i]; iy += row[i + 1];
      const lon = ix / 1e5, lat = iy / 1e5;
      coords.push([lon, lat]); X.push(px(lon)); Y.push(py(lat));
      vKey.push(ix * 1e7 + iy);
    }
    lines[w] = coords;

    let acc = 0, total = 0, startSeg = sax.length;
    for (let i = 0; i < X.length; i++) { vX.push(X[i]); vY.push(Y[i]); }
    for (let i = 1; i < X.length; i++) {
      vSeg.push(sax.length);
      const ax = X[i - 1], ay = Y[i - 1], dx = X[i] - ax, dy = Y[i] - ay;
      const L = Math.hypot(dx, dy);
      if (L === 0) continue;
      const n = Math.max(1, Math.ceil(L / SUB));
      for (let k = 0; k < n; k++) {
        sax.push(ax + dx * k / n); say.push(ay + dy * k / n);
        sbx.push(ax + dx * (k + 1) / n); sby.push(ay + dy * (k + 1) / n);
        segChunk.push(chunkWay.length);
        acc += L / n; total += L / n;
        if (acc >= CHUNK) {
          chunkWay.push(w); chunkLen.push(acc); chunkSeg0.push(startSeg);
          startSeg = sax.length; acc = 0;
        }
      }
    }
    if (sax.length > startSeg) {
      const hasPrev = chunkWay.length > wayChunk0[w];
      if (hasPrev && acc < CHUNK / 2) {
        const last = chunkWay.length - 1;
        chunkLen[last] += acc;
        for (let s = startSeg; s < sax.length; s++) segChunk[s] = last;
      } else {
        chunkWay.push(w); chunkLen.push(acc); chunkSeg0.push(startSeg);
      }
    }
    vSeg.push(sax.length);
    wayLen[w] = total;
    if (wayZH[w]) classLen[cls] += total; else outerLen += total;
  }
  wayChunk0[W] = chunkWay.length;
  wayVert0[W] = vKey.length;
  chunkSeg0.push(sax.length);

  const S = sax.length;
  const SAX = Float32Array.from(sax), SAY = Float32Array.from(say), SBX = Float32Array.from(sbx), SBY = Float32Array.from(sby);
  const grid = new Map();
  for (let s = 0; s < S; s++) {
    const x0 = Math.floor((Math.min(SAX[s], SBX[s]) - MATCH_R) / CELL), x1 = Math.floor((Math.max(SAX[s], SBX[s]) + MATCH_R) / CELL);
    const y0 = Math.floor((Math.min(SAY[s], SBY[s]) - MATCH_R) / CELL), y1 = Math.floor((Math.max(SAY[s], SBY[s]) + MATCH_R) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const key = cellKey(cx, cy);
      let a = grid.get(key);
      if (!a) grid.set(key, a = []);
      a.push(s);
    }
  }
  let totalLen = 0;
  for (const l of classLen) totalLen += l;

  return {
    W, C: chunkWay.length, S, wayClass, wayOne, wayName, wayVert0,
    vKey: Float64Array.from(vKey), vX: Float32Array.from(vX), vY: Float32Array.from(vY), vSeg: Uint32Array.from(vSeg), wayLen, wayChunk0, lines, names: data.names,
    SAX, SAY, SBX, SBY, segChunk: Uint32Array.from(segChunk),
    chunkWay: Uint32Array.from(chunkWay), chunkLen: Float32Array.from(chunkLen), chunkSeg0: Uint32Array.from(chunkSeg0),
    grid, classLen, totalLen, outerLen, wayZH, version: data.generated, box: bbox(vX, vY),
  };
}
function bbox(X, Y) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < X.length; i++) { if (X[i] < x0) x0 = X[i]; if (X[i] > x1) x1 = X[i]; if (Y[i] < y0) y0 = Y[i]; if (Y[i] > y1) y1 = Y[i]; }
  return { x0, y0, x1, y1 };
}
// Liegt der Punkt im Gebiet mit Strassendaten? (margin in m)
function inRoadArea(lon, lat, margin = 0) {
  const x = px(lon), y = py(lat), b = R.box;
  return x >= b.x0 - margin && x <= b.x1 + margin && y >= b.y0 - margin && y <= b.y1 + margin;
}
function cellKey(cx, cy) { return (cx + 5000) * 10000 + (cy + 5000); }

// Nächstes Segment zu (x,y); optional mit Fahrtrichtung (hx,hy)
function nearestSeg(x, y, hx, hy, r, wide) {
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  let best = -1, bd = r * r;
  const span = wide ? 1 : 0;
  for (let ox = -span; ox <= span; ox++) for (let oy = -span; oy <= span; oy++) {
    const arr = R.grid.get(cellKey(cx + ox, cy + oy));
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      const ax = R.SAX[s], ay = R.SAY[s], dx = R.SBX[s] - ax, dy = R.SBY[s] - ay;
      const L2 = dx * dx + dy * dy;
      let u = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = ax + u * dx - x, ey = ay + u * dy - y, d2 = ex * ex + ey * ey;
      if (d2 >= bd) continue;
      if ((hx || hy) && L2 > 0 && Math.abs(dx * hx + dy * hy) / Math.sqrt(L2) < COS_HEADING) continue;
      bd = d2; best = s;
    }
  }
  return best;
}

// ───────────────────────── Abdeckung berechnen ─────────────────────────
// Verarbeitet alle Punktpaare ab Zeitpunkt tFrom. Idempotent: CF = frühester Zeitpunkt.
function processFrom(tFrom) {
  const { t, lat, lon, acc, n } = P;
  let i = Number.isFinite(tFrom) ? lowerBound(t, n, tFrom) : 0;
  if (i > 0) i--;
  let newly = 0, prev = -1;
  const mark = (c, ts) => {
    const cur = CF[c];
    if (cur === 0) { newly += R.chunkLen[c]; CF[c] = ts; }
    else if (ts < cur) CF[c] = ts;
  };
  for (; i < n; i++) {
    if (acc[i] > MAX_ACC) continue;
    if (prev >= 0) matchPair(t[prev], lat[prev], lon[prev], t[i], lat[i], lon[i], mark);
    prev = i;
  }
  return newly;
}

// Ordnet die Strecke zwischen zwei GPS-Punkten den Strassenstücken zu
function matchPair(t0, lat0, lon0, t1, lat1, lon1, mark) {
  const dt = t1 - t0;
  const ax = px(lon0), ay = py(lat0), bx = px(lon1), by = py(lat1);
  const d = Math.hypot(bx - ax, by - ay);
  const v = d / (dt / 1000);
  if (!(dt > 0 && dt <= MAX_GAP_T && d <= MAX_GAP_D && v >= MIN_SPEED && v <= MAX_SPEED)) return;
  const hx = (bx - ax) / d, hy = (by - ay) / d;
  const steps = Math.max(1, Math.ceil(d / STEP));
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    const s = nearestSeg(ax + (bx - ax) * f, ay + (by - ay) * f, hx, hy, MATCH_R, false);
    if (s >= 0) mark(R.segChunk[s], t0 + dt * f);
  }
}

async function saveCoverage() {
  await idb.set('coverage', { version: R.version, n: P.n, cf: CF.buffer.slice(0) });
}

// ───────────────────────── Fahrten & Statistik ─────────────────────────
function computeTrips() {
  const { t, lat, lon, acc, spd, n } = P;
  const trips = [];
  let cur = null, prev = -1, ref = -1;
  const close = () => { if (cur && cur.dist >= 500) trips.push(cur); };
  for (let i = 0; i < n; i++) {
    if (acc[i] > MAX_ACC) continue;
    if (prev < 0 || t[i] - t[prev] > TRIP_GAP) {
      close();
      cur = { start: t[i], end: t[i], dist: 0, moving: 0, maxSpd: 0, maxCalc: 0, newLen: 0 };
      ref = i;
    } else {
      const dt = t[i] - t[prev];
      const d = Math.hypot(px(lon[i]) - px(lon[prev]), py(lat[i]) - py(lat[prev]));
      const v = d / (dt / 1000);
      if (dt > 0 && v >= MIN_SPEED && v <= MAX_SPEED) {
        cur.dist += d; cur.moving += dt;
      }
      cur.end = t[i];
      // Geschwindigkeit über mind. 5 s gemittelt (für GPX ohne Geschwindigkeitsangabe)
      const rdt = t[i] - t[ref];
      if (rdt >= 5000) {
        const rv = Math.hypot(px(lon[i]) - px(lon[ref]), py(lat[i]) - py(lat[ref])) / (rdt / 1000);
        if (rdt <= 60000 && rv <= MAX_SPEED && rv > cur.maxCalc) cur.maxCalc = rv;
        ref = i;
      }
    }
    if (spd[i] > 0 && spd[i] < MAX_SPEED && !(acc[i] > 25) && spd[i] > cur.maxSpd) cur.maxSpd = spd[i];
    prev = i;
  }
  close();
  for (const tr of trips) tr.top = tr.maxSpd > 0 ? tr.maxSpd : tr.maxCalc;
  // Neu erkundete Strecke je Fahrt
  const starts = trips.map(tr => tr.start);
  for (let c = 0; c < R.C; c++) {
    const f = CF[c];
    if (!f) continue;
    const k = lowerBound(starts, starts.length, f + 1) - 1;
    if (k >= 0 && f <= trips[k].end + 1000) trips[k].newLen += R.chunkLen[c];
  }
  return trips;
}

function coverageStats() {
  const classDriven = new Float64Array(R.classLen.length);
  let driven = 0, drivenOuter = 0, drivenWeek = 0, drivenMonth = 0;
  const now = Date.now(), weekAgo = now - 7 * 864e5, monthAgo = now - 30 * 864e5;
  // Wochen-Balken (letzte 12 Wochen, ab Montag)
  const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weeks = new Float64Array(12);
  const w0 = monday.getTime() - 11 * 7 * 864e5;
  for (let c = 0; c < R.C; c++) {
    const f = CF[c];
    if (!f) continue;
    const L = R.chunkLen[c];
    const w = R.chunkWay[c];
    if (R.wayZH[w]) { driven += L; classDriven[R.wayClass[w]] += L; } else drivenOuter += L;
    if (f >= weekAgo) drivenWeek += L;
    if (f >= monthAgo) drivenMonth += L;
    if (f >= w0) weeks[Math.min(11, Math.floor((f - w0) / (7 * 864e5)))] += L;
  }
  return { driven, drivenOuter, drivenWeek, drivenMonth, classDriven, weeks, w0 };
}

// ───────────────────────── Karte ─────────────────────────
async function initMap() {
  let style;
  try {
    const r = await fetch(STYLE_URL);
    if (!r.ok) throw 0;
    style = await r.json();
    for (const l of style.layers) {
      if (l.type === 'line' && l['source-layer'] === 'transportation') {
        l.paint = { ...(l.paint || {}), 'line-opacity': 0.25 };
      }
    }
  } catch {
    style = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0e121a' } }] };
  }
  map = new maplibregl.Map({
    container: 'map', style, center: CENTER, zoom: 9.6, minZoom: 1.5, maxZoom: 19,
    dragRotate: false, pitchWithRotate: false, attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  geo = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: false });
  map.addControl(geo, 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© OpenStreetMap' }));

  await new Promise(res => map.on('load', res));
  const before = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
  map.addSource('network', { type: 'geojson', data: empty(), tolerance: 0.5 });
  map.addSource('driven', { type: 'geojson', data: empty(), tolerance: 0.3 });
  map.addSource('target', { type: 'geojson', data: empty() });

  const w = (a, b, c, d) => ['interpolate', ['exponential', 1.6], ['zoom'], 8, a, 12, b, 15, c, 18, d];
  const cf = ['match', ['get', 'c'], [0, 1], 1.6, [2, 3], 1.3, 1];
  const wc = (a, b, c, d) => ['interpolate', ['exponential', 1.6], ['zoom'], 8, ['*', cf, a], 12, ['*', cf, b], 15, ['*', cf, c], 18, ['*', cf, d]];
  map.addLayer({ id: 'network', type: 'line', source: 'network',
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: cfg.network ? 'visible' : 'none' },
    paint: { 'line-color': '#6f7a8c', 'line-opacity': 0.55,
      'line-width': wc(0.3, 0.9, 2.2, 6) } }, before);
  const col = ['case', ['get', 'r'], '#ffb300', '#00e5ff'];
  map.addLayer({ id: 'driven-glow', type: 'line', source: 'driven', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': col, 'line-opacity': 0.35, 'line-blur': w(2, 3, 5, 8), 'line-width': w(3, 5, 11, 26) } }, before);
  map.addLayer({ id: 'driven', type: 'line', source: 'driven', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': col, 'line-width': w(0.9, 1.8, 3.6, 9) } }, before);
  map.addLayer({ id: 'target-line', type: 'line', source: 'target', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ff3df2', 'line-width': w(3, 5, 9, 16), 'line-opacity': 0.85, 'line-dasharray': [1.5, 1] } });
  map.addLayer({ id: 'target-pt', type: 'circle', source: 'target', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 9, 'circle-color': '#ff3df2', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });

  map.addSource('tracks', { type: 'geojson', data: empty(), tolerance: 0.6 });
  map.addSource('live', { type: 'geojson', data: empty() });
  for (const src of ['tracks', 'live']) {
    map.addLayer({ id: `${src}-glow`, type: 'line', source: src, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#00e5ff', 'line-opacity': 0.3, 'line-blur': w(2, 3, 5, 8), 'line-width': w(3, 5, 11, 26) } }, 'driven-glow');
    map.addLayer({ id: src, type: 'line', source: src, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#00e5ff', 'line-width': w(1.2, 2, 3.6, 9) } }, 'driven-glow');
  }
  map.addSource('route', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2a0a2a', 'line-width': w(4, 6, 10, 18), 'line-opacity': 0.8 } });
  map.addLayer({ id: 'route', type: 'line', source: 'route', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ff3df2', 'line-width': w(2, 3.5, 6, 11) } });
  map.addLayer({ id: 'route-stops', type: 'circle', source: 'route', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#ff3df2', 'circle-stroke-width': 3 } });
  map.addSource('me', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'me-halo', type: 'circle', source: 'me', paint: { 'circle-radius': 18, 'circle-color': '#3d8bff', 'circle-opacity': 0.2 } });
  map.addLayer({ id: 'me', type: 'circle', source: 'me', paint: { 'circle-radius': 8, 'circle-color': '#3d8bff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
  map.on('dragstart', () => { if (drive.on) drive.followPause = Date.now() + 15000; });
  map.on('click', onMapClick);
  mapReady = true;
}
const empty = () => ({ type: 'FeatureCollection', features: [] });

function renderNetwork() {
  if (!mapReady) return;
  const feats = new Array(R.W);
  for (let w = 0; w < R.W; w++) feats[w] = { type: 'Feature', properties: { c: R.wayClass[w] }, geometry: { type: 'LineString', coordinates: R.lines[w] } };
  map.getSource('network').setData({ type: 'FeatureCollection', features: feats });
}

function renderDriven() {
  if (!mapReady) return;
  const feats = [];
  const recent = Date.now() - 7 * 864e5;
  for (let w = 0; w < R.W; w++) {
    const c0 = R.wayChunk0[w], c1 = R.wayChunk0[w + 1];
    let runStart = -1, runRecent = false;
    for (let c = c0; c <= c1; c++) {
      const on = c < c1 && CF[c] > 0;
      const rec = on && CF[c] >= recent;
      if (runStart >= 0 && (!on || rec !== runRecent)) {
        feats.push(chunkLine(runStart, c, runRecent));
        runStart = -1;
      }
      if (on && runStart < 0) { runStart = c; runRecent = rec; }
    }
  }
  map.getSource('driven').setData({ type: 'FeatureCollection', features: feats });
}
function chunkLine(cFrom, cTo, recent) {
  const s0 = R.chunkSeg0[cFrom], s1 = R.chunkSeg0[cTo];
  const coords = [[ux(R.SAX[s0]), uy(R.SAY[s0])]];
  for (let s = s0; s < s1; s++) coords.push([ux(R.SBX[s]), uy(R.SBY[s])]);
  return { type: 'Feature', properties: { r: recent }, geometry: { type: 'LineString', coordinates: coords } };
}

function onMapClick(e) {
  const { lng, lat } = e.lngLat;
  const s = nearestSeg(px(lng), py(lat), 0, 0, 35, true);
  let html;
  let dest = [lat, lng];
  if (s >= 0) {
    const c = R.segChunk[s], w = R.chunkWay[c];
    const name = R.names[R.wayName[w]] || CLASS_LABEL[R.wayClass[w]];
    const f = CF[c];
    const status = f ? `<span class="ok">Erkundet am ${new Date(f).toLocaleDateString('de-CH')}</span>` : '<span style="color:#ffb300">Noch nicht erkundet</span>';
    dest = [uy((R.SAY[s] + R.SBY[s]) / 2), ux((R.SAX[s] + R.SBX[s]) / 2)];
    html = `<b>${esc(name)}</b><br><span style="color:#8a93a3">${CLASS_LABEL[R.wayClass[w]]}</span><br>${status}`;
  } else {
    html = '<b>Kein erfasster Strassenabschnitt</b>';
  }
  html += `<br><a class="btn primary" style="margin-top:8px;padding:7px 10px" href="${navUrl(dest[0], dest[1])}" target="_blank" rel="noopener">Hierhin navigieren</a>`;
  new maplibregl.Popup({ closeButton: false, maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(html).addTo(map);
}

// ───────────────────────── Fahrspuren (weltweit) & Länder ─────────────────────────
let COUNTRIES = null, countriesLoading = null;
function loadCountries() {
  if (!countriesLoading) countriesLoading = fetch('geo/countries.json').then(r => r.json()).then(d => { COUNTRIES = d; return d; }).catch(() => null);
  return countriesLoading;
}
function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inCountry(c, lon, lat) {
  if (lon < c.b[0] || lon > c.b[2] || lat < c.b[1] || lat > c.b[3]) return false;
  for (const poly of c.p) {
    if (!inRing(poly[0], lon, lat)) continue;
    let hole = false;
    for (let k = 1; k < poly.length; k++) if (inRing(poly[k], lon, lat)) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}
function countryAt(lon, lat, hint) {
  if (!COUNTRIES) return null;
  if (hint && inCountry(hint, lon, lat)) return hint;
  for (const c of COUNTRIES) if (inCountry(c, lon, lat)) return c;
  return null;
}
const flag = c => c && c.length === 2 ? String.fromCodePoint(...[...c.toUpperCase()].map(ch => 0x1F1A5 + ch.charCodeAt(0))) : '🏳️';

// Linien der GPS-Spuren ausserhalb des Strassendaten-Gebiets + km pro Land
function computeTracks() {
  const { t, lat, lon, acc, n } = P;
  const lines = [], countries = new Map();
  let line = null, lastAdded = null, prev = -1, trip = 0, cHint = null, cAcc = 1e9, curC = null;
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const endLine = () => { if (line && line.length > 1) lines.push(line); line = null; lastAdded = null; };
  for (let i = 0; i < n; i++) {
    if (acc[i] > MAX_ACC) continue;
    if (lon[i] < x0) x0 = lon[i]; if (lon[i] > x1) x1 = lon[i]; if (lat[i] < y0) y0 = lat[i]; if (lat[i] > y1) y1 = lat[i];
    if (prev >= 0) {
      const dt = t[i] - t[prev];
      if (dt > TRIP_GAP) trip++;
      const d = haversine(lat[prev], lon[prev], lat[i], lon[i]);
      const v = d / (dt / 1000);
      const moving = dt > 0 && dt <= 5 * 60e3 && d <= 5000 && v >= MIN_SPEED && v <= MAX_SPEED;
      if (moving) {
        cAcc += d;
        if (cAcc >= 500 || !curC) { curC = countryAt(lon[i], lat[i], cHint) || curC; cHint = curC; cAcc = 0; }
        if (curC) {
          let e = countries.get(curC.c || curC.n);
          if (!e) countries.set(curC.c || curC.n, e = { name: curC.n, code: curC.c, dist: 0, trips: new Set() });
          e.dist += d; e.trips.add(trip);
        }
        const outside = !(inRoadArea(lon[prev], lat[prev]) && inRoadArea(lon[i], lat[i]));
        if (outside) {
          if (!line) { line = [[lon[prev], lat[prev]]]; lastAdded = prev; }
          if (haversine(lat[lastAdded], lon[lastAdded], lat[i], lon[i]) >= 25) { line.push([lon[i], lat[i]]); lastAdded = i; }
        } else endLine();
      } else if (!(dt > 0 && dt <= 5 * 60e3 && d <= 5000)) { endLine(); curC = null; }
    }
    prev = i;
  }
  endLine();
  return { lines, countries: [...countries.values()].sort((a, b) => b.dist - a.dist), bounds: n ? [[x0, y0], [x1, y1]] : null };
}
function haversine(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742018 * Math.asin(Math.sqrt(a));
}
let TRACKS = null;
function renderTracks() {
  TRACKS = computeTracks();
  if (!mapReady) return;
  map.getSource('tracks').setData({ type: 'FeatureCollection', features: TRACKS.lines.map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } })) });
}
function renderLive() {
  if (!mapReady) return;
  const b = drive.buf, c = [];
  if (b) for (let i = 0; i < b.t.length; i++) c.push([b.lon[i], b.lat[i]]);
  map.getSource('live').setData(c.length > 1 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } } : empty());
}
function showAllTrips() {
  if (!TRACKS?.bounds) { toast('Noch keine Fahrten'); return; }
  document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden'));
  map.fitBounds(TRACKS.bounds, { padding: { top: 140, bottom: 120, left: 40, right: 40 }, maxZoom: 14, duration: 900 });
}

// ───────────────────────── Erkunden ─────────────────────────
function navUrl(lat, lon) {
  const ll = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  return cfg.gmApp
    ? `comgooglemaps://?daddr=${ll}&directionsmode=driving`
    : `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`;
}

function getPosition() {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      p => res([p.coords.longitude, p.coords.latitude]),
      () => res(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}

function findTarget(lon, lat) {
  const wayDriven = new Float64Array(R.W);
  for (let c = 0; c < R.C; c++) if (CF[c]) wayDriven[R.chunkWay[c]] += R.chunkLen[c];
  const x = px(lon), y = py(lat);
  let best = -1, bd = Infinity;
  for (let c = 0; c < R.C; c++) {
    if (CF[c]) continue;
    const w = R.chunkWay[c];
    if (!cfg.motorway && R.wayClass[w] === 0) continue;
    if (explore.excludeWays.has(w)) continue;
    const nm = R.names[R.wayName[w]];
    if (nm && explore.excludeNames.has(nm)) continue;
    const L = R.wayLen[w], open = L - wayDriven[w];
    if (L < 40 || open < Math.min(150, L * 0.8)) continue;
    const s = R.chunkSeg0[c];
    const d2 = (R.SAX[s] - x) ** 2 + (R.SAY[s] - y) ** 2;
    if (d2 < bd) { bd = d2; best = c; }
  }
  if (best < 0) return null;
  const w = R.chunkWay[best];
  return { c: best, w, dist: Math.sqrt(bd), open: R.wayLen[w] - wayDriven[w] };
}

async function startExplore(next) {
  if (!R) return;
  if (!next) {
    explore = { excludeWays: new Set(), excludeNames: new Set(), origin: null };
    toast('Suche unerkundete Strasse …', 2000);
    const pos = await getPosition();
    explore.origin = pos || [map.getCenter().lng, map.getCenter().lat];
    if (!pos) toast('Kein Standort – verwende Kartenmitte', 2500);
  }
  if (!inRoadArea(explore.origin[0], explore.origin[1], 5000)) { toast('Erkunden geht vorerst nur in Zürich + Umgebung', 4000); return; }
  const t = findTarget(explore.origin[0], explore.origin[1]);
  if (!t) { toast('Keine unerkundete Strasse gefunden 🎉'); return; }
  explore.excludeWays.add(t.w);
  const name = R.names[R.wayName[t.w]];
  if (name) explore.excludeNames.add(name);

  // ganze Strasse (alle Stücke des Wegs) hervorheben
  const c0 = R.wayChunk0[t.w], c1 = R.wayChunk0[t.w + 1];
  const line = chunkLine(c0, c1, false);
  const s0 = R.chunkSeg0[t.c], s1 = R.chunkSeg0[t.c + 1];
  const sm = (s0 + s1) >> 1;
  const dLat = uy(R.SAY[sm]), dLon = ux(R.SAX[sm]);
  map.getSource('target').setData({ type: 'FeatureCollection', features: [line,
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [dLon, dLat] } }] });

  const b = new maplibregl.LngLatBounds(explore.origin, explore.origin);
  for (const p of line.geometry.coordinates) b.extend(p);
  map.fitBounds(b, { padding: { top: 140, bottom: 240, left: 50, right: 50 }, maxZoom: 16, duration: 900 });

  $('exKicker').textContent = `Unerkundet · ${CLASS_LABEL[R.wayClass[t.w]]}`;
  $('exTitle').textContent = name || 'Strasse ohne Namen';
  $('exSub').textContent = `${km(t.dist)} km Luftlinie · ${nf0.format(t.open)} m neu`;
  $('exNav').href = navUrl(dLat, dLon);
  $('exploreCard').classList.remove('hidden');
}

function closeExplore() {
  $('exploreCard').classList.add('hidden');
  if (mapReady) map.getSource('target').setData(empty());
}

// ───────────────────────── Routenplanung ─────────────────────────
// Geschätzte Fahrgeschwindigkeit je Strassenklasse (m/s) – bewusst eher vorsichtig
const SPEED = [25, 20, 13, 12.5, 11.5, 9.5, 8, 4.5];
const EDGE_PENALTY = 4;    // s je Kante (Kreuzungen, Abbiegen)
const MIN_NEW = 40;        // m – kürzere unerkundete Reste lohnen keinen Umweg
const STOPS_PER_LEG = 9;   // Google Maps: max. ~9 Stopps pro Route
let G = null;
let route = null;          // aktuelle Route
let routeUi = { mode: 'time', minutes: 45, radius: 3 };

function buildGraph() {
  const { W, wayVert0, vKey, vX, vY, vSeg } = R;
  const deg = new Map();
  for (let w = 0; w < W; w++) {
    const a = wayVert0[w], b = wayVert0[w + 1];
    for (let i = a; i < b; i++) deg.set(vKey[i], (deg.get(vKey[i]) || 0) + (i === a || i === b - 1 ? 2 : 1));
  }
  const nodeId = new Map(), nX = [], nY = [];
  const node = i => {
    let id = nodeId.get(vKey[i]);
    if (id === undefined) { id = nX.length; nodeId.set(vKey[i], id); nX.push(vX[i]); nY.push(vY[i]); }
    return id;
  };
  const eU = [], eV = [], eW = [], eS0 = [], eS1 = [], eLen = [], eCost = [], eDir = [], eC0 = [], eC1 = [];
  for (let w = 0; w < W; w++) {
    const a = wayVert0[w], b = wayVert0[w + 1];
    let start = a;
    for (let i = a + 1; i < b; i++) {
      if (i !== b - 1 && deg.get(vKey[i]) < 2) continue;
      const s0 = vSeg[start], s1 = vSeg[i];
      if (s1 > s0) {
        let len = 0;
        for (let s = s0; s < s1; s++) len += Math.hypot(R.SBX[s] - R.SAX[s], R.SBY[s] - R.SAY[s]);
        eU.push(node(start)); eV.push(node(i)); eW.push(w); eS0.push(s0); eS1.push(s1); eLen.push(len);
        eCost.push(len / SPEED[R.wayClass[w]] + EDGE_PENALTY); eDir.push(R.wayOne[w]);
        eC0.push(R.segChunk[s0]); eC1.push(R.segChunk[s1 - 1]);
      }
      start = i;
    }
  }
  const N = nX.length, E = eU.length;
  // Gerichtete Kanten (Arcs) als CSR, vorwärts und rückwärts
  const fwdCnt = new Uint32Array(N + 1), revCnt = new Uint32Array(N + 1);
  const arcs = []; // [from, to, edge, rev]
  for (let e = 0; e < E; e++) {
    if (eDir[e] !== 2) arcs.push(eU[e], eV[e], e, 0);
    if (eDir[e] !== 1) arcs.push(eV[e], eU[e], e, 1);
  }
  const A = arcs.length / 4;
  for (let k = 0; k < A; k++) { fwdCnt[arcs[4 * k] + 1]++; revCnt[arcs[4 * k + 1] + 1]++; }
  for (let n = 0; n < N; n++) { fwdCnt[n + 1] += fwdCnt[n]; revCnt[n + 1] += revCnt[n]; }
  const mk = cnt => ({ start: cnt, to: new Uint32Array(A), edge: new Uint32Array(A), rev: new Uint8Array(A) });
  const fwd = mk(fwdCnt), bwd = mk(revCnt);
  const fp = fwdCnt.slice(0, N), bp = revCnt.slice(0, N);
  for (let k = 0; k < A; k++) {
    const f = arcs[4 * k], t = arcs[4 * k + 1], e = arcs[4 * k + 2], r = arcs[4 * k + 3];
    let i = fp[f]++; fwd.to[i] = t; fwd.edge[i] = e; fwd.rev[i] = r;
    i = bp[t]++; bwd.to[i] = f; bwd.edge[i] = e; bwd.rev[i] = r;
  }
  const segLen = new Float32Array(R.S);
  for (let k = 0; k < R.S; k++) segLen[k] = Math.hypot(R.SBX[k] - R.SAX[k], R.SBY[k] - R.SAY[k]);
  return {
    segLen, N, E, nX: Float32Array.from(nX), nY: Float32Array.from(nY), fwd, bwd,
    eU: Uint32Array.from(eU), eV: Uint32Array.from(eV), eW: Uint32Array.from(eW), eS0: Uint32Array.from(eS0), eS1: Uint32Array.from(eS1),
    eLen: Float32Array.from(eLen), eCost: Float32Array.from(eCost), eDir: Uint8Array.from(eDir),
    eC0: Uint32Array.from(eC0), eC1: Uint32Array.from(eC1),
    dist: new Float64Array(N), stamp: new Uint32Array(N), gen: 0,
    prevNode: new Int32Array(N), prevEdge: new Int32Array(N), prevRev: new Uint8Array(N),
  };
}

// Binärer Min-Heap (Kosten, Knoten)
class Heap {
  constructor() { this.c = []; this.n = []; }
  get size() { return this.c.length; }
  push(cost, node) {
    const c = this.c, n = this.n; let i = c.length; c.push(cost); n.push(node);
    while (i > 0) { const p = (i - 1) >> 1; if (c[p] <= cost) break; c[i] = c[p]; n[i] = n[p]; i = p; }
    c[i] = cost; n[i] = node;
  }
  pop() {
    const c = this.c, n = this.n, top = n[0], lc = c.pop(), ln = n.pop(), len = c.length;
    if (len) {
      let i = 0;
      for (;;) { let k = 2 * i + 1; if (k >= len) break; if (k + 1 < len && c[k + 1] < c[k]) k++; if (c[k] >= lc) break; c[i] = c[k]; n[i] = n[k]; i = k; }
      c[i] = lc; n[i] = ln;
    }
    return top;
  }
  peekCost() { return this.c[0]; }
}

// Dijkstra; visit(node, dist) → true = abbrechen
function dijkstra(src, adj, limit, visit) {
  const g = G, gen = ++g.gen, dist = g.dist, stamp = g.stamp;
  const D = n => stamp[n] === gen ? dist[n] : Infinity;
  const h = new Heap();
  stamp[src] = gen; dist[src] = 0; g.prevNode[src] = -1; h.push(0, src);
  while (h.size) {
    const dc = h.peekCost(), n = h.pop();
    if (dc > D(n)) continue;
    if (dc > limit) break;
    if (visit && visit(n, dc)) break;
    for (let k = adj.start[n], ke = adj.start[n + 1]; k < ke; k++) {
      const m = adj.to[k], nd = dc + g.eCost[adj.edge[k]];
      if (nd < D(m)) {
        stamp[m] = gen; dist[m] = nd; g.prevNode[m] = n; g.prevEdge[m] = adj.edge[k]; g.prevRev[m] = adj.rev[k];
        h.push(nd, m);
      }
    }
  }
  return D;
}

function tracePath(target) {
  const steps = [];
  for (let n = target; G.prevNode[n] >= 0; n = G.prevNode[n]) steps.push({ e: G.prevEdge[n], rev: G.prevRev[n] });
  return steps.reverse();
}

async function planRoute(startLonLat, opts) {
  if (!G) { setLoading('Strassengraph wird aufgebaut …'); await tick(); G = buildGraph(); }
  setLoading('Route wird berechnet …'); await tick();
  const T = opts.mode === 'time' ? opts.minutes * 60 : 3 * 3600;
  const sx = px(startLonLat[0]), sy = py(startLonLat[1]);
  let sNode = -1, bd = Infinity;
  for (let n = 0; n < G.N; n++) {
    const d2 = (G.nX[n] - sx) ** 2 + (G.nY[n] - sy) ** 2;
    if (d2 < bd && G.fwd.start[n + 1] > G.fwd.start[n]) { bd = d2; sNode = n; }
  }
  if (sNode < 0 || bd > 2000 ** 2) return { error: 'Routenplanung geht vorerst nur in Zürich + Umgebung.' };

  // Erlaubte Zielkanten (im Umkreis, ohne Autobahn falls nicht gewünscht)
  const maxR2 = opts.mode === 'radius' ? (opts.radius * 1000) ** 2 : (T * 9 / 2) ** 2;
  const allowed = new Uint8Array(G.E);
  for (let e = 0; e < G.E; e++) {
    if (!cfg.motorway && R.wayClass[G.eW[e]] <= 1) continue;
    const s = (G.eS0[e] + G.eS1[e]) >> 1;
    if ((R.SAX[s] - sx) ** 2 + (R.SAY[s] - sy) ** 2 <= maxR2) allowed[e] = 1;
  }
  // metergenau auf Segmentebene: unerkundet und noch nicht eingeplant
  const planned = new Uint8Array(R.S);
  let gained = 0;
  const newLen = e => { let s = 0; for (let k = G.eS0[e]; k < G.eS1[e]; k++) if (!planned[k] && !CF[R.segChunk[k]]) s += G.segLen[k]; return s; };
  const mark = e => { for (let k = G.eS0[e]; k < G.eS1[e]; k++) if (!planned[k]) { planned[k] = 1; if (!CF[R.segChunk[k]]) gained += G.segLen[k]; } };
  let maxNew = 0;
  for (let e = 0; e < G.E; e++) if (allowed[e] && G.eLen[e] > maxNew) maxNew = G.eLen[e];

  // Distanz zurück zum Start (rückwärts-Dijkstra), als Kopie
  let toStart = null;
  if (opts.back) {
    const D = dijkstra(sNode, G.bwd, T);
    toStart = new Float64Array(G.N);
    for (let n = 0; n < G.N; n++) toStart[n] = D(n);
  }

  const steps = [];
  let cur = sNode, t = 0, iter = 0, lastYield = performance.now();
  for (; iter < 600; iter++) {
    let best = -1, bestRev = 0, bestScore = 0, bestFrom = -1, bestTT = 0;
    const remain = T - t;
    dijkstra(cur, G.fwd, remain, (n, dn) => {
      if (bestScore > 0 && bestScore * (dn + 30) >= maxNew) return true; // weiter weg kann nicht besser werden
      for (let k = G.fwd.start[n], ke = G.fwd.start[n + 1]; k < ke; k++) {
        const e = G.fwd.edge[k];
        if (!allowed[e]) continue;
        const nl = newLen(e);
        if (nl < MIN_NEW) continue;
        const tt = dn + G.eCost[e];
        if (tt > remain) continue;
        if (toStart && tt + toStart[G.fwd.to[k]] > remain) continue;
        const score = nl / (tt + 30);
        if (score > bestScore) { bestScore = score; best = e; bestRev = G.fwd.rev[k]; bestFrom = n; bestTT = tt; }
      }
      return false;
    });
    if (best < 0) break;
    // bestFrom wurde von Dijkstra endgültig besucht → Vorgängerkette ist gültig
    for (const st of tracePath(bestFrom)) { steps.push({ ...st, target: false }); mark(st.e); }
    steps.push({ e: best, rev: bestRev, target: true }); mark(best);
    t += bestTT;
    cur = bestRev ? G.eU[best] : G.eV[best];
    if (performance.now() - lastYield > 150) { await tick(); lastYield = performance.now(); }
  }
  if (opts.back && cur !== sNode) {
    const D = dijkstra(cur, G.fwd, Infinity, n => n === sNode);
    if (D(sNode) < Infinity) { for (const st of tracePath(sNode)) { steps.push({ ...st, target: false }); mark(st.e); } t += D(sNode); }
  }
  if (!steps.some(s => s.target)) return { error: 'Keine unerkundeten Strassen in Reichweite gefunden.' };

  // Ergebnis aufbereiten
  const coords = [];
  let totalLen = 0;
  for (const st of steps) {
    const pts = edgeCoords(st.e, st.rev);
    if (coords.length) pts.shift();
    coords.push(...pts);
    totalLen += G.eLen[st.e];
  }
  return { coords, steps, time: t, totalLen, gained, stops: routeStops(steps, opts.back ? startLonLat : null), leg: 0 };
}

function edgeCoords(e, rev) {
  const s0 = G.eS0[e], s1 = G.eS1[e];
  const pts = [[ux(R.SAX[s0]), uy(R.SAY[s0])]];
  for (let s = s0; s < s1; s++) pts.push([ux(R.SBX[s]), uy(R.SBY[s])]);
  return rev ? pts.reverse() : pts;
}

// Wegpunkte für Google Maps: je zusammenhängendem Abschnitt neuer Strassen ein Punkt (bei langen alle ~1.2 km)
function routeStops(steps, backTo) {
  const stops = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const pts = [];
    for (const st of run) { const c = edgeCoords(st.e, st.rev); if (pts.length) c.shift(); pts.push(...c); }
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(px(pts[i][0]) - px(pts[i - 1][0]), py(pts[i][1]) - py(pts[i - 1][1]));
    const n = Math.max(1, Math.round(len / 1200));
    for (let k = 0; k < n; k++) {
      const goal = len * (k + 0.5) / n;
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        acc += Math.hypot(px(pts[i][0]) - px(pts[i - 1][0]), py(pts[i][1]) - py(pts[i - 1][1]));
        if (acc >= goal) { stops.push(pts[i]); break; }
      }
    }
    run = [];
  };
  for (const st of steps) { if (st.target) run.push(st); else flush(); }
  flush();
  if (backTo) stops.push(backTo);
  return stops;
}

function legCount(r) { return Math.max(1, Math.ceil(r.stops.length / STOPS_PER_LEG)); }

function legUrl(r, leg) {
  const part = r.stops.slice(leg * STOPS_PER_LEG, (leg + 1) * STOPS_PER_LEG);
  const f = p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`;
  const dest = part[part.length - 1], via = part.slice(0, -1);
  if (cfg.gmApp) return `comgooglemaps://?daddr=${[...via, dest].map(f).join('+to:')}&directionsmode=driving`;
  return `https://www.google.com/maps/dir/?api=1&destination=${f(dest)}${via.length ? `&waypoints=${encodeURIComponent(via.map(f).join('|'))}` : ''}&travelmode=driving`;
}

// ── UI ──
function openRoutePanel() {
  closeExplore();
  $('routeResult').classList.add('hidden');
  renderRouteChips();
  $('routeCard').classList.remove('hidden');
}
function renderRouteChips() {
  document.querySelectorAll('#rtMode button').forEach(b => b.classList.toggle('on', b.dataset.mode === routeUi.mode));
  const opts = routeUi.mode === 'time' ? [15, 30, 45, 60, 90, 120] : [1, 2, 3, 5, 10];
  const cur = routeUi.mode === 'time' ? routeUi.minutes : routeUi.radius;
  $('rtChips').innerHTML = opts.map(v => `<button class="chip${v === cur ? ' on' : ''}" data-v="${v}">${routeUi.mode === 'time' ? (v < 60 ? `${v} Min` : `${v / 60} h`).replace('1.5 h', '1½ h') : `${v} km`}</button>`).join('');
}
async function runPlanner() {
  $('routeCard').classList.add('hidden');
  const pos = await getPosition();
  const start = pos || [map.getCenter().lng, map.getCenter().lat];
  if (!pos) toast('Kein Standort – plane ab Kartenmitte', 2500);
  let r;
  try { r = await planRoute(start, { ...routeUi, back: $('rtBack').checked }); }
  finally { setLoading(null); }
  if (r.error) { toast(r.error, 4000); $('routeCard').classList.remove('hidden'); return; }
  route = r;
  map.getSource('route').setData({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords } },
    ...r.stops.map((p, i) => ({ type: 'Feature', properties: { n: i + 1 }, geometry: { type: 'Point', coordinates: p } })),
  ] });
  const b = new maplibregl.LngLatBounds(start, start);
  for (const p of r.coords) b.extend(p);
  map.fitBounds(b, { padding: { top: 140, bottom: 260, left: 40, right: 40 }, duration: 900 });
  showRouteResult();
}
function showRouteResult() {
  if (!route) return;
  const legs = legCount(route);
  $('rtTitle').textContent = `${dur(route.time * 1000)} · ${km(route.totalLen)} km`;
  $('rtSub').textContent = `${km(route.gained)} km neue Strassen (${nf0.format(100 * route.gained / Math.max(1, route.totalLen))} %) · ${route.stops.length} Stopps`;
  $('rtNav').textContent = legs > 1 ? `Google Maps · Etappe ${route.leg + 1}/${legs}` : 'Navigieren mit Google Maps';
  $('rtNav').href = legUrl(route, route.leg);
  $('rtLegPrev').classList.toggle('hidden', legs < 2);
  $('rtLegNext').classList.toggle('hidden', legs < 2);
  $('routeResult').classList.remove('hidden');
}
function clearRoute() {
  route = null;
  $('routeResult').classList.add('hidden');
  if (mapReady) map.getSource('route').setData(empty());
}
function bindRouteUi() {
  $('routeBtn').addEventListener('click', openRoutePanel);
  $('rtClose').addEventListener('click', () => $('routeCard').classList.add('hidden'));
  $('rtMode').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { routeUi.mode = b.dataset.mode; renderRouteChips(); } });
  $('rtChips').addEventListener('click', e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    if (routeUi.mode === 'time') routeUi.minutes = +b.dataset.v; else routeUi.radius = +b.dataset.v;
    renderRouteChips();
  });
  $('rtGo').addEventListener('click', runPlanner);
  $('rtDiscard').addEventListener('click', clearRoute);
  $('rtDrive').addEventListener('click', () => { $('routeResult').classList.add('hidden'); startDrive(); });
  // Nach dem Öffnen von Google Maps automatisch zur nächsten Etappe weiterschalten
  $('rtNav').addEventListener('click', () => setTimeout(() => {
    if (route && route.leg < legCount(route) - 1) { route.leg++; showRouteResult(); }
  }, 1500));
  $('rtLegPrev').addEventListener('click', () => { if (route.leg > 0) { route.leg--; showRouteResult(); } });
  $('rtLegNext').addEventListener('click', () => { if (route.leg < legCount(route) - 1) { route.leg++; showRouteResult(); } });
}

// ───────────────────────── Fahrmodus ─────────────────────────
const drive = { on: false, watch: null, wake: null, last: null, buf: null, newLen: 0, followPause: 0, lastRender: 0, lastNameT: 0, speed: null };

async function startDrive() {
  if (!R || !mapReady || drive.on) return;
  if (!navigator.geolocation) { toast('Kein GPS verfügbar'); return; }
  Object.assign(drive, { on: true, last: null, buf: { t: [], lat: [], lon: [], acc: [], spd: [] }, newLen: 0, followPause: 0, speed: null });
  $('exploreCard').classList.add('hidden');
  document.body.classList.add('driving');
  updateDriveBar();
  await requestWake();
  drive.watch = navigator.geolocation.watchPosition(onDrivePos, onDriveErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

async function requestWake() {
  try {
    if ('wakeLock' in navigator) { drive.wake = await navigator.wakeLock.request('screen'); return; }
  } catch {}
  toast('Bildschirm bleibt evtl. nicht an – ggf. automatische Sperre ausschalten', 5000);
}

function onDrivePos(pos) {
  if (!drive.on) return;
  const c = pos.coords, t = pos.timestamp || Date.now();
  const lon = c.longitude, lat = c.latitude, acc = c.accuracy;
  drive.speed = c.speed != null && c.speed >= 0 ? c.speed : null;
  if (drive.speed == null && drive.last && t - drive.last.t >= 500) {
    drive.speed = Math.hypot(px(lon) - px(drive.last.lon), py(lat) - py(drive.last.lat)) / ((t - drive.last.t) / 1000);
  }
  map.getSource('me').setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } });
  if (Date.now() > drive.followPause) map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15), duration: 900 });

  if (!(acc > MAX_ACC)) {
    const b = drive.buf;
    b.t.push(t); b.lat.push(lat); b.lon.push(lon); b.acc.push(acc ?? null); b.spd.push(drive.speed);
    if (drive.last && t > drive.last.t) {
      let gained = 0, firstNew = -1;
      matchPair(drive.last.t, drive.last.lat, drive.last.lon, t, lat, lon, (ci, ts) => {
        if (CF[ci] === 0) { CF[ci] = ts; gained += R.chunkLen[ci]; if (firstNew < 0) firstNew = ci; }
        else if (ts < CF[ci]) CF[ci] = ts;
      });
      if (gained) {
        drive.newLen += gained;
        const now = Date.now();
        if (now - drive.lastRender > 3000) { drive.lastRender = now; renderDriven(); renderHud(); }
        const name = R.names[R.wayName[R.chunkWay[firstNew]]];
        if (name && now - drive.lastNameT > 5000) { drive.lastNameT = now; toast(`✦ Neu: ${name}`, 2500); }
      }
    }
    drive.last = { t, lat, lon };
    if (Date.now() - (drive.lastLive || 0) > 3000) { drive.lastLive = Date.now(); renderLive(); }
  }
  updateDriveBar();
}

function onDriveErr(e) {
  if (e.code === 1) { toast('Standortzugriff verweigert'); stopDrive(); }
}

function updateDriveBar() {
  $('drvSpeed').textContent = drive.speed == null ? '–' : nf0.format(drive.speed * 3.6);
  $('drvNew').textContent = km(drive.newLen);
}

async function stopDrive() {
  if (!drive.on) return;
  drive.on = false;
  if (drive.watch != null) navigator.geolocation.clearWatch(drive.watch);
  try { await drive.wake?.release(); } catch {}
  drive.wake = null;
  document.body.classList.remove('driving');
  map.getSource('me').setData(empty());
  if (drive.buf.t.length) {
    await idb.addBatch(drive.buf);
    batches.push(drive.buf);
    P = buildPoints(batches);
  }
  await saveCoverage();
  drive.buf = null; renderLive();
  renderDriven(); renderTracks(); renderHud(); renderDataInfo();
  toast(`Fahrmodus beendet · +${km(drive.newLen)} km neu`, 4000);
  if (route) showRouteResult();
}

// ───────────────────────── HUD & Statistik ─────────────────────────
function renderHud() {
  const st = coverageStats();
  $('hudPct').textContent = `${pct(st.driven, R.totalLen)} %`;
  $('hudBar').style.width = `${Math.min(100, 100 * st.driven / R.totalLen)}%`;
  const syncTxt = cfg.url ? (lastSync ? ` · Sync ${ago(lastSync)}` : ' · nicht synchronisiert') : ' · Empfänger nicht eingerichtet';
  $('hudSub').textContent = `${km(st.driven)} von ${km(R.totalLen)} km · +${km(st.drivenWeek)} km diese Woche${syncTxt}`;
  return st;
}

function renderStats() {
  const st = coverageStats();
  const trips = computeTrips();
  let dist = 0, moving = 0, top = 0, longest = 0, car = 0, moto = 0;
  for (const tr of trips) {
    dist += tr.dist; moving += tr.moving; top = Math.max(top, tr.top); longest = Math.max(longest, tr.dist);
    if (tags[tr.start] === 'moto') moto += tr.dist; else car += tr.dist;
  }
  const tile = (v, unit, l, cls = '') => `<div class="tile ${cls}"><div class="v">${v}${unit ? `<small>${unit}</small>` : ''}</div><div class="l">${l}</div></div>`;
  let h = '<div class="tiles">';
  h += tile(`${pct(st.driven, R.totalLen)}`, '%', `vom Kanton Zürich erkundet · ${km(st.driven)} von ${km(R.totalLen)} km`, 'big');
  if (R.outerLen > 0) h += tile(`${pct(st.drivenOuter, R.outerLen)}`, '%', `Umgebung (10 km um ZH) · ${km(st.drivenOuter)} von ${km(R.outerLen)} km`, 'big outer');
  h += tile(`+${km(st.drivenWeek)}`, 'km', 'neue Strassen (7 Tage)');
  h += tile(`+${km(st.drivenMonth)}`, 'km', 'neue Strassen (30 Tage)');
  h += tile(km(dist), 'km', 'insgesamt gefahren');
  h += tile(nf0.format(trips.length), '', 'Fahrten');
  h += tile(dur(moving), '', 'Fahrzeit');
  h += tile(km(longest), 'km', 'längste Fahrt');
  h += tile(nf0.format(top * 3.6), 'km/h', 'Höchstgeschw. (GPS)');
  h += tile(dist > 0 ? nf0.format(100 * st.driven / dist) : '0', '%', 'Anteil neue Strecke');
  h += tile(`🚗 ${km(car)}`, 'km', 'Auto');
  h += tile(`🏍️ ${km(moto)}`, 'km', 'Motorrad');
  h += '</div>';

  h += '<h3>Länder</h3>';
  if (!COUNTRIES) { h += '<div class="empty">Länder werden geladen …</div>'; loadCountries().then(() => { TRACKS = computeTracks(); renderStats(); }); }
  else if (!TRACKS?.countries.length) h += '<div class="empty">Noch keine Fahrten.</div>';
  else {
    const maxD = TRACKS.countries[0].dist;
    h += `<div class="hint">${TRACKS.countries.length} ${TRACKS.countries.length === 1 ? 'Land' : 'Länder'} befahren</div>`;
    for (const c of TRACKS.countries) {
      h += `<div class="cls"><div class="cls-top"><span>${flag(c.code)} ${esc(c.name)}</span><span>${km(c.dist)} km · ${c.trips.size} ${c.trips.size === 1 ? 'Fahrt' : 'Fahrten'}</span></div>
        <div class="bar"><div class="bar-fill" style="width:${100 * c.dist / maxD}%"></div></div></div>`;
    }
  }
  h += '<button class="btn" id="showAll" style="width:100%;margin-top:10px">🗺️ Alle Fahrten auf der Karte zeigen</button>';

  h += '<h3>Nach Strassentyp (Kanton Zürich)</h3>';
  for (const [label, cls] of GROUPS) {
    let tot = 0, drv = 0;
    for (const c of cls) { tot += R.classLen[c]; drv += st.classDriven[c]; }
    h += `<div class="cls"><div class="cls-top"><span>${label}</span><span>${pct(drv, tot)} % · ${km(drv)}/${km(tot)} km</span></div>
      <div class="bar"><div class="bar-fill" style="width:${tot ? 100 * drv / tot : 0}%"></div></div></div>`;
  }

  h += '<h3>Neue Strassen pro Woche (km)</h3><div class="weeks">';
  const maxW = Math.max(1, ...st.weeks);
  for (let i = 0; i < 12; i++) {
    const d = new Date(st.w0 + i * 7 * 864e5);
    h += `<div class="week"><div class="wv">${st.weeks[i] >= 50 ? nf0.format(st.weeks[i] / 1000) : ''}</div>
      <div class="col" style="height:${80 * st.weeks[i] / maxW}%"></div><div class="wl">${d.getDate()}.${d.getMonth() + 1}.</div></div>`;
  }
  h += '</div>';

  h += '<h3>Fahrten</h3>';
  if (!trips.length) h += '<div class="empty">Noch keine Fahrten. Richte Overland ein oder importiere GPX-Dateien.</div>';
  for (const tr of trips.slice().reverse().slice(0, 100)) {
    const moto = tags[tr.start] === 'moto';
    h += `<div class="trip"><button class="veh" data-trip="${tr.start}" title="Fahrzeug wechseln">${moto ? '🏍️' : '🚗'}</button>
      <div class="trip-main"><div class="trip-date">${dateFmt.format(tr.start)}</div>
      <div class="trip-meta">${timeFmt.format(tr.start)}–${timeFmt.format(tr.end)} · ${km(tr.dist)} km · ${dur(tr.moving)} · max ${nf0.format(tr.top * 3.6)} km/h</div></div>
      <div class="trip-new">+${km(tr.newLen)} km</div></div>`;
  }
  $('statsBody').innerHTML = h;
}

async function toggleVehicle(start) {
  const v = tags[start] === 'moto' ? null : 'moto';
  if (v) tags[start] = v; else delete tags[start];
  await idb.set('tags', tags);
  renderStats();
  if (cfg.url && cfg.token) api('/api/tags', { method: 'PUT', body: JSON.stringify({ start: +start, vehicle: v }) }).catch(() => toast('Fahrzeug konnte nicht synchronisiert werden'));
}

// ───────────────────────── Sync mit dem Worker ─────────────────────────
async function api(path, opts = {}) {
  const base = cfg.url.trim().replace(/\/+$/, '');
  const r = await fetch(base + path, { ...opts, headers: { Authorization: `Bearer ${cfg.token.trim()}`, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(r.status === 401 ? 'Token falsch' : `HTTP ${r.status}`);
  return r.json();
}

let syncing = false;
async function sync(manual) {
  if (!cfg.url || !cfg.token || syncing) return;
  syncing = true;
  try {
    let after = (await idb.get('lastId')) || 0;
    const got = [];
    for (;;) {
      const { points } = await api(`/api/points?after=${after}&limit=5000`);
      if (!points.length) break;
      got.push(...points);
      after = points[points.length - 1][0];
      if (points.length < 5000) break;
    }
    try {
      const r = await api('/api/tags');
      tags = r.tags || {};
      await idb.set('tags', tags);
    } catch {}
    lastSync = Date.now();
    if (got.length) {
      const b = { t: [], lat: [], lon: [], acc: [], spd: [] };
      for (const p of got) { b.t.push(p[1]); b.lat.push(p[2]); b.lon.push(p[3]); b.acc.push(p[4]); b.spd.push(p[5]); }
      await idb.addBatch(b);
      await idb.set('lastId', after);
      await ingest(b);
    } else if (manual) toast('Keine neuen Punkte');
    renderHud();
  } catch (e) {
    if (manual) toast(`Sync fehlgeschlagen: ${e.message}`);
    $('cfgStatus').innerHTML = `<span class="err">Sync fehlgeschlagen: ${esc(e.message)}</span>`;
  } finally { syncing = false; }
}

async function ingest(b) {
  batches.push(b);
  P = buildPoints(batches);
  let minT = Infinity;
  for (const t of b.t) if (t < minT) minT = t;
  const newly = processFrom(minT - 60e3);
  await saveCoverage();
  renderDriven(); renderTracks(); renderHud();
  if (!$('panel-stats').classList.contains('hidden')) renderStats();
  renderDataInfo();
  if (newly >= 20) toast(`+${km(newly)} km neue Strassen erkundet!`, 5000);
  return newly;
}

// ───────────────────────── GPX-Import ─────────────────────────
async function importGpx(files) {
  let total = 0;
  for (const f of files) {
    const xml = new DOMParser().parseFromString(await f.text(), 'application/xml');
    const b = { t: [], lat: [], lon: [], acc: [], spd: [] };
    for (const pt of xml.querySelectorAll('trkpt, rtept')) {
      const timeEl = [...pt.children].find(c => c.localName === 'time');
      const t = timeEl ? Date.parse(timeEl.textContent.trim()) : NaN;
      const lat = parseFloat(pt.getAttribute('lat')), lon = parseFloat(pt.getAttribute('lon'));
      if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const spEl = pt.getElementsByTagNameNS('*', 'speed')[0];
      const sp = spEl ? parseFloat(spEl.textContent) : NaN;
      b.t.push(t); b.lat.push(lat); b.lon.push(lon); b.acc.push(null); b.spd.push(Number.isFinite(sp) ? sp : null);
    }
    if (!b.t.length) { toast(`${f.name}: keine Punkte mit Zeitstempel`); continue; }
    total += b.t.length;
    await idb.addBatch(b);
    await ingest(b);
    if (cfg.url && cfg.token) uploadBatch(b).catch(() => toast('GPX nur lokal gespeichert (Upload fehlgeschlagen)'));
  }
  if (total) toast(`${nf0.format(total)} Punkte importiert`);
}

async function uploadBatch(b) {
  for (let i = 0; i < b.t.length; i += 1000) {
    const locations = [];
    for (let k = i; k < Math.min(b.t.length, i + 1000); k++) {
      locations.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [b.lon[k], b.lat[k]] },
        properties: { timestamp: new Date(b.t[k]).toISOString(), speed: b.spd[k] ?? -1, horizontal_accuracy: b.acc[k] ?? -1 } });
    }
    await api('/api/overland', { method: 'POST', body: JSON.stringify({ locations }) });
  }
}

// ───────────────────────── Einstellungen ─────────────────────────
function overlandUrl() {
  if (!cfg.url || !cfg.token) return '';
  return `${cfg.url.trim().replace(/\/+$/, '')}/api/overland?token=${encodeURIComponent(cfg.token.trim())}`;
}
function fillSettings() {
  $('cfgUrl').value = cfg.url; $('cfgToken').value = cfg.token;
  $('overlandUrl').value = overlandUrl() || '(zuerst Worker-URL und Token speichern)';
  $('optGmApp').checked = cfg.gmApp; $('optMotorway').checked = cfg.motorway; $('optNetwork').checked = cfg.network;
  renderDataInfo();
}
function renderDataInfo() {
  const last = P.n ? `, letzter ${new Date(P.t[P.n - 1]).toLocaleString('de-CH')}` : '';
  $('dataInfo').textContent = `${nf0.format(P.n)} GPS-Punkte gespeichert${last}. Strassendaten vom ${R ? new Date(R.version).toLocaleDateString('de-CH') : '–'}.`;
}
function randomToken() {
  const a = new Uint8Array(24); crypto.getRandomValues(a);
  return Array.from(a, x => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x % 56]).join('');
}

function bindUi() {
  document.querySelectorAll('[data-panel]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.panel;
    closeExplore();
    $('routeCard').classList.add('hidden');
    if (id === 'stats') renderStats();
    if (id === 'settings') fillSettings();
    $(`panel-${id}`).classList.remove('hidden');
  }));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('.sheet').classList.add('hidden')));
  $('exploreBtn').addEventListener('click', () => startExplore(false));
  $('exNext').addEventListener('click', () => startExplore(true));
  $('exClose').addEventListener('click', closeExplore);
  $('locateBtn').addEventListener('click', () => geo && geo.trigger());
  $('driveBtn').addEventListener('click', startDrive);
  bindRouteUi();
  $('drvStop').addEventListener('click', stopDrive);
  $('drvCenter').addEventListener('click', () => { drive.followPause = 0; if (drive.last) map.easeTo({ center: [drive.last.lon, drive.last.lat], zoom: 16 }); });
  $('statsBody').addEventListener('click', e => {
    if (e.target.closest('#showAll')) return showAllTrips();
    const b = e.target.closest('[data-trip]'); if (b) toggleVehicle(b.dataset.trip);
  });

  $('genToken').addEventListener('click', () => { $('cfgToken').value = randomToken(); });
  $('saveCfg').addEventListener('click', async () => {
    cfg.url = $('cfgUrl').value.trim(); cfg.token = $('cfgToken').value.trim(); saveCfg();
    $('overlandUrl').value = overlandUrl();
    $('cfgStatus').textContent = 'Teste Verbindung …';
    try {
      const r = await api('/api/ping');
      $('cfgStatus').innerHTML = `<span class="ok">✓ Verbunden – ${nf0.format(r.count)} Punkte auf dem Server.</span>`;
      sync(true);
    } catch (e) { $('cfgStatus').innerHTML = `<span class="err">✗ ${esc(e.message)}</span>`; }
  });
  $('syncNow').addEventListener('click', () => sync(true));
  $('copyOverland').addEventListener('click', async () => {
    const u = overlandUrl(); if (!u) return;
    try { await navigator.clipboard.writeText(u); toast('Kopiert'); } catch { $('overlandUrl').select(); }
  });
  $('optGmApp').addEventListener('change', e => { cfg.gmApp = e.target.checked; saveCfg(); });
  $('optMotorway').addEventListener('change', e => { cfg.motorway = e.target.checked; saveCfg(); });
  $('optNetwork').addEventListener('change', e => {
    cfg.network = e.target.checked; saveCfg();
    if (mapReady) map.setLayoutProperty('network', 'visibility', cfg.network ? 'visible' : 'none');
  });
  $('gpxInput').addEventListener('change', async e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) await importGpx(f); });
  $('recompute').addEventListener('click', async () => {
    setLoading('Berechne neu …'); await tick();
    CF = new Float64Array(R.C); processFrom(-Infinity); await saveCoverage();
    renderDriven(); renderHud(); setLoading(null); toast('Neu berechnet');
  });
  $('wipe').addEventListener('click', async () => {
    if (!confirm('Alle lokal gespeicherten GPS-Punkte löschen? (Daten auf dem Server bleiben erhalten und werden beim nächsten Sync neu geladen.)')) return;
    await idb.clear(); location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && drive.on) requestWake();
    if (document.visibilityState === 'visible' && Date.now() - lastSync > 60e3) sync(false);
  });
}

// ───────────────────────── Start ─────────────────────────
async function main() {
  bindUi();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  await idb.open();
  const mapP = initMap();

  setLoading('Strassennetz wird geladen …');
  try {
    const r = await fetch(ROADS_URL, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ROADS = await r.json();
  } catch (e) {
    setLoading(`Strassendaten konnten nicht geladen werden (${e.message}). Bitte später erneut öffnen.`);
    return;
  }
  setLoading('Strassennetz wird aufbereitet …'); await tick();
  R = buildRoads(ROADS);
  ROADS = null;

  setLoading('Fahrten werden geladen …'); await tick();
  batches = await idb.allBatches();
  P = buildPoints(batches);
  tags = (await idb.get('tags')) || {};

  const cov = await idb.get('coverage');
  if (cov && cov.version === R.version && cov.n === P.n && cov.cf && cov.cf.byteLength === R.C * 8) {
    CF = new Float64Array(cov.cf);
  } else {
    setLoading('Erkundete Strassen werden berechnet …'); await tick();
    CF = new Float64Array(R.C);
    processFrom(-Infinity);
    await saveCoverage();
  }

  await mapP;
  renderNetwork(); renderDriven(); renderTracks(); renderHud();
  loadCountries().then(() => { renderTracks(); if (!$('panel-stats').classList.contains('hidden')) renderStats(); });
  setLoading(null);
  if (!cfg.url) toast('Tipp: Empfänger unter ⚙ Optionen einrichten', 5000);
  sync(false);
  setInterval(() => { if (document.visibilityState === 'visible') { renderHud(); if (Date.now() - lastSync > 5 * 60e3) sync(false); } }, 60e3);
}

// Für Tests
window.__erkunder = { get R() { return R; }, get CF() { return CF; }, get P() { return P; }, computeTrips, coverageStats, findTarget, importGpx, drive, onDrivePos, planRoute, computeTracks, get TRACKS() { return TRACKS; }, get route() { return route; }, get G() { return G; } };

main();
})();

// Strassenjäger – Empfänger (Cloudflare Worker + D1)
//
// Benötigt:
//   D1-Binding  "DB"     (Datenbank, Tabellen werden automatisch angelegt)
//   Secret      "TOKEN"  (beliebige lange Zeichenkette)
//
// Endpunkte (alle brauchen ?token=… oder "Authorization: Bearer …"):
//   POST /api/overland        Overland-GPS-Punkte empfangen
//   GET  /api/points?after=ID Punkte abholen (nach Empfangs-ID)
//   GET  /api/tags            Fahrzeug-Zuordnung der Fahrten
//   PUT  /api/tags            {start, vehicle} setzen (vehicle null = löschen)
//   GET  /api/ping            Verbindungstest

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS points (
     id  INTEGER PRIMARY KEY AUTOINCREMENT,
     t   INTEGER NOT NULL UNIQUE,
     lat REAL NOT NULL, lon REAL NOT NULL,
     acc REAL, spd REAL)`,
  `CREATE TABLE IF NOT EXISTS tags (start INTEGER PRIMARY KEY, vehicle TEXT NOT NULL)`,
];
let schemaReady = false;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '') {
      return new Response('Strassenjäger Empfänger läuft.', { headers: CORS });
    }
    if (!env.TOKEN || !env.DB) return json({ error: 'TOKEN oder DB nicht konfiguriert' }, 500);

    const auth = req.headers.get('Authorization') || '';
    const token = url.searchParams.get('token') || auth.replace(/^Bearer\s+/i, '');
    if (!safeEqual(token, env.TOKEN)) return json({ error: 'unauthorized' }, 401);

    if (!schemaReady) {
      await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
      schemaReady = true;
    }

    try {
      switch (`${req.method} ${url.pathname}`) {
        case 'POST /api/overland': return await receive(req, env);
        case 'GET /api/points': return await points(url, env);
        case 'GET /api/tags': return await getTags(env);
        case 'PUT /api/tags': return await putTag(req, env);
        case 'GET /api/ping': {
          const r = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(t) AS last FROM points').first();
          return json({ ok: true, count: r.n, last: r.last });
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },
};

async function receive(req, env) {
  const body = await req.json();
  const rows = [];
  for (const f of body.locations || []) {
    const c = f?.geometry?.coordinates, p = f?.properties || {};
    if (f?.geometry?.type !== 'Point' || !Array.isArray(c) || p.type === 'trip') continue;
    const t = parseTime(p.timestamp);
    const lon = +c[0], lat = +c[1];
    if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const acc = num(p.horizontal_accuracy), spd = num(p.speed);
    rows.push([t, lat, lon, acc != null && acc >= 0 ? acc : null, spd != null && spd >= 0 ? spd : null]);
  }
  const stmt = env.DB.prepare('INSERT OR IGNORE INTO points (t, lat, lon, acc, spd) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < rows.length; i += 400) {
    await env.DB.batch(rows.slice(i, i + 400).map(r => stmt.bind(...r)));
  }
  // Overland löscht seine Warteschlange nur bei genau dieser Antwort
  return json({ result: 'ok', saved: rows.length });
}

async function points(url, env) {
  const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);
  const limit = Math.min(10000, Math.max(1, parseInt(url.searchParams.get('limit') || '5000', 10) || 5000));
  const { results } = await env.DB
    .prepare('SELECT id, t, lat, lon, acc, spd FROM points WHERE id > ? ORDER BY id LIMIT ?')
    .bind(after, limit).all();
  return json({ points: results.map(r => [r.id, r.t, r.lat, r.lon, r.acc, r.spd]) });
}

async function getTags(env) {
  const { results } = await env.DB.prepare('SELECT start, vehicle FROM tags').all();
  const tags = {};
  for (const r of results) tags[r.start] = r.vehicle;
  return json({ tags });
}

async function putTag(req, env) {
  const { start, vehicle } = await req.json();
  if (!Number.isFinite(+start)) return json({ error: 'start fehlt' }, 400);
  if (vehicle == null) await env.DB.prepare('DELETE FROM tags WHERE start = ?').bind(+start).run();
  else await env.DB.prepare('INSERT OR REPLACE INTO tags (start, vehicle) VALUES (?, ?)')
    .bind(+start, String(vehicle).slice(0, 20)).run();
  return json({ ok: true });
}

function parseTime(s) {
  if (typeof s === 'number') return s < 1e12 ? s * 1000 : s;
  if (typeof s !== 'string') return NaN;
  // "2026-11-08T10:00:00-0700" → "-07:00"
  return Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
}

function num(v) { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n; }

function safeEqual(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

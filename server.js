// Brickfall score server: a shared weekly leaderboard for the website.
// Needs DATABASE_URL (a Postgres connection string). Weeks reset Monday 00:00 Pacific.
const http = require('http');
const { Pool } = require('pg');

const PORT = process.env.PORT || 10000;
const DB_URL = process.env.DATABASE_URL || '';
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'https://brickfall.onrender.com').split(',').map(s => s.trim());
const pool = DB_URL ? new Pool({ connectionString: DB_URL, ssl: /\.render\.com/.test(DB_URL) ? { rejectUnauthorized: false } : false, max: 4 }) : null;

function weekKey(d = new Date()) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
    .formatToParts(d).forEach(x => (p[x.type] = x.value));
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day - wd)).toISOString().slice(0, 10);
}

let ready = null;
function init() {
  if (!pool) return Promise.reject(new Error('DATABASE_URL is not set'));
  if (!ready) ready = pool.query(`CREATE TABLE IF NOT EXISTS scores (
      pid TEXT NOT NULL, week DATE NOT NULL, name TEXT NOT NULL,
      score INTEGER NOT NULL, level INTEGER NOT NULL DEFAULT 1, bosses INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (pid, week));
    CREATE INDEX IF NOT EXISTS scores_week_score ON scores (week, score DESC);`).catch(e => { ready = null; throw e; });
  return ready;
}

// Simple per-IP limit on score posts.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 30;
}

function send(res, code, body, origin) {
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (origin && (ALLOWED.includes(origin) || ALLOWED.includes('*'))) { h['Access-Control-Allow-Origin'] = origin; h['Vary'] = 'Origin'; }
  res.writeHead(code, h); res.end(JSON.stringify(body));
}

async function board(pid) {
  await init();
  const wk = weekKey();
  const top = (await pool.query('SELECT pid,name,score,level,bosses FROM scores WHERE week=$1 ORDER BY score DESC, updated_at ASC LIMIT 10', [wk])).rows;
  const hof = (await pool.query(`SELECT DISTINCT ON (week) to_char(week,'YYYY-MM-DD') AS week,name,score FROM scores WHERE week<$1 ORDER BY week DESC, score DESC LIMIT 5`, [wk])).rows;
  const mine = pid ? (await pool.query('SELECT name,score,level,bosses FROM scores WHERE pid=$1 AND week=$2', [pid, wk])).rows[0] || null : null;
  return { week: wk, top: top.map(({ pid: p, ...r }) => ({ ...r, mine: p === pid })), hof, mine };
}

async function post(body) {
  const pid = String(body.pid || '');
  const name = String(body.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 14);
  const score = Math.floor(Number(body.score)), level = Math.floor(Number(body.level) || 1), bosses = Math.floor(Number(body.bosses) || 0);
  if (!/^[a-z0-9]{12,40}$/i.test(pid)) return [400, { error: 'Missing player id. Reload the page and try again.' }];
  if (!name) return [400, { error: 'Enter a name first.' }];
  if (!Number.isFinite(score) || score < 0 || score > 5000000) return [400, { error: 'That score looks wrong.' }];
  if (level < 1 || level > 999 || bosses < 0 || bosses > 333) return [400, { error: 'That run looks wrong.' }];
  await init();
  const wk = weekKey();
  const before = (await pool.query('SELECT score FROM scores WHERE pid=$1 AND week=$2', [pid, wk])).rows[0];
  const improved = !before || score > before.score;
  const row = (await pool.query(`INSERT INTO scores (pid,week,name,score,level,bosses) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (pid,week) DO UPDATE SET name=EXCLUDED.name,
      level=CASE WHEN EXCLUDED.score>scores.score THEN EXCLUDED.level ELSE scores.level END,
      bosses=CASE WHEN EXCLUDED.score>scores.score THEN EXCLUDED.bosses ELSE scores.bosses END,
      score=GREATEST(scores.score,EXCLUDED.score), updated_at=now()
    RETURNING score`, [pid, wk, name, score, level, bosses])).rows[0];
  const rank = +(await pool.query('SELECT COUNT(*)+1 AS r FROM scores WHERE week=$1 AND score>$2', [wk, row.score])).rows[0].r;
  return [200, { ok: true, improved, best: row.score, rank }];
}

http.createServer((req, res) => {
  const origin = req.headers.origin, url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    const h = { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
    if (origin && (ALLOWED.includes(origin) || ALLOWED.includes('*'))) { h['Access-Control-Allow-Origin'] = origin; h['Vary'] = 'Origin'; }
    res.writeHead(204, h); return res.end();
  }
  if (url.pathname === '/health') return send(res, 200, { ok: true, db: !!pool }, origin);
  if (req.method === 'GET' && url.pathname === '/api/board') {
    return board(String(url.searchParams.get('pid') || '')).then(d => send(res, 200, d, origin))
      .catch(e => { console.error(e); send(res, 503, { error: 'Leaderboard is unavailable.' }, origin); });
  }
  if (req.method === 'POST' && url.pathname === '/api/score') {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (limited(ip)) return send(res, 429, { error: 'Too many posts. Try again in a few minutes.' }, origin);
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2048) req.destroy(); });
    req.on('end', () => {
      let body; try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'Bad request.' }, origin); }
      post(body).then(([c, d]) => send(res, c, d, origin)).catch(e => { console.error(e); send(res, 503, { error: 'Leaderboard is unavailable.' }, origin); });
    });
    return;
  }
  send(res, 404, { error: 'Not found' }, origin);
}).listen(PORT, () => console.log('Brickfall score server on', PORT));

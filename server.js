// Cycle sync server: stores entries + full change history for the Cycle web app.
// Zero dependencies, Node >= 22.5 (node:sqlite).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8790);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WEB_DIR = path.join(__dirname, 'web');
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 30);
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP === '1';
// Single-person mode: no login, every request acts as the owner account. Set REQUIRE_AUTH=1 to turn passwords back on.
const OPEN = process.env.REQUIRE_AUTH !== '1';
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://paulshubko.github.io').split(',').map(s => s.trim()).filter(Boolean);

fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'cycle.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}', settings_ts INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used INTEGER);
CREATE TABLE IF NOT EXISTS entries (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                 -- YYYY-MM-DD
  data TEXT NOT NULL,                -- JSON
  deleted INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,               -- client edit time (ms), last-write-wins
  seq INTEGER NOT NULL,              -- server change counter, for incremental pulls
  PRIMARY KEY (user_id, day));
CREATE INDEX IF NOT EXISTS entries_seq ON entries(user_id, seq);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL, action TEXT NOT NULL, before TEXT, after TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now')), device TEXT);
CREATE INDEX IF NOT EXISTS history_user ON history(user_id, id DESC);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0);
`);

// ---------- auth ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function hashPass(p) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(p, salt, 32).toString('hex')}`;
}
function checkPass(p, stored) {
  const [, s, h] = stored.split('$');
  return crypto.timingSafeEqual(crypto.scryptSync(p, Buffer.from(s, 'hex'), 32), Buffer.from(h, 'hex'));
}
const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;
function createUser(name, pass) {
  const admin = userCount() === 0 ? 1 : 0;
  const id = db.prepare('INSERT INTO users (username, pass_hash, is_admin) VALUES (?, ?, ?)').run(name, hashPass(pass), admin).lastInsertRowid;
  if (admin) importSeed(id);
  return id;
}
// Imports seed.json (period history exported from another app) into the owner account, once.
function importSeed(userId) {
  const f = path.join(__dirname, 'seed.json');
  if (!fs.existsSync(f)) return;
  if (db.prepare('SELECT COUNT(*) n FROM history WHERE user_id = ?').get(userId).n > 0) return;
  const { periods = [] } = JSON.parse(fs.readFileSync(f, 'utf8'));
  const today = new Date().toISOString().slice(0, 10), ts = Date.now();
  let n = 0;
  for (const p of periods) {
    for (let i = 0; i < Math.min(p.days, 14); i++) {
      const day = new Date(Date.parse(p.start + 'T00:00:00Z') + i * 864e5).toISOString().slice(0, 10);
      if (day > today) continue;
      if (applyChange(userId, day, { flow: 3 }, ts, 'seed', 'import')) n++;
    }
  }
  console.log(`Imported ${n} days from seed.json`);
}

// CLI: node server.js adduser <name> <password> | passwd <name> <password> | users
if (['adduser', 'passwd', 'users'].includes(process.argv[2])) {
  const [, , cmd, name, pass] = process.argv;
  if (cmd === 'users') { console.table(db.prepare('SELECT id, username, is_admin, created_at FROM users').all()); process.exit(0); }
  if (!name || !pass || pass.length < 8) { console.error('Usage: node server.js adduser|passwd <name> <password(8+)>'); process.exit(1); }
  if (cmd === 'adduser') createUser(name, pass);
  else {
    db.prepare('UPDATE users SET pass_hash = ? WHERE username = ?').run(hashPass(pass), name);
    db.prepare('DELETE FROM tokens WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(name);
  }
  console.log(`OK: ${cmd} ${name}`); process.exit(0);
}
if (userCount() === 0 && process.env.INIT_USER && process.env.INIT_PASSWORD) {
  createUser(process.env.INIT_USER, process.env.INIT_PASSWORD);
  console.log(`Created user ${process.env.INIT_USER}`);
}

{ const owner = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get(); if (owner) setImmediate(() => importSeed(owner.id)); }

function getUser(req) {
  if (OPEN) {
    if (userCount() === 0) createUser('admin', crypto.randomBytes(24).toString('hex'));
    const u = db.prepare('SELECT id, username, settings, settings_ts FROM users ORDER BY id LIMIT 1').get();
    return { ...u, tokenHash: '' };
  }
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const h = sha(m[1]);
  const row = db.prepare('SELECT u.id, u.username, u.settings, u.settings_ts FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?').get(h);
  if (!row) return null;
  db.prepare('UPDATE tokens SET last_used = ? WHERE token_hash = ?').run(Date.now(), h);
  return { ...row, tokenHash: h };
}
function issueToken(userId, device) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO tokens (token_hash, user_id, device, last_used) VALUES (?,?,?,?)').run(sha(token), userId, device, Date.now());
  return token;
}
const attempts = new Map();
function limited(key) { const a = attempts.get(key); return a && a.until > Date.now(); }
function fail(key) { const n = (attempts.get(key)?.n || 0) + 1; attempts.set(key, { n, until: n >= 5 ? Date.now() + 10 * 60e3 : 0 }); }

// ---------- validation ----------
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const strArr = (max, len) => v => Array.isArray(v) && v.length <= max && v.every(s => typeof s === 'string' && s.length <= len);
const ALLOWED = {
  flow: v => [0, 1, 2, 3, 4].includes(v),
  symptoms: strArr(40, 40), mood: strArr(20, 40),
  pain: v => Number.isInteger(v) && v >= 0 && v <= 10,
  energy: v => [1, 2, 3, 4, 5].includes(v),
  discharge: v => typeof v === 'string' && v.length <= 30,
  temp: v => typeof v === 'number' && v > 34 && v < 43,
  weight: v => typeof v === 'number' && v > 20 && v < 400,
  sex: v => ['none', 'protected', 'unprotected'].includes(v),
  test: v => ['ovu_pos', 'ovu_neg', 'preg_pos', 'preg_neg'].includes(v),
  pill: v => typeof v === 'boolean',
  meds: v => typeof v === 'string' && v.length <= 300,
  note: v => typeof v === 'string' && v.length <= 2000,
};
function cleanEntry(d) {
  const out = {};
  if (!d || typeof d !== 'object') return out;
  for (const [k, ok] of Object.entries(ALLOWED)) if (d[k] !== undefined && d[k] !== null && ok(d[k])) out[k] = d[k];
  if (out.flow === 0) delete out.flow;
  return out;
}
function cleanSettings(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  for (const k of ['cycleLength', 'periodLength', 'lutealLength']) if (Number.isInteger(s[k]) && s[k] > 0 && s[k] < 90) out[k] = s[k];
  if (Array.isArray(s.customSymptoms)) out.customSymptoms = s.customSymptoms.filter(x => typeof x === 'string' && x.length <= 40).slice(0, 30);
  return out;
}

// ---------- writes (with history) ----------
function nextSeq() { db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'seq'").run(); return db.prepare("SELECT v FROM meta WHERE k = 'seq'").get().v; }
// Applies one change if it is newer than what we have. Returns true if applied.
function applyChange(userId, day, data, ts, device, action) {
  const prev = db.prepare('SELECT data, deleted, ts FROM entries WHERE user_id = ? AND day = ?').get(userId, day);
  if (prev && prev.ts >= ts && action !== 'restore') return false;
  const empty = Object.keys(data).length === 0;
  const prevData = prev && !prev.deleted ? prev.data : null;
  const json = empty ? '{}' : JSON.stringify(data);
  if ((prevData || '{}') === json) { // nothing changed in content; just bump ts
    if (prev) db.prepare('UPDATE entries SET ts = ? WHERE user_id = ? AND day = ?').run(ts, userId, day);
    return false;
  }
  db.prepare(`INSERT INTO entries (user_id, day, data, deleted, ts, seq) VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id, day) DO UPDATE SET data = excluded.data, deleted = excluded.deleted, ts = excluded.ts, seq = excluded.seq`)
    .run(userId, day, json, empty ? 1 : 0, ts, nextSeq());
  db.prepare('INSERT INTO history (user_id, day, action, before, after, device) VALUES (?,?,?,?,?,?)')
    .run(userId, day, action || (empty ? 'delete' : prevData ? 'update' : 'create'), prevData, empty ? null : json, device);
  return true;
}

// ---------- backups ----------
function backup() {
  const f = path.join(DATA_DIR, 'backups', `cycle-${new Date().toISOString().slice(0, 10)}.db`);
  if (fs.existsSync(f)) return;
  try { db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`); } catch (e) { console.error('backup failed', e.message); return; }
  const all = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter(n => n.startsWith('cycle-')).sort();
  for (const n of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) fs.rmSync(path.join(DATA_DIR, 'backups', n));
  console.log('backup ok', f);
}
backup();
setInterval(backup, 3600e3);

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
function cors(req) {
  const o = req.headers.origin;
  if (!o || !(ORIGINS.includes('*') || ORIGINS.includes(o))) return {};
  return { 'Access-Control-Allow-Origin': o, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Device', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Max-Age': '86400' };
}
function send(req, res, code, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...cors(req), ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readBody(req, limit = 10e6) {
  return new Promise((ok, bad) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { bad(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { bad(new Error('bad json')); } });
  });
}
const ipOf = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const deviceOf = req => String(req.headers['x-device'] || '').slice(0, 60);

async function api(req, res, url) {
  const p = url.pathname, R = (c, b, h) => send(req, res, c, b, h);
  if (req.method === 'OPTIONS') return R(204, '');
  if (p === '/api/health') return R(200, { ok: true, app: 'cycle', open: OPEN, signup: ALLOW_SIGNUP || userCount() === 0 });

  if ((p === '/api/login' || p === '/api/register') && req.method === 'POST') {
    const key = ipOf(req);
    if (limited(key)) return R(429, { error: 'Забагато спроб, зачекай 10 хвилин' });
    const { username, password } = await readBody(req);
    let name = String(username || '').trim().toLowerCase(); const pass = String(password || '');
    if (p === '/api/register' && !name) name = 'admin';
    if (p === '/api/register') {
      if (!(ALLOW_SIGNUP || userCount() === 0)) return R(403, { error: 'Реєстрація на цьому сервері вимкнена' });
      if (!/^[a-z0-9._-]{2,32}$/.test(name)) return R(400, { error: 'Логін: 2–32 символи, латиниця/цифри' });
      if (pass.length < 8) return R(400, { error: 'Пароль мінімум 8 символів' });
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return R(409, { error: 'Такий логін вже є' });
      const id = createUser(name, pass);
      return R(200, { token: issueToken(id, deviceOf(req)), username: name });
    }
    const u = name ? db.prepare('SELECT * FROM users WHERE username = ?').get(name)
                   : db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();
    if (!u || !checkPass(pass, u.pass_hash)) { fail(key); return R(401, { error: 'Невірний логін або пароль' }); }
    attempts.delete(key);
    return R(200, { token: issueToken(u.id, deviceOf(req)), username: u.username });
  }

  const user = getUser(req);
  if (!user) return R(401, { error: 'auth' });
  const device = deviceOf(req);

  if (p === '/api/logout' && req.method === 'POST') { db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(user.tokenHash); return R(200, { ok: true }); }

  if (p === '/api/sync' && req.method === 'POST') {
    // Push: {changes:[{day,data,ts}], settings?, settingsTs?, since}. Pull: everything with seq > since.
    const body = await readBody(req);
    const changes = Array.isArray(body.changes) ? body.changes.slice(0, 5000) : [];
    const now = Date.now();
    db.exec('BEGIN');
    try {
      for (const c of changes) {
        if (!DAY_RE.test(c?.day || '')) continue;
        const ts = Math.min(Number(c.ts) || now, now + 60e3); // no edits from the future
        applyChange(user.id, c.day, cleanEntry(c.data), ts, device, body.import ? 'import' : null);
      }
      if (body.settings && Number(body.settingsTs) > user.settings_ts) {
        db.prepare('UPDATE users SET settings = ?, settings_ts = ? WHERE id = ?').run(JSON.stringify(cleanSettings(body.settings)), Number(body.settingsTs), user.id);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const since = Number(body.since) || 0;
    const rows = db.prepare('SELECT day, data, deleted, ts, seq FROM entries WHERE user_id = ? AND seq > ? ORDER BY seq').all(user.id, since);
    const u = db.prepare('SELECT settings, settings_ts FROM users WHERE id = ?').get(user.id);
    const seq = db.prepare("SELECT v FROM meta WHERE k = 'seq'").get().v;
    return R(200, {
      seq, username: user.username,
      entries: rows.map(r => ({ day: r.day, data: r.deleted ? null : JSON.parse(r.data), ts: r.ts })),
      settings: JSON.parse(u.settings), settingsTs: u.settings_ts,
    });
  }
  if (p === '/api/history' && req.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare('SELECT id, day, action, before, after, at, device FROM history WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(user.id, before, limit);
    return R(200, rows.map(r => ({ ...r, before: r.before && JSON.parse(r.before), after: r.after && JSON.parse(r.after) })));
  }
  let m;
  if ((m = /^\/api\/history\/(\d+)\/restore$/.exec(p)) && req.method === 'POST') {
    const h = db.prepare('SELECT * FROM history WHERE id = ? AND user_id = ?').get(Number(m[1]), user.id);
    if (!h) return R(404, { error: 'not found' });
    applyChange(user.id, h.day, h.before ? JSON.parse(h.before) : {}, Date.now(), device, 'restore');
    return R(200, { ok: true, day: h.day });
  }
  if (p === '/api/devices' && req.method === 'GET') {
    return R(200, db.prepare('SELECT device, created_at, last_used FROM tokens WHERE user_id = ? ORDER BY last_used DESC').all(user.id));
  }
  return R(404, { error: 'not found' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    // The same web app is also served here, so it works without GitHub Pages too.
    let f = path.normalize(path.join(WEB_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(WEB_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(WEB_DIR, 'index.html');
    const ext = path.extname(f);
    send(req, res, 200, fs.readFileSync(f), { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(req, res, e.message === 'bad json' ? 400 : 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`Cycle sync on :${PORT}, data in ${DATA_DIR}, CORS: ${ORIGINS.join(', ')}`));

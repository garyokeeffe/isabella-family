'use strict';
// Isabella's log: feedings and diaper changes.
// One small Node server: static page + JSON API + CSV export.
// Storage: Firestore in production, a local JSON file when LOCAL_DATA_FILE is set.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const PASSCODE = process.env.PASSCODE || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const TZ_NAME = process.env.TZ_NAME || 'America/Phoenix';
const COOKIE = 'isabella_session';
const SESSION_DAYS = 365;
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!PASSCODE || !SESSION_SECRET) {
  console.error('PASSCODE and SESSION_SECRET must be set.');
  process.exit(1);
}

// ---------- storage ----------

function fileStore(file) {
  const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  const save = (d) => fs.writeFileSync(file, JSON.stringify(d, null, 2));
  return {
    async list(sinceIso) {
      return Object.values(load())
        .filter((e) => e.at >= sinceIso)
        .sort((a, b) => (a.at < b.at ? 1 : -1));
    },
    async all() {
      return Object.values(load()).sort((a, b) => (a.at < b.at ? -1 : 1));
    },
    async get(id) {
      return load()[id] || null;
    },
    async put(ev) {
      const d = load();
      d[ev.id] = ev;
      save(d);
    },
    async remove(id) {
      const d = load();
      delete d[id];
      save(d);
    },
  };
}

function firestoreStore() {
  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore({ ignoreUndefinedProperties: true });
  const col = db.collection('events');
  const rows = (snap) => snap.docs.map((d) => d.data());
  return {
    async list(sinceIso) {
      return rows(await col.where('at', '>=', sinceIso).orderBy('at', 'desc').get());
    },
    async all() {
      return rows(await col.orderBy('at', 'asc').get());
    },
    async get(id) {
      const d = await col.doc(id).get();
      return d.exists ? d.data() : null;
    },
    async put(ev) {
      await col.doc(ev.id).set(ev);
    },
    async remove(id) {
      await col.doc(id).delete();
    },
  };
}

const store = process.env.LOCAL_DATA_FILE
  ? fileStore(process.env.LOCAL_DATA_FILE)
  : firestoreStore();

// ---------- auth ----------

const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');

function makeSession() {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return `${exp}.${sign(exp)}`;
}

function validSession(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig) return false;
  const want = Buffer.from(sign(exp));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
  return Number(exp) > Date.now();
}

function passcodeOk(input) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(input), h(PASSCODE));
}

// Slow down passcode guessing: 10 wrong tries per address per 15 minutes.
const fails = new Map();
function throttled(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) {
    fails.delete(ip);
    return false;
  }
  return f.count >= 10;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > 15 * 60e3) fails.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

// ---------- validation ----------

const METHODS = ['breast_left', 'breast_right', 'breast_both'];
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function cleanEvent(input, existing) {
  const src = { ...(existing || {}), ...input };
  const out = { id: src.id, kind: src.kind };
  if (!ID_RE.test(String(out.id || ''))) throw new Error('bad id');
  if (out.kind !== 'feed' && out.kind !== 'diaper') throw new Error('kind must be feed or diaper');

  const at = new Date(src.at || Date.now());
  if (isNaN(at)) throw new Error('bad time');
  if (at.getTime() > Date.now() + 5 * 60e3) throw new Error('time is in the future');
  out.at = at.toISOString();

  out.by = String(src.by || '').trim().slice(0, 40);
  out.note = String(src.note || '').slice(0, 500);

  if (out.kind === 'diaper') {
    out.pee = !!src.pee;
    out.poop = !!src.poop;
    if (!out.pee && !out.poop) throw new Error('diaper needs pee or poop');
  } else {
    out.method = METHODS.includes(src.method) ? src.method : null;
  }
  out.created_at = (existing && existing.created_at) || new Date().toISOString();
  out.updated_at = new Date().toISOString();
  return out;
}

// ---------- export ----------

const CSV_COLS = ['id', 'at_utc', 'at_local', 'kind', 'pee', 'poop', 'method', 'by', 'note', 'created_at', 'updated_at'];

function localStamp(iso) {
  return new Date(iso).toLocaleString('sv-SE', { timeZone: TZ_NAME }); // YYYY-MM-DD HH:MM:SS
}

function toCsv(events) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from reading notes as formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLS.join(',')];
  for (const e of events) {
    const row = { ...e, at_utc: e.at, at_local: localStamp(e.at) };
    lines.push(CSV_COLS.map((c) => esc(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------- http ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 20000) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return send(res, 404, 'Not found');
  const file = path.join(PUBLIC_DIR, name);
  if (!fs.existsSync(file)) return send(res, 404, 'Not found');
  send(res, 200, fs.readFileSync(file), {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': name === 'index.html' ? 'no-cache' : 'public, max-age=86400',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  // Cloud Run appends the real client address last; earlier entries can be forged.
  const ip = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;

  if (p === '/healthz') return send(res, 200, 'ok');
  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    return serveStatic(res, p);
  }

  // Block cross-site form posts: API writes must be JSON from our own page.
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'cross-site request' });
  }

  if (p === '/api/login' && req.method === 'POST') {
    if (throttled(ip)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
    const body = await readJson(req);
    if (!passcodeOk(body.passcode || '')) {
      noteFail(ip);
      return send(res, 401, { error: 'Wrong passcode' });
    }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, {
      'Set-Cookie': `${COOKIE}=${makeSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`,
    });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0` });
  }

  if (!validSession(req)) return send(res, 401, { error: 'Sign in' });

  if (p === '/api/events' && req.method === 'GET') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 3, 1), 60);
    const since = new Date(Date.now() - days * 864e5).toISOString();
    return send(res, 200, { events: await store.list(since), now: new Date().toISOString() });
  }
  if (p === '/api/events' && req.method === 'POST') {
    const body = await readJson(req);
    let ev;
    try {
      // Same id sent twice (offline retry) just overwrites itself.
      ev = cleanEvent(body, ID_RE.test(String(body.id || '')) ? await store.get(body.id) : null);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    await store.put(ev);
    return send(res, 200, { event: ev });
  }
  const m = p.match(/^\/api\/events\/([A-Za-z0-9_-]{8,64})$/);
  if (m && req.method === 'DELETE') {
    await store.remove(m[1]);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/export.csv' && req.method === 'GET') {
    return send(res, 200, toCsv(await store.all()), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="isabella-log.csv"',
    });
  }
  return send(res, 404, { error: 'Not found' });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, e.message === 'bad json' || e.message === 'too large' ? 400 : 500, { error: 'Something went wrong' });
    });
  })
  .listen(PORT, () => console.log(`listening on ${PORT}`));

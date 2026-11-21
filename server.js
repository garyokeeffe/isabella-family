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
    async latest(n) {
      return Object.values(load()).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, n);
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

function firestoreStore(name) {
  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore({ ignoreUndefinedProperties: true });
  const col = db.collection(name);
  const rows = (snap) => snap.docs.map((d) => d.data());
  return {
    async list(sinceIso) {
      return rows(await col.where('at', '>=', sinceIso).orderBy('at', 'desc').get());
    },
    async all() {
      return rows(await col.orderBy('at', 'asc').get());
    },
    async latest(n) {
      return rows(await col.orderBy('at', 'desc').limit(n).get());
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

const makeStore = (name) =>
  process.env.LOCAL_DATA_FILE
    ? fileStore(name === 'events' ? process.env.LOCAL_DATA_FILE : process.env.LOCAL_DATA_FILE + '.' + name)
    : firestoreStore(name);
const store = makeStore('events');
const appts = makeStore('appointments');
const notes = makeStore('notes');        // free-standing notes and questions for the doctor
const pushSubs = makeStore('push');      // one row per phone that turned reminders on
const settings = makeStore('settings');  // reminder interval, push keys, last reminder sent

// ---------- feed reminders (push notifications) ----------

const webpush = require('web-push');
const CRON_KEY = process.env.CRON_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://isabella.family';
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
const NUDGE_EVERY_MS = 30 * 60e3;   // repeat until a feed starts
const GIVE_UP_AFTER_MS = 3 * 3600e3; // stop nudging this long after the first reminder was due

let vapidKeys = null;
async function getVapid() {
  if (vapidKeys) return vapidKeys;
  let doc = await settings.get('vapid');
  if (!doc) {
    // First run: make the key pair that identifies this app to the phones' push services, and keep it.
    const k = webpush.generateVAPIDKeys();
    await settings.put({ id: 'vapid', at: new Date().toISOString(), publicKey: k.publicKey, privateKey: k.privateKey });
    doc = await settings.get('vapid');
  }
  vapidKeys = doc;
  return doc;
}
async function getReminderConfig() {
  return (await settings.get('reminders')) || { id: 'reminders', at: new Date().toISOString(), hours: 3, last_for: null, last_sent: null };
}
const subId = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 40);

async function sendPush(sub, payload) {
  if (process.env.PUSH_DRY_RUN) {
    console.log('PUSH', sub.by, JSON.stringify(payload));
    return true;
  }
  const v = await getVapid();
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(payload), {
      vapidDetails: { subject: VAPID_SUBJECT, publicKey: v.publicKey, privateKey: v.privateKey },
      TTL: 1800,
      urgency: 'high',
    });
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) await pushSubs.remove(sub.id); // that phone turned notifications off
    else console.error('push failed', e.statusCode, String(e.body || e.message).slice(0, 200));
    return false;
  }
}

// Called every few minutes by Cloud Scheduler. Time is counted from the START of the last feed.
async function checkReminders() {
  const cfg = await getReminderConfig();
  const feeds = (await store.latest(12)).filter((e) => e.kind === 'feed');
  if (!feeds.length) return { sent: 0, why: 'no feeds yet' };
  if (feeds.some((e) => e.in_progress)) return { sent: 0, why: 'feeding now' };
  const last = feeds[0];
  const elapsed = Date.now() - new Date(last.at);
  const due = cfg.hours * 3600e3;
  if (elapsed < due) return { sent: 0, why: 'not due' };
  if (elapsed > due + GIVE_UP_AFTER_MS) return { sent: 0, why: 'gave up' };
  if (cfg.last_for === last.id && cfg.last_sent && Date.now() - new Date(cfg.last_sent) < NUDGE_EVERY_MS - 60e3) return { sent: 0, why: 'nudged recently' };

  const mins = Math.floor(elapsed / 60000);
  const ended = last.last_side || (last.method === 'breast_left' ? 'left' : last.method === 'breast_right' ? 'right' : null);
  const next = ended ? (ended === 'left' ? 'right' : 'left') : null;
  const payload = {
    title: 'Time to feed Isabella',
    body: `Last feed started ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m ago.` + (next ? ` Start on the ${next}.` : ''),
    tag: 'feed-reminder',
  };
  let sent = 0;
  for (const sub of await pushSubs.all()) if (await sendPush(sub, payload)) sent++;
  await settings.put({ ...cfg, last_for: last.id, last_sent: new Date().toISOString() });
  return { sent, why: 'due' };
}

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
    // A feed can be a running timer: `at` is when it started. While it runs, `side` is the breast in use,
    // `side_since` when she went onto it, and left_ms/right_ms the time already banked on each side.
    const num = (v, max) => {
      if (v === '' || v == null) return null;
      const n = Number(v);
      if (!isFinite(n) || n < 0 || n > max) throw new Error('bad number');
      return n;
    };
    const side = (v) => (v === 'left' || v === 'right' ? v : null);
    out.in_progress = !!src.in_progress;
    out.side = out.in_progress ? side(src.side) : null;
    const since = out.side && src.side_since ? new Date(src.side_since) : null;
    out.side_since = since && !isNaN(since) ? since.toISOString() : null;
    out.left_ms = num(src.left_ms, 864e5) || 0;
    out.right_ms = num(src.right_ms, 864e5) || 0;
    out.last_side = side(src.last_side);
    out.duration_min = out.in_progress ? null : num(src.duration_min, 600);
    out.left_min = out.in_progress ? null : num(src.left_min, 600);
    out.right_min = out.in_progress ? null : num(src.right_min, 600);
  }
  out.created_at = (existing && existing.created_at) || new Date().toISOString();
  out.updated_at = new Date().toISOString();
  return out;
}

function cleanAppointment(input, existing) {
  const src = { ...(existing || {}), ...input };
  const out = { id: src.id };
  if (!ID_RE.test(String(out.id || ''))) throw new Error('bad id');
  const at = new Date(src.at);
  if (isNaN(at)) throw new Error('Pick a date and time');
  out.at = at.toISOString();
  out.title = String(src.title || '').trim().slice(0, 80);
  if (!out.title) throw new Error('Say what the appointment is');
  out.where = String(src.where || '').trim().slice(0, 120);
  out.note = String(src.note || '').slice(0, 2000);       // older free-text notes; new notes live in the notes collection
  out.summary = String(src.summary || '').slice(0, 4000); // what the doctor said
  out.by = String(src.by || '').trim().slice(0, 40);
  out.created_at = (existing && existing.created_at) || new Date().toISOString();
  out.updated_at = new Date().toISOString();
  return out;
}

function cleanNote(input, existing) {
  const src = { ...(existing || {}), ...input };
  const out = { id: src.id };
  if (!ID_RE.test(String(out.id || ''))) throw new Error('bad id');
  out.text = String(src.text || '').trim().slice(0, 2000);
  if (!out.text) throw new Error('Write something first');
  out.is_question = !!src.is_question;
  out.appt_id = ID_RE.test(String(src.appt_id || '')) ? src.appt_id : null; // the visit it belongs to, once asked or answered
  out.asked = out.is_question && !!src.asked;
  out.answer = out.is_question ? String(src.answer || '').slice(0, 2000) : '';
  out.by = String(src.by || '').trim().slice(0, 40);
  const at = new Date((existing && existing.at) || src.at || Date.now());
  out.at = (isNaN(at) ? new Date() : at).toISOString();
  out.updated_at = new Date().toISOString();
  return out;
}

// Notes used to be one text box on each appointment. Copy those across once, each attached to its visit.
async function migrateAppointmentNotes() {
  if (await settings.get('notes_migrated')) return;
  for (const a of await appts.all()) {
    if (a.note && a.note.trim() && !(await notes.get('fromappt-' + a.id.slice(0, 50))))
      await notes.put(cleanNote({ id: 'fromappt-' + a.id.slice(0, 50), text: a.note, appt_id: a.id, by: a.by, at: a.created_at }));
  }
  await settings.put({ id: 'notes_migrated', at: new Date().toISOString() });
}

// ---------- export ----------

const CSV_COLS = ['id', 'at_utc', 'at_local', 'kind', 'pee', 'poop', 'duration_min', 'left_min', 'right_min', 'last_side', 'in_progress', 'by', 'note', 'created_at', 'updated_at'];

function localStamp(iso) {
  return new Date(iso).toLocaleString('sv-SE', { timeZone: TZ_NAME }); // YYYY-MM-DD HH:MM:SS
}

function toCsv(events, cols = CSV_COLS) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from reading notes as formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const e of events) {
    const row = { ...e, at_utc: e.at, at_local: localStamp(e.at) };
    lines.push(cols.map((c) => esc(row[c])).join(','));
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
  '.flac': 'audio/flac',
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

function serveStatic(req, res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return send(res, 404, 'Not found');
  const file = path.join(PUBLIC_DIR, name);
  if (!fs.existsSync(file)) return send(res, 404, 'Not found');
  const size = fs.statSync(file).size;
  const headers = {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': name === 'index.html' || name === 'sw.js' ? 'no-cache' : 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Accept-Ranges': 'bytes',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-ancestors 'none'",
  };
  // Phones ask for audio in byte ranges; iPhones will not play a sound without this.
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  // Cloud Run appends the real client address last; earlier entries can be forged.
  const ip = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;

  if (p === '/healthz') return send(res, 200, 'ok');
  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, p);
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

  if (p === '/api/cron/reminders' && req.method === 'POST') {
    const got = Buffer.from(String(req.headers['x-cron-key'] || '')), want = Buffer.from(CRON_KEY);
    if (!CRON_KEY || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return send(res, 403, { error: 'no' });
    return send(res, 200, await checkReminders());
  }

  if (!validSession(req)) return send(res, 401, { error: 'Sign in' });

  if (p === '/api/reminders' && req.method === 'GET') {
    return send(res, 200, { hours: (await getReminderConfig()).hours, publicKey: (await getVapid()).publicKey });
  }
  if (p === '/api/reminders' && req.method === 'POST') {
    const hours = Number((await readJson(req)).hours);
    if (!isFinite(hours) || hours < 1 || hours > 8) return send(res, 400, { error: 'Pick between 1 and 8 hours' });
    await settings.put({ ...(await getReminderConfig()), hours: Math.round(hours * 2) / 2 });
    return send(res, 200, { hours: Math.round(hours * 2) / 2 });
  }
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const body = await readJson(req), sub = body.subscription || {};
    let host = '';
    try { const u = new URL(sub.endpoint); if (u.protocol === 'https:') host = u.hostname; } catch {}
    if (!PUSH_HOSTS.test(host) || String(sub.endpoint).length > 1000 || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string')
      return send(res, 400, { error: 'This phone could not be set up for reminders' });
    const id = subId(sub.endpoint);
    await pushSubs.put({ id, at: new Date().toISOString(), by: String(body.by || '').slice(0, 40), subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) } } });
    return send(res, 200, { ok: true });
  }
  if ((p === '/api/push/unsubscribe' || p === '/api/push/test') && req.method === 'POST') {
    const id = subId(String((await readJson(req)).endpoint || ''));
    if (p === '/api/push/unsubscribe') { await pushSubs.remove(id); return send(res, 200, { ok: true }); }
    const sub = await pushSubs.get(id);
    if (!sub) return send(res, 404, { error: 'Reminders are not on for this phone' });
    const ok = await sendPush(sub, { title: 'Isabella', body: 'Test: reminders are working on this phone.', tag: 'test' });
    return send(res, ok ? 200 : 502, ok ? { ok: true } : { error: 'The notification could not be sent' });
  }

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
  if (p === '/api/appointments' && req.method === 'GET') {
    return send(res, 200, { appointments: await appts.all() });
  }
  if (p === '/api/appointments' && req.method === 'POST') {
    const body = await readJson(req);
    let a;
    try {
      a = cleanAppointment(body, ID_RE.test(String(body.id || '')) ? await appts.get(body.id) : null);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    await appts.put(a);
    return send(res, 200, { appointment: a });
  }
  const am = p.match(/^\/api\/appointments\/([A-Za-z0-9_-]{8,64})$/);
  if (am && req.method === 'DELETE') {
    await appts.remove(am[1]);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/notes' && req.method === 'GET') {
    await migrateAppointmentNotes();
    return send(res, 200, { notes: await notes.all() });
  }
  if (p === '/api/notes' && req.method === 'POST') {
    const body = await readJson(req);
    let n;
    try {
      n = cleanNote(body, ID_RE.test(String(body.id || '')) ? await notes.get(body.id) : null);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    await notes.put(n);
    return send(res, 200, { note: n });
  }
  const nm = p.match(/^\/api\/notes\/([A-Za-z0-9_-]{8,64})$/);
  if (nm && req.method === 'DELETE') {
    await notes.remove(nm[1]);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/notes.csv' && req.method === 'GET') {
    const cols = ['id', 'at_utc', 'at_local', 'text', 'is_question', 'asked', 'answer', 'appt_id', 'by', 'updated_at'];
    return send(res, 200, toCsv(await notes.all(), cols), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="isabella-notes.csv"',
    });
  }
  if (p === '/api/appointments.csv' && req.method === 'GET') {
    const cols = ['id', 'at_utc', 'at_local', 'title', 'where', 'summary', 'note', 'by', 'created_at', 'updated_at'];
    return send(res, 200, toCsv(await appts.all(), cols), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="isabella-appointments.csv"',
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

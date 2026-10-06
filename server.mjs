import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const origin = process.env.PUBLIC_ORIGIN;
const unisenderBase = process.env.NODE_ENV === 'test' && process.env.UNISENDER_API_BASE
  ? process.env.UNISENDER_API_BASE : 'https://api.unisender.com/ru/api';
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const required = ['PUBLIC_ORIGIN', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'UNISENDER_TRIGGER_URL', 'UNISENDER_API_KEY', 'UNISENDER_MARKETING_LIST_ID', 'CONSENT_VERSION'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
if (!/^https:\/\//.test(origin) && !/^http:\/\/localhost(?::\d+)?$/.test(origin)) throw new Error('PUBLIC_ORIGIN must be HTTPS (localhost excepted)');
const triggerUrl = new URL(process.env.UNISENDER_TRIGGER_URL);
const localTrigger = process.env.NODE_ENV === 'test' && triggerUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(triggerUrl.hostname);
if ((!localTrigger && (triggerUrl.protocol !== 'https:' || !['api.unisender.ru', 'api.unisender.com'].includes(triggerUrl.hostname))) || triggerUrl.username || triggerUrl.password) {
  throw new Error('UNISENDER_TRIGGER_URL must be an HTTPS UniSender API URL');
}
await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'requests.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS requests (
 id TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL,
 source TEXT NOT NULL, personal_data_consent INTEGER NOT NULL DEFAULT 0,
 marketing_consent INTEGER NOT NULL, consent_version TEXT NOT NULL,
 mail_status TEXT NOT NULL, marketing_status TEXT NOT NULL,
 mail_attempts INTEGER NOT NULL DEFAULT 0, marketing_attempts INTEGER NOT NULL DEFAULT 0,
 next_mail_at INTEGER NOT NULL, next_marketing_at INTEGER NOT NULL,
 mail_operation_id TEXT, marketing_operation_id TEXT,
 mail_error TEXT, marketing_error TEXT
);
CREATE INDEX IF NOT EXISTS requests_email_time ON requests(email, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_created ON requests(created_at DESC);
CREATE TABLE IF NOT EXISTS throttle (source TEXT PRIMARY KEY, created_ms INTEGER NOT NULL);`);
if (!db.prepare('PRAGMA table_info(requests)').all().some(column => column.name === 'personal_data_consent')) {
  db.exec('ALTER TABLE requests ADD COLUMN personal_data_consent INTEGER NOT NULL DEFAULT 0');
}

const insert = db.prepare(`INSERT INTO requests (id,email,created_at,source,personal_data_consent,marketing_consent,consent_version,mail_status,marketing_status,next_mail_at,next_marketing_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const latestEmail = db.prepare('SELECT created_at FROM requests WHERE email=? ORDER BY created_at DESC LIMIT 1');
const sourceHit = db.prepare('SELECT created_ms FROM throttle WHERE source=?');
const sourceUpsert = db.prepare('INSERT INTO throttle(source,created_ms) VALUES (?,?) ON CONFLICT(source) DO UPDATE SET created_ms=excluded.created_ms');
const due = db.prepare(`SELECT * FROM requests WHERE (mail_status IN ('pending','retry') AND next_mail_at<=?) OR (marketing_status IN ('pending','retry') AND next_marketing_at<=?) ORDER BY created_at LIMIT 10`);
const record = db.prepare('SELECT * FROM requests WHERE id=?');
const updateMail = db.prepare('UPDATE requests SET mail_status=?,mail_attempts=?,next_mail_at=?,mail_operation_id=?,mail_error=? WHERE id=?');
const updateMarketing = db.prepare('UPDATE requests SET marketing_status=?,marketing_attempts=?,next_marketing_at=?,marketing_operation_id=?,marketing_error=? WHERE id=?');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ttf': 'font/ttf' };

function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}
function same(a, b) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function admin(req, res) {
  const auth = req.headers.authorization || '';
  const encoded = auth.startsWith('Basic ') ? auth.slice(6) : '';
  let decoded = '';
  try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch {}
  const colon = decoded.indexOf(':');
  if (colon >= 0 && same(decoded.slice(0, colon), process.env.ADMIN_USERNAME) && same(decoded.slice(colon + 1), process.env.ADMIN_PASSWORD)) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Tarifikator requests"', 'Cache-Control': 'no-store' });
  res.end('Authorization required');
  return false;
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new Error('too_large');
  }
  try { return JSON.parse(raw); } catch { throw new Error('invalid_json'); }
}
async function unisender(method, fields) {
  const payload = new URLSearchParams({ format: 'json', api_key: process.env.UNISENDER_API_KEY, ...fields });
  const response = await fetch(`${unisenderBase}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: payload,
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const data = await response.json();
  if (data.error) {
    const code = String(data.code || 'rejected').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
    const error = new Error(`api_${code}`);
    error.contactNotFound = method === 'getContact' && (
      /^(contact_not_found|email_not_found|not_found|email_does_not_exist)$/i.test(code) ||
      /contact.*not found|email.*not found|контакт.*не найден|адрес.*не найден/i.test(String(data.error))
    );
    throw error;
  }
  return data.result;
}
async function triggerMail(email) {
  const response = await fetch(triggerUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const data = await response.json().catch(() => null);
  if (data?.success !== true) {
    if (!data?.error) throw new Error('trigger_unconfirmed');
    const code = String(data.code || 'rejected').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
    throw new Error(`trigger_${code}`);
  }
}
function retryAt(attempts) { return Date.now() + Math.min(60_000 * 2 ** (attempts - 1), 3_600_000); }
let processing = false;
async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    for (const item of due.all(Date.now(), Date.now())) {
      if (['pending', 'retry'].includes(item.mail_status) && item.next_mail_at <= Date.now()) {
        const attempts = item.mail_attempts + 1;
        // Claim before the external call. An interrupted in-flight trigger needs manual review to avoid a second letter.
        updateMail.run('sending', attempts, 0, null, null, item.id);
        try {
          await triggerMail(item.email);
          updateMail.run('triggered', attempts, 0, null, null, item.id);
        } catch (error) {
          const code = String(error.message).slice(0, 80);
          const uncertain = error.name === 'TimeoutError' || error.name === 'TypeError' || code === 'trigger_unconfirmed';
          const permanent = code.startsWith('trigger_') || /^http_4(?!29)/.test(code);
          const status = uncertain ? 'review' : permanent || attempts >= 5 ? 'failed' : 'retry';
          updateMail.run(status, attempts, uncertain ? 0 : retryAt(attempts), null, code, item.id);
        }
      }
      if (item.marketing_consent && ['pending', 'retry'].includes(item.marketing_status) && item.next_marketing_at <= Date.now()) {
        const attempts = item.marketing_attempts + 1;
        updateMarketing.run('sending', attempts, 0, null, null, item.id);
        try {
          let contact;
          try { contact = await unisender('getContact', { email: item.email, include_lists: '1' }); }
          catch (error) { if (!error.contactNotFound) throw error; }
          const oldStatus = contact?.lists?.find(list => String(list.id) === process.env.UNISENDER_MARKETING_LIST_ID)?.status;
          if (['unsubscribed', 'blocked'].includes(contact?.email?.status) || ['unsubscribed', 'blocked'].includes(oldStatus)) {
            updateMarketing.run('skipped_unsubscribed', attempts, 0, null, null, item.id);
            continue;
          }
          const result = await unisender('subscribe', {
            list_ids: process.env.UNISENDER_MARKETING_LIST_ID,
            'fields[email]': item.email, double_optin: '3', overwrite: '0'
          });
          updateMarketing.run('synced', attempts, 0, String(result?.person_id || ''), null, item.id);
        } catch (error) {
          const code = String(error.message).slice(0, 80);
          const permanent = code.startsWith('api_') || /^http_4(?!29)/.test(code);
          updateMarketing.run(permanent || attempts >= 5 ? 'failed' : 'retry', attempts, retryAt(attempts), null, code, item.id);
        }
      }
    }
  } finally { processing = false; }
}
setInterval(() => { processQueue().catch(error => console.error('Queue failure:', error.message)); }, 5000).unref();
processQueue().catch(error => console.error('Queue failure:', error.message));

async function serveFile(req, res, relative) {
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !mime[path.extname(file)]) return json(res, 404, { error: 'not_found' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  } catch { json(res, 404, { error: 'not_found' }); }
}
function rows(query) {
  const where = []; const args = [];
  if (query.get('email')) { where.push('email LIKE ?'); args.push(`%${query.get('email').slice(0, 254)}%`); }
  if (['0', '1'].includes(query.get('consent'))) { where.push('marketing_consent=?'); args.push(Number(query.get('consent'))); }
  if (query.get('from')) { where.push('created_at>=?'); args.push(query.get('from')); }
  if (query.get('to')) { where.push('created_at<?'); args.push(query.get('to') + 'T23:59:59.999Z'); }
  if (query.get('mailStatus')) { where.push('mail_status=?'); args.push(query.get('mailStatus')); }
  if (query.get('marketingStatus')) { where.push('marketing_status=?'); args.push(query.get('marketingStatus')); }
  const offset = Math.max(0, Math.min(100000, Number(query.get('offset')) || 0));
  return db.prepare(`SELECT * FROM requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 100 OFFSET ?`).all(...args, offset);
}
function csvCell(value) { const s = String(value ?? ''); return `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replaceAll('"', '""')}\"`; }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (req.method === 'POST' && url.pathname === '/api/demo-requests') {
      if (req.headers.origin !== origin) return json(res, 403, { error: 'origin' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'content_type' });
      let input;
      try { input = await body(req); } catch { return json(res, 400, { error: 'invalid_body' }); }
      const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
      if (!isEmail(email) || typeof input.marketingConsent !== 'boolean') return json(res, 422, { error: 'validation' });
      if (input.personalDataConsent !== true) return json(res, 422, { error: 'consent_required' });
      const now = Date.now();
      const prior = latestEmail.get(email);
      const waitEmail = prior ? 60000 - (now - Date.parse(prior.created_at)) : 0;
      const ip = String(req.socket.remoteAddress || 'unknown');
      const source = sourceHit.get(ip);
      const waitSource = source ? 3000 - (now - source.created_ms) : 0;
      const wait = Math.max(waitEmail, waitSource);
      if (wait > 0) return json(res, 429, { error: 'rate_limit', retryAfter: Math.ceil(wait / 1000) }, { 'Retry-After': String(Math.ceil(wait / 1000)) });
      const id = randomUUID();
      db.exec('BEGIN IMMEDIATE');
      try {
        insert.run(id, email, new Date(now).toISOString(), 'promo', 1, Number(input.marketingConsent), process.env.CONSENT_VERSION, 'pending', input.marketingConsent ? 'pending' : 'not_requested', now, now);
        sourceUpsert.run(ip, now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      json(res, 202, { status: 'accepted' });
      processQueue().catch(error => console.error('Queue failure:', error.message));
      return;
    }
    if (url.pathname.startsWith('/api/admin/') || url.pathname === '/admin') {
      if (!admin(req, res)) return;
      if (req.method === 'GET' && url.pathname === '/admin') return serveFile(req, res, 'admin.html');
      if (req.method === 'GET' && url.pathname === '/api/admin/requests') return json(res, 200, rows(url.searchParams));
      if (req.method === 'GET' && url.pathname === '/api/admin/requests.csv') {
        const columns = ['id', 'email', 'created_at', 'source', 'personal_data_consent', 'marketing_consent', 'consent_version', 'mail_status', 'marketing_status', 'mail_attempts', 'marketing_attempts', 'mail_operation_id', 'marketing_operation_id', 'mail_error', 'marketing_error'];
        const all = db.prepare(`SELECT ${columns.join(',')} FROM requests ORDER BY created_at DESC`).all();
        const csv = [columns.join(','), ...all.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="demo-requests.csv"', 'Cache-Control': 'no-store' });
        return res.end('\uFEFF' + csv);
      }
      const retry = url.pathname.match(/^\/api\/admin\/requests\/([a-f0-9-]+)\/retry$/);
      if (req.method === 'POST' && retry) {
        if (req.headers.origin !== origin) return json(res, 403, { error: 'origin' });
        const item = record.get(retry[1]);
        if (!item) return json(res, 404, { error: 'not_found' });
        const target = url.searchParams.get('target');
        if (target === 'mail' && ['failed', 'review', 'sending'].includes(item.mail_status)) updateMail.run('pending', item.mail_attempts, Date.now(), null, null, item.id);
        else if (target === 'marketing' && item.marketing_consent && ['failed', 'review', 'sending'].includes(item.marketing_status)) updateMarketing.run('pending', item.marketing_attempts, Date.now(), null, null, item.id);
        else return json(res, 409, { error: 'not_retryable' });
        processQueue().catch(error => console.error('Queue failure:', error.message));
        return json(res, 200, { status: 'queued' });
      }
      return json(res, 404, { error: 'not_found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' });
    if (url.pathname === '/') return serveFile(req, res, 'index.html');
    if (/^\/(assets|css|fonts)\/[a-zA-Z0-9._/-]+$/.test(url.pathname) && !url.pathname.includes('..')) return serveFile(req, res, url.pathname.slice(1));
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('Request failure:', error.message);
    if (!res.headersSent) json(res, 500, { error: 'server' });
  }
});
server.listen(port, () => console.log(`Tarifikator listening on ${port}`));

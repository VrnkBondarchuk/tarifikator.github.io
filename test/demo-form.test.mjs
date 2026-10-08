import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function eventually(check) {
  for (let i = 0; i < 60; i++) {
    try { if (await check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server');
}

test('demo requests persist, mail is separate from optional marketing consent, and repeat is limited', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tarifikator-test-'));
  const appPort = await freePort();
  const apiPort = await freePort();
  const calls = [];
  const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const method = req.url.startsWith('/triggerBlock/') ? 'triggerBlock' : req.url.split('/').at(-1);
    calls.push({ method, params: method === 'triggerBlock' ? null : new URLSearchParams(raw), json: method === 'triggerBlock' ? JSON.parse(raw) : null });
    res.setHeader('Content-Type', 'application/json');
    if (method === 'triggerBlock') {
      res.end(JSON.stringify(calls.at(-1).json.email === 'rejected@example.test'
        ? { error: 'Invalid contact', code: 'invalid_arg' } : { success: true }));
    }
    else if (method === 'getContact') res.end(JSON.stringify({ error: 'Contact not found', code: 'contact_not_found' }));
    else res.end(JSON.stringify({ result: { person_id: 42 } }));
  });
  await new Promise(resolve => mock.listen(apiPort, '127.0.0.1', resolve));
  const origin = `http://localhost:${appPort}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', PORT: String(appPort), PUBLIC_ORIGIN: origin,
      DATA_DIR: dir, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password',
      UNISENDER_API_BASE: `http://127.0.0.1:${apiPort}`,
      UNISENDER_API_KEY: 'test', UNISENDER_TRIGGER_URL: `http://127.0.0.1:${apiPort}/triggerBlock/test`,
      UNISENDER_MARKETING_LIST_ID: '3',
      CONSENT_VERSION: 'test-v1' }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let childError = '';
  child.stderr.on('data', chunk => { childError += chunk; });
  let completed = false;
  try {
    try { await eventually(async () => (await fetch(origin)).ok); }
    catch (error) { throw new Error(`${error.message}: ${childError.trim()}`); }
    const page = await fetch(origin);
    const html = await page.text();
    assert.match(html, /<title>Тарификатор<\/title>/);
    assert.ok(html.includes('<meta name="description" content="Тарификатор — онлайн-программа для тарификации и комплектования в школе. Помогает директорам распределять нагрузку между педагогами, обновлять учебные часы, готовить ведомости и финансовые отчёты для бухгалтерии.">'));
    assert.equal(page.headers.get('x-robots-tag'), null);
    const favicon = await fetch(origin + '/favicon/favicon.svg');
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get('content-type'), 'image/svg+xml');
    const manifest = await fetch(origin + '/favicon/site.webmanifest');
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
    const robots = await fetch(origin + '/robots.txt');
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type'), /^text\/plain; charset=utf-8$/);
    assert.equal(await robots.text(), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
    const sitemap = await fetch(origin + '/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type'), /^application\/xml; charset=utf-8$/);
    const xml = await sitemap.text();
    assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.ok(xml.includes(`<loc>${origin}/</loc>`));
    assert.equal((xml.match(/<loc>/g) || []).length, 1);
    const robotsHead = await fetch(origin + '/robots.txt', { method: 'HEAD' });
    assert.equal(robotsHead.status, 200);
    assert.equal(await robotsHead.text(), '');
    const sitemapHead = await fetch(origin + '/sitemap.xml', { method: 'HEAD' });
    assert.equal(sitemapHead.status, 200);
    assert.equal(await sitemapHead.text(), '');
    const post = (email, marketingConsent, personalDataConsent = true) => fetch(origin + '/api/demo-requests', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, marketingConsent, personalDataConsent })
    });
    assert.equal((await post('bad', false)).status, 422);
    assert.equal((await post('no-consent@example.test', false, false)).status, 422);
    assert.equal((await post('first@example.test', false)).status, 202);
    assert.equal((await post('first@example.test', true)).status, 429);
    await eventually(() => calls.some(call => call.method === 'triggerBlock'));
    assert.equal(calls.filter(call => call.method === 'subscribe').length, 0);
    const unauthorized = await fetch(origin + '/api/admin/requests');
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('x-robots-tag'), 'noindex, nofollow');
    const adminPage = await fetch(origin + '/admin');
    assert.equal(adminPage.status, 401);
    assert.equal(adminPage.headers.get('x-robots-tag'), 'noindex, nofollow');
    await new Promise(resolve => setTimeout(resolve, 3100));
    assert.equal((await post('second@example.test', true)).status, 202);
    await eventually(() => calls.some(call => call.method === 'subscribe'));
    const auth = { Authorization: 'Basic ' + Buffer.from('admin:test-password').toString('base64') };
    const authorizedAdminPage = await fetch(origin + '/admin', { headers: auth });
    assert.equal(authorizedAdminPage.status, 200);
    assert.equal(authorizedAdminPage.headers.get('x-robots-tag'), 'noindex, nofollow');
    const list = await fetch(origin + '/api/admin/requests', { headers: auth });
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('x-robots-tag'), 'noindex, nofollow');
    const rows = await list.json();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.personal_data_consent), [1, 1]);
    assert.deepEqual(rows.map(row => row.marketing_consent).sort(), [0, 1]);
    assert.equal(calls.filter(call => call.method === 'triggerBlock').length, 2);
    assert.equal(calls.filter(call => call.method === 'subscribe').length, 1);
    assert.deepEqual(calls.find(call => call.method === 'triggerBlock').json, { email: 'first@example.test' });
    assert.equal(calls.find(call => call.method === 'subscribe').params.get('list_ids'), '3');
    assert.deepEqual(rows.map(row => row.mail_status), ['triggered', 'triggered']);
    await new Promise(resolve => setTimeout(resolve, 3100));
    assert.equal((await post('rejected@example.test', false)).status, 202);
    await eventually(async () => {
      const response = await fetch(origin + '/api/admin/requests?email=rejected@example.test', { headers: auth });
      const [item] = await response.json();
      return item?.mail_status === 'failed' && item.mail_error === 'trigger_invalid_arg';
    });
    completed = true;
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => mock.close(resolve));
    const db = new DatabaseSync(path.join(dir, 'requests.sqlite'));
    if (completed) assert.equal(db.prepare('SELECT count(*) AS count FROM requests').get().count, 3);
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

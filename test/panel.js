import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { startPanel } from '../src/core/panel/index.js';

const calls = [];
const state = { version: '1.0.0', platform: 'win32', pid: 1, uptimeMs: 5000, clients: 2, recent: [], stopLabel: 'Esc x3',
  effectsEnabled: true, passwordSet: true, password: 'secret', passwordHash: 'h', denylist: ['keepass.exe'], autostart: false };
const actions = {
  quit: () => calls.push(['quit']), setAutostart: (v) => calls.push(['setAutostart', v]),
  setEffects: (v) => calls.push(['setEffects', v]), openLog: () => calls.push(['openLog']),
  changePassword: () => calls.push(['changePassword']),
  copy: (v) => calls.push(['copy', v]), requestPermission: (v) => calls.push(['requestPermission', v]),
  openPermissionSettings: (v) => calls.push(['openPermissionSettings', v]),
  addDeny: (v) => calls.push(['addDeny', v]),
  removeDeny: (v) => { if (v.current !== 'good') throw Object.assign(new Error('The password is wrong.'), { expose: true }); calls.push(['removeDeny', v.name]); },
  setPassword: () => { throw new Error('secret internals'); },
  setAuthRequired: (v) => calls.push(['setAuthRequired', v.on]),
};
const panel = await startPanel({ getState: () => state, actions });
const port = new URL(panel.url).port;

function req(method, path, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { ...headers, ...(host ? { Host: host } : {}) } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

// Token exchange
assert.equal((await req('GET', '/api/state')).status, 403, 'no cookie');
assert.equal((await req('GET', '/?t=wrong')).status, 403, 'wrong token');
const first = await req('GET', '/?t=' + panel.token);
assert.equal(first.status, 302);
const sc = first.headers['set-cookie'][0];
assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
const cookie = sc.split(';')[0];
const H = { Cookie: cookie };

assert.equal((await req('GET', '/api/state', { headers: H, host: 'evil.com:' + port })).status, 403, 'bad host');
assert.equal((await req('GET', '/api/state', { headers: H, host: 'localhost:' + port })).status, 200, 'localhost host ok');
const page = await req('GET', '/', { headers: H });
assert.equal(page.status, 200); assert.match(page.body, /Ispyx/);
// the page uses relative urls only and no external hosts (it also runs from file/WKWebView without a server)
assert.ok(!/(src|href)\s*=\s*["']\//.test(page.body), 'no root-absolute src/href');
assert.ok(!/fetch\(\s*["']\//.test(page.body), 'no root-absolute fetch');
assert.ok(!/https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(page.body), 'no external hosts');
assert.match(page.body, /<img src="icon\.png"/); assert.match(page.body, /<link rel="icon" href="icon\.png"/);
assert.match(page.body, /"api\/state"/); assert.match(page.body, /"api\/action"/);
const icon = await req('GET', '/icon.png', { headers: H });
assert.equal(icon.status, 200); assert.equal(icon.headers['content-type'], 'image/png');
assert.equal(page.headers['cache-control'], 'no-store');
assert.match(page.headers['content-security-policy'], /default-src 'self'/);
assert.equal(page.headers['access-control-allow-origin'], undefined);
assert.equal((await req('GET', '/..%2f..%2fpackage.json', { headers: H })).status, 404);

const st = await req('GET', '/api/state', { headers: H });
assert.equal(st.status, 200);
const j = JSON.parse(st.body);
assert.equal(j.clients, 2); assert.equal(j.passwordSet, true);
assert.ok(!('password' in j) && !('passwordHash' in j) && !st.body.includes('secret'));

// Actions
const origin = `http://127.0.0.1:${port}`;
const JH = { ...H, 'Content-Type': 'application/json', Origin: origin };
const post = (b, h = JH) => req('POST', '/api/action', { headers: h, body: JSON.stringify(b) });
assert.equal((await post({ name: 'setEffects', value: false }, { ...JH, Origin: 'http://evil.com' })).status, 403, 'foreign origin');
assert.equal((await post({ name: 'setEffects', value: false }, { ...H, 'Content-Type': 'application/json' })).status, 403, 'no origin');
assert.equal((await post({ name: 'setEffects', value: false }, { ...JH, 'Content-Type': 'text/plain' })).status, 415, 'not json');
assert.equal((await post({ name: 'setEffects', value: false }, { 'Content-Type': 'application/json', Origin: origin })).status, 403, 'no cookie');
assert.equal((await post({ name: 'changePassword' })).status, 400, 'not whitelisted');
assert.equal((await post({ name: 'toString' })).status, 400);
assert.equal((await post({ name: 'setEffects', value: 'x' })).status, 400, 'non-boolean');
assert.deepEqual(calls, [], 'nothing dispatched yet');
assert.equal((await post({ name: 'setEffects', value: false })).status, 200);
assert.equal((await post({ name: 'setAutostart', value: true })).status, 200);
assert.equal((await post({ name: 'openLog' })).status, 200);
assert.deepEqual(calls, [['setEffects', false], ['setAutostart', true], ['openLog']]);
assert.equal((await post({ name: 'copy', value: 'hello' })).status, 200);
assert.equal((await post({ name: 'copy', value: 5 })).status, 400, 'copy needs a string');
assert.equal((await post({ name: 'requestPermission', value: 'accessibility' })).status, 200);
assert.equal((await post({ name: 'openPermissionSettings', value: 'screen-recording' })).status, 200);
assert.equal((await post({ name: 'openPermissionSettings', value: '../x' })).status, 400, 'unknown permission');
assert.equal((await post({ name: 'close' })).status, 200, 'close is a no-op');
assert.equal((await post({ name: 'showConfigFile' })).status, 400, 'host does not define it');
assert.deepEqual(calls.slice(3), [['copy', 'hello'], ['requestPermission', 'accessibility'], ['openPermissionSettings', 'screen-recording']]);
// settings: object values are validated, and only refusals meant for the person are shown
assert.equal((await post({ name: 'addDeny', value: 'x.exe' })).status, 200);
assert.equal((await post({ name: 'addDeny', value: 5 })).status, 400);
assert.equal((await post({ name: 'setAuthRequired', value: { on: 'yes' } })).status, 400, 'on must be boolean');
assert.equal((await post({ name: 'setAuthRequired', value: { on: true } })).status, 200);
assert.equal((await post({ name: 'removeDeny', value: 'x' })).status, 400, 'object required');
assert.equal((await post({ name: 'removeDeny', value: { name: 'x.exe', current: 'x'.repeat(500) } })).status, 400, 'too long');
const wrong = await post({ name: 'removeDeny', value: { name: 'x.exe', current: 'bad' } });
assert.equal(wrong.status, 400); assert.equal(JSON.parse(wrong.body).error, 'The password is wrong.');
assert.equal((await post({ name: 'removeDeny', value: { name: 'x.exe', current: 'good' } })).status, 200);
const hidden = await post({ name: 'setPassword', value: { next: 'abcdef' } });
assert.equal(hidden.status, 500); assert.ok(!hidden.body.includes('secret internals'), 'internal errors stay hidden');
assert.equal((await post({ name: 'quit' })).status, 200);
await new Promise((r) => setTimeout(r, 150));
assert.deepEqual(calls.at(-1), ['quit']);

// close frees the port
await panel.close();
await new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject).listen(Number(port), '127.0.0.1', () => s.close(resolve));
});
console.log('panel: all ok');

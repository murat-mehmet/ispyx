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
assert.equal((await post({ name: 'quit' })).status, 200);
await new Promise((r) => setTimeout(r, 150));
assert.deepEqual(calls.at(-1), ['quit']);

// close frees the port
await panel.close();
await new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject).listen(Number(port), '127.0.0.1', () => s.close(resolve));
});
console.log('panel: all ok');

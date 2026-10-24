// Tests of src/platform/darwin against a mock helper (test/darwin/helper-mock.js). Runs on any OS.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};
const skip = (label) => console.log(`SKIP  ${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const throws = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };
const rejects = async (p) => { try { await p; } catch (e) { return e.message; } return null; };

// ---- start the mock ----
const mock = spawn(process.execPath, [path.join(here, 'helper-mock.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
const port = await new Promise((resolve, reject) => {
  mock.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
  mock.on('exit', () => reject(new Error('mock exited')));
});
process.env.ISPYX_HELPER_ENDPOINT = `127.0.0.1:${port}`;

const rpc = await import('../../src/platform/darwin/rpc.js');
const d = await import('../../src/platform/darwin/index.js');
const { callSync, callAsync } = rpc;
const log = () => callSync('log');

try {
  // ---- basics and latency ----
  ok(callSync('echo', { a: [1, 'é', null] }).a[1] === 'é', 'sync call returns the result');
  for (let i = 0; i < 300; i++) callSync('echo', i); // warm up
  const N = 3000, times = [];
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    callSync('echo', i);
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  const med = times[N >> 1], p99 = times[Math.floor(N * 0.99)];
  ok(med < 0.3, 'sync round trip median < 0.3 ms', `median ${med.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, max ${times[N - 1].toFixed(3)} ms`);

  const big = callSync('big', 6);
  ok(big.length === 6 * 1024 * 1024, 'response larger than the shared area (port fallback)');
  ok(callSync('echo', 'after-big') === 'after-big', 'sync still fine after a big response');

  // ---- errors ----
  ok(throws(() => callSync('fail', 'Ispyx needs the Accessibility permission.')) === 'Ispyx needs the Accessibility permission.', 'error response throws with the message');
  ok((await rejects(callAsync('fail', 'nope'))) === 'nope', 'async error rejects with the message');
  ok(/unknown function/.test(throws(() => callSync('nothing')) ?? ''), 'unknown function is an error');

  // ---- out of order ----
  const order = [];
  const pa = callAsync('slow', 200, 'a').then((v) => order.push(v));
  const pb = callAsync('slow', 20, 'b').then((v) => order.push(v));
  const quick = callSync('echo', 'quick'); // a sync call while two async calls are pending
  await Promise.all([pa, pb]);
  ok(quick === 'quick' && order.join('') === 'ba', 'out-of-order responses are paired by id', `order ${order.join('')}`);

  // ---- events ----
  const got = [];
  const off = rpc.onEvent('permissions', (e) => got.push(e));
  callSync('emit', 'permissions', { missing: ['accessibility'] });
  await sleep(50);
  ok(got.length === 1 && got[0].missing[0] === 'accessibility', 'event delivered to the main thread');
  off();
  callSync('emit', 'permissions', { missing: [] });
  await sleep(50);
  ok(got.length === 1, 'unsubscribed handler gets no more events');

  // ---- panel: the app asks the owner for its part of the window ----
  {
    callSync('reset');
    let effects = true;
    const offPanel = d.servePanel({
      getState: () => ({ effectsEnabled: effects, recent: [{ tool: 'move' }] }),
      actions: { setEffects: (on) => { effects = !!on; return effects; }, addDeny: () => { throw new Error('Already on the list.'); } },
    });
    callSync('emit', 'panelRequest', { req: 7, kind: 'state', name: 'state', value: null });
    callSync('emit', 'panelRequest', { req: 8, kind: 'action', name: 'setEffects', value: false });
    callSync('emit', 'panelRequest', { req: 9, kind: 'action', name: 'addDeny', value: 'x' });
    callSync('emit', 'panelRequest', { req: 10, kind: 'action', name: 'constructor', value: null });
    await sleep(100);
    const replies = Object.fromEntries(log().filter((c) => c.fn === 'panelReply').map((c) => [c.args[0].req, c.args[0]]));
    ok(replies[7]?.ok && replies[7].result.effectsEnabled === true && replies[7].result.recent[0].tool === 'move', 'panel: state request answered with the model state');
    ok(replies[8]?.ok && replies[8].result === false && effects === false, 'panel: action runs and returns its result');
    ok(replies[9] && !replies[9].ok && replies[9].error === 'Already on the list.', 'panel: action error goes back as the message');
    ok(replies[10] && !replies[10].ok, 'panel: only own actions run (no prototype names)');
    offPanel();
  }

  // ---- reconnect ----
  callSync('dropAll');
  await sleep(150);
  ok(callSync('echo', 'again') === 'again', 'reconnects after the app drops the connection');

  // ---- module surface ----
  ok(d.name === 'darwin' && d.capabilities.elevation === false && d.stopLabel === 'Option+Esc', 'name, capabilities, stopLabel');
  ok(/Library[\\/]Application Support[\\/]Ispyx$/.test(d.dataDir()), 'dataDir', d.dataDir());
  d.init(); d.init();
  ok(d.listMonitors()[0].primary === true && d.cursorPos().x === 10, 'forwarded window/monitor/pointer calls');
  ok(d.getClipboardText().text === 'hello', 'clipboard forwarded');

  // ---- typeUnicode ----
  callSync('reset');
  let checks = 0;
  const t0 = Date.now();
  await d.typeUnicode('ab\r\nc', () => { checks++; }, [40, 40, 40, 40, 40]);
  const dt = Date.now() - t0;
  let typed = (await callAsync('log')).filter((c) => c.fn === 'typeChar').map((c) => c.args[0]);
  ok(JSON.stringify(typed) === JSON.stringify([97, 98, 10, 99]), 'typeUnicode: code points, CR skipped, LF = 10', JSON.stringify(typed));
  ok(checks === 4, 'typeUnicode: check() before every typed character');
  ok(dt >= 4 * 40 - 5 && dt < 4 * 40 + 400, 'typeUnicode: delays[i] after each character', `${dt} ms for 4 x 40 ms`);
  const t1 = Date.now();
  await d.typeUnicode('xyz', null, [0, 0, 0]);
  ok(Date.now() - t1 >= 3 * 8 - 3, 'typeUnicode: delay never under 8 ms', `${Date.now() - t1} ms`);
  const t2 = Date.now();
  await d.typeUnicode('😀', null, []);
  typed = (await callAsync('log')).filter((c) => c.fn === 'typeChar').map((c) => c.args[0]);
  ok(typed.at(-1) === 0x1f600 && Date.now() - t2 >= 6, 'typeUnicode: astral code point as one call; missing delay -> 8 ms');
  callSync('reset');
  let n = 0;
  const msg = await rejects(d.typeUnicode('abcdef', () => { if (++n === 3) throw new Error('cancelled'); }, Array(6).fill(5)));
  typed = (await callAsync('log')).filter((c) => c.fn === 'typeChar');
  ok(msg === 'cancelled' && typed.length === 2, 'typeUnicode: check() throwing cancels the rest', `${typed.length} typed`);

  // ---- parseChord tables ----
  const P = d.parseChord;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok(eq(P('cmd+c'), [55, 8]) && eq(P('win+c'), [55, 8]) && eq(P('meta+c'), [55, 8]) && eq(P('super+c'), [55, 8]), 'win/cmd/meta/super = Command (55)');
  ok(eq(P('ctrl+alt+shift+a'), [59, 58, 56, 0]), 'ctrl = Control 59 (literal), alt = Option 58, shift 56');
  ok(eq(P('enter'), [36]) && eq(P('tab'), [48]) && eq(P('space'), [49]) && eq(P('backspace'), [51]) && eq(P('esc'), [53]), 'enter tab space backspace esc');
  ok(eq(P('delete'), [117]) && eq(P('home'), [115]) && eq(P('end'), [119]) && eq(P('pageup'), [116]) && eq(P('pagedown'), [121]), 'forward delete, home, end, page keys');
  ok(eq(P('left'), [123]) && eq(P('right'), [124]) && eq(P('down'), [125]) && eq(P('up'), [126]), 'arrows');
  ok(eq(P('f1'), [122]) && eq(P('f5'), [96]) && eq(P('f12'), [111]) && eq(P('f20'), [90]) && eq(P('f13'), [105]), 'function keys');
  ok(eq('abcdefghijklmnopqrstuvwxyz'.split('').map((c) => P(c)[0]), [0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6]), 'letters a-z');
  ok(eq('1234567890'.split('').map((c) => P(c)[0]), [18, 19, 20, 21, 23, 22, 26, 28, 25, 29]), 'digits');
  ok(eq([',', '.', '-', '=', '/', ';', "'", '[', ']', '\\', '`'].map((c) => P(c)[0]), [43, 47, 27, 24, 44, 41, 39, 33, 30, 42, 50]), 'punctuation');
  ok(eq(d.parseSequence('cmd+a  cmd+c'), [[55, 0], [55, 8]]), 'parseSequence');
  const bad = throws(() => P('cmd+banana'));
  ok(/^Unknown key "banana"\./.test(bad ?? ''), 'unknown key message', bad);
  ok(throws(() => P('f21')) !== null && throws(() => P(' + ')) === 'Empty key chord.', 'f21 unknown on a Mac; empty chord');
  ok(d.insertsContent(P('cmd+v')) && d.insertsContent(P('cmd+shift+v')) && d.insertsContent(P('cmd+alt+shift+v')), 'insertsContent: the three paste chords');
  ok(!d.insertsContent(P('cmd+c')) && !d.insertsContent(P('ctrl+v')) && !d.insertsContent(P('v')), 'insertsContent: others are not');
  ok(d.chordDown(P('cmd+c')) === true, 'chordDown forwards keysState');

  // ---- capture ----
  const cap = d.captureScreenRect({ left: 1, top: 2, width: 5, height: 3 });
  ok(cap.bits instanceof Uint8Array && cap.bits.length === 60 && cap.width === 5 && cap.height === 3 && cap.rect.left === 1, 'captureScreenRect result shape');
  ok(cap.bits[(2 * 5 + 4) * 4] === 4 && cap.bits[(2 * 5 + 4) * 4 + 1] === 2 && cap.bits[3] === 255, 'captureScreenRect pixels read from the raw file');
  const cw = d.captureWindow(77);
  ok(cw.bits.length === 7 * 4 * 4 && cw.method === 'mock-77' && cw.rect.width === 7, 'captureWindow result shape');

  // ---- stop hotkey ----
  callSync('reset');
  const stops = [];
  const hk = d.installStopHotkey((r) => stops.push(r), 250);
  ok(hk.active() === false, 'hotkey: no hook while idle');
  callSync('emit', 'stop', { reason: 'Option+Esc' });
  await sleep(40);
  ok(stops.length === 0, 'hotkey: stop event ignored while not touched');
  hk.touch();
  ok(hk.active() === true, 'hotkey: touch() arms it');
  callSync('emit', 'stop', { reason: 'Option+Esc' });
  await sleep(40);
  ok(stops.length === 1 && stops[0] === 'Option+Esc', 'hotkey: stop event calls onStop', JSON.stringify(stops));
  await sleep(150);
  hk.touch(); // pushes the removal back
  await sleep(150);
  ok(hk.active() === true, 'hotkey: touch() extends the linger');
  await sleep(200);
  ok(hk.active() === false, 'hotkey: expires lingerMs after the last touch');
  callSync('emit', 'stop', { reason: 'Option+Esc' });
  await sleep(40);
  ok(stops.length === 1, 'hotkey: no stop once expired');
  hk.touch();
  hk.stop();
  ok(hk.active() === false, 'hotkey: stop() disarms');
  const hl = (await callAsync('log')).filter((c) => c.fn.startsWith('hook'));
  ok(hl.length === 4 && hl[0].fn === 'hookTouch' && hl[0].args[0] === 250 && hl.at(-1).fn === 'hookStop', 'hotkey: app told hookTouch(lingerMs) / hookStop', hl.map((c) => c.fn).join(','));

  // ---- Overlay ----
  callSync('reset');
  const ov = new d.Overlay({ hideAfterMs: 60, stopLabel: 'Option+Esc' });
  const ovLog = async () => (await callAsync('log')).filter((c) => c.fn.startsWith('overlay') && c.fn !== 'overlayVisible');
  ov.begin('click');
  ov.begin('type');
  ov.done();
  await sleep(100);
  let l = await ovLog();
  ok(l.length === 2 && l[0].args[0].text === 'ispyx is working: click   |   To stop press Option+Esc' && l[1].args[0].text.includes('working: type') && l[0].args[0].kind === 'running', 'overlay: begin text, nested begin');
  ok(l.filter((c) => c.fn === 'overlayHide').length === 0, 'overlay: stays while a tool is active');
  ov.done();
  await sleep(120);
  l = await ovLog();
  ok(l.at(-1).fn === 'overlayHide' && ov.active === 0, 'overlay: hides hideAfterMs after the last done()');
  callSync('reset');
  ov.stop('Option+Esc');
  l = await ovLog();
  ok(l[0].args[0].text === 'ispyx STOPPED (Option+Esc)' && l[0].args[0].kind === 'stopped', 'overlay: stop text and red kind');
  ov.cancel('Option+Esc', 80);
  l = await ovLog();
  ok(l.at(-1).args[0].text === 'ispyx CANCELLED (Option+Esc)   |   press again to shut down' && ov.active === 0, 'overlay: cancel text');
  await sleep(150);
  l = await ovLog();
  ok(l.at(-1).fn === 'overlayHide', 'overlay: cancel window hides it');
  callSync('reset');
  const ov2 = new d.Overlay({});
  ov2.begin('shot');
  let seen;
  await ov2.hiddenDuring(async () => { seen = (await ovLog()).map((c) => c.fn).join(','); });
  l = await ovLog();
  ok(seen === 'overlayShow,overlayHide' && l.at(-1).fn === 'overlayShow', 'overlay: hiddenDuring hides, then shows again', seen);
  callSync('reset');
  const off2 = new d.Overlay({ enabled: false });
  off2.begin('x'); off2.done(); off2.stop('r');
  ok((await ovLog()).length === 0, 'overlay: disabled does nothing');

  // ---- showDialog / bringToForeground ----
  ok((await d.bringToForeground(5)) === true, 'bringToForeground resolves with the app result');
  const dlg = await d.showDialog({ mode: 'unlock' }, 1000);
  ok(dlg.cancel === true && /^dialog failed: /.test(dlg.reason), 'showDialog: app error becomes {cancel, reason: "dialog failed: ..."}', dlg.reason);

  // ---- Layer / textMask ----
  const tm = d.textMask('Hi', 12, 600);
  ok(tm.width === 8 && tm.height === 12 && tm.mask.length === 96 && tm.mask[5] === 5, 'textMask reads the mask file');
  if (process.platform === 'darwin') {
    const layer = new d.Layer(8, 4);
    layer.px[0] = 7; layer.px[8 * 4 * 4 - 1] = 9;
    layer.present(10.4, 20.6, 300, 2, 8, 1);
    await sleep(30);
    const lp = (await callAsync('log')).find((c) => c.fn === 'layerPresent').args[0];
    ok(layer.px.length === 128 && layer.shown && lp.x === 10 && lp.y === 21 && lp.alpha === 255 && lp.srcY === 1 && lp.height === 2, 'Layer: mmap + present');
    const fs = await import('node:fs');
    const created = (await callAsync('log')).find((c) => c.fn === 'layerCreate');
    ok(!!created, 'Layer: layerCreate called');
    layer.destroy();
  } else {
    skip('Layer mmap/present (needs macOS libSystem through koffi)');
  }
} catch (e) {
  failed++;
  console.log('FAIL  unexpected error:', e.stack);
}

// ---- connection failure message (fresh process: the client is a per-process singleton) ----
mock.stdin.end();
const r = spawnSync(process.execPath, [path.join(here, 'unreachable.js')],
  { env: { ...process.env, ISPYX_HELPER_ENDPOINT: '127.0.0.1:1', ISPYX_HELPER_WAIT_MS: '300' }, encoding: 'utf8', timeout: 20000 });
ok(/Install Ispyx\.app/.test(r.stdout) && /start it/.test(r.stdout), 'unreachable app: message tells the user to install/start Ispyx.app', (r.stdout + r.stderr).trim());

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

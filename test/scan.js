// Screenshot animation: windows appear over the region during the animation, are gone afterwards, the screenshot
// result comes back at once and the next call waits. Presses no keys and moves the pointer only in the drag-trail check (no button), and puts it back.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as w from '../src/win32.js';
import fs from 'node:fs';
import { SCAN_TOTAL_MS, FLASH_TOTAL_MS, ScanAnimation, RIPPLE_MS, renderRipple, keyLabels } from '../src/scan.js';
import { shrinkToPng } from '../src/image.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
w.init();
let failed = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!ok) failed++; };
const sleep = w.sleep;
const env = { ...process.env, WIN_INPUT_AUTH: '0', WIN_INPUT_OVERLAY: '0', WIN_INPUT_ANIMATIONS: '1', WIN_INPUT_STOP_CHORD: 'alt+f24', WIN_INPUT_LOG: path.join(os.tmpdir(), `win-input-mcp-scan-${Date.now()}.jsonl`) };
const client = new Client({ name: 'scan-test', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'server.js')], env }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content.find((c) => c.type === 'text')?.text ?? '' };
};
const scanWindows = () => w._raw.FindWindowW('WinInputMcpScan', null);

try {
  const v = w.virtualScreen();
  const region = { x: v.x + 100, y: v.y + 100, width: 500, height: 300 };
  const t0 = performance.now();
  const shot = await call('screenshot_screen', { region });
  const back = performance.now() - t0;
  check('screenshot result comes back at once (before the animation ends)', !shot.isError && back < SCAN_TOTAL_MS - 400, `${Math.round(back)} ms`);
  await sleep(500);
  check('animation windows are on screen during it', !!scanWindows());
  await sleep(0); // mid-sweep frame for a look: test/out/scan-frame.png
  fs.mkdirSync('test/out', { recursive: true });
  fs.writeFileSync('test/out/scan-frame.png', shrinkToPng(w.captureScreenRect({ left: region.x - 220, top: region.y - 40, width: region.width + 440, height: region.height + 80 }), 700).png);
  await sleep(450);
  fs.writeFileSync('test/out/scan-frame2.png', shrinkToPng(w.captureScreenRect({ left: region.x - 220, top: region.y - 40, width: region.width + 440, height: region.height + 80 }), 700).png);
  // green iris pixels somewhere in the eye area (beside the region)
  const eyeCap = w.captureScreenRect({ left: region.x - 130, top: region.y + 60, width: region.width + 260, height: 180 });
  let purple = 0;
  for (let i = 0; i < eyeCap.bits.length; i += 4) { const b = eyeCap.bits[i], g = eyeCap.bits[i + 1], r = eyeCap.bits[i + 2]; if (g > 150 && g - r > 70 && g - b > 60) purple++; }
  check('the eye (green iris) is drawn over the region', purple > 150, `${purple} green pixels`);
  const t1 = performance.now();
  const next = await call('cursor_position');
  const waited = (performance.now() - t0);
  check('the next call waited for the animation to finish', !next.isError && waited > SCAN_TOTAL_MS - 150, `${Math.round(waited)} ms since the screenshot call`);
  await sleep(200);
  check('animation windows are gone afterwards', !scanWindows());
  // full monitor: the eye sits inside the region
  const t2 = performance.now();
  await call('screenshot_screen', {});
  await sleep(700);
  const mon = w.listMonitors().find((m) => m.primary);
  fs.writeFileSync('test/out/scan-full.png', shrinkToPng(w.captureScreenRect({ left: mon.left, top: mon.top, width: mon.width, height: mon.height }), 1100).png);
  check('full-monitor scan has its windows up', !!scanWindows());
  await call('cursor_position');
  check('full-monitor scan finishes and cleans up', !scanWindows(), `${Math.round(performance.now() - t2)} ms`);
  // click rings, drawn directly (no real click is sent): green ring around the point, then gone
  {
    const anim = new ScanAnimation({ enabled: true });
    const pt = { x: v.x + 700, y: v.y + 500 };
    const done = anim.ripple(pt, 'left', 2);
    await sleep(160);
    const cap = w.captureScreenRect({ left: pt.x - 66, top: pt.y - 66, width: 132, height: 132 });
    let ring = 0;
    for (let i = 0; i < cap.bits.length; i += 4) { const b = cap.bits[i], g = cap.bits[i + 1], r = cap.bits[i + 2]; if (g > 200 && g - r > 90 && g - b > 60) ring++; }
    check('click rings are drawn at the point', !!scanWindows() && ring > 60, `${ring} ring pixels`);
    await done;
    check('click rings are gone afterwards', !scanWindows());
    // preview over white for a look
    const S = 132, px = new Uint8Array(S * S * 4), out = Buffer.alloc(S * 3 * S * 4);
    [['left', 90], ['right', 150], ['middle', 230]].forEach(([btn, ms], k) => {
      renderRipple(px, S, ms, 2, { left: [60, 255, 110], right: [40, 200, 255], middle: [255, 190, 40] }[btn]);
      for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) { const i = (yy * S + xx) * 4, o = (yy * S * 3 + k * S + xx) * 4, a = px[i + 3] / 255; out[o] = px[i + 2] + 255 * (1 - a); out[o + 1] = px[i + 1] + 255 * (1 - a); out[o + 2] = px[i] + 255 * (1 - a); out[o + 3] = 255; }
    });
    const { encodePng } = await import('../src/image.js');
    fs.writeFileSync('test/out/ripple.png', encodePng(out, S * 3, S));
  }
  // drag trail: the effect follows the real pointer (moved here with no button down), then fades and rings the end
  {
    const home = w.cursorPos();
    const anim = new ScanAnimation({ enabled: true });
    const a = { x: v.x + 800, y: v.y + 500 }, z = { x: v.x + 1100, y: v.y + 650 };
    w.mouseMoveTo(a.x, a.y);
    let stop; const stopped = new Promise((r) => { stop = r; });
    const run = anim.trail(a, { left: a.x, top: a.y, right: z.x, bottom: z.y }, stopped);
    for (let i = 1; i <= 24; i++) { w.mouseMoveTo(Math.round(a.x + ((z.x - a.x) * i) / 24), Math.round(a.y + ((z.y - a.y) * i) / 24)); await sleep(16); }
    const cap = w.captureScreenRect({ left: a.x - 30, top: a.y - 30, width: 360, height: 210 });
    let lit = 0;
    for (let i = 0; i < cap.bits.length; i += 4) { const b = cap.bits[i], g = cap.bits[i + 1], r = cap.bits[i + 2]; if (g > 200 && g - r > 90 && g - b > 60) lit++; }
    fs.writeFileSync('test/out/drag-trail.png', shrinkToPng(cap, 540).png);
    check('drag trail is drawn behind the pointer', !!scanWindows() && lit > 200, `${lit} trail pixels`);
    stop();
    await run;
    check('drag trail is gone after release', !scanWindows());
    w.mouseMoveTo(home.x, home.y);
  }
  // move: trail without a start marker
  {
    const home = w.cursorPos();
    const anim = new ScanAnimation({ enabled: true });
    const a = { x: v.x + 800, y: v.y + 500 }, z = { x: v.x + 1000, y: v.y + 600 };
    w.mouseMoveTo(a.x, a.y);
    let stop; const stopped = new Promise((r) => { stop = r; });
    const run = anim.trail(a, { left: a.x, top: a.y, right: z.x, bottom: z.y }, stopped, () => false, 'left', { marker: false, life: 520 });
    for (let i = 1; i <= 20; i++) { w.mouseMoveTo(Math.round(a.x + ((z.x - a.x) * i) / 20), Math.round(a.y + ((z.y - a.y) * i) / 20)); await sleep(16); }
    check('move trail is on screen while the pointer moves', !!scanWindows());
    stop();
    await run;
    check('move trail and arrival ring are gone afterwards', !scanWindows());
    w.mouseMoveTo(home.x, home.y);
  }
  // scroll cue: chevrons beside the point while the wheel turns (drawn directly, nothing is scrolled)
  {
    const anim = new ScanAnimation({ enabled: true });
    const pt = { x: v.x + 900, y: v.y + 500 };
    let stop; const stopped = new Promise((r) => { stop = r; });
    const run = anim.wheelCue(pt, 1, -1, 1, stopped);
    await sleep(350);
    const cap = w.captureScreenRect({ left: pt.x - 90, top: pt.y - 90, width: 180, height: 180 });
    let lit = 0;
    for (let i = 0; i < cap.bits.length; i += 4) { const b = cap.bits[i], g = cap.bits[i + 1], r = cap.bits[i + 2]; if (g > 200 && g - r > 90 && g - b > 60) lit++; }
    fs.writeFileSync('test/out/scroll-cue.png', shrinkToPng(cap, 360).png);
    check('scroll chevrons are drawn beside the point', !!scanWindows() && lit > 40, `${lit} chevron pixels`);
    stop();
    await run;
    check('scroll chevrons are gone afterwards', !scanWindows());
  }
  // press_keys key caps (drawn directly, no key is pressed)
  {
    const anim = new ScanAnimation({ enabled: true });
    const mon = w.listMonitors().find((m) => m.primary);
    const labels = keyLabels('ctrl+shift+t alt+left enter');
    const run = anim.keycaps(labels, { left: mon.left, top: mon.top, width: mon.width, height: mon.height });
    await sleep(260);
    const cap = w.captureScreenRect({ left: mon.left + Math.round(mon.width / 2) - 330, top: mon.top + mon.height - 190, width: 660, height: 110 });
    let lit = 0;
    for (let i = 0; i < cap.bits.length; i += 4) { const b = cap.bits[i], g = cap.bits[i + 1], r = cap.bits[i + 2]; if (g > 200 && g - r > 90 && g - b > 60) lit++; }
    fs.writeFileSync('test/out/keycaps.png', shrinkToPng(cap, 660).png);
    check('key caps are drawn near the bottom of the screen', !!scanWindows() && lit > 200, `${lit} cap-border pixels; labels ${JSON.stringify(labels)}`);
    await run;
    check('key caps are gone afterwards', !scanWindows());
  }
  // type_text progress pill (drawn directly, nothing is typed): follows the counter, never shows text
  {
    const anim = new ScanAnimation({ enabled: true });
    const mon = w.listMonitors().find((m) => m.primary);
    const progress = { n: 0 };
    let stop; const stopped = new Promise((r) => { stop = r; });
    const run = anim.typing(120, progress, { left: mon.left, top: mon.top, width: mon.width, height: mon.height }, stopped);
    await sleep(200);
    progress.n = 37;
    await sleep(200);
    const grab = () => w.captureScreenRect({ left: mon.left + Math.round(mon.width / 2) - 160, top: mon.top + mon.height - 190, width: 320, height: 100 });
    const cap = grab();
    let lit = 0;
    for (let i = 0; i < cap.bits.length; i += 4) { const b = cap.bits[i], g = cap.bits[i + 1], r = cap.bits[i + 2]; if (g > 200 && g - r > 90 && g - b > 60) lit++; }
    fs.writeFileSync('test/out/typing-pill.png', shrinkToPng(cap, 320).png);
    check('typing pill is drawn with a progress bar', !!scanWindows() && lit > 150, `${lit} green pixels`);
    progress.n = 120;
    await sleep(120);
    stop();
    await run;
    check('typing pill is gone afterwards', !scanWindows());
  }
  // list_windows radar: the line sweeps the monitor and window frames light up (drawn directly, nothing is listed)
  {
    const anim = new ScanAnimation({ enabled: true });
    const mon = w.listMonitors().find((m) => m.primary);
    const wins = w.listWindows().filter((q) => !q.minimized).map((q) => ({ rect: q.rect, allowed: true, elevated: q.elevated }));
    const run = anim.radar(wins, { left: mon.left, top: mon.top, width: mon.width, height: mon.height });
    await sleep(1150);
    const cap = w.captureScreenRect({ left: mon.left, top: mon.top, width: mon.width, height: mon.height });
    let lit = 0;
    for (let i = 0; i < cap.bits.length; i += 4) { const b = cap.bits[i], g = cap.bits[i + 1], r = cap.bits[i + 2]; if (g > 200 && g - r > 90 && g - b > 60) lit++; }
    fs.writeFileSync('test/out/radar.png', shrinkToPng(cap, 1100).png);
    check('radar draws the dish, the eye and window frames', !!scanWindows() && lit > 1500, `${lit} green pixels, ${wins.length} windows`);
    await run;
    check('radar is gone afterwards', !scanWindows());
  }
  // focus_window on the window that already has focus (changes nothing): green frame, short wait
  const fg = w.foregroundWindow();
  if (fg) {
    const t3 = performance.now();
    const fr = await call('focus_window', { hwnd: fg });
    const back3 = performance.now() - t3;
    await sleep(120);
    const rect = w.getRect(fg);
    fs.writeFileSync('test/out/focus-frame.png', shrinkToPng(w.captureScreenRect({ left: Math.max(rect.left, w.virtualScreen().x), top: Math.max(rect.top, 0), width: Math.min(rect.width, 1200), height: Math.min(rect.height, 700) }), 900).png);
    check('focus_window answers at once and shows the frame', !fr.isError && back3 < 300 && !!scanWindows(), `${Math.round(back3)} ms`);
    await call('cursor_position');
    const waited3 = performance.now() - t3;
    check('the next call waits for the frame (about half a second)', waited3 > FLASH_TOTAL_MS - 120 && waited3 < 1200 && !scanWindows(), `${Math.round(waited3)} ms`);
  }
  // a window screenshot animates too
  const notepadFree = w.listWindows().filter((x) => x.process === 'notepad.exe').length === 0;
  const first = w.listWindows().find((x) => x.visible && x.title && x.process !== 'node.exe');
  if (first) {
    const s2 = await call('screenshot_window', { hwnd: first.hwnd });
    await sleep(500);
    check('screenshot_window shows it as well', !s2.isError && !!scanWindows(), first.title.slice(0, 30));
    await call('cursor_position');
    check('and cleans up', !scanWindows());
  }
} catch (e) {
  check('scan test ran to completion', false, e.message);
} finally {
  await client.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nSCAN TEST PASSED');
process.exit(failed ? 1 : 0);

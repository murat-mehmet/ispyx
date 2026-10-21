// Global-mode end-to-end test: opens Chrome like a person (middle-click on its taskbar button = NEW window),
// checks scrolling on a local page, then opens the Instagram login page and checks that it is shown.
// It never types into or clicks anything on Instagram: no username, no password, no Log in / Sign up,
// no cookie banner buttons. Only the window it opened is closed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as w from '../src/win32.js';
import { decodePng } from '../src/image.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test', 'out');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(os.tmpdir(), `win-input-mcp-instagram-${Date.now()}.jsonl`);

w.init();
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};
const sleep = w.sleep;

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.find((c) => c.type === 'text')?.text ?? '';
  let data = t;
  try { data = JSON.parse(t); } catch { /* plain error text */ }
  return { isError: !!r.isError, data, image: r.content.find((c) => c.type === 'image') };
}
const keys = (client, k) => call(client, 'press_keys', { keys: k });
async function copyAfter(client, chord) {
  await call(client, 'set_clipboard', { text: '\u0001sentinel' });
  await keys(client, chord);
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const c = (await call(client, 'get_clipboard')).data.text;
    if (c !== '\u0001sentinel') return c ?? '';
  }
  return '';
}
async function navigate(client, url) {
  await keys(client, 'ctrl+l');
  await sleep(300);
  const r = await call(client, 'type_text', { text: url, instant: url.startsWith('data:') }); // the long local test URL is pasted fast; real addresses are typed at human pace
  if (r.isError) throw new Error('type address: ' + r.data);
  await keys(client, 'enter');
}
// mean colour of a patch of a screenshot_screen region image (scale 1)
async function patch(client, rect) {
  const r = await call(client, 'screenshot_screen', { region: rect, maxWidth: 8000 });
  const img = decodePng(Buffer.from(r.image.data, 'base64'));
  let R = 0, G = 0, B = 0, n = 0;
  const cx = Math.floor(img.width / 2), cy = Math.floor(img.height / 2);
  for (let y = cy - 10; y < cy + 10; y++) for (let x = cx - 10; x < cx + 10; x++) {
    const o = (y * img.width + x) * 4; R += img.rgba[o]; G += img.rgba[o + 1]; B += img.rgba[o + 2]; n++;
  }
  return { r: R / n, g: G / n, b: B / n };
}

const client = new Client({ name: 'instagram-test', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'server.js')],
  env: { ...process.env, WIN_INPUT_AUTH: '0', WIN_INPUT_LOG: LOG },
}));

let hwnd = 0;
try {
  const first = (await call(client, 'list_windows')).data;
  check('list_windows includes the taskbar', first.windows.some((x) => x.className === 'Shell_TrayWnd'));
  const before = new Set(first.windows.map((x) => x.hwnd));

  // middle-click the Chrome taskbar button with a global (screen) click -> a NEW window
  const btn = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'test', 'taskbar-button.ps1')], { encoding: 'utf8' }).trim().split(' ').map(Number);
  check('Chrome taskbar button found', btn.length === 4 && btn.every(Number.isFinite), btn.join(','));
  if (btn.length !== 4) throw new Error('No Chrome taskbar button.');
  let r = await call(client, 'click', { space: 'screen', x: btn[0] + btn[2] / 2, y: btn[1] + btn[3] / 2, button: 'middle' });
  check('global middle-click on the taskbar button', !r.isError, r.isError ? r.data : '');

  for (let i = 0; i < 60 && !hwnd; i++) {
    await sleep(500);
    hwnd = (await call(client, 'list_windows')).data.windows.find((x) => !before.has(x.hwnd) && x.process === 'chrome.exe')?.hwnd ?? 0;
  }
  check('a new Chrome window appears', !!hwnd, `hwnd=${hwnd}`);
  if (!hwnd) throw new Error('Chrome window did not appear.');
  await sleep(1500);
  r = await call(client, 'focus_window', { hwnd });
  check('focus_window', !r.isError, r.isError ? r.data : '');
  const rectOf = async () => (await call(client, 'list_windows')).data.windows.find((x) => x.hwnd === hwnd).rect;

  // ---- scroll test on a local page: 4000x3000 colour field (x: red->blue, y: black->green)
  await navigate(client, 'data:text/html,<body style=margin:0><div style="width:4000px;height:3000px;background:linear-gradient(180deg,rgba(0,255,0,0),rgba(0,255,0,1)),linear-gradient(90deg,red,blue)"></div>');
  await sleep(1500);
  const wr = await rectOf();
  const mid = { x: wr.left + Math.round(wr.width / 2), y: wr.top + Math.round(wr.height * 0.6) };
  const probe = { x: mid.x - 40, y: mid.y - 40, width: 80, height: 80 };
  const p0 = await patch(client, probe);
  const scrollAt = (o) => call(client, 'scroll', { space: 'screen', x: mid.x, y: mid.y, ...o });
  // sample the page while the wheel is still turning: a smooth scroll shows in-between positions
  await call(client, 'move', { space: 'screen', x: mid.x, y: mid.y }); // arrive first, so sampling covers only the wheel
  const scrolling = scrollAt({ amount: -10 });
  const mids = [];
  for (let i = 0; i < 5; i++) { await sleep(110); mids.push((await patch(client, probe)).g); }
  r = await scrolling; await sleep(600);
  const pDown = await patch(client, probe);
  check('scroll down (global coords) changes the page', !r.isError && pDown.g > p0.g + 8, `G ${p0.g.toFixed(0)} -> ${pDown.g.toFixed(0)}`);
  r = await scrollAt({ amount: 10 }); await sleep(900);
  const pUp = await patch(client, probe);
  const wheel = JSON.parse(r.data ? JSON.stringify(r.data) : '{}');
  check('scroll is smooth: many small wheel events over 300+ ms', wheel.wheelEvents > 20 && wheel.ms >= 300, `${wheel.wheelEvents} events, ${wheel.ms} ms`);
  check('page was seen at in-between positions while scrolling', mids.some((g) => g > p0.g + 6 && g < pDown.g - 6), 'G samples ' + mids.map((g) => g.toFixed(0)).join(', '));
  check('scroll up returns to the start', !r.isError && Math.abs(pUp.g - p0.g) < 8, `G ${pUp.g.toFixed(0)}`);
  r = await scrollAt({ horizontal: 10 }); await sleep(900);
  const pRight = await patch(client, probe);
  check('horizontal scroll right changes the page', !r.isError && pRight.b > p0.b + 8 && pRight.r < p0.r - 8, `R ${p0.r.toFixed(0)} -> ${pRight.r.toFixed(0)}, B ${p0.b.toFixed(0)} -> ${pRight.b.toFixed(0)}`);
  r = await scrollAt({ horizontal: -10 }); await sleep(900);
  const pLeft = await patch(client, probe);
  check('horizontal scroll left returns to the start', !r.isError && Math.abs(pLeft.r - p0.r) < 8 && Math.abs(pLeft.b - p0.b) < 8);

  // ---- Instagram login page (look only)
  await navigate(client, 'https://www.instagram.com/accounts/login/');
  let title = '';
  for (let i = 0; i < 50 && !/instagram/i.test(title); i++) { await sleep(500); title = w.getTitle(hwnd); }
  await sleep(3000);
  title = w.getTitle(hwnd);
  check('window title mentions Instagram', /instagram/i.test(title), JSON.stringify(title));

  r = await call(client, 'screenshot_screen', { all: true, maxWidth: 1600 });
  fs.writeFileSync(path.join(OUT, 'instagram-login.png'), Buffer.from(r.image.data, 'base64'));
  check('global screenshot saved', !r.isError, path.join(OUT, 'instagram-login.png'));

  // Google's "Sign in as" account chooser may float over the page and steal focus; Escape only dismisses it (nothing is chosen).
  await keys(client, 'escape');
  await sleep(800);
  // read the page through UI Automation (read-only; the password field's value is never read)
  let ui = '';
  const hasPw = (s) => s.includes('|True|');
  for (let i = 0; i < 3 && !hasPw(ui); i++) {
    ui = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'test', 'ui-text.ps1'), '-Hwnd', String(hwnd)], { encoding: 'utf8', maxBuffer: 1 << 24 });
  }
  fs.writeFileSync(path.join(OUT, 'instagram-login-ui.txt'), ui);
  const text = ui;
  const url = await copyAfter(client, 'ctrl+l ctrl+c');
  await keys(client, 'escape');
  check('URL is the Instagram login page', url.includes('instagram.com/accounts/login'), url.slice(0, 100));
  const lines = text.split(/\r?\n/).filter(Boolean);
  check('page UI mentions Instagram', /instagram/i.test(text), `${lines.length} elements`);
  check('page has a password field, a username field and a log-in button',
    hasPw(text) && lines.some((l) => l.startsWith('Edit|False|')) && lines.some((l) => /^Button\|False\|(Log ?in|Giri[sş])/i.test(l)));
  const cookieBanner = /cookie|çerez/i.test(text);
  console.log(`  cookie banner text present: ${cookieBanner} (nothing was clicked or accepted)`);

  // scroll the Instagram page down and up (report only: the login page may fit the window)
  const wr2 = await rectOf();
  const m2 = { x: wr2.left + Math.round(wr2.width / 2), y: wr2.top + Math.round(wr2.height * 0.6) };
  const probe2 = { x: wr2.left, y: wr2.top + 100, width: wr2.width, height: Math.round(wr2.height * 0.8) };
  const shot = async () => decodePng(Buffer.from((await call(client, 'screenshot_screen', { region: probe2, maxWidth: 8000 })).image.data, 'base64')).rgba;
  const s0 = await shot();
  r = await call(client, 'scroll', { space: 'screen', x: m2.x, y: m2.y, amount: -5 });
  check('scroll down on Instagram accepted', !r.isError, r.isError ? r.data : '');
  await sleep(900);
  const s1 = await shot();
  r = await call(client, 'scroll', { space: 'screen', x: m2.x, y: m2.y, amount: 5 });
  check('scroll up on Instagram accepted', !r.isError, r.isError ? r.data : '');
  await sleep(900);
  const s2 = await shot();
  const differs = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4 * 7) if (Math.abs(a[i] - b[i]) > 24) n++; return n; };
  console.log(`  Instagram page scrolled: ${differs(s0, s1) > 50 ? 'yes' : 'no (page fits the window)'}; back at top: ${differs(s0, s2) < 50}`);
} catch (e) {
  check('instagram test ran to completion', false, e.message);
} finally {
  if (hwnd && w.windowExists(hwnd)) {
    w._raw.PostMessageW(hwnd, 0x10, 0, 0); // WM_CLOSE on the window we opened only
    for (let i = 0; i < 20 && w.windowExists(hwnd); i++) await sleep(300);
  }
  await client.close();
  check('Chrome window closed', !hwnd || !w.windowExists(hwnd));
}

const logLines = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const typedIg = logLines.filter((l) => l.tool === 'type_text').map((l) => l.args.text);
check('only the two addresses were typed', typedIg.length === 2 && typedIg.every((t) => /^(data:|https:\/\/www\.instagram\.com\/accounts\/login\/$)/.test(t)), JSON.stringify(typedIg.map((t) => t.slice(0, 40))));
console.log(`  action log: ${LOG}`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nINSTAGRAM TEST PASSED');
process.exit(failed ? 1 : 0);

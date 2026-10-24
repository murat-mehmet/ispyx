// End-to-end Chrome test: drives the real server over stdio. Chrome is opened like a person would, by
// middle-clicking its taskbar button, which makes a NEW window; only that window is used and closed.
// Flow: new window -> google.com -> type a query -> Enter -> read the results page (screenshot + copied text).
// Text is read with ctrl+a / ctrl+c and the clipboard (no OCR); the URL is read with ctrl+l / ctrl+c.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import w from '../src/platform/index.js';
import { decodePng } from '../src/core/image.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test', 'out');
fs.mkdirSync(OUT, { recursive: true });
const QUERY = 'Hello world weather forecast London';
const LOG = path.join(os.tmpdir(), `win-input-mcp-chrome-${Date.now()}.jsonl`);

w.init();
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};
const sleep = w.sleep;
const clipboard = () => execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8;Get-Clipboard -Raw'], { encoding: 'utf8' }).replace(/\r?\n$/, '');

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.find((c) => c.type === 'text')?.text ?? '';
  let data = t;
  try { data = JSON.parse(t); } catch { /* plain error text */ }
  return { isError: !!r.isError, data, image: r.content.find((c) => c.type === 'image') };
}
const keys = (client, hwnd, k) => call(client, 'press_keys', { hwnd, keys: k });
async function readClipboardAfter(client, hwnd, chord) {
  await call(client, 'set_clipboard', { text: '\u0001sentinel' });
  await keys(client, hwnd, chord);
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const c = clipboard();
    if (c !== '\u0001sentinel') return c;
  }
  return '';
}

const client = new Client({ name: 'chrome-test', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'server.js')],
  env: { ...process.env, WIN_INPUT_AUTH: '0', WIN_INPUT_LOG: LOG },
}));

let hwnd = 0;
try {
  const before = new Set((await call(client, 'list_windows')).data.windows.map((x) => x.hwnd));

  // Open Chrome like a person: middle-click its taskbar button. That starts a NEW window and leaves the
  // windows that are already open alone (a left click would focus or minimise one of them).
  const btn = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'test', 'taskbar-button.ps1')], { encoding: 'utf8' }).trim().split(' ').map(Number);
  check('Chrome taskbar button found', btn.length === 4 && btn.every(Number.isFinite), btn.join(','));
  // the taskbar has no title, so list_windows skips it: look it up by class and read its rect directly
  const trayHwnd = w._raw.FindWindowW('Shell_TrayWnd', null);
  const tray = trayHwnd ? { hwnd: trayHwnd, rect: w.getRect(trayHwnd) } : null;
  check('taskbar window found', !!tray, tray ? JSON.stringify(tray.rect) : '');
  if (btn.length !== 4 || !tray) throw new Error('Cannot locate the taskbar button.');
  let r = await call(client, 'screenshot_window', { hwnd: tray.hwnd, maxWidth: 4000 });
  if (r.isError) throw new Error('Taskbar screenshot failed: ' + r.data);
  const sc = r.data.scale;
  const cx = Math.round((btn[0] + btn[2] / 2 - tray.rect.left) * sc);
  const cy = Math.round((btn[1] + btn[3] / 2 - tray.rect.top) * sc);
  r = await call(client, 'click', { hwnd: tray.hwnd, x: cx, y: cy, button: 'middle' });
  check('middle-click on the taskbar Chrome button', !r.isError, r.isError ? r.data : '');

  for (let i = 0; i < 60 && !hwnd; i++) {
    await sleep(500);
    const ws = (await call(client, 'list_windows')).data.windows;
    hwnd = ws.find((x) => !before.has(x.hwnd) && x.process === 'chrome.exe')?.hwnd ?? 0;
  }
  check('a new Chrome window appears', !!hwnd, `hwnd=${hwnd}`);
  if (!hwnd) throw new Error('Chrome window did not appear.');
  await sleep(1500);

  r = await call(client, 'focus_window', { hwnd });
  check('focus_window', !r.isError, r.isError ? r.data : '');

  // navigate: address bar -> google.com
  await keys(client, hwnd, 'ctrl+l');
  await sleep(300);
  r = await call(client, 'type_text', { hwnd, text: 'https://www.google.com/?hl=en' });
  check('type address', !r.isError, r.isError ? r.data : '');
  await keys(client, hwnd, 'enter');
  await sleep(3500);

  let shot = await call(client, 'screenshot_window', { hwnd, maxWidth: 1000 });
  fs.writeFileSync(path.join(OUT, 'chrome-google-home.png'), Buffer.from(shot.image.data, 'base64'));

  // Consent screen: only a text check here; the test refuses to guess where to click.
  const home = await readClipboardAfter(client, hwnd, 'ctrl+a ctrl+c');
  const consent = /Before you continue|Reject all/i.test(home);
  check('no consent screen in the way', !consent, consent ? 'consent screen shown (see test/out/chrome-google-home.png)' : '');
  if (consent) throw new Error('Google consent screen is displayed; handle it manually once or extend the test.');

  // type the query into the page's search box (Google focuses it on load), then Enter
  r = await call(client, 'type_text', { hwnd, text: QUERY });
  check('type query', !r.isError, r.isError ? r.data : '');
  await keys(client, hwnd, 'enter');
  await sleep(4000);

  // results: window title, URL, screenshot, copied page text
  const title = w.getTitle(hwnd);
  check('window title shows the query', title.toLowerCase().includes('weather forecast'), JSON.stringify(title));

  const url = await readClipboardAfter(client, hwnd, 'ctrl+l ctrl+c');
  check('URL is a Google results page for the query', /google\.[a-z.]+\/search\?/.test(url) && /weather(\+|%20)forecast/i.test(url), url.slice(0, 120));
  await keys(client, hwnd, 'escape');

  shot = await call(client, 'screenshot_window', { hwnd, maxWidth: 1200 });
  const png = Buffer.from(shot.image.data, 'base64');
  fs.writeFileSync(path.join(OUT, 'chrome-results.png'), png);
  const img = decodePng(png);
  check('results screenshot returned', !shot.isError && img.width > 400 && img.height > 300, `${img.width}x${img.height}`);

  // page text: focus is in the address bar/page after the steps above; click-free focus via F6 cycling is
  // unreliable, so reload-free approach: ctrl+a on the page works once the page (not omnibox) has focus.
  let text = '';
  for (let i = 0; i < 4 && !/results|All/.test(text); i++) {
    if (i) await keys(client, hwnd, 'f6');
    text = await readClipboardAfter(client, hwnd, 'ctrl+a ctrl+c');
  }
  fs.writeFileSync(path.join(OUT, 'chrome-results.txt'), text);
  check('copied page text is non-empty', text.length > 200, `${text.length} chars`);
  check('copied text contains the query terms', /weather forecast/i.test(text) && /london/i.test(text));

  // result titles: Google renders each title as its own short line just above a URL/breadcrumb line
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const titles = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^(https?:\/\/|www\.)\S+( ›.*)?$/i.test(lines[i]) || /\S+\.\w{2,}( › .*)$/.test(lines[i])) {
      const t = lines[i - 1];
      if (t.length > 8 && t.length < 140 && !titles.includes(t)) titles.push(t);
    }
  }
  console.log(`  result titles (${titles.length}):`);
  titles.slice(0, 10).forEach((t) => console.log('   -', t));
  check('at least one result title extracted', titles.length >= 1);
} catch (e) {
  check('chrome test ran to completion', false, e.message);
} finally {
  // close only the window we opened (WM_CLOSE on its hwnd); the browser process and other windows stay
  if (hwnd && w.windowExists(hwnd)) {
    w._raw.PostMessageW(hwnd, 0x10, 0, 0);
    for (let i = 0; i < 20 && w.windowExists(hwnd); i++) await sleep(300);
  }
  await client.close();
  check('chrome window closed', !hwnd || !w.windowExists(hwnd));
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nCHROME TEST PASSED');
process.exit(failed ? 1 : 0);

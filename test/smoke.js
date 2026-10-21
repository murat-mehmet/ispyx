// End-to-end smoke test: drives the real server over stdio against a fresh Notepad window.
// Notepad only; nothing else is clicked or typed into.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as w from '../src/win32.js';
import { decodePng } from '../src/image.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test', 'out');
fs.mkdirSync(OUT, { recursive: true });
const TEXT = 'Merhaba ğüşıöç';
const LOG = path.join(os.tmpdir(), `win-input-mcp-smoke-${Date.now()}.jsonl`);

w.init(); // same DPI mode as the server, so cursor readings are comparable
const dpi = w.windowDpi(w.listWindows()[0].hwnd);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};
const sleep = w.sleep;
const clipboard = () => execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8;Get-Clipboard -Raw'], { encoding: 'utf8' }).replace(/\r?\n$/, '');

function launch() {
  const client = new Client({ name: 'smoke', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'server.js')],
    env: { ...process.env, WIN_INPUT_ALLOWLIST: 'chrome.exe,msedge.exe,notepad.exe', WIN_INPUT_LOG: LOG },
  });
  return client.connect(transport).then(() => client);
}
async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.find((c) => c.type === 'text')?.text ?? '';
  let data = t;
  try { data = JSON.parse(t); } catch { /* plain error text */ }
  return { isError: !!r.isError, data, image: r.content.find((c) => c.type === 'image') };
}
const notepads = (list) => list.windows.filter((x) => x.process === 'notepad.exe');

const client = await launch();
let hwnd = 0;
try {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const want = ['click', 'drag', 'focus_window', 'list_windows', 'move', 'press_keys', 'screenshot_screen', 'screenshot_window', 'scroll', 'set_clipboard', 'type_text'];
  check('tool list', JSON.stringify(tools) === JSON.stringify(want), tools.join(','));

  const before = (await call(client, 'list_windows')).data;
  if (notepads(before).length) throw new Error('A Notepad window is already open; close it first so the test does not touch your own Notepad.');

  // 1. open Notepad
  spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40 && !hwnd; i++) {
    await sleep(250);
    hwnd = notepads((await call(client, 'list_windows')).data)[0]?.hwnd ?? 0;
  }
  check('notepad window appears', !!hwnd, `hwnd=${hwnd}`);
  if (!hwnd) throw new Error('Notepad did not open.');
  await sleep(1500);
  // Notepad restores the user's earlier tabs: work only in a fresh tab so none of them is touched.
  await call(client, 'press_keys', { hwnd, keys: 'ctrl+n' });
  await sleep(700);
  const title = w.getTitle(hwnd);
  check('working in a fresh Untitled tab', /^Untitled/.test(title), title);
  if (!/^Untitled/.test(title)) throw new Error('Could not open a fresh tab; stopping so no existing tab is changed.');

  let r = await call(client, 'focus_window', { hwnd });
  check('focus_window', !r.isError, JSON.stringify(r.data));

  // 2. type Turkish text
  r = await call(client, 'type_text', { hwnd, text: TEXT });
  check('type_text', !r.isError, r.isError ? r.data : 'layout ' + r.data.keyboardLayout);
  await sleep(300);

  // 3. select all, copy, compare with what was typed
  await call(client, 'set_clipboard', { text: 'sentinel' });
  r = await call(client, 'press_keys', { hwnd, keys: 'ctrl+a' });
  check('press_keys ctrl+a', !r.isError, r.isError ? r.data : '');
  await call(client, 'press_keys', { hwnd, keys: 'ctrl+c' });
  await sleep(300);
  check('typed text arrived exactly (clipboard copy)', clipboard() === TEXT, JSON.stringify(clipboard()));

  // 4. screenshot
  r = await call(client, 'screenshot_window', { hwnd, maxWidth: 1000 });
  check('screenshot_window returns image', !!r.image && !r.isError);
  const shot = r.data;
  const png = Buffer.from(r.image.data, 'base64');
  fs.writeFileSync(path.join(OUT, 'notepad-selected.png'), png);
  const img = decodePng(png);
  check('screenshot size matches scale', img.width === shot.width && Math.abs(img.width / shot.rect.width - shot.scale) < 0.01, `${img.width}x${img.height} scale=${shot.scale.toFixed(3)} rect=${JSON.stringify(shot.rect)} dpi=${dpi}`);

  // 5. locate the selected text (ink differing from the editor background) in the lower 70%
  const px = (x, y) => { const o = (y * img.width + x) * 4; return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]]; };
  const y0 = 60;
  const bg = px(Math.floor(img.width / 2), img.height - 20).join(',');
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  for (let y = y0; y < img.height - 30; y++) {
    for (let x = 4; x < img.width - 4; x++) {
      const [pr, , pb] = px(x, y); if (pb - pr > 100) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
  }
  check('found selected text in screenshot', maxX > minX && maxY > minY, `x ${minX}-${maxX}, y ${minY}-${maxY}`);
  const midY = Math.round((minY + maxY) / 2);

  // 6. move: pointer must land exactly where the screenshot coordinates say
  const mx = Math.round((minX + maxX) / 2);
  r = await call(client, 'move', { hwnd, x: mx, y: midY });
  const cur = w.cursorPos();
  const wantX = Math.round(shot.rect.left + mx / shot.scale);
  const wantY = Math.round(shot.rect.top + midY / shot.scale);
  check('move lands on mapped coordinates', !r.isError && Math.abs(cur.x - wantX) <= 1 && Math.abs(cur.y - wantY) <= 1, `cursor ${cur.x},${cur.y} expected ${wantX},${wantY}`);

  // 7. drag across the first half of the text, then copy: the selection must be a proper prefix
  await call(client, 'click', { hwnd, x: maxX + 40, y: midY }); // collapse the selection after the text
  await call(client, 'set_clipboard', { text: 'sentinel' });
  const dragTo = Math.round(minX + (maxX - minX) * 0.55);
  r = await call(client, 'drag', { hwnd, fromX: minX + 1, fromY: midY, toX: dragTo, toY: midY, steps: 15 });
  check('drag', !r.isError, r.isError ? r.data : '');
  await call(client, 'press_keys', { hwnd, keys: 'ctrl+c' });
  await sleep(300);
  const part = clipboard();
  check('drag selected a prefix of the text (coordinates line up)', part.length >= 3 && part.length < TEXT.length && TEXT.startsWith(part), JSON.stringify(part));
  r = await call(client, 'screenshot_window', { hwnd });
  fs.writeFileSync(path.join(OUT, 'notepad-dragged.png'), Buffer.from(r.image.data, 'base64'));

  // 8. refusals
  const explorer = (await call(client, 'list_windows')).data.windows.find((x) => x.process === 'explorer.exe');
  if (explorer) {
    r = await call(client, 'click', { hwnd: explorer.hwnd, x: 10, y: 10 });
    check('non-allowlisted window refused', r.isError && /allowlist/.test(r.data), r.data);
  }
  r = await call(client, 'screenshot_screen', { maxWidth: 800 });
  check('screenshot_screen', !r.isError && !!r.image);

  // 9. leave nothing behind: empty the tab, close it, then close the window
  await call(client, 'press_keys', { hwnd, keys: 'ctrl+a' });
  await call(client, 'press_keys', { hwnd, keys: 'delete' });
  await call(client, 'press_keys', { hwnd, keys: 'ctrl+w' });
  await sleep(500);
  w._raw.PostMessageW(hwnd, 0x10, 0, 0); // WM_CLOSE
  for (let i = 0; i < 10 && w.windowExists(hwnd); i++) await sleep(300);
  if (w.windowExists(hwnd)) {
    const dlg = notepads((await call(client, 'list_windows')).data);
    console.log('  save prompt windows:', JSON.stringify(dlg.map((d) => d.title)));
    r = await call(client, 'screenshot_window', { hwnd });
    if (r.image) fs.writeFileSync(path.join(OUT, 'notepad-close-prompt.png'), Buffer.from(r.image.data, 'base64'));
    await call(client, 'press_keys', { hwnd, keys: 'alt+n' }); // "Don't save"
    for (let i = 0; i < 10 && w.windowExists(hwnd); i++) await sleep(300);
  }
  check('notepad closed without saving', !w.windowExists(hwnd));
} catch (e) {
  check('smoke test ran to completion', false, e.message);
} finally {
  await client.close();
}

// kill switch needs its own server instance, because it stays tripped until restart
{
  const c2 = await launch();
  w._raw.SetCursorPos(0, 0);
  await sleep(150);
  const r = await call(c2, 'list_windows');
  check('kill switch refuses after pointer in top-left corner', r.isError && /Kill switch/.test(r.data), r.data);
  w._raw.SetCursorPos(400, 400);
  const r2 = await call(c2, 'list_windows');
  check('kill switch stays latched until restart', r2.isError);
  await c2.close();
}

const logLines = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
check('action log written', logLines.some((l) => l.tool === 'type_text' && l.args.text === TEXT), `${logLines.length} lines at ${LOG}`);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nSMOKE TEST PASSED');
process.exit(failed ? 1 : 0);

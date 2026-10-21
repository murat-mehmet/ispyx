// Banner + emergency stop test. Uses a fresh Notepad window as the foreground window, because Alt+Esc
// makes Windows cycle to the next window. The banner must show while a tool runs, be click-through, and
// disappear afterwards; Alt+Esc must abort a running tool with an error and refuse everything after it.
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as w from '../src/win32.js';
import { OVERLAY_CLASS } from '../src/overlay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
w.init();
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};
const sleep = w.sleep;
const overlayWin = () => w._raw.FindWindowW(OVERLAY_CLASS, null);
const notepads = () => w.listWindows().filter((x) => x.process === 'notepad.exe');

const client = new Client({ name: 'stop-test', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'server.js')],
  env: { ...process.env, WIN_INPUT_GLOBAL: '1', WIN_INPUT_ALLOWLIST: '', WIN_INPUT_LOG: path.join(os.tmpdir(), `win-input-mcp-stop-${Date.now()}.jsonl`) },
}));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content.find((c) => c.type === 'text')?.text ?? '' };
};

let np = 0;
try {
  if (notepads().length) throw new Error('A Notepad window is already open; close it first.');
  spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40 && !np; i++) { await sleep(250); np = notepads()[0]?.hwnd ?? 0; }
  if (!np) throw new Error('Notepad did not open.');
  await sleep(1500);
  await call('focus_window', { hwnd: np });
  await sleep(2200); // the banner lingers 1.5 s after the focus call
  check('banner is gone when no tool runs', !overlayWin() || !w._raw.IsWindowVisible(overlayWin()));

  // a long tool call in flight: the banner shows and lets clicks through
  const inflight = call('wait', { ms: 6000 });
  await sleep(700);
  const ov = overlayWin();
  check('banner is visible while a tool runs', !!ov && w._raw.IsWindowVisible(ov));
  if (ov) {
    const r = w.getRect(ov);
    const exStyle = Number(w._raw.GetWindowLongPtrW(ov, -20));
    check('banner is topmost, click-through and non-activating', (exStyle & 0x8) && (exStyle & 0x20) && (exStyle & 0x08000000), `ex=0x${exStyle.toString(16)}`);
    const under = w.rootWindowAt(r.left + Math.round(r.width / 2), r.top + Math.round(r.height / 2));
    check('a point inside the banner belongs to the window underneath', under !== ov, `root=${under}`);
    check('banner has no title, so list_windows does not show it', !w.listWindows().some((x) => x.hwnd === ov));
  }

  // emergency stop: a press of Alt+Esc while the tool is running
  const t0 = performance.now();
  w.keysDown([0x12, 0x1b]);
  await sleep(120);
  w.keysUp([0x12, 0x1b]);
  const res = await inflight;
  const took = performance.now() - t0;
  check('running tool is aborted with an error', res.isError && /STOPPED BY THE USER/.test(res.text) && /Alt\+Esc/.test(res.text), res.text.slice(0, 80));
  check('abort is quick (not the full 6 s)', took < 1500, `${Math.round(took)} ms`);
  const after = await call('list_windows');
  check('later calls are refused', after.isError && /STOPPED BY THE USER/.test(after.text));
  const click = await call('click', { space: 'screen', x: 800, y: 500 });
  check('click is refused too', click.isError);
} catch (e) {
  check('stop test ran to completion', false, e.message);
} finally {
  if (np && w.windowExists(np)) {
    w._raw.PostMessageW(np, 0x10, 0, 0);
    for (let i = 0; i < 20 && w.windowExists(np); i++) await sleep(300);
  }
  await client.close();
}

// banner without a stop: shows during a tool, hides afterwards
{
  const c2 = new Client({ name: 'banner-test', version: '1' });
  await c2.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'src', 'server.js')],
    env: { ...process.env, WIN_INPUT_GLOBAL: '1', WIN_INPUT_ALLOWLIST: '', WIN_INPUT_LOG: path.join(os.tmpdir(), `win-input-mcp-banner-${Date.now()}.jsonl`) },
  }));
  const p = c2.callTool({ name: 'wait', arguments: { ms: 800 } });
  await sleep(300);
  const shown = overlayWin() && w._raw.IsWindowVisible(overlayWin());
  await p;
  await sleep(2300);
  const hidden = !w._raw.IsWindowVisible(overlayWin());
  check('banner shows during a tool and hides about 1.5 s after it', shown && hidden, `shown=${!!shown} hidden=${hidden}`);
  await c2.close();
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nSTOP TEST PASSED');
process.exit(failed ? 1 : 0);

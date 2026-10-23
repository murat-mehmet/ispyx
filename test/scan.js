// Screenshot animation: windows appear over the region during the animation, are gone afterwards, the screenshot
// result comes back at once and the next call waits. Presses no keys and never moves the pointer.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as w from '../src/win32.js';
import fs from 'node:fs';
import { SCAN_TOTAL_MS } from '../src/scan.js';
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
  fs.writeFileSync('test/out/scan-frame.png', shrinkToPng(w.captureScreenRect({ left: region.x - 40, top: region.y - 60, width: region.width + 80, height: region.height + 120 }), 700).png);
  await sleep(450);
  fs.writeFileSync('test/out/scan-frame2.png', shrinkToPng(w.captureScreenRect({ left: region.x - 40, top: region.y - 60, width: region.width + 80, height: region.height + 120 }), 700).png);
  // green iris pixels somewhere in the eye area (middle of the region)
  const eyeCap = w.captureScreenRect({ left: region.x + 150, top: region.y + 60, width: 200, height: 180 });
  let purple = 0;
  for (let i = 0; i < eyeCap.bits.length; i += 4) { const b = eyeCap.bits[i], g = eyeCap.bits[i + 1], r = eyeCap.bits[i + 2]; if (g > 150 && g - r > 70 && g - b > 60) purple++; }
  check('the eye (green iris) is drawn over the region', purple > 150, `${purple} green pixels`);
  const t1 = performance.now();
  const next = await call('cursor_position');
  const waited = (performance.now() - t0);
  check('the next call waited for the animation to finish', !next.isError && waited > SCAN_TOTAL_MS - 150, `${Math.round(waited)} ms since the screenshot call`);
  await sleep(200);
  check('animation windows are gone afterwards', !scanWindows());
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

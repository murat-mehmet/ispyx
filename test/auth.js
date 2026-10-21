// Password gate, end to end: a real server with auth on, the real dialog, driven through UI Automation.
// Uses a temp auth file; touches nothing but its own dialog. Never presses Alt+Esc or moves the pointer.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as w from '../src/win32.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'test', 'auth-ui.ps1');
const FILE = path.join(os.tmpdir(), `win-input-auth-e2e-${Date.now()}.json`);
w.init();
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

/** Runs the UI driver in the background; resolves with its one-word result. */
const drive = (...args) => new Promise((resolve) => {
  const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', UI, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('close', () => resolve(out.trim()));
});
const dialogOpen = () => execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', UI, '-WaitSeconds', '1', '-Cancel'], { encoding: 'utf8' }).trim() !== 'nowindow';

async function launch() {
  const c = new Client({ name: 'auth-test', version: '1' });
  await c.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'src', 'server.js')],
    env: { ...process.env, WIN_INPUT_AUTH: '1', WIN_INPUT_AUTH_FILE: FILE, WIN_INPUT_OVERLAY: '0', WIN_INPUT_STOP_CHORD: 'alt+f24', WIN_INPUT_LOG: path.join(os.tmpdir(), `win-input-mcp-auth-${Date.now()}.jsonl`) },
  }));
  return c;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content.find((x) => x.type === 'text')?.text ?? '' };
};

try {
  // 1. first run: set a password, 2 hours, make it the default
  let c = await launch();
  let ui = drive('-Password', 'secret1', '-Confirm', 'secret1', '-Value', '2', '-MakeDefault');
  let r = await call(c, 'list_windows');
  check('first call opens the setup dialog and succeeds after it', !r.isError && (await ui) === 'submitted', r.text.slice(0, 60));
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  check('chosen 2 hours saved as the default; no password or unlock time on disk', data.defaultMinutes === 120 && !('unlockedUntil' in data) && !JSON.stringify(data).includes('secret1'));

  // 2. unlocked: no window
  const t0 = Date.now();
  r = await call(c, 'list_windows');
  check('no dialog while unlocked', !r.isError && Date.now() - t0 < 3000 && !dialogOpen());
  await c.close();

  // 3. a restarted server (e.g. /mcp reconnect) asks again: it offers the saved default, comes up in front,
  //    and three wrong passwords in a row (window reopening each time) are needed before the tool gets an error
  c = await launch();
  let settled = false;
  const p = call(c, 'list_windows').then((x) => { settled = true; return x; });
  const first = await drive('-Read');
  check('window offers the saved default (2 hours)', first.startsWith('2|hours'), first);
  const fg = w.foregroundWindow();
  check('the password window comes up in front (foreground)', !!fg && w.getTitle(fg) === 'win-input-mcp', fg ? w.getTitle(fg) : 'none');
  await drive('-Password', 'wrong-1', '-Value', '3');
  await w.sleep(2500);
  const second = await drive('-Read');
  check('after a wrong password the window reopens, tool not answered, picked duration kept', !settled && /^3|hours|.*2 tries left/.test(second), second);
  await drive('-Password', 'wrong-2');
  await w.sleep(2500);
  check('second wrong password: still reopens', !settled && /1 try left/.test(await drive('-Read')));
  await drive('-Password', 'wrong-3');
  r = await p;
  check('third wrong password refuses the tool', r.isError && /3 times/.test(r.text), r.text.slice(0, 70));
  await c.close();

  // 4. a new start: the right password unlocks
  c = await launch();
  ui = drive('-Password', 'secret1', '-Value', '1');
  r = await call(c, 'list_windows');
  check('right password unlocks', (await ui) === 'submitted' && !r.isError, r.text.slice(0, 60));
  await c.close();

  // 5. a new start and no answer: the window closes by itself after 30 s and the tool fails
  c = await launch();
  const t1 = Date.now();
  r = await call(c, 'list_windows');
  const took = Date.now() - t1;
  await w.sleep(1200);
  const open = dialogOpen();
  check('no answer: after 30 s the tool fails with a plain error and the window is gone', !open && r.isError && /Password was not entered \(timed out\)/.test(r.text) && took > 28000 && took < 36000, `${took} ms open=${open}: ${r.text.slice(0, 60)}`);

  // 6. cancel button
  const ui2 = drive('-Cancel');
  r = await call(c, 'list_windows');
  check('Cancel refuses the tool', r.isError && (await ui2) === 'cancelled' && /closed by the user/.test(r.text), r.text.slice(0, 70));
  await c.close();
} catch (e) {
  check('auth test ran to completion', false, e.message);
} finally {
  fs.rmSync(FILE, { force: true });
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAUTH TEST PASSED');
process.exit(failed ? 1 : 0);

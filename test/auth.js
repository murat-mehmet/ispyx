// Password gate, end to end: a real server with auth on, the real dialog, driven through UI Automation.
// Uses a temp auth file; touches nothing but its own dialog. Never presses Alt+Esc or moves the pointer.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'test', 'auth-ui.ps1');
const FILE = path.join(os.tmpdir(), `win-input-auth-e2e-${Date.now()}.json`);
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

async function launch(timeoutMs = 30000) {
  const c = new Client({ name: 'auth-test', version: '1' });
  await c.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'src', 'server.js')],
    env: { ...process.env, WIN_INPUT_AUTH: '1', WIN_INPUT_AUTH_FILE: FILE, WIN_INPUT_AUTH_TIMEOUT_MS: String(timeoutMs), WIN_INPUT_OVERLAY: '0', WIN_INPUT_STOP_CHORD: 'alt+f24', WIN_INPUT_LOG: path.join(os.tmpdir(), `win-input-mcp-auth-${Date.now()}.jsonl`) },
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

  // 3. a restarted server (e.g. /mcp reconnect) asks again; wrong password first, then the right one
  c = await launch();
  const p = call(c, 'list_windows');
  const wrong = await drive('-Password', 'wrong-one');
  const right = drive('-Password', 'secret1', '-Value', '1');
  r = await p;
  check('wrong password keeps the dialog asking; right one unlocks', wrong === 'submitted' && (await right) === 'submitted' && !r.isError, r.text.slice(0, 60));

  // 5. a new start and no answer: the window closes by itself and the tool fails
  await c.close();
  c = await launch(5000);
  const t1 = Date.now();
  r = await call(c, 'list_windows');
  const took = Date.now() - t1;
  check('no answer: tool fails with a plain error and the window is gone', r.isError && /Password was not entered/.test(r.text) && took < 9000 && !dialogOpen(), `${took} ms: ${r.text.slice(0, 60)}`);

  // 6. cancel button
  const ui2 = drive('-Cancel');
  r = await call(c, 'list_windows');
  check('Cancel refuses the tool', r.isError && (await ui2) === 'cancelled');
  await c.close();
} catch (e) {
  check('auth test ran to completion', false, e.message);
} finally {
  fs.rmSync(FILE, { force: true });
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAUTH TEST PASSED');
process.exit(failed ? 1 : 0);

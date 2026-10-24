// Resident model: several `ispyx mcp` processes (one per Claude) share one resident that does the work.
// Also: a second resident exits at once; `mcp` starts the resident when none runs.
// Harmless: only list_monitors / cursor_position / wait; never moves the pointer.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'server.js');
const LOG = path.join(os.tmpdir(), `win-input-mcp-inst-${Date.now()}.jsonl`);
const env = { ...process.env, WIN_INPUT_AUTH: '0', WIN_INPUT_OVERLAY: '0', WIN_INPUT_STOP_CHORD: 'alt+f24', WIN_INPUT_LOG: LOG, ISPYX_IDLE_EXIT_MS: '20000' };
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

const resident = (args) => spawn(process.execPath, [ENTRY, ...args], { env, stdio: 'ignore', windowsHide: true });
const exited = (p, ms) => new Promise((r) => { if (p.exitCode !== null) return r(p.exitCode); const t = setTimeout(() => r('timeout'), ms); p.once('exit', (c) => { clearTimeout(t); r(c); }); });
async function launch() {
  const c = new Client({ name: 'inst-test', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY, 'mcp'], env }));
  return c;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content.find((x) => x.type === 'text')?.text ?? '' };
};
const starts = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('server_start')).length : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 1. mcp with no resident starts one by itself
  const a = await launch();
  const r0 = await call(a, 'list_monitors');
  check('mcp started the resident on demand and got an answer', !r0.isError && r0.text.includes('['), r0.text.slice(0, 30));
  check('one resident (one server_start)', starts() === 1, `starts=${starts()}`);

  // 2. a second resident exits at once
  const second = resident(['--resident']);
  check('a second resident exits at once', (await exited(second, 6000)) === 0);
  check('it did not start a second core', starts() === 1, `starts=${starts()}`);

  // 3. several mcp processes, one resident
  const b = await launch();
  const c = await launch();
  await sleep(500);
  check('three mcp processes, still one resident', starts() === 1, `starts=${starts()}`);
  const rs = await Promise.all([a, b, c].map((x) => call(x, 'list_monitors')));
  check('every mcp answers its Claude', rs.every((r) => !r.isError && r.text.includes('[')), rs.map((r) => r.text.slice(0, 20)).join(' | '));
  const par = await Promise.all([a, b, c].map((x) => call(x, 'wait', { ms: 300 })));
  check('parallel calls from all of them work', par.every((r) => !r.isError));

  // 4. a Claude goes away: the others (and the resident) are unaffected
  await a.close();
  await sleep(500);
  const r2 = await Promise.all([b, c].map((x) => call(x, 'list_monitors')));
  check('one mcp closed: the others keep working', r2.every((r) => !r.isError), r2.map((r) => r.text.slice(0, 40)).join(' | '));
  await b.close();
  await c.close();
  await sleep(2500);
  const d = await launch();
  const r3 = await call(d, 'list_monitors');
  check('the resident outlives its clients', !r3.isError && starts() === 1, `starts=${starts()}`);
  await d.close();

  // 5. quit
  const q = spawn(process.execPath, [ENTRY, 'quit'], { env, stdio: 'ignore', windowsHide: true });
  check('quit returns', (await exited(q, 6000)) === 0);
  await sleep(1000);
  const probe = resident(['--resident']);
  await sleep(2500);
  check('after quit the pipe is free for a new resident', probe.exitCode === null);
  spawn(process.execPath, [ENTRY, 'quit'], { env, stdio: 'ignore', windowsHide: true });
} catch (e) {
  check('instances test ran to completion', false, e.message);
} finally {
  await sleep(800);
  spawn(process.execPath, [ENTRY, 'quit'], { env, stdio: 'ignore', windowsHide: true });
  fs.rmSync(LOG, { force: true });
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nINSTANCES TEST PASSED');
process.exit(failed ? 1 : 0);

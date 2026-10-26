// Resident model on the fake platform (no desktop): `mcp` auto-starts the resident, a second resident exits,
// a resident killed mid-call gives a tool error, `quit` ends it. Runs anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENTRY = fileURLToPath(new URL('../../src/server.js', import.meta.url));
const LOG = path.join(os.tmpdir(), `ispyx-resident-fake-${process.pid}.jsonl`);
const env = { ...process.env, ISPYX_PLATFORM: 'fake', ISPYX_AUTH: '0', ISPYX_OVERLAY: '0', ISPYX_ANIMATIONS: '0', ISPYX_LOG: LOG, ISPYX_TEST_ID: String(process.pid), ISPYX_IDLE_EXIT_MS: '20000' };
let failed = 0;
const ok = (c, m, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}${d ? '  ' + d : ''}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args) => spawn(process.execPath, [ENTRY, ...args], { env, stdio: 'ignore', windowsHide: true });
const exited = (p, ms) => new Promise((r) => { if (p.exitCode !== null) return r(p.exitCode); const t = setTimeout(() => r('timeout'), ms); p.once('exit', (c) => { clearTimeout(t); r(c); }); });
const starts = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('server_start')).map((l) => JSON.parse(l)) : []);
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content.find((x) => x.type === 'text')?.text ?? '' };
};
const mcp = async () => {
  const c = new Client({ name: 'resident-test', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY, 'mcp'], env }));
  return c;
};

try {
  // no resident yet: the first call starts one
  const a = await mcp();
  ok((await a.listTools()).tools.length === 20, 'mcp lists the 20 tools');
  const r1 = await call(a, 'list_monitors');
  ok(!r1.isError && r1.text.includes('monitors'), 'mcp auto-started the resident and the call was forwarded', r1.text.slice(0, 40));
  ok(starts().length === 1, 'one resident started (one server_start)');

  // a second resident finds the owner and leaves at once
  const second = run(['--resident']);
  ok((await exited(second, 5000)) === 0, 'a second resident exits at once');
  ok(starts().length === 1, 'and did not start the core');

  // more mcp processes share the one resident
  const b = await mcp();
  const rs = await Promise.all([call(a, 'cursor_position'), call(b, 'cursor_position')]);
  ok(rs.every((r) => !r.isError), 'two mcp processes, one resident');
  ok(starts().length === 1, 'still one resident');
  await b.close();

  // the resident dies in the middle of a call: clear tool error
  const pid = starts()[0].pid;
  const pending = call(a, 'wait', { ms: 5000 });
  await sleep(500);
  process.kill(pid);
  const dead = await pending;
  ok(dead.isError && /ispyx/i.test(dead.text), 'resident killed mid-call gives a tool error', dead.text.slice(0, 80));

  // the next call starts the resident again
  const r2 = await call(a, 'list_monitors');
  ok(!r2.isError, 'the next call restarts the resident', r2.text.slice(0, 40));
  ok(starts().length === 2, 'a new resident core started');

  // quit
  const q = run(['quit']);
  ok((await exited(q, 5000)) === 0, '`quit` returns');
  await sleep(1500);
  const probe = run(['--resident']); // a resident can start again only if the pipe is free
  await sleep(2500);
  ok(probe.exitCode === null, 'after quit the pipe is free (a new resident keeps running)');
  run(['quit']);
  await a.close().catch(() => {});
} catch (e) {
  ok(false, 'resident test ran to completion', e.stack);
} finally {
  await sleep(800);
  run(['quit']);
  fs.rmSync(LOG, { force: true });
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nRESIDENT TEST PASSED');
process.exit(failed ? 1 : 0);

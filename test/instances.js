// Several Claude instances = several server processes: one owns the work, the rest forward to it.
// Harmless: only list_monitors / cursor_position; never moves the pointer.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(os.tmpdir(), `win-input-mcp-inst-${Date.now()}.jsonl`);
const env = { ...process.env, WIN_INPUT_AUTH: '0', WIN_INPUT_OVERLAY: '0', WIN_INPUT_STOP_CHORD: 'alt+f24', WIN_INPUT_LOG: LOG };
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

async function launch() {
  const c = new Client({ name: 'inst-test', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'server.js')], env }));
  return c;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content.find((x) => x.type === 'text')?.text ?? '' };
};
const starts = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('server_start')).length : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const a = await launch();
  const b = await launch();
  const c = await launch();
  await sleep(500);
  check('three instances, one doing the work (one server_start)', starts() === 1, `starts=${starts()}`);
  const rs = await Promise.all([a, b, c].map((x) => call(x, 'list_monitors')));
  check('every instance answers its Claude', rs.every((r) => !r.isError && r.text.includes('[')), rs.map((r) => r.text.slice(0, 20)).join(' | '));
  const par = await Promise.all([a, b, c].map((x) => call(x, 'wait', { ms: 300 })));
  check('parallel calls from all of them work', par.every((r) => !r.isError));

  await a.close(); // the owner's Claude goes away; b and c must stay connected
  await sleep(500);
  const r2 = await Promise.all([b, c].map((x) => call(x, 'list_monitors')));
  check('owner\'s Claude closed: the others keep working', r2.every((r) => !r.isError), r2.map((r) => r.text.slice(0, 40)).join(' | '));
  await b.close();
  await sleep(2500);
  const r3 = await call(c, 'list_monitors');
  check('last instance still answers (took over or kept serving)', !r3.isError, r3.text.slice(0, 40));
  await c.close();
} catch (e) {
  check('instances test ran to completion', false, e.message);
} finally {
  fs.rmSync(LOG, { force: true });
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nINSTANCES TEST PASSED');
process.exit(failed ? 1 : 0);

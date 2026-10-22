// Second stop press on the owner shuts every instance down; a single press cancels calls of all of them.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as w from '../src/win32.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
w.init();
const env = { ...process.env, WIN_INPUT_AUTH: '0', WIN_INPUT_OVERLAY: '0', WIN_INPUT_STOP_CHORD: 'alt+f24', WIN_INPUT_LOG: path.join(os.tmpdir(), `win-input-mcp-sd-${Date.now()}.jsonl`) };
let failed = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!ok) failed++; };
const sleep = w.sleep;
const press = async () => { w.keysDown([0x12, 0x87]); await sleep(120); w.keysUp([0x12, 0x87]); };
async function launch() {
  const t = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'server.js')], env });
  const c = new Client({ name: 'sd', version: '1' });
  let closed = false;
  t.onclose = () => { closed = true; };
  await c.connect(t);
  return { c, isClosed: () => closed };
}
const call = async (x, name, args = {}) => {
  const r = await x.c.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content.find((y) => y.type === 'text')?.text ?? '' };
};
const [a, b, c] = [await launch(), await launch(), await launch()];
await sleep(600);

const pa = call(a, 'wait', { ms: 5000 }), pb = call(b, 'wait', { ms: 5000 }), pc = call(c, 'wait', { ms: 5000 });
await sleep(500);
await press();
const rs = await Promise.all([pa, pb, pc]);
check('one press cancels the calls of every instance', rs.every((r) => r.isError && /CANCELLED/.test(r.text)), rs.map((r) => r.text.slice(0, 9)).join(','));
check('all three still connected and working', (await Promise.all([a, b, c].map((x) => call(x, 'list_monitors')))).every((r) => !r.isError));

await sleep(5500); // fresh first press, then a quick second one
await press(); await sleep(500); await press();
await sleep(2500);
check('second press shut down every instance', [a, b, c].every((x) => x.isClosed()), [a, b, c].map((x) => x.isClosed()).join(','));
console.log(failed ? `\n${failed} FAILED` : '\nSHUTDOWN-ALL TEST PASSED');
process.exit(failed ? 1 : 0);

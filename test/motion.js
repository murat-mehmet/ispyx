// Human-motion test: the pointer must glide along a curve in 300-1000 ms and arrive exactly.
// Only moves the pointer between two empty-ish desktop points; nothing is clicked or typed.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as w from '../src/win32.js';
import { curvedPath, ease, randomDuration, typingDelays } from '../src/motion.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
w.init();
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

// pure path checks
{
  const from = { x: 100, y: 100 }, to = { x: 900, y: 500 };
  const p = curvedPath(from, to);
  const a = p(0), b = p(1);
  check('path starts and ends exactly', Math.round(a.x) === 100 && Math.round(a.y) === 100 && Math.round(b.x) === 900 && Math.round(b.y) === 500);
  const len = Math.hypot(800, 400);
  let dev = 0;
  for (let t = 0; t <= 1; t += 0.01) { const q = p(t); dev = Math.max(dev, Math.abs((q.x - 100) * 400 - (q.y - 100) * 800) / len); }
  check('path is curved, not a straight line', dev > 5, `max bend ${dev.toFixed(0)} px`);
  check('ease is smooth (slow start, fast middle, slow end)', ease(0.1) < 0.02 && Math.abs(ease(0.5) - 0.5) < 1e-9 && ease(0.9) > 0.98);
  const ds = Array.from({ length: 200 }, () => randomDuration());
  check('random durations stay within 300-1000 ms and vary', Math.min(...ds) >= 300 && Math.max(...ds) <= 1000 && new Set(ds).size > 50, `${Math.min(...ds)}-${Math.max(...ds)}`);
}

{
  const d = typingDelays('Merhaba dunya, nasilsin?');
  check('typing delays are random within 60-200 ms (longer after spaces/punctuation)', d.length === 24 && new Set(d).size > 12 && d.every((x) => x >= 60 && x <= 200 * 1.8 + 600), `${Math.min(...d)}-${Math.max(...d)} ms`);
  const long = typingDelays('x'.repeat(2000), { capMs: 60000 });
  check('long text is sped up to fit the cap', long.reduce((a, b) => a + b, 0) <= 60500);
}

// live: through the real server
const client = new Client({ name: 'motion-test', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'server.js')],
  env: { ...process.env, WIN_INPUT_AUTH: '0', WIN_INPUT_LOG: path.join(os.tmpdir(), `win-input-mcp-motion-${Date.now()}.jsonl`) },
}));
const call = (name, args) => client.callTool({ name, arguments: args });

const v = w.virtualScreen();
const A = { x: v.x + Math.round(v.width * 0.25), y: v.y + Math.round(v.height * 0.30) };
const B = { x: v.x + Math.round(v.width * 0.75), y: v.y + Math.round(v.height * 0.65) };
const durations = [];
try {
  for (let run = 0; run < 3; run++) {
    const [s, e] = run % 2 === 0 ? [A, B] : [B, A];
    await call('move', { space: 'screen', x: s.x, y: s.y, instant: true });
    await w.sleep(100);
    const samples = [];
    let stop = false;
    const t0 = performance.now();
    const poll = (async () => { while (!stop) { const c = w.cursorPos(); samples.push({ t: performance.now() - t0, ...c }); await w.sleep(4); } })();
    const r = await call('move', { space: 'screen', x: e.x, y: e.y });
    const total = performance.now() - t0;
    stop = true;
    await poll;
    const end = w.cursorPos();
    durations.push(total);
    const dx = e.x - s.x, dy = e.y - s.y, len = Math.hypot(dx, dy);
    let dev = 0, back = 0, prev = 0;
    for (const q of samples) {
      dev = Math.max(dev, Math.abs((q.x - s.x) * dy - (q.y - s.y) * dx) / len);
      const prog = ((q.x - s.x) * dx + (q.y - s.y) * dy) / (len * len);
      if (prog < prev - 0.03) back++;
      prev = Math.max(prev, prog);
    }
    const moving = samples.filter((q) => q.x !== samples[0].x || q.y !== samples[0].y);
    const earlyShare = samples.filter((q) => q.t < 0.1 * total).reduce((m, q) => Math.max(m, ((q.x - s.x) * dx + (q.y - s.y) * dy) / (len * len)), 0);
    check(`run ${run + 1}: arrives exactly`, !r.isError && end.x === e.x && end.y === e.y, `${end.x},${end.y} expected ${e.x},${e.y}`);
    check(`run ${run + 1}: takes 300-1000 ms`, total >= 290 && total <= 1150, `${Math.round(total)} ms`);
    check(`run ${run + 1}: path bends`, dev > 4, `max bend ${dev.toFixed(0)} px of ${Math.round(len)}`);
    check(`run ${run + 1}: smooth, no backtracking, gentle start`, back === 0 && moving.length > 25 && earlyShare < 0.1, `${moving.length} positions seen, first 10% of time covered ${(earlyShare * 100).toFixed(1)}%`);
  }
  check('durations differ between runs', new Set(durations.map(Math.round)).size === 3, durations.map(Math.round).join(', '));
  const t = performance.now();
  await call('move', { space: 'screen', x: A.x, y: A.y, instant: true });
  check('instant: true still jumps', performance.now() - t < 250, `${Math.round(performance.now() - t)} ms`);
} finally {
  await client.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nMOTION TEST PASSED');
process.exit(failed ? 1 : 0);

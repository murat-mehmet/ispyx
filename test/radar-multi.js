// list_windows radar on every monitor: draws the effect directly (nothing is listed or sent) and checks each monitor shows it.
import fs from 'node:fs';
import * as w from '../src/win32.js';
import { ScanAnimation } from '../src/scan.js';
import { shrinkToPng } from '../src/image.js';

w.init();
fs.mkdirSync('test/out', { recursive: true });
let failed = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!ok) failed++; };

const mons = w.listMonitors();
console.log(`${mons.length} monitors: ${mons.map((m) => `${m.width}x${m.height}@${m.left},${m.top}`).join('  ')}`);
const wins = w.listWindows().filter((q) => !q.minimized).map((q) => ({ rect: q.rect, allowed: true, elevated: q.elevated }));
const anim = new ScanAnimation({ enabled: true });
// one eye in the middle of the primary monitor; the ping runs on across the others
const home = mons.find((m) => m.primary) ?? mons[0];
const run = anim.radarAll(wins, mons.map((m) => ({ left: m.left, top: m.top, width: m.width, height: m.height })), home);
await w.sleep(1000);
mons.forEach((m, i) => {
  const cap = w.captureScreenRect({ left: m.left, top: m.top, width: m.width, height: m.height });
  let lit = 0;
  for (let k = 0; k < cap.bits.length; k += 4) { const b = cap.bits[k], g = cap.bits[k + 1], r = cap.bits[k + 2]; if (g > 200 && g - r > 90 && g - b > 60) lit++; }
  fs.writeFileSync(`test/out/radar-monitor${i}.png`, shrinkToPng(cap, 900).png);
  const onIt = wins.filter((q) => q.rect.left < m.left + m.width && q.rect.left + q.rect.width > m.left && q.rect.top < m.top + m.height && q.rect.top + q.rect.height > m.top).length;
  check(`monitor ${i} shows the radar`, onIt === 0 || lit > 300, `${lit} green pixels, ${onIt} windows on it`);
});
await run;
check('radar is gone afterwards', !w._raw.FindWindowW('WinInputMcpScan', null));
console.log(failed ? `\n${failed} FAILED` : '\nRADAR MULTI TEST PASSED');
process.exit(failed ? 1 : 0);

// Screenshot scan over the whole desktop: one eye, one scan line crossing every monitor. Draws directly, captures nothing.
import fs from 'node:fs';
import * as w from '../src/win32.js';
import { ScanAnimation, SCAN_TOTAL_MS } from '../src/scan.js';
import { shrinkToPng } from '../src/image.js';

w.init();
fs.mkdirSync('test/out', { recursive: true });
let failed = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!ok) failed++; };

const v = w.virtualScreen();
const mons = w.listMonitors();
const anim = new ScanAnimation({ enabled: true });
const t0 = performance.now();
const run = anim.play({ left: v.x, top: v.y, width: v.width, height: v.height });
await w.sleep(SCAN_TOTAL_MS * 0.5);
mons.forEach((m, i) => {
  const cap = w.captureScreenRect({ left: m.left, top: m.top, width: m.width, height: m.height });
  let lit = 0;
  for (let k = 0; k < cap.bits.length; k += 4) { const b = cap.bits[k], g = cap.bits[k + 1], r = cap.bits[k + 2]; if (g > 200 && g - r > 90 && g - b > 60) lit++; }
  fs.writeFileSync(`test/out/scan-monitor${i}.png`, shrinkToPng(cap, 900).png);
  check(`monitor ${i} shows the scan line`, lit > 100, `${lit} green pixels`);
});
await run;
check('scan is gone afterwards', !w._raw.FindWindowW('WinInputMcpScan', null), `${Math.round(performance.now() - t0)} ms`);
console.log(failed ? `\n${failed} FAILED` : '\nSCAN MULTI TEST PASSED');
process.exit(failed ? 1 : 0);

// The Alt+Esc hook exists only while working: installed on touch(), removed after the linger, kept by repeated touches.
import w from '../src/platform/index.js';
import { installStopHotkey } from '../src/platform/win32/hotkey.js';
w.init();
let failed = 0;
const check = (n, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h = installStopHotkey(() => {}, 600);
check('no hook before the first call', !h.active());
h.touch();
check('hook installed on first call', h.active());
await sleep(400); h.touch(); await sleep(400);
check('a second call within the linger keeps it (no reinstall gap)', h.active());
await sleep(500);
check('removed after the linger with no calls', !h.active());
h.touch(); check('installed again by the next call', h.active());
h.stop(); check('stop() removes it at once', !h.active());
for (let i = 0; i < 200; i++) { h.touch(); h.stop(); }
check('200 install/remove cycles are fine', !h.active());
console.log(failed ? `\n${failed} FAILED` : '\nHOOK LIFECYCLE PASSED');
process.exit(failed ? 1 : 0);

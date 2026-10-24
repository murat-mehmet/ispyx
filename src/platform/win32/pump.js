// Windows only calls window procedures and low-level hooks while the owning thread pumps messages.
// Node has no message loop of its own, so one shared timer does it. Two speeds: IDLE_MS while nothing needs
// quick turnaround (tray icon only), FAST_MS while the keyboard hook or an effect window is alive. A low-level
// keyboard hook that is serviced every 300 ms would make the user's own typing lag, so anything that installs
// one must hold the fast pace for as long as it exists.
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const MSG = koffi.struct('PUMP_MSG', {
  hwnd: 'intptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', ptx: 'int32', pty: 'int32', lPrivate: 'uint32',
});
const PeekMessageW = user32.func('bool PeekMessageW(_Out_ PUMP_MSG *m, intptr_t h, uint32 min, uint32 max, uint32 remove)');
const DispatchMessageW = user32.func('intptr_t DispatchMessageW(PUMP_MSG *m)');

const FAST_MS = 10;
const IDLE_MS = 300;
const DEFAULT_HOLD_MS = 10000;

let timer = null;
let fastUntil = 0;

export function pumpOnce() {
  const m = {};
  for (let i = 0; i < 50 && PeekMessageW(m, 0, 0, 0, 1); i++) DispatchMessageW(m);
}

let delay = IDLE_MS;

function tick() {
  pumpOnce();
  delay = Date.now() < fastUntil ? FAST_MS : IDLE_MS;
  timer = setTimeout(tick, delay);
  timer.unref();
}

/**
 * Make sure the pump runs and keep it fast for holdMs (default 10 s, extended by every call). Pass 0 for a
 * caller that is happy with the idle pace (the tray icon).
 */
export function ensurePump(holdMs = DEFAULT_HOLD_MS) {
  if (holdMs > 0) fastUntil = Math.max(fastUntil, Date.now() + holdMs);
  if (!timer) return tick();
  if (holdMs > 0 && delay === IDLE_MS) { // a 300 ms wait is pending: cut it short
    clearTimeout(timer);
    tick();
  }
}

// Windows only calls window procedures and low-level hooks while the owning thread pumps messages.
// Node has no message loop of its own, so a timer does it, but only while something needs it: the keyboard hook
// or an effect window. Anything that installs a hook must hold the pump for as long as the hook exists (a
// low-level hook that is not serviced makes the user's own typing lag). When nothing holds it, polling stops.
// The tray icon does not use this: it has its own thread (tray-worker.js).
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const MSG = koffi.struct('PUMP_MSG', {
  hwnd: 'intptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', ptx: 'int32', pty: 'int32', lPrivate: 'uint32',
});
const PeekMessageW = user32.func('bool PeekMessageW(_Out_ PUMP_MSG *m, intptr_t h, uint32 min, uint32 max, uint32 remove)');
const DispatchMessageW = user32.func('intptr_t DispatchMessageW(PUMP_MSG *m)');

const PUMP_MS = 10;
const DEFAULT_HOLD_MS = 10000;

let timer = null;
let until = 0;

export function pumpOnce() {
  const m = {};
  for (let i = 0; i < 50 && PeekMessageW(m, 0, 0, 0, 1); i++) DispatchMessageW(m);
}

function tick() {
  pumpOnce();
  if (Date.now() >= until) { timer = null; return; }
  timer = setTimeout(tick, PUMP_MS);
  timer.unref();
}

/** Run the pump for at least holdMs from now (default 10 s); every call extends it. */
export function ensurePump(holdMs = DEFAULT_HOLD_MS) {
  until = Math.max(until, Date.now() + holdMs);
  if (!timer) tick();
}

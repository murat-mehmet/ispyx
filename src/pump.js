// Windows only calls window procedures and low-level hooks while the owning thread pumps messages.
// Node has no message loop of its own, so one shared timer does it.
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const MSG = koffi.struct('PUMP_MSG', {
  hwnd: 'intptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', ptx: 'int32', pty: 'int32', lPrivate: 'uint32',
});
const PeekMessageW = user32.func('bool PeekMessageW(_Out_ PUMP_MSG *m, intptr_t h, uint32 min, uint32 max, uint32 remove)');
const DispatchMessageW = user32.func('intptr_t DispatchMessageW(PUMP_MSG *m)');

let timer = null;
export function pumpOnce() {
  const m = {};
  for (let i = 0; i < 50 && PeekMessageW(m, 0, 0, 0, 1); i++) DispatchMessageW(m);
}
export function ensurePump() {
  if (timer) return;
  timer = setInterval(pumpOnce, 10);
  timer.unref();
}

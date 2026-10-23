// Emergency stop hotkey: Alt+Esc pressed by the person (not by this server).
// Primary path is a low-level keyboard hook, which can tell real keystrokes from injected ones and swallows
// the Esc, so Windows does not also cycle windows. A polling fallback in the guard covers moments when the
// hook is not serviced (long synchronous work).
import koffi from 'koffi';
import * as w from './win32.js';
import { ensurePump } from './pump.js';

const user32 = koffi.load('user32.dll');
const HookProc = koffi.proto('intptr_t StopHookProc(int code, uintptr_t wp, intptr_t lp)');
const SetWindowsHookExW = user32.func('intptr_t SetWindowsHookExW(int id, StopHookProc *proc, intptr_t mod, uint32 tid)');
const UnhookWindowsHookEx = user32.func('bool UnhookWindowsHookEx(intptr_t h)');
const CallNextHookEx = user32.func('intptr_t CallNextHookEx(intptr_t h, int code, uintptr_t wp, intptr_t lp)');
const GetAsyncKeyState = user32.func('int16_t GetAsyncKeyState(int vk)');

const VK_ESCAPE = 0x1b;
const LLKHF_INJECTED = 0x10;
const LLKHF_ALTDOWN = 0x20;

/** True while every key of the chord is down right now (used as a fallback; injected keys also count). */
export const chordDown = (vks) => vks.every((vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0);

export const HOOK_LINGER_MS = 30000;

/**
 * Alt+Esc hook that exists only while the server is working: touch() installs it (if absent) and pushes the
 * removal back HOOK_LINGER_MS, so idle time and the user's own typing never go through this process.
 */
export function installStopHotkey(onStop, lingerMs = HOOK_LINGER_MS) {
  let hook = 0;
  let swallowUp = false;
  let timer = null;
  const proc = koffi.register((code, wp, lp) => {
    try {
      if (code === 0) {
        const buf = Buffer.alloc(24);
        w._raw.CopyFromMem(buf, lp, 24);
        const vk = buf.readUInt32LE(0);
        const flags = buf.readUInt32LE(8);
        if (vk === VK_ESCAPE && !(flags & LLKHF_INJECTED)) {
          const down = wp === 0x100 || wp === 0x104;
          if (down && flags & LLKHF_ALTDOWN) {
            if (!swallowUp) { // key auto-repeat while held counts as one press
              swallowUp = true;
              setImmediate(() => onStop('Alt+Esc'));
            }
            return 1; // swallowed: no window cycling
          }
          if (!down && swallowUp) {
            swallowUp = false;
            return 1;
          }
        }
      }
    } catch { /* never let a hook error break the keyboard */ }
    return CallNextHookEx(hook, code, wp, lp);
  }, koffi.pointer(HookProc));
  const remove = () => {
    timer = null;
    if (hook) UnhookWindowsHookEx(hook);
    hook = 0;
  };
  return {
    touch() {
      if (!hook) {
        ensurePump();
        hook = SetWindowsHookExW(13, proc, 0, 0); // WH_KEYBOARD_LL
        if (!hook) process.stderr.write('ispyx: stop hotkey hook not installed; using polling only\n');
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(remove, lingerMs);
      timer.unref();
    },
    active: () => !!hook,
    stop: remove,
  };
}

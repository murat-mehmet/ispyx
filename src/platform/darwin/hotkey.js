// Emergency stop hotkey (Option+Esc). The CGEventTap lives in Ispyx.app and exists only while touched.
import { callSync, post, onEvent } from './rpc.js';

export const HOOK_LINGER_MS = 30000;

/** True while every key of the chord is physically down right now. */
export const chordDown = (codes) => callSync('keysState', codes) === true;

/**
 * Same shape as the Windows hook: touch() arms the app's event tap and pushes its removal lingerMs ahead; the
 * app emits a `stop` event per press (auto-repeat counts as one, synthetic events are ignored there).
 */
export function installStopHotkey(onStop, lingerMs = HOOK_LINGER_MS) {
  let armed = false;
  let timer = null;
  let off = null;
  const expire = () => {
    timer = null;
    armed = false;
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    expire();
    if (off) { off(); off = null; }
    try { post('hookStop'); } catch { /* app gone */ }
  };
  return {
    touch() {
      if (!armed) {
        armed = true;
        off ??= onEvent('stop', (ev) => { if (armed) onStop(ev?.reason ?? 'Option+Esc'); });
      }
      post('hookTouch', lingerMs);
      if (timer) clearTimeout(timer);
      timer = setTimeout(expire, lingerMs);
      timer.unref();
    },
    active: () => armed,
    stop,
  };
}

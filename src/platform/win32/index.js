// Windows platform layer: the API every platform exports (see ../CONTRACT.md).
import path from 'node:path';

export * from './win32.js';
export { chordDown, installStopHotkey, HOOK_LINGER_MS } from './hotkey.js';
export { Overlay } from './overlay.js';
export { parseChord, parseSequence, insertsContent } from './keys.js';
export { showDialog } from './dialog.js';
export { ensurePump, pumpOnce } from './pump.js';

export const name = 'win32';
export const capabilities = { elevation: true };
export const stopLabel = 'Alt+Esc';

/** Where the password hash and other per-user state live. */
export const dataDir = () => {
  const roaming = process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
  const fs = process.getBuiltinModule('node:fs');
  const dir = path.join(roaming, 'ispyx');
  const old = path.join(roaming, 'win-input-mcp');
  try { // one-time migration from the old name: copy auth.json, leave the old folder alone
    if (!fs.existsSync(dir) && fs.existsSync(path.join(old, 'auth.json'))) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(old, 'auth.json'), path.join(dir, 'auth.json'));
    }
  } catch { /* best effort: a fresh folder just asks for a new password */ }
  return dir;
};
export { Layer, textMask } from './layer.js';
export { Tray } from './tray.js';
export { autostart } from './autostart.js';

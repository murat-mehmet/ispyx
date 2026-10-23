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

/** Where the password hash and other per-user state live. */
export const dataDir = () => path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'win-input-mcp');

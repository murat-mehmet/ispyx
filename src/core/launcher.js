// Starting and reaching the resident app (resident model). No platform import: usable before anything is loaded.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callOwner, OwnerGone, pipeName } from './ipc.js';

const ENTRY = fileURLToPath(new URL('../server.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts `ispyx --resident` detached and hidden, with this process's environment (same pipe). */
export function spawnResident() {
  const child = spawn(process.execPath, [ENTRY, '--resident'], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/** True when a resident answers on the pipe. */
export async function residentRunning(pipe = pipeName()) {
  try { await callOwner(pipe, '__ping', {}); return true; } catch (e) { if (e instanceof OwnerGone) return false; return true; }
}

/** Makes sure a resident listens, starting one if needed; waits up to timeoutMs. Resolves true when it answers. */
export async function ensureResident(pipe = pipeName(), timeoutMs = 10000) {
  if (await residentRunning(pipe)) return true;
  spawnResident();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(150);
    if (await residentRunning(pipe)) return true;
  }
  return false;
}

/** Opens a URL in the default browser (Windows). */
export function openUrl(url) {
  const c = spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore', detached: true });
  c.on('error', () => {});
  c.unref();
}

/** `ispyx` with a console: start the resident if none runs, open its panel, leave. */
export async function runLauncher() {
  const pipe = pipeName();
  const wasRunning = await residentRunning(pipe);
  if (!(await ensureResident(pipe))) {
    process.stderr.write('ispyx: could not start the resident app (see %APPDATA%\\ispyx\\ispyx.log).\n');
    process.exit(1);
  }
  // Starting it (login, first click) just puts the icon in the tray; clicking the shortcut again opens the panel.
  if (wasRunning) {
    try { await callOwner(pipe, '__panel', {}); } catch { /* no panel: the tray icon is enough */ }
  }
  process.exit(0);
}

/** `ispyx quit`: asks the resident to exit; exits 0 either way. */
export async function runQuit() {
  try { await callOwner(pipeName(), '__quit', {}); } catch { /* not running, or gone before answering */ }
  process.exit(0);
}

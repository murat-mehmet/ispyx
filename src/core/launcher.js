// Starting and reaching the resident app (resident model). No platform import: usable before anything is loaded.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callOwner, OwnerGone, pipeName } from './ipc.js';

const ENTRY = fileURLToPath(new URL('../server.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Inside Ispyx.app (macOS) the app starts and watches the resident: the bundle path, else null. */
function macApp() {
  if (process.platform !== 'darwin') return null;
  const m = /^(.*?\.app)\/Contents\/Resources\//.exec(ENTRY);
  return m ? m[1] : null;
}

/** Starts `ispyx --resident` detached and hidden, with this process's environment (same pipe). Inside Ispyx.app it
 * opens the app instead, which starts the resident itself. */
export function spawnResident() {
  const app = macApp();
  const child = app
    ? spawn('open', ['-g', app, '--args', '--background'], { stdio: 'ignore', detached: true })
    : spawn(process.execPath, [ENTRY, '--resident'], { detached: true, windowsHide: true, stdio: 'ignore' });
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

/** `ispyx update`: stops the resident (it holds files open), installs the latest package, starts it again if it ran. */
export async function runUpdate() {
  if (macApp() || process.platform === 'darwin') {
    process.stderr.write('ispyx: on macOS update by installing the newest Ispyx.app from the Releases page.\n');
    process.exit(1);
  }
  const pipe = pipeName();
  const wasRunning = await residentRunning(pipe);
  if (wasRunning) {
    try { await callOwner(pipe, '__quit', {}); } catch { /* gone before answering */ }
    for (let i = 0; i < 40 && await residentRunning(pipe); i++) await sleep(150);
  }
  const code = await new Promise((resolve) => {
    const c = spawn('npm', ['install', '-g', 'ispyx@latest'], { stdio: 'inherit', shell: true });
    c.on('error', () => resolve(1));
    c.on('exit', (n) => resolve(n ?? 1));
  });
  if (code !== 0) process.stderr.write('ispyx: the update failed (see the npm output above).\n');
  // Start the new copy: npm replaced the files in place, so a fresh process loads them.
  if (wasRunning) spawnResident();
  process.exit(code);
}

/** `ispyx quit`: asks the resident to exit; exits 0 either way. */
export async function runQuit() {
  try { await callOwner(pipeName(), '__quit', {}); } catch { /* not running, or gone before answering */ }
  process.exit(0);
}

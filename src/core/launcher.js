// Starting and reaching the resident app (resident model). No platform import: usable before anything is loaded.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const MAC_BUNDLE_ID = 'com.ispyx.app';
/** Where Ispyx.app's resident listens (macos-entry.js pins it there for the app's own processes). */
export const macAppPipe = () => path.join(os.homedir(), 'Library', 'Application Support', 'Ispyx', 'ispyx.sock');

/**
 * ispyx from npm/npx on a Mac with Ispyx.app installed: forward to the app's resident instead of running a second
 * server of its own (one stop key, one banner, the calls in the panel). Not for tests (ISPYX_PLATFORM) or an explicit
 * ISPYX_PIPE. Returns true when this process should be the `mcp` forwarder.
 */
export function useMacAppResident(env = process.env) {
  if (process.platform !== 'darwin' || macApp() || env.ISPYX_PLATFORM || env.ISPYX_PIPE) return false;
  const installed = ['/Applications', path.join(os.homedir(), 'Applications')].some((d) => fs.existsSync(path.join(d, 'Ispyx.app')));
  if (!installed) return false;
  env.ISPYX_PIPE = macAppPipe();
  return true;
}

/** Starts `ispyx --resident` detached and hidden, with this process's environment (same pipe). Inside Ispyx.app it
 * opens the app instead, which starts the resident itself. */
export function spawnResident() {
  const app = macApp();
  const forApp = app || (process.platform === 'darwin' && process.env.ISPYX_PIPE === macAppPipe());
  const child = forApp
    ? spawn('open', ['-g', ...(app ? [app] : ['-b', MAC_BUNDLE_ID]), '--args', '--background'], { stdio: 'ignore', detached: true })
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

/**
 * `ispyx update`. Windows: stops the resident (it holds files open), installs the latest package, starts it again if
 * it ran. macOS: the app is updated as a whole (it is signed), by scripts/install.sh from the latest release.
 */
export async function runUpdate() {
  if (process.platform === 'darwin') {
    const { MAC_INSTALL_URL } = await import('./updates.js');
    const code = await new Promise((resolve) => {
      const c = spawn('/bin/sh', ['-c', `curl -fsSL ${MAC_INSTALL_URL} | sh`], { stdio: 'inherit' });
      c.on('error', () => resolve(1));
      c.on('exit', (n) => resolve(n ?? 1));
    });
    process.exit(code);
  }
  // "==> <step>" lines: the panel shows them while it runs this (core/updates.js readUpdateLog)
  const step = (s) => process.stdout.write(`\n==> ${s}\n`);
  const pipe = pipeName();
  const wasRunning = await residentRunning(pipe);
  if (wasRunning) {
    step('Stopping ispyx');
    // quietly: the `ispyx mcp` forwarders stay connected and reach the new resident on their next call
    try { await callOwner(pipe, '__restart', {}); } catch { /* gone before answering */ }
    for (let i = 0; i < 40 && await residentRunning(pipe); i++) await sleep(150);
  }
  step('Installing the latest ispyx (npm install -g ispyx@latest)');
  const code = await new Promise((resolve) => {
    const c = spawn('npm', ['install', '-g', 'ispyx@latest'], { stdio: 'inherit', shell: true });
    c.on('error', () => resolve(1));
    c.on('exit', (n) => resolve(n ?? 1));
  });
  if (code !== 0) process.stderr.write('ispyx: the update failed (see the npm output above).\n');
  // Start the new copy: npm replaced the files in place, so a fresh process loads them.
  if (wasRunning) { step('Starting ispyx'); spawnResident(); }
  process.exit(code);
}

/** `ispyx quit`: asks the resident to exit; exits 0 either way. */
export async function runQuit() {
  // macOS: the app would start its resident again; quitting the app ends it and the forwarders
  useMacAppResident();
  if (process.platform === 'darwin' && (macApp() || process.env.ISPYX_PIPE === macAppPipe())) {
    // inside the app: its own id (a dev build is com.ispyx.app.dev)
    let id = MAC_BUNDLE_ID;
    try { id = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)</.exec(fs.readFileSync(path.join(macApp(), 'Contents', 'Info.plist'), 'utf8'))?.[1] ?? id; } catch { /* npm copy: the installed app */ }
    spawnSync('osascript', ['-e', `quit app id "${id}"`], { stdio: 'ignore', timeout: 10000 });
    process.exit(0);
  }
  try { await callOwner(pipeName(), '__quit', {}); } catch { /* not running, or gone before answering */ }
  process.exit(0);
}

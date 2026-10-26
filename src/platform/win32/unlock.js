// Optional win32 feature: "Let the AI unlock this PC" (see docs/unlock-windows.md for the full design and what
// was validated). All native work lives in native/win32-unlock/provider (Rust Credential Provider COM DLL,
// built separately, not part of this package's install) and its install.ps1/uninstall.ps1, each one elevated
// UAC prompt, never run automatically.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = 'C:\\ProgramData\\ispyx';
const SECRET_PATH = path.join(ROOT, 'unlock.secret');
const SIGNAL_PATH = path.join(ROOT, 'unlock.signal');
const PROVIDER_DIR = fileURLToPath(new URL('../../../native/win32-unlock/provider/', import.meta.url));
const DLL_PATH = fileURLToPath(new URL('../../../native/win32-unlock/bin/ispyx_unlock.dll', import.meta.url));

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.on('error', (e) => resolve({ code: -1, out, err: e.message }));
  });
}

/**
 * Runs a .ps1 elevated (one UAC prompt) and waits for it. Resolves { code, out }.
 * -WindowStyle cannot be combined with -Verb RunAs in Windows PowerShell 5.1 (Start-Process throws a parameter
 * error before the UAC prompt even appears) -- confirmed hitting exactly this, so it is deliberately omitted.
 */
function runElevated(scriptPath, args) {
  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args];
  const quoted = psArgs.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const outer = `try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(${quoted}); exit $p.ExitCode } catch { Write-Output "ELEVATE-FAILED: $($_.Exception.Message)"; exit 1 }`;
  return run('powershell.exe', ['-NoProfile', '-Command', outer]);
}

/**
 * Runs an elevated .ps1 that takes a trailing -ResultFile path and writes 'OK' or 'ERROR: ...' there (the
 * elevated child's own stdout/stderr never reaches this process -- see install.ps1's header comment). Resolves
 * { ok, message }.
 */
async function runElevatedScript(scriptPath, args) {
  const resultFile = path.join(os.tmpdir(), `ispyx-unlock-result-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    const { out } = await runElevated(scriptPath, [...args, resultFile]);
    let result = '';
    try { result = fs.readFileSync(resultFile, 'utf8'); } catch { /* elevation itself never ran the script */ }
    if (result) {
      return result.startsWith('ERROR:') ? { ok: false, message: result.slice(6).trim() } : { ok: true, message: result };
    }
    const outer = out.trim().split('\n').pop() || '';
    return { ok: false, message: outer.replace(/^ELEVATE-FAILED:\s*/, '') || 'Setup was cancelled or failed.' };
  } finally {
    try { fs.unlinkSync(resultFile); } catch { /* did not get created, or the script already removed it */ }
  }
}

/**
 * `fs.existsSync` returns false on ANY stat error, not just "missing" -- and the secret file's ACL (by design,
 * see install.ps1) denies read to this account's normal, non-elevated token, which is exactly the context the
 * resident always runs in. So existsSync would report "not enabled" right after a successful install. statSync
 * + checking the error code distinguishes "really missing" (ENOENT) from "there, just can't read it" (anything
 * else) -- confirmed hitting this directly: a real install left this returning false until fixed.
 */
export function isEnabled() {
  try {
    fs.statSync(SECRET_PATH);
    return true;
  } catch (e) {
    return e.code !== 'ENOENT';
  }
}

/**
 * Local-account check (see docs/unlock-windows.md "Known gaps" for why PIN/Microsoft-account and passwordless
 * accounts cannot work here). Resolves { ok: true } or { ok: false, reason }.
 *
 * Deliberately does NOT try to detect "no password set" up front: the one signal Windows exposes for that,
 * UserFlags' UF_PASSWD_NOTREQD bit ("net user"'s "Password required"), means the password-policy check is
 * waived for this account, not that the password is blank -- confirmed a false positive on a real account with
 * a working password. A wrong/blank stored secret is already caught safely at unlock time (one attempt, no
 * retry -- see credential.rs), so there is no need to predict it here.
 */
export async function checkAccount() {
  const ps = `
    $src = $null
    try { $src = (Get-LocalUser -Name $env:USERNAME -ErrorAction Stop).PrincipalSource.ToString() } catch {}
    [PSCustomObject]@{ principalSource = $src } | ConvertTo-Json -Compress
  `;
  const { code, out } = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  if (code !== 0) return { ok: false, reason: 'Could not check the account type.' };
  let info;
  try { info = JSON.parse(out.trim().split('\n').pop()); } catch { return { ok: false, reason: 'Could not check the account type.' }; }
  if (info.principalSource && info.principalSource !== 'Local') {
    return { ok: false, reason: 'This looks like a Microsoft-account or PIN-only sign-in. Unattended unlock only supports a local account with a password.' };
  }
  return { ok: true };
}

/**
 * Panel action: writes the DPAPI secret and registers the Credential Provider (one UAC prompt). Only the
 * password is asked for in the panel -- the account is always the one the resident itself runs as, since that
 * is the only session this mechanism can ever unlock.
 */
export async function enable({ password }) {
  if (!password) throw new Error('Enter the Windows account password.');
  const check = await checkAccount();
  if (!check.ok) throw new Error(check.reason);
  const username = os.userInfo().username;
  const domain = process.env.USERDOMAIN || '';
  const tmp = path.join(os.tmpdir(), `ispyx-unlock-${crypto.randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, `${domain}\n${username}\n${password}\n`);
  try {
    const r = await runElevatedScript(path.join(PROVIDER_DIR, 'install.ps1'), [tmp, DLL_PATH]);
    if (!r.ok) throw new Error(r.message);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* install.ps1 deletes it too either way */ }
  }
}

/** Panel action: unregisters the Credential Provider and deletes the stored secret (one UAC prompt). */
export async function disable() {
  const r = await runElevatedScript(path.join(PROVIDER_DIR, 'uninstall.ps1'), []);
  if (!r.ok) throw new Error(r.message);
}

/**
 * Called by the `unlock` tool while the screen is locked: touches the signal file the Credential Provider
 * watches (a named Win32 event was tried instead, to drop the watcher's poll loop entirely -- reverted, see
 * docs/unlock-windows.md: a named kernel object only exists while some process holds a handle open, and
 * nothing here runs continuously between an enable() and a much later signal() to be that holder). Never
 * needs elevation -- the install step already granted this account write access to this one file.
 */
export function signal() {
  fs.writeFileSync(SIGNAL_PATH, '1');
}

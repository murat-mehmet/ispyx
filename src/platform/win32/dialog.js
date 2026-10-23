// Native password window for the auth gate (Windows: PowerShell + WinForms).
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG = path.join(HERE, 'auth-dialog.ps1');

/**
 * Real password window. Resolves to the dialog's JSON, or
 * { cancel: true, reason } where reason says why: 'timed out', 'closed by the user', or 'dialog failed: ...'.
 */
export function showDialog(opts, ms) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', DIALOG,
      '-Mode', opts.mode,
      '-Message', ` ${opts.message || ''}`, // leading space: a bare "-" would be read as a parameter name
      '-Seconds', String(Math.max(1, Math.ceil(ms / 1000))),
      '-Value', String(opts.value), '-Unit', opts.unit];
    const p = spawn('powershell.exe', args, { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let killed = false;
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => { killed = true; try { p.kill(); } catch { /* gone */ } }, ms + 1500);
    const finish = (code) => {
      clearTimeout(kill);
      try {
        const r = JSON.parse(out.trim().split('\n').pop());
        if (r.cancel) r.reason = r.reason === 'timeout' ? 'timed out' : 'closed by the user';
        resolve(r);
      } catch {
        const why = killed ? 'timed out' : `dialog failed (exit ${code}): ${(err.trim().split('\n')[0] || 'no output').slice(0, 120)}`;
        resolve({ cancel: true, reason: why });
      }
    };
    p.on('close', finish);
    p.on('error', (e) => { clearTimeout(kill); resolve({ cancel: true, reason: `dialog failed to start: ${e.message}` }); });
  });
}

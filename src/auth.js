// Optional password gate. Off by default (config `auth`). When on, the first tool call opens a password
// window; a correct password unlocks this server for a duration the user picks. The unlock is kept in memory
// only, so every server start (every /mcp reconnect) asks again. No answer within 30 s closes the window and
// the tool fails. Only a salted PBKDF2 hash is stored, never the password.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ToolError } from './guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG = path.join(HERE, 'auth-dialog.ps1');
const UNIT_MIN = { minutes: 1, hours: 60, days: 1440 };
const MAX_MIN = 365 * 1440;
const MIN_PASSWORD = 6;
const ITER = 200000;

export const defaultAuthFile = () => path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'win-input-mcp', 'auth.json');

export const toMinutes = (value, unit) => Math.min(MAX_MIN, Math.max(1, Math.round(Number(value) * (UNIT_MIN[unit] ?? 60))));

/** Minutes -> the largest whole unit it fits, for the dialog's initial value. */
export function fromMinutes(min) {
  if (min % 1440 === 0 && min >= 2880) return { value: min / 1440, unit: 'days' };
  if (min % 60 === 0) return { value: min / 60, unit: 'hours' };
  return { value: min, unit: 'minutes' };
}

const hash = (pw, salt, iter) => crypto.pbkdf2Sync(pw, Buffer.from(salt, 'hex'), iter, 32, 'sha256').toString('hex');

/** Real password window (PowerShell + WinForms). Resolves to the dialog's JSON, or { cancel: true } on timeout. */
export function showDialog(opts, ms) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', DIALOG,
      '-Mode', opts.mode, '-Message', ` ${opts.message || ''}`, // leading space: a bare "-" would be read as a parameter name '-Seconds', String(Math.max(1, Math.ceil(ms / 1000))),
      '-Value', String(opts.value), '-Unit', opts.unit];
    const p = spawn('powershell.exe', args, { windowsHide: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    const kill = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, ms + 1500);
    const finish = () => {
      clearTimeout(kill);
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ cancel: true }); }
    };
    p.on('close', finish);
    p.on('error', () => { clearTimeout(kill); resolve({ cancel: true }); });
  });
}

export class Auth {
  /** `prompt(opts, ms)` is injectable so tests need no window. */
  constructor({ enabled, file = defaultAuthFile(), timeoutMs = 30000, prompt = showDialog, now = () => Date.now() }) {
    Object.assign(this, { enabled, file, timeoutMs, prompt, now });
    this.pending = null;
    this.until = 0;
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
  }

  /** The unlock lives in memory only: every server start (and every /mcp reconnect) asks again. */
  unlocked() {
    return this.until > this.now();
  }

  /** Resolves when the server is unlocked; throws a plain message otherwise. Parallel calls share one window. */
  async ensure() {
    if (!this.enabled || this.unlocked()) return;
    this.pending ??= this.ask().finally(() => { this.pending = null; });
    await this.pending;
  }

  async ask() {
    const deadline = this.now() + this.timeoutMs;
    let message = '';
    for (;;) {
      const data = this.read();
      const setup = !data.hash;
      const dur = fromMinutes(data.defaultMinutes ?? 1440);
      const left = deadline - this.now();
      if (left < 1000) throw new ToolError('Password was not entered in time, so the action was refused. Ask the user to enter it, then try again.');
      const r = await this.prompt({ mode: setup ? 'setup' : 'unlock', message, ...dur }, left);
      if (r.cancel) throw new ToolError('Password was not entered (window closed or timed out), so the action was refused. Ask the user to enter it, then try again.');
      const pw = String(r.password ?? '');
      if (setup) {
        if (pw.length < MIN_PASSWORD) { message = `Password must be at least ${MIN_PASSWORD} characters.`; continue; }
        if (pw !== r.confirm) { message = 'The two passwords do not match.'; continue; }
        const salt = crypto.randomBytes(16).toString('hex');
        Object.assign(data, { salt, iter: ITER, hash: hash(pw, salt, ITER) });
      } else {
        const a = Buffer.from(hash(pw, data.salt, data.iter), 'hex');
        const b = Buffer.from(data.hash, 'hex');
        if (!crypto.timingSafeEqual(a, b)) { message = 'Wrong password.'; continue; }
      }
      const minutes = toMinutes(r.value, r.unit);
      this.until = this.now() + minutes * 60000;
      delete data.unlockedUntil; // older versions kept the unlock on disk
      if (r.makeDefault) data.defaultMinutes = minutes;
      this.write(data);
      return;
    }
  }
}

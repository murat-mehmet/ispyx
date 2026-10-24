// Fast typing (speed 0 = fixed 8 ms, speed 100) must arrive exactly. The target is a text box in a small
// form this test opens and closes itself (no Notepad, nothing of yours is touched).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import w from '../src/platform/index.js';
import { typingDelays } from '../src/core/motion.js';

const TARGET = path.join(path.dirname(fileURLToPath(import.meta.url)), 'typing-target.ps1');
w.init();
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};
const FAST = 'Speed ğüşıöç test: the quick brown fox jumps over the lazy dog; Café déjà vu, naïve façade; Straße, smörgåsbord. 0123456789 .,;:!? eeeeeeeeee ....... Ğ Ü Ş İ Ö Ç ok.';
const find = () => w.listWindows().find((x) => x.title === 'win-input-typing-test');

for (const speed of [1, 0, 100, 0]) {
  if (speed === 1 && process.argv[2] !== 'all') continue; // speed 1 takes ~25 s; `npm run typing-test -- all` includes it
  const out = path.join(os.tmpdir(), `win-input-typing-${Date.now()}.txt`);
  const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', TARGET, '-OutFile', out], { stdio: 'ignore' });
  let win = null;
  for (let i = 0; i < 50 && !win; i++) { await w.sleep(200); win = find(); }
  if (!win) { check(`speed ${speed}: target form opened`, false); break; }
  await w.sleep(800);
  await w.bringToForeground(win.hwnd);
  await w.sleep(300);
  const t0 = performance.now();
  await w.typeUnicode(FAST, null, typingDelays(FAST, { speed }));
  const ms = performance.now() - t0;
  await w.sleep(400);
  w._raw.PostMessageW(win.hwnd, 0x10, 0, 0); // WM_CLOSE
  await new Promise((r) => p.on('close', r));
  const got = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '(no output)';
  fs.rmSync(out, { force: true });
  const n = [...FAST].length;
  check(`${n} chars at speed ${speed} arrive exactly`, got === FAST, got === FAST ? `${Math.round(ms)} ms` : JSON.stringify(got));
  if (speed !== 1) check(`speed ${speed}: at least 8 ms per character`, ms >= n * 8 - 20, `${Math.round(ms)} ms`);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nTYPING TEST PASSED');
process.exit(failed ? 1 : 0);

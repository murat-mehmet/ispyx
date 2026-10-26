// Throwaway manual test: exercises src/platform/win32/unlock.js's enable() exactly as the panel's
// setUnlock action would, without needing a browser. Run directly: the password is read from stdin in
// this process only, never passed as a command-line argument or seen by anything else.
// Usage:  node test/manual-enable-unlock.mjs
import readline from 'node:readline';
import * as unlock from '../src/platform/win32/unlock.js';

function readPassword(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Best-effort masking: not perfect on every terminal, but keeps it off the visible history either way.
    rl._writeToOutput = (s) => { if (s.trim() && s !== '\r\n') rl.output.write('*'); else rl.output.write(s); };
    rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
  });
}

const check = await unlock.checkAccount();
console.log('checkAccount():', check);
if (!check.ok) process.exit(1);

const password = await readPassword('\nWindows password for this account (input hidden): ');
console.log('\nCalling enable()... a UAC prompt should appear now.');
try {
  await unlock.enable({ password });
  console.log('OK: enabled. isEnabled() =', unlock.isEnabled());
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}

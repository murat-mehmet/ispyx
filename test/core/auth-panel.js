// Setting, changing and checking the password from the panel (no window involved).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Auth, PasswordError } from '../../src/core/auth.js';

const file = path.join(os.tmpdir(), `ispyx-auth-panel-${process.pid}.json`);
let t = 1000;
const auth = new Auth({ enabled: false, file, now: () => t });
try {
  assert.equal(auth.passwordSet(), false);
  assert.throws(() => auth.setPassword('abc'), PasswordError, 'too short');
  auth.setPassword('first-password');
  assert.equal(auth.passwordSet(), true);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('first-password'), 'only a hash is stored');
  assert.throws(() => auth.setPassword('second-password', 'nope'), /current password is wrong/, 'change needs the current one');
  auth.setPassword('second-password', 'first-password');
  assert.equal(auth.verify('second-password'), true);
  assert.equal(auth.verify('first-password'), false);
  // three wrong tries in a row (the one above counted) lock further tries for 30 s
  auth.verify('x'); auth.verify('x');
  assert.throws(() => auth.verify('second-password'), /Too many/, 'locked');
  t += 31000;
  assert.equal(auth.verify('second-password'), true, 'lock expires');
  console.log('auth-panel: all ok');
} finally {
  fs.rmSync(file, { force: true });
}

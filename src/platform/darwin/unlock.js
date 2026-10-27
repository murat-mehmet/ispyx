// "Let the AI unlock this Mac" (docs/unlock-mac.md). The password goes into a Keychain item owned by Ispyx.app;
// nothing on the Node side keeps it. Same shape as win32/unlock.js so the panel action and the `unlock` tool need
// no per-platform code. NOT VERIFIED ON A REAL MAC YET (see the notes in UnlockServices.swift).
import { callSync } from './rpc.js';

export const isEnabled = () => callSync('unlockEnabled') === true;

/** A Mac login always has a password to replay (no PIN-only or Microsoft-account split), so there is nothing to check. */
export const checkAccount = async () => ({ ok: true });

export async function enable({ password }) {
  if (!password) throw new Error('Enter the Mac login password.');
  callSync('unlockStore', password);
}

export async function disable() {
  callSync('unlockClear');
}

/** Starts one unlock attempt (the app wakes the screen and types the stored password once). Never retries. */
export function signal() {
  if (callSync('unlockRun') !== true) throw new Error('The Mac is not locked.');
}

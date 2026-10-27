# Unlocking the Mac from ispyx: research brief

Status: written but NOT TESTED on a Mac (Keychain item, `UnlockServices.swift`, `src/platform/darwin/unlock.js`, panel toggle shared with Windows). The questions below are still open; answer them on a real Mac and tune the timings in `runAttempt`. This is for whoever works on the macOS side (Ispyx.app). Windows is being looked at separately.

## The idea

The user stores their login password once in the panel. When the Mac is locked, an AI can ask ispyx to unlock it, so the AI can keep working on a machine nobody is sitting at.

## What we do not know yet (please find out, on a real Mac)

Answer each with a test, not a guess, and write the result at the bottom of this file.

1. **Does a synthetic key reach the lock screen?** With the screen locked (Lock Screen, not just the screensaver), does `CGEvent.post(tap: .cghidEventTap)` from Ispyx.app type into the password field? Also try `.cgSessionEventTap`. Does it need the Accessibility permission, and does the lock screen change that?
2. **Wake and dismiss.** If the display is asleep or the screensaver is running, does a mouse move or a key press wake it? Does the first key press get swallowed (it often only wakes the screen)?
3. **Which lock states exist?** (a) screensaver with "require password", (b) display sleep with password, (c) the lock screen after "Lock Screen" (ctrl+cmd+Q), (d) fast user switching to the login window, (e) FileVault pre-boot screen after a restart. Expect (e) to be impossible. Say which of the rest work.
4. **Touch ID / Apple Watch.** If the Mac offers Touch ID first, does typing the password still work (the password field is shown after one failed or skipped attempt)? Is there a way to land straight on the password field?
5. **Secure Event Input.** The password field turns on secure input. Does that block posted events? (It blocks other apps from *reading* keystrokes; posting may be fine, but check.)
6. **Does `isScreenLocked` stay accurate?** We have `isScreenLocked` in `WindowServices.swift`. Check what it returns in each state in question 3, and whether the app keeps running (and answering the socket) while locked.
7. **Timing.** How long after the last key until the desktop is usable? How should we confirm success (the lock window is gone, `isScreenLocked` false)?

## Constraints from the design (not up for debate)

- **The AI never sees the password.** Not in tool arguments, results, logs or screenshots. The tool takes no password parameter.
- **Storage:** macOS Keychain, an item owned by Ispyx.app, not readable by other apps. Never in `settings.json` or the log.
- **It is opt-in and off by default.** A switch in the panel ("Let the AI unlock this Mac") plus the password field. Turning it off deletes the Keychain item.
- **It is a deliberate weakening of the lock screen.** Say so in the panel text. Anyone who can reach the MCP server while the Mac is locked can open it. This must go through the same stop key (Option+Esc) and the existing password gate as every other tool.
- **No typing into other password fields.** The existing "refuse to type into a password field" rule stays. Unlock is a separate, narrow code path that only runs when the Mac is locked, not a way around that rule.
- **Log the event** (time, success or failure, nothing else) like other tool calls.
- Wrong password: stop after one try and report it. Do not retry: repeated attempts can lock the account.

## What to deliver

1. The answers to the questions above, in this file, with the macOS version and Mac model tested.
2. If it works: a short design (service, router call, tool name, panel UI, Keychain access flow) and a small spike that unlocks once.
3. If it does not work for the common case (screen lock after a lid close, screensaver): say that plainly. A "keep the Mac awake while ispyx works" option may be the better answer.

## Safe way to test

Test on a Mac you can reach physically. Keep a second way in (another computer with Screen Sharing or SSH is handy) before you lock it. Start with a throwaway local account whose password you don't mind typing into logs. Do not test with the real account until the throwaway one works.

## What is built (untested)

- Panel toggle "Let the AI unlock this Mac" -> `setUnlock` -> `unlockStore(password)`: a generic-password Keychain item, service `com.ispyx.app.unlock`, account = the login name.
- `unlock` tool (same as Windows): not locked -> `alreadyUnlocked`; locked -> `unlockRun`, then polls `isScreenLocked` for 10 s.
- `unlockRun` (one attempt, background queue): declares user activity (wakes the display), moves the mouse, taps Shift, waits, types the password as unicode key events, taps Return. A second call while one runs does nothing; it never retries.
- Guesses to verify: the 0.8 s / 0.7 s waits, whether Shift is enough to reach the password field, whether the login keychain is readable while locked, and whether a posted key is accepted by the lock screen at all (question 1, 5).

## Results

(fill in)

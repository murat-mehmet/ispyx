# Unlocking Windows from ispyx: design brief (Credential Provider)

Status: an idea, nothing is built. Mirrors `docs/unlock-mac.md` for the other platform.

## The ask

The user stores their Windows account password (or PIN) once, in the panel, deliberately and knowingly. When the machine is locked, an AI using ispyx can ask it to unlock the session so it can keep working unattended. The user accepts the trade-off: whoever can reach the ispyx server while the PC is locked can unlock it.

## Why a Credential Provider, not a synthetic-key approach

The lock screen (`LogonUI.exe`) runs on the secure desktop; a normal process cannot post keystrokes into it, and trying to defeat that boundary with privilege tricks is the approach we're explicitly avoiding here. A **Credential Provider** is Microsoft's own, documented extension point for adding a login/unlock method to that same screen — it runs *as part of* LogonUI, in-process, with no desktop-boundary trick needed. This is how Windows Hello, smart-card logon, and third-party SSO/MFA agents show up as tiles on the lock screen.

Docs: `ICredentialProvider`/`ICredentialProviderCredential` (COM interfaces), registered under `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers`. Each provider is a COM DLL with a CLSID, loaded by LogonUI when the lock/logon screen appears.

## Shape of the solution

1. **A small native COM DLL** (C++ or Rust; Node cannot register as an in-proc COM server for this) implementing `ICredentialProvider`. It offers one tile: "Unlock with ispyx". Selecting it does not ask the user anything — it reads a stored, encrypted secret and calls `SetSerialization` with the user's actual Windows credential, exactly as a smart-card provider would after reading the card.
2. **Where the secret lives:** DPAPI-protected (`CryptProtectData`, machine-scope, SYSTEM-only, since LogonUI runs as SYSTEM before the user's DPAPI user keys are available). Written once when the user turns the feature on in the panel (elevation prompt at that moment, not at every unlock). Never passed to or readable by the AI.
3. **How ispyx triggers it:** the credential provider DLL also exposes a tiny local signal (e.g. watches a named event or a file it alone can read) that the *running* resident sets when the `unlock` tool is called and the screen is locked. On seeing the signal, the already-loaded provider auto-submits its tile instead of waiting for a click. This avoids needing ispyx itself to run with SYSTEM rights at unlock time — only the DLL, which LogonUI itself loads as SYSTEM, touches the secret.
4. **Install:** ships as part of the normal Windows install/update (`scripts/install.ps1`), with one elevation prompt to register the DLL and (re)write the DPAPI secret whenever the panel toggle or stored password changes. No scheduled task, no second long-running elevated process.
5. **Panel UI:** a switch, "Let the AI unlock this PC", off by default, with the password field and a one-line explanation of the trade-off; turning it off re-registers the provider with the secret cleared (or unregisters it).
6. **ispyx side:** a `unlock` tool, no parameters, works only while the screen is locked; it does not touch the secret directly, only signals the provider and then polls `isScreenLocked()` the way the Mac doc does, with a timeout and a plain error if it doesn't clear.

## What's unverified (needs a real spike, not assumed)

- Whether `SetSerialization` with a plain password credential actually completes an unlock the same way typing it would (expected: yes, this is the documented path image/smart-card providers use — but untested here).
- Behavior on Windows Hello–only setups (no password credential provider enabled) — may need the password provider enabled in policy.
- Whether running on a non-domain, Microsoft-account vs local-account setup changes anything about the credential blob `SetSerialization` expects (`CPUS_UNLOCK_WORKSTATION` usage).
- Signing/driver-signing requirements for the DLL on a stock Windows 11 box (none expected — this isn't a kernel driver — but SmartScreen/Defender behavior around an unsigned COM DLL should be checked).
- Clean uninstall/registration edge cases (crash mid-update leaving a stale CLSID registered).

## Order of work

1. Spike: register a minimal `ICredentialProvider` DLL by hand (outside the installer) on a throwaway VM, confirm it shows a tile and that `SetSerialization` unlocks with a hardcoded test password. This alone answers the biggest unknown.
2. If it works: wire up DPAPI storage, the ispyx-to-provider signal, panel UI, and installer registration.
3. Keep it entirely optional and off by default, same as the Mac side.

## Suggested test setup

Do this on a disposable VM with a throwaway local account, not this machine or your main account — a bug in an early credential provider can make an account temporarily unable to log in normally (removable by booting to safe mode / another admin account and deleting the registry key, but annoying). Keep a second admin account or snapshot you can roll back to before testing.

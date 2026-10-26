// Gate: the tile must not exist (and must not submit) unless a real, recent trigger is present. The resident
// sets this file's mtime when the `unlock` tool runs while the screen is locked.
//
// A named Win32 event was tried first for the "wait" side (no polling), but a named kernel object only exists
// while some process holds a handle open -- install.ps1 creates it, closes its own handle on exit, and the OS
// discards it immediately (confirmed: a later OpenExisting failed with "No handle of the given name exists").
// Nothing in this architecture runs continuously to hold such a handle open between an `enable()` and a much
// later `signal()` (the DLL only exists transiently, per lock cycle; adding a persistent holder process would
// be a second long-running background process, which the brief rules out). A file has no such problem -- it
// just sits on disk -- so the signal stays file-based. What changes is how the watcher thread *waits*:
// FindFirstChangeNotificationW blocks (no CPU) until something in the directory changes, instead of sleeping
// in a poll loop; is_signal_fresh() is still the actual source of truth on each wake (a wake can be spurious --
// our own log.txt lives in the same directory).
use std::time::{Duration, SystemTime};

use windows::Win32::Foundation::{CloseHandle, FILETIME, GENERIC_WRITE, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification, OPEN_EXISTING, SetFileTime,
};
use windows::Win32::System::Threading::{INFINITE, WaitForMultipleObjects};
use windows::core::{PCWSTR, w};

const SIGNAL_PATH: &str = r"C:\ProgramData\ispyx\unlock.signal";
const WATCH_DIR: windows::core::PCWSTR = w!(r"C:\ProgramData\ispyx");
const SIGNAL_MAX_AGE: Duration = Duration::from_secs(20);

pub fn is_signal_fresh() -> bool {
    let Ok(meta) = std::fs::metadata(SIGNAL_PATH) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    match SystemTime::now().duration_since(modified) {
        Ok(age) => age <= SIGNAL_MAX_AGE,
        Err(_) => false, // mtime in the future: clock skew, don't trust it
    }
}

// One attempt per signal: called the moment GetSerialization commits to an
// unlock try, so a failed attempt can never auto-retry even while the
// freshness window is still open. Without this, a wrong/stale credential
// loops the tile until the window lapses, locking the user out of their own
// manual sign-in meanwhile.
//
// Ages the file's mtime instead of deleting it: the file's ACL (set once at install time) grants this account
// write access to the file itself, not create rights on C:\ProgramData\ispyx (locked to SYSTEM/Administrators
// at install time, see install.ps1). Deleting it meant the *next* signal() had to create a new file there,
// which failed with EPERM -- confirmed hitting this directly, the resident could signal exactly once per
// install. Setting the mtime to the Windows epoch needs only the write access already granted, forever.
pub fn consume_signal() {
    let wide: Vec<u16> = SIGNAL_PATH.encode_utf16().chain(std::iter::once(0)).collect();
    let epoch = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    unsafe {
        let Ok(h) = CreateFileW(
            PCWSTR(wide.as_ptr()),
            GENERIC_WRITE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        ) else {
            return;
        };
        let _ = SetFileTime(h, None, None, Some(&epoch));
        let _ = CloseHandle(h);
    }
}

/// An unnamed, per-Provider-instance manual-reset event UnAdvise/a new Advise signals to wake the watcher
/// thread immediately for shutdown, instead of it waking on a timer to check a stop flag.
pub fn create_stop_event() -> Option<HANDLE> {
    unsafe { windows::Win32::System::Threading::CreateEventW(None, true, false, windows::core::PCWSTR::null()).ok() }
}

/// Blocks until something changes in the watched directory or `stop` is signalled (no polling). Returns true
/// for "something changed, go check is_signal_fresh()", false for "stop requested" (or the watch could not be
/// set up at all).
pub fn wait_for_change_or_stop(stop: HANDLE) -> bool {
    let Ok(watch) = (unsafe { FindFirstChangeNotificationW(WATCH_DIR, false, FILE_NOTIFY_CHANGE_LAST_WRITE) }) else {
        return false;
    };
    let handles = [watch, stop];
    let r = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
    if r == WAIT_OBJECT_0 {
        unsafe {
            let _ = FindNextChangeNotification(watch); // re-arm is unnecessary here (this handle is about to close), kept for correctness if reused
            let _ = FindCloseChangeNotification(watch);
        }
        true
    } else {
        unsafe {
            let _ = FindCloseChangeNotification(watch);
        }
        false
    }
}


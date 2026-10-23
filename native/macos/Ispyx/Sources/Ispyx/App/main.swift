import AppKit
import Darwin

// Ispyx.app entry point: a menu-bar agent (no Dock icon). One instance per user.

/// Kept open for the life of the process: the advisory lock is released by the OS when we exit or crash.
var instanceLockFd: Int32 = -1

func acquireSingleInstanceLock() -> Bool {
    let dir = AppPaths.supportDir
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                             attributes: [.posixPermissions: 0o700])
    let fd = open(dir + "/instance.lock", O_CREAT | O_RDWR, 0o600)
    if fd < 0 { return true } // cannot lock: better to run than to refuse
    if flock(fd, LOCK_EX | LOCK_NB) != 0 {
        close(fd)
        return false
    }
    instanceLockFd = fd
    return true
}

signal(SIGPIPE, SIG_IGN)

if !acquireSingleInstanceLock() {
    // Another Ispyx is already running for this user.
    exit(0)
}

let ispyxApp = NSApplication.shared
let ispyxDelegate = AppDelegate()
ispyxApp.delegate = ispyxDelegate
ispyxApp.setActivationPolicy(.accessory)
ispyxApp.run()

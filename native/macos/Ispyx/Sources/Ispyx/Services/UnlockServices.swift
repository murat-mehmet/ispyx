import Foundation
import CoreGraphics
import IOKit.pwr_mgt
import Security
import Carbon.HIToolbox

// "Let the AI unlock this Mac" (see docs/unlock-mac.md). The login password lives in a Keychain item owned by this
// app; the Node side only ever says "store this", "forget it" and "try once". Nothing here logs or returns it.
//
// NOT VERIFIED ON A REAL MAC YET: written from the brief's design, not from a test. The open questions in
// docs/unlock-mac.md (does a posted key reach the lock screen, is the first key swallowed by the wake, which lock
// states work) still need answering; the timings below are guesses to tune.

private let keychainService = "com.ispyx.app.unlock"
private var attemptRunning = false

private func keychainQuery() -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: keychainService,
     kSecAttrAccount as String: NSUserName()]
}

private func storedPassword() -> String? {
    var q = keychainQuery()
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
}

/// Attributes only, never the secret: the panel polls this every second and a data read could raise a Keychain prompt.
private func passwordIsStored() -> Bool {
    var q = keychainQuery()
    q[kSecReturnAttributes as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    return SecItemCopyMatching(q as CFDictionary, nil) == errSecSuccess
}

private func screenIsLocked() -> Bool {
    guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    if let locked = d["CGSSessionScreenIsLocked"] as? NSNumber, locked.boolValue { return true }
    if let onConsole = d[kCGSessionOnConsoleKey as String] as? NSNumber, !onConsole.boolValue { return true }
    return false
}

private let unlockSource: CGEventSource? = CGEventSource(stateID: .privateState)

private func postUnlockEvent(_ ev: CGEvent?) {
    guard let ev else { return }
    ev.setIntegerValueField(.eventSourceUserData, value: ispyxSyntheticMarker)
    ev.post(tap: .cghidEventTap)
}

private func tapKey(_ code: Int) {
    for down in [true, false] {
        postUnlockEvent(CGEvent(keyboardEventSource: unlockSource, virtualKey: CGKeyCode(code), keyDown: down))
    }
}

private func typeText(_ text: String) {
    for ch in text {
        let units = Array(String(ch).utf16)
        for down in [true, false] {
            guard let ev = CGEvent(keyboardEventSource: unlockSource, virtualKey: 0, keyDown: down) else { continue }
            ev.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            postUnlockEvent(ev)
        }
        usleep(25_000)
    }
}

/// One attempt, on a background queue so the router (main thread) is not blocked for the seconds this takes.
/// The caller polls isScreenLocked to learn the outcome. Never retries: a wrong password must not be tried twice.
private func runAttempt(_ password: String) {
    DispatchQueue.global(qos: .userInitiated).async {
        defer { attemptRunning = false }
        var assertion: IOPMAssertionID = 0
        IOPMAssertionDeclareUserActivity("Ispyx unlock" as CFString, kIOPMUserActiveLocal, &assertion)
        // wake the display / dismiss the screensaver; the first input is often swallowed doing only that
        postUnlockEvent(CGEvent(mouseEventSource: unlockSource, mouseType: .mouseMoved,
                                mouseCursorPosition: CGPoint(x: 10, y: 10), mouseButton: .left))
        usleep(800_000)
        tapKey(kVK_Shift)
        usleep(700_000)
        typeText(password)
        usleep(150_000)
        tapKey(kVK_Return)
        IOPMAssertionRelease(assertion)
    }
}

func registerUnlockServices(_ r: Router) {
    r.register("unlockEnabled") { _ in passwordIsStored() }

    r.register("unlockStore") { args in
        let password = try args.string(0)
        if password.isEmpty { throw HelperError("Enter the Mac login password.") }
        let data = Data(password.utf8)
        let update = SecItemUpdate(keychainQuery() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecItemNotFound {
            var add = keychainQuery()
            add[kSecValueData as String] = data
            let status = SecItemAdd(add as CFDictionary, nil)
            if status != errSecSuccess { throw HelperError("Could not save the password to the Keychain (error \(status)).") }
        } else if update != errSecSuccess {
            throw HelperError("Could not update the password in the Keychain (error \(update)).")
        }
        return true
    }

    r.register("unlockClear") { _ in
        let status = SecItemDelete(keychainQuery() as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound { throw HelperError("Could not remove the password from the Keychain (error \(status)).") }
        return true
    }

    r.register("unlockRun") { _ in
        guard let password = storedPassword() else { throw HelperError("Unattended unlock was never turned on.") }
        guard screenIsLocked() else { return false }
        if attemptRunning { return true } // one attempt per request: a second call while one is typing does nothing
        attemptRunning = true
        runAttempt(password)
        return true
    }
}

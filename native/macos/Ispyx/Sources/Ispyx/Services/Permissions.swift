import Foundation
import ApplicationServices
import CoreGraphics

private var accessibilityGranted = false
private var screenRecordingGranted = false

/// Names of the permissions Ispyx still lacks ("accessibility", "screenRecording").
func missingPermissions() -> [String] {
    var out: [String] = []
    if !hasPermission("accessibility") { out.append("accessibility") }
    if !hasPermission("screenRecording") { out.append("screenRecording") }
    return out
}

func hasPermission(_ name: String) -> Bool {
    switch name {
    case "accessibility":
        // A granted permission stays granted for the life of the process: cache it to keep hot paths cheap.
        if accessibilityGranted { return true }
        if AXIsProcessTrusted() { accessibilityGranted = true }
        return accessibilityGranted
    case "screenRecording":
        if screenRecordingGranted { return true }
        if CGPreflightScreenCaptureAccess() { screenRecordingGranted = true }
        return screenRecordingGranted
    default:
        return true
    }
}

/// Adds Ispyx to the permission's list in System Settings (macOS lists only apps that asked) and lets macOS show
/// its own prompt. Checking alone (AXIsProcessTrusted, CGPreflightScreenCaptureAccess) never adds the entry.
func requestPermission(_ name: String) {
    switch name {
    case "accessibility":
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        if AXIsProcessTrustedWithOptions(opts) { accessibilityGranted = true }
    case "screenRecording":
        if CGRequestScreenCaptureAccess() { screenRecordingGranted = true }
    default:
        break
    }
}

/// Throws the message from PROTOCOL.md's Permissions section when `name` is missing.
func requirePermission(_ name: String) throws {
    if hasPermission(name) { return }
    switch name {
    case "accessibility":
        throw HelperError("Ispyx needs the Accessibility permission. Open System Settings > Privacy & Security > Accessibility and switch Ispyx on, then try again.")
    case "screenRecording":
        throw HelperError("Ispyx needs the Screen Recording permission. Open System Settings > Privacy & Security > Screen Recording and switch Ispyx on, then try again.")
    default:
        throw HelperError("Ispyx is missing the \(name) permission.")
    }
}

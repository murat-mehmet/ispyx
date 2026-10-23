import Foundation
import AppKit
import CoreGraphics
import ApplicationServices
import Carbon.HIToolbox

// Stop hotkey: Option+Esc. An active session event tap exists only between hookTouch and
// (lingerMs after the last touch | hookStop).

private var stopTap: CFMachPort?
private var stopSource: CFRunLoopSource?
private var lingerItem: DispatchWorkItem?
private var escSwallowed = false  // an Esc key-down was swallowed and its key-up (and repeats) must be too

private func stopTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = stopTap { CGEvent.tapEnable(tap: t, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    if event.getIntegerValueField(.eventSourceUserData) == ispyxSyntheticMarker {
        return Unmanaged.passUnretained(event)
    }
    if type != .keyDown && type != .keyUp {
        return Unmanaged.passUnretained(event)
    }
    let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
    if code != kVK_Escape {
        return Unmanaged.passUnretained(event)
    }
    if type == .keyDown {
        let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        if event.flags.contains(.maskAlternate) {
            if !isRepeat && !escSwallowed {
                EventBus.shared.send("stop", ["reason": "Option+Esc"])
            }
            escSwallowed = true
            return nil
        }
        if escSwallowed { return nil }  // repeat after Option was released
        return Unmanaged.passUnretained(event)
    }
    // keyUp
    if escSwallowed {
        escSwallowed = false
        return nil
    }
    return Unmanaged.passUnretained(event)
}

private func installStopTap() throws {
    if let t = stopTap {
        if !CGEvent.tapIsEnabled(tap: t) { CGEvent.tapEnable(tap: t, enable: true) }
        return
    }
    try requirePermission("accessibility")
    let mask: CGEventMask = (CGEventMask(1) << CGEventMask(CGEventType.keyDown.rawValue))
        | (CGEventMask(1) << CGEventMask(CGEventType.keyUp.rawValue))
        | (CGEventMask(1) << CGEventMask(CGEventType.flagsChanged.rawValue))
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                      eventsOfInterest: mask, callback: stopTapCallback, userInfo: nil) else {
        throw HelperError("Ispyx could not install the stop hotkey (Option+Esc). Check the Accessibility permission for Ispyx in System Settings > Privacy & Security, then try again.")
    }
    let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    stopTap = tap
    stopSource = src
    escSwallowed = false
}

private func removeStopTap() {
    lingerItem?.cancel()
    lingerItem = nil
    if let t = stopTap {
        CGEvent.tapEnable(tap: t, enable: false)
        if let s = stopSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
        CFMachPortInvalidate(t)
    }
    stopTap = nil
    stopSource = nil
    escSwallowed = false
}

func registerHotkeyServices(_ r: Router) {
    r.register("hookTouch") { args in
        var linger = 30000
        if args.count > 0, let n = args[0] as? NSNumber { linger = n.intValue }
        if linger < 1000 { linger = 1000 }
        try installStopTap()
        lingerItem?.cancel()
        let item = DispatchWorkItem { removeStopTap() }
        lingerItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(linger) / 1000.0, execute: item)
        return true
    }

    r.register("hookStop") { _ in
        removeStopTap()
        return true
    }
}

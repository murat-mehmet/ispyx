import Foundation
import AppKit
import CoreGraphics
import ApplicationServices
import Carbon.HIToolbox

// Synthetic input. Every event is posted to the HID tap from a private event source and carries
// ispyxSyntheticMarker in kCGEventSourceUserData so the stop-hotkey tap can recognise and ignore it.

private let inputSource: CGEventSource? = CGEventSource(stateID: .privateState)

/// Modifier flags of the modifier keys currently held by keysDown (applied to every event we post).
private var heldFlags: CGEventFlags = []
private var heldKeys = Set<Int>()

// Mouse state
private var heldButtons = Set<String>()
private var lastMousePos = CGPoint.zero
private var lastClickTime: TimeInterval = 0
private var lastClickPos = CGPoint.zero
private var lastClickButton = ""
private var clickCount = 0

private var wheelRemainderY = 0.0
private var wheelRemainderX = 0.0
private let pixelsPerNotch = 40.0

private var pendingHighSurrogate: UInt16 = 0

private func post(_ ev: CGEvent) {
    ev.setIntegerValueField(.eventSourceUserData, value: ispyxSyntheticMarker)
    ev.post(tap: .cghidEventTap)
}

private func cursorLocation() -> CGPoint {
    if let e = CGEvent(source: nil) { return e.location }
    return .zero
}

private struct ButtonInfo {
    let down: CGEventType
    let up: CGEventType
    let dragged: CGEventType
    let button: CGMouseButton
    let number: Int64
}

private func buttonInfo(_ name: String) throws -> ButtonInfo {
    switch name {
    case "left": return ButtonInfo(down: .leftMouseDown, up: .leftMouseUp, dragged: .leftMouseDragged, button: .left, number: 0)
    case "right": return ButtonInfo(down: .rightMouseDown, up: .rightMouseUp, dragged: .rightMouseDragged, button: .right, number: 1)
    case "middle": return ButtonInfo(down: .otherMouseDown, up: .otherMouseUp, dragged: .otherMouseDragged, button: .center, number: 2)
    default: throw HelperError("Unknown mouse button '\(name)'. Use left, right or middle.")
    }
}

private func keyEvent(_ code: Int, down: Bool) throws -> CGEvent {
    guard let ev = CGEvent(keyboardEventSource: inputSource, virtualKey: CGKeyCode(code), keyDown: down) else {
        throw HelperError("macOS refused to create a keyboard event. Check that Ispyx has the Accessibility permission.")
    }
    return ev
}

private func postKey(_ code: Int, down: Bool) throws {
    let ev = try keyEvent(code, down: down)
    if let flag = modifierFlag(forKeyCode: code) {
        // Modifier keys are reported with flagsChanged events whose flags already include the new state.
        if down { heldFlags.insert(flag) } else { heldFlags.remove(flag) }
        ev.type = .flagsChanged
        ev.flags = heldFlags
    } else {
        ev.flags = heldFlags
    }
    post(ev)
}

private func scalarUnits(_ codePoint: Int) -> [UInt16]? {
    // Lone surrogate halves arrive when the client splits UTF-16: pair them up.
    if codePoint >= 0xD800 && codePoint <= 0xDBFF {
        pendingHighSurrogate = UInt16(codePoint)
        return nil
    }
    if codePoint >= 0xDC00 && codePoint <= 0xDFFF {
        let high = pendingHighSurrogate
        pendingHighSurrogate = 0
        if high == 0 { return nil }
        return [high, UInt16(codePoint)]
    }
    pendingHighSurrogate = 0
    guard codePoint >= 0, let scalar = Unicode.Scalar(UInt32(codePoint)) else { return nil }
    return Array(String(Character(scalar)).utf16)
}

func registerInputServices(_ r: Router) {
    r.register("cursorPos") { _ in
        let p = cursorLocation()
        return ["x": Int(p.x.rounded()), "y": Int(p.y.rounded())] as [String: Any]
    }

    r.register("mouseMoveTo") { args in
        try requirePermission("accessibility")
        let x = try args.double(0)
        let y = try args.double(1)
        let pt = CGPoint(x: x, y: y)
        var type = CGEventType.mouseMoved
        var button = CGMouseButton.left
        if heldButtons.contains("left") { type = .leftMouseDragged; button = .left }
        else if heldButtons.contains("right") { type = .rightMouseDragged; button = .right }
        else if heldButtons.contains("middle") { type = .otherMouseDragged; button = .center }
        guard let ev = CGEvent(mouseEventSource: inputSource, mouseType: type, mouseCursorPosition: pt, mouseButton: button) else {
            throw HelperError("macOS refused to create a mouse event.")
        }
        if button == .center && type != .mouseMoved { ev.setIntegerValueField(.mouseEventButtonNumber, value: 2) }
        ev.setIntegerValueField(.mouseEventDeltaX, value: Int64((x - lastMousePos.x).rounded()))
        ev.setIntegerValueField(.mouseEventDeltaY, value: Int64((y - lastMousePos.y).rounded()))
        ev.flags = heldFlags
        lastMousePos = pt
        post(ev)
        return true
    }

    r.register("mouseDown") { args in
        try requirePermission("accessibility")
        let name = try args.string(0)
        let info = try buttonInfo(name)
        let pos = cursorLocation()
        let now = ProcessInfo.processInfo.systemUptime
        let dx = pos.x - lastClickPos.x
        let dy = pos.y - lastClickPos.y
        let near = (dx * dx + dy * dy) <= 16.0
        if name == lastClickButton && near && (now - lastClickTime) <= NSEvent.doubleClickInterval {
            clickCount += 1
        } else {
            clickCount = 1
        }
        lastClickTime = now
        lastClickPos = pos
        lastClickButton = name
        guard let ev = CGEvent(mouseEventSource: inputSource, mouseType: info.down, mouseCursorPosition: pos, mouseButton: info.button) else {
            throw HelperError("macOS refused to create a mouse event.")
        }
        ev.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        if info.number >= 2 { ev.setIntegerValueField(.mouseEventButtonNumber, value: info.number) }
        ev.flags = heldFlags
        heldButtons.insert(name)
        lastMousePos = pos
        post(ev)
        return true
    }

    r.register("mouseUp") { args in
        try requirePermission("accessibility")
        let name = try args.string(0)
        let info = try buttonInfo(name)
        let pos = cursorLocation()
        guard let ev = CGEvent(mouseEventSource: inputSource, mouseType: info.up, mouseCursorPosition: pos, mouseButton: info.button) else {
            throw HelperError("macOS refused to create a mouse event.")
        }
        let count = (name == lastClickButton && clickCount > 0) ? clickCount : 1
        ev.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        if info.number >= 2 { ev.setIntegerValueField(.mouseEventButtonNumber, value: info.number) }
        ev.flags = heldFlags
        heldButtons.remove(name)
        lastMousePos = pos
        post(ev)
        return true
    }

    // Positive = up / right (the contract). CGEvent: wheel1 positive = up, wheel2 positive = left, so wheel2 is negated.
    r.register("mouseWheel") { args in
        try requirePermission("accessibility")
        let notches = try args.double(0)
        let total = notches * pixelsPerNotch + wheelRemainderY
        let whole = total.rounded(.towardZero)
        wheelRemainderY = total - whole
        if whole == 0 { return true }
        guard let ev = CGEvent(scrollWheelEvent2Source: inputSource, units: .pixel, wheelCount: 2,
                               wheel1: Int32(whole), wheel2: 0, wheel3: 0) else {
            throw HelperError("macOS refused to create a scroll event.")
        }
        ev.flags = heldFlags
        post(ev)
        return true
    }

    r.register("mouseHWheel") { args in
        try requirePermission("accessibility")
        let notches = try args.double(0)
        let total = notches * pixelsPerNotch + wheelRemainderX
        let whole = total.rounded(.towardZero)
        wheelRemainderX = total - whole
        if whole == 0 { return true }
        guard let ev = CGEvent(scrollWheelEvent2Source: inputSource, units: .pixel, wheelCount: 2,
                               wheel1: 0, wheel2: Int32(-whole), wheel3: 0) else {
            throw HelperError("macOS refused to create a scroll event.")
        }
        ev.flags = heldFlags
        post(ev)
        return true
    }

    r.register("keysDown") { args in
        try requirePermission("accessibility")
        for c in try args.ints(0) {
            try postKey(c, down: true)
            heldKeys.insert(c)
        }
        return true
    }

    r.register("keysUp") { args in
        try requirePermission("accessibility")
        for c in try args.ints(0) {
            try postKey(c, down: false)
            heldKeys.remove(c)
        }
        return true
    }

    r.register("pressVirtualKeys") { args in
        try requirePermission("accessibility")
        let codes = try args.ints(0)
        for c in codes {
            try postKey(c, down: true)
            usleep(2000)
        }
        for c in codes.reversed() {
            try postKey(c, down: false)
            usleep(2000)
        }
        return true
    }

    r.register("typeChar") { args in
        try requirePermission("accessibility")
        let cp = try args.int(0)
        if cp == 10 || cp == 13 {
            try postKey(kVK_Return, down: true)
            try postKey(kVK_Return, down: false)
            return true
        }
        if cp == 9 {
            try postKey(kVK_Tab, down: true)
            try postKey(kVK_Tab, down: false)
            return true
        }
        guard let units = scalarUnits(cp) else { return true }
        for down in [true, false] {
            let ev = try keyEvent(0, down: down)
            ev.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            ev.flags = heldFlags
            post(ev)
        }
        return true
    }

    // True when every listed key is physically down (hardware + synthetic combined session state).
    r.register("keysState") { args in
        let codes = try args.ints(0)
        if codes.isEmpty { return false }
        for c in codes {
            if !CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(c)) { return false }
        }
        return true
    }
}

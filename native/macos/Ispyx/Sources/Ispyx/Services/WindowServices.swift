import Foundation
import AppKit
import CoreGraphics
import ApplicationServices
import Carbon.HIToolbox

// Window ids are CGWindowIDs. Coordinates are points, origin top-left of the primary display (CG's global space).

private struct WinInfo {
    var id: Int
    var pid: Int
    var owner: String
    var name: String
    var bounds: CGRect
    var layer: Int
    var onScreen: Bool
    var alpha: Double
}

private func num(_ v: Any?) -> Double {
    if let n = v as? NSNumber { return n.doubleValue }
    return 0
}

/// All windows known to the window server, front to back for the on-screen ones. `.optionAll` also returns
/// minimised and off-Space windows (kCGWindowIsOnscreen = false).
private func allWindows(onScreenOnly: Bool) -> [WinInfo] {
    let opts: CGWindowListOption = onScreenOnly ? [.optionOnScreenOnly] : [.optionAll]
    guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out: [WinInfo] = []
    for d in raw {
        var rect = CGRect.zero
        if let b = d[kCGWindowBounds as String] {
            rect = CGRect(dictionaryRepresentation: b as! CFDictionary) ?? .zero
        }
        let onScreen = (d[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
        out.append(WinInfo(
            id: Int(num(d[kCGWindowNumber as String])),
            pid: Int(num(d[kCGWindowOwnerPID as String])),
            owner: (d[kCGWindowOwnerName as String] as? String) ?? "",
            name: (d[kCGWindowName as String] as? String) ?? "",
            bounds: rect,
            layer: Int(num(d[kCGWindowLayer as String])),
            onScreen: onScreen,
            alpha: d[kCGWindowAlpha as String] == nil ? 1.0 : num(d[kCGWindowAlpha as String])))
    }
    return out
}

private func findWindow(_ id: Int) -> WinInfo? {
    if id <= 0 { return nil }
    for w in allWindows(onScreenOnly: false) where w.id == id { return w }
    return nil
}

// MARK: process names

private func executableName(_ pid: Int, fallback: String) -> String {
    if let app = NSRunningApplication(processIdentifier: pid_t(pid)) {
        if let n = app.executableURL?.lastPathComponent, !n.isEmpty { return n }
        if let n = app.localizedName, !n.isEmpty { return n }
    }
    return fallback
}

// MARK: Accessibility helpers

private func axCopy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, attr as CFString, &value)
    if err != .success { return nil }
    return value
}

private func axString(_ el: AXUIElement, _ attr: String) -> String? {
    if let v = axCopy(el, attr), CFGetTypeID(v) == CFStringGetTypeID() { return (v as! String) }
    return nil
}

private func axBool(_ el: AXUIElement, _ attr: String) -> Bool {
    if let v = axCopy(el, attr), CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
    return false
}

private func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let p = axCopy(el, kAXPositionAttribute as String), let s = axCopy(el, kAXSizeAttribute as String) else { return nil }
    if CFGetTypeID(p) != AXValueGetTypeID() || CFGetTypeID(s) != AXValueGetTypeID() { return nil }
    var pt = CGPoint.zero
    var sz = CGSize.zero
    if !AXValueGetValue((p as! AXValue), .cgPoint, &pt) { return nil }
    if !AXValueGetValue((s as! AXValue), .cgSize, &sz) { return nil }
    return CGRect(origin: pt, size: sz)
}

private func axApp(_ pid: Int) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid_t(pid))
    AXUIElementSetMessagingTimeout(app, 0.3)  // an unresponsive app must not stall the helper
    return app
}

private func axWindows(_ pid: Int) -> [AXUIElement] {
    if !hasPermission("accessibility") { return [] }
    guard let v = axCopy(axApp(pid), kAXWindowsAttribute as String), CFGetTypeID(v) == CFArrayGetTypeID() else { return [] }
    return (v as? [AXUIElement]) ?? []
}

private func nearlyEqual(_ a: CGRect, _ b: CGRect) -> Bool {
    let t: CGFloat = 3
    return abs(a.origin.x - b.origin.x) <= t && abs(a.origin.y - b.origin.y) <= t
        && abs(a.size.width - b.size.width) <= t && abs(a.size.height - b.size.height) <= t
}

/// The AX element of a CG window, matched by frame (then by title).
private func axWindow(for w: WinInfo, among candidates: [AXUIElement]? = nil) -> AXUIElement? {
    let list = candidates ?? axWindows(w.pid)
    var byFrame: [AXUIElement] = []
    for el in list {
        if let f = axFrame(el), nearlyEqual(f, w.bounds) { byFrame.append(el) }
    }
    if byFrame.count == 1 { return byFrame[0] }
    if byFrame.count > 1 {
        if !w.name.isEmpty {
            for el in byFrame where axString(el, kAXTitleAttribute as String) == w.name { return el }
        }
        return byFrame[0]
    }
    if !w.name.isEmpty {
        for el in list where axString(el, kAXTitleAttribute as String) == w.name { return el }
    }
    return nil
}

private func titleOf(_ w: WinInfo) -> String {
    if !w.name.isEmpty { return w.name }
    if let el = axWindow(for: w), let t = axString(el, kAXTitleAttribute as String) { return t }
    return ""
}

private func isMinimized(_ w: WinInfo) -> Bool {
    if w.onScreen { return false }
    if let el = axWindow(for: w) { return axBool(el, kAXMinimizedAttribute as String) }
    return false
}

private func rectObject(_ r: CGRect) -> [String: Any] {
    return ["left": Int(r.origin.x.rounded()), "top": Int(r.origin.y.rounded()),
            "width": Int(r.size.width.rounded()), "height": Int(r.size.height.rounded())]
}

private func describe(_ w: WinInfo, title: String? = nil, minimized: Bool? = nil) -> [String: Any] {
    return [
        "hwnd": w.id,
        "title": title ?? titleOf(w),
        "className": "",
        "pid": w.pid,
        "process": executableName(w.pid, fallback: w.owner),
        "elevated": false,
        "minimized": minimized ?? isMinimized(w),
        "rect": rectObject(w.bounds),
    ]
}

private func isRealWindow(_ w: WinInfo) -> Bool {
    return w.layer == 0 && w.alpha > 0.01 && w.bounds.width >= 2 && w.bounds.height >= 2
}

// MARK: screens

private func monitorRects() -> [CGRect] {
    let screens = NSScreen.screens
    guard let primary = screens.first else { return [] }  // screens[0] is the one with the menu bar
    let h = primary.frame.height
    return screens.map { s in
        CGRect(x: s.frame.minX, y: h - s.frame.maxY, width: s.frame.width, height: s.frame.height)
    }
}

/// Shared with CaptureServices.
func ispyxMonitorRects() -> [CGRect] { return monitorRects() }

private func fnv(_ s: String) -> Int {
    var h: UInt32 = 2166136261
    for b in s.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
    return Int(h & 0x7fffffff)
}

private func frontmostWindowId() -> Int {
    guard let app = NSWorkspace.shared.frontmostApplication else { return 0 }
    let pid = Int(app.processIdentifier)
    let mine = allWindows(onScreenOnly: true).filter { isRealWindow($0) && $0.pid == pid }
    if mine.isEmpty { return 0 }
    if hasPermission("accessibility"),
       let fv = axCopy(axApp(pid), kAXFocusedWindowAttribute as String), CFGetTypeID(fv) == AXUIElementGetTypeID() {
        let el = fv as! AXUIElement
        if let f = axFrame(el) {
            for w in mine where nearlyEqual(f, w.bounds) { return w.id }
        }
    }
    return mine[0].id
}

func registerWindowServices(_ r: Router) {
    r.register("listWindows") { args in
        var includeUntitled = false
        if args.count > 0, let o = args[0] as? [String: Any], let b = o["includeUntitled"] as? NSNumber {
            includeUntitled = b.boolValue
        }
        let all = allWindows(onScreenOnly: false).filter { isRealWindow($0) }
        // Off-screen windows are listed only when they are minimised (AX knows), never windows of other Spaces.
        var axCache: [Int: [AXUIElement]] = [:]
        var out: [[String: Any]] = []
        for w in all {
            var minimized = false
            if !w.onScreen {
                if axCache[w.pid] == nil { axCache[w.pid] = axWindows(w.pid) }
                guard let el = axWindow(for: w, among: axCache[w.pid]), axBool(el, kAXMinimizedAttribute as String) else { continue }
                minimized = true
            }
            var title = w.name
            if title.isEmpty {
                if axCache[w.pid] == nil { axCache[w.pid] = axWindows(w.pid) }
                if let el = axWindow(for: w, among: axCache[w.pid]), let t = axString(el, kAXTitleAttribute as String) { title = t }
            }
            if title.isEmpty && !includeUntitled { continue }
            out.append(describe(w, title: title, minimized: minimized))
        }
        return out
    }

    r.register("describeWindow") { args in
        let id = try args.int(0)
        guard let w = findWindow(id) else { throw HelperError("Window \(id) no longer exists.") }
        return describe(w)
    }

    r.register("getRect") { args in
        guard let w = findWindow(try args.int(0)) else { return NSNull() }
        return rectObject(w.bounds)
    }

    r.register("getTitle") { args in
        guard let w = findWindow(try args.int(0)) else { return "" }
        return titleOf(w)
    }

    r.register("getClass") { _ in return "" }

    r.register("getPid") { args in
        guard let w = findWindow(try args.int(0)) else { return 0 }
        return w.pid
    }

    r.register("processInfo") { args in
        let pid = try args.int(0)
        return ["name": executableName(pid, fallback: ""), "elevated": false] as [String: Any]
    }

    r.register("windowExists") { args in
        return findWindow(try args.int(0)) != nil
    }

    r.register("rootWindowAt") { args in
        let pt = CGPoint(x: try args.double(0), y: try args.double(1))
        // On-screen list is ordered front to back.
        for w in allWindows(onScreenOnly: true) where isRealWindow(w) && w.bounds.contains(pt) { return w.id }
        return 0
    }

    r.register("foregroundWindow") { _ in return frontmostWindowId() }

    r.register("bringToForeground") { args in
        let id = try args.int(0)
        guard let w = findWindow(id) else { return false }
        let axOK = hasPermission("accessibility")
        var el: AXUIElement? = axOK ? axWindow(for: w) : nil
        if let e = el, axBool(e, kAXMinimizedAttribute as String) {
            AXUIElementSetAttributeValue(e, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        }
        func raise() {
            if let app = NSRunningApplication(processIdentifier: pid_t(w.pid)) {
                app.activate(options: [.activateIgnoringOtherApps])
            }
            if let e = el {
                AXUIElementPerformAction(e, kAXRaiseAction as CFString)
                AXUIElementSetAttributeValue(e, kAXMainAttribute as CFString, kCFBooleanTrue)
                AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            }
        }
        raise()
        let deadline = Date(timeIntervalSinceNow: 1.0)
        var reraised = false
        while Date() < deadline {
            // Let AppKit/NSWorkspace observe the activation.
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(w.pid) {
                if el == nil && axOK { el = axWindow(for: w) }
                if frontmostWindowId() == id { return true }
                if !axOK { return true }  // cannot tell windows apart without AX: the app is in front, good enough
            }
            if !reraised && deadline.timeIntervalSinceNow < 0.5 { reraised = true; raise() }
        }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(w.pid)
    }

    r.register("windowDpi") { _ in return 96 }
    r.register("selfIsElevated") { _ in return false }

    r.register("isScreenLocked") { _ in
        guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        if let locked = d["CGSSessionScreenIsLocked"] as? NSNumber, locked.boolValue { return true }
        if let onConsole = d[kCGSessionOnConsoleKey as String] as? NSNumber, !onConsole.boolValue { return true }
        return false
    }

    r.register("focusIsPassword") { _ in
        if !hasPermission("accessibility") { return false }
        guard let app = NSWorkspace.shared.frontmostApplication else { return false }
        let appEl = axApp(Int(app.processIdentifier))
        guard let fv = axCopy(appEl, kAXFocusedUIElementAttribute as String), CFGetTypeID(fv) == AXUIElementGetTypeID() else { return false }
        let el = fv as! AXUIElement
        if axString(el, kAXSubroleAttribute as String) == "AXSecureTextField" { return true }
        if axString(el, kAXRoleAttribute as String) == "AXSecureTextField" { return true }
        return false
    }

    r.register("foregroundLayout") { _ in
        guard let src = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else { return 0 }
        guard let p = TISGetInputSourceProperty(src, kTISPropertyInputSourceID) else { return 0 }
        let id = Unmanaged<CFString>.fromOpaque(p).takeUnretainedValue() as String
        return fnv(id)
    }

    r.register("virtualScreen") { _ in
        let rects = monitorRects()
        guard var u = rects.first else { return ["x": 0, "y": 0, "width": 0, "height": 0] as [String: Any] }
        for m in rects { u = u.union(m) }
        return ["x": Int(u.minX.rounded()), "y": Int(u.minY.rounded()),
                "width": Int(u.width.rounded()), "height": Int(u.height.rounded())] as [String: Any]
    }

    r.register("listMonitors") { _ in
        var out: [[String: Any]] = []
        for (i, m) in monitorRects().enumerated() {
            out.append(["left": Int(m.minX.rounded()), "top": Int(m.minY.rounded()),
                        "width": Int(m.width.rounded()), "height": Int(m.height.rounded()), "primary": i == 0])
        }
        return out
    }
}

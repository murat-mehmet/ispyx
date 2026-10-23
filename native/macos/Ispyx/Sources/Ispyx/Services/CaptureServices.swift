import Foundation
import AppKit
import CoreGraphics
import CoreVideo
import ScreenCaptureKit

// Captures are scaled to the logical (point) size so that width/height equal the rect's size in points.
// The result is a raw BGRA premultiplied top-down file in $TMPDIR/ispyx/; the client reads and deletes it.

private let permissionHint = "Ispyx could not capture the screen. Make sure Ispyx has the Screen Recording permission (System Settings > Privacy & Security > Screen Recording), then quit and reopen Ispyx and try again."

private final class ImageBox {
    var image: CGImage?
    var error: Error?
}

private final class ContentBox {
    var windows: [SCWindow] = []
    var displays: [SCDisplay] = []
    var error: Error?
}

private func waitOrThrow(_ sem: DispatchSemaphore, _ what: String) throws {
    // Pump the run loop while waiting: a completion handler delivered on the main queue must not deadlock us.
    let deadline = Date(timeIntervalSinceNow: 6.0)
    while sem.wait(timeout: .now()) == .timedOut {
        if Date() >= deadline {
            throw HelperError("Capturing \(what) timed out. " + permissionHint)
        }
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
    }
}

// MARK: ScreenCaptureKit (macOS 14+)

@available(macOS 14.0, *)
private func sckContent(onScreenOnly: Bool) throws -> ContentBox {
    let box = ContentBox()
    let sem = DispatchSemaphore(value: 0)
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: onScreenOnly) { content, error in
        if let c = content {
            box.windows = c.windows
            box.displays = c.displays
        }
        box.error = error
        sem.signal()
    }
    try waitOrThrow(sem, "the screen")
    if let e = box.error { throw e }
    return box
}

@available(macOS 14.0, *)
private func sckImage(filter: SCContentFilter, width: Int, height: Int, sourceRect: CGRect?) throws -> CGImage {
    let cfg = SCStreamConfiguration()
    cfg.width = width
    cfg.height = height
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.showsCursor = false
    if let s = sourceRect { cfg.sourceRect = s }
    let box = ImageBox()
    let sem = DispatchSemaphore(value: 0)
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { image, error in
        box.image = image
        box.error = error
        sem.signal()
    }
    try waitOrThrow(sem, "the image")
    if let e = box.error { throw e }
    guard let img = box.image else { throw HelperError(permissionHint) }
    return img
}

@available(macOS 14.0, *)
private func sckCaptureRect(_ rect: CGRect) throws -> CGImage {
    let content = try sckContent(onScreenOnly: true)
    for d in content.displays where d.frame.contains(rect) {
        let local = CGRect(x: rect.origin.x - d.frame.origin.x, y: rect.origin.y - d.frame.origin.y,
                           width: rect.width, height: rect.height)
        let filter = SCContentFilter(display: d, excludingWindows: [])
        return try sckImage(filter: filter, width: Int(rect.width), height: Int(rect.height), sourceRect: local)
    }
    throw HelperError("The area spans several monitors.")  // caller falls back to CGWindowList
}

@available(macOS 14.0, *)
private func sckCaptureWindow(_ id: Int, width: Int, height: Int) throws -> CGImage {
    let content = try sckContent(onScreenOnly: false)
    for w in content.windows where Int(w.windowID) == id {
        let filter = SCContentFilter(desktopIndependentWindow: w)
        return try sckImage(filter: filter, width: width, height: height, sourceRect: nil)
    }
    throw HelperError("The window is not available for capture.")
}

// MARK: CGWindowList fallback (macOS 13, multi-monitor rects)

// CGWindowListCreateImage is marked unavailable in the newest SDKs but still exists at run time: look it up dynamically.
private typealias WindowListCreateImageFn = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

private func legacyImage(rect: CGRect, listOption: CGWindowListOption, windowID: CGWindowID, imageOption: CGWindowImageOption) -> CGImage? {
    guard let handle = dlopen(nil, RTLD_NOW), let sym = dlsym(handle, "CGWindowListCreateImage") else { return nil }
    let fn = unsafeBitCast(sym, to: WindowListCreateImageFn.self)
    return fn(rect, listOption.rawValue, windowID, imageOption.rawValue)?.takeRetainedValue()
}

// MARK: pixels

private func isBlank(_ buf: [UInt8]) -> Bool {
    // Real captures are opaque; an all-transparent image means macOS handed back nothing.
    let pixels = buf.count / 4
    if pixels == 0 { return true }
    let step = max(1, pixels / 2000)
    var i = 0
    while i < pixels {
        if buf[i * 4 + 3] != 0 { return false }
        i += step
    }
    return true
}

/// Draws `image` into a width x height BGRA premultiplied top-down buffer and writes it to a temp file.
private func writeBGRA(_ image: CGImage, width: Int, height: Int) throws -> String {
    var buf = [UInt8](repeating: 0, count: width * height * 4)
    let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    var ok = false
    buf.withUnsafeMutableBytes { raw in
        if let ctx = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8,
                               bytesPerRow: width * 4, space: space, bitmapInfo: info) {
            ctx.interpolationQuality = .high
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            ok = true
        }
    }
    if !ok { throw HelperError("Ispyx could not allocate the capture buffer.") }
    if isBlank(buf) { throw HelperError("The capture came back empty. " + permissionHint) }
    let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("ispyx")
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: nil)
    let path = (dir as NSString).appendingPathComponent("cap-\(UUID().uuidString).bgra")
    do {
        try Data(buf).write(to: URL(fileURLWithPath: path))
    } catch {
        throw HelperError("Ispyx could not write the capture file: \(error.localizedDescription)")
    }
    return path
}

private func rectObject(_ r: CGRect) -> [String: Any] {
    return ["left": Int(r.origin.x.rounded()), "top": Int(r.origin.y.rounded()),
            "width": Int(r.size.width.rounded()), "height": Int(r.size.height.rounded())]
}

private func windowBounds(_ id: Int) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for d in list {
        if let n = d[kCGWindowNumber as String] as? NSNumber, n.intValue == id,
           let b = d[kCGWindowBounds as String] {
            return CGRect(dictionaryRepresentation: b as! CFDictionary)
        }
    }
    return nil
}

func registerCaptureServices(_ r: Router) {
    r.register("captureScreenRect") { args in
        try requirePermission("screenRecording")
        let o = try args.object(0)
        func field(_ k: String) throws -> Double {
            guard let n = o[k] as? NSNumber else { throw HelperError("captureScreenRect needs left, top, width and height.") }
            return n.doubleValue
        }
        let want = CGRect(x: try field("left"), y: try field("top"), width: try field("width"), height: try field("height"))
        // Clamp to the union of the monitors.
        var union = CGRect.null
        for m in ispyxMonitorRects() { union = union.union(m) }
        let clipped = want.intersection(union)
        if clipped.isNull || clipped.isEmpty {
            throw HelperError("The requested area is outside every monitor.")
        }
        let rect = clipped.integral
        if rect.width < 1 || rect.height < 1 {
            throw HelperError("The requested area is outside every monitor.")
        }
        let w = Int(rect.width)
        let h = Int(rect.height)
        var image: CGImage?
        var method = ""
        if #available(macOS 14.0, *) {
            if let img = try? sckCaptureRect(rect) { image = img; method = "ScreenCaptureKit" }
        }
        if image == nil {
            if let img = legacyImage(rect: rect, listOption: .optionOnScreenOnly, windowID: kCGNullWindowID, imageOption: [.bestResolution]) {
                image = img
                method = "CGWindowList"
            }
        }
        guard let picture = image else { throw HelperError(permissionHint) }
        let file = try writeBGRA(picture, width: w, height: h)
        return ["file": file, "width": w, "height": h, "rect": rectObject(rect), "method": method] as [String: Any]
    }

    r.register("captureWindow") { args in
        try requirePermission("screenRecording")
        let id = try args.int(0)
        guard let bounds = windowBounds(id) else { throw HelperError("Window \(id) no longer exists.") }
        let w = Int(bounds.width.rounded())
        let h = Int(bounds.height.rounded())
        if w < 1 || h < 1 { throw HelperError("Window \(id) has no visible area to capture.") }
        var image: CGImage?
        var method = ""
        if #available(macOS 14.0, *) {
            if let img = try? sckCaptureWindow(id, width: w, height: h) { image = img; method = "ScreenCaptureKit" }
        }
        if image == nil {
            if let img = legacyImage(rect: CGRect.null, listOption: .optionIncludingWindow, windowID: CGWindowID(id),
                                     imageOption: [.boundsIgnoreFraming, .bestResolution]) {
                image = img
                method = "CGWindowList"
            }
        }
        guard let picture = image else {
            throw HelperError("Ispyx could not capture window \(id). Bring it to the front (it may be minimised or on another Space) and try again. " + permissionHint)
        }
        let file = try writeBGRA(picture, width: w, height: h)
        return ["file": file, "width": w, "height": h, "rect": rectObject(bounds), "method": method] as [String: Any]
    }
}

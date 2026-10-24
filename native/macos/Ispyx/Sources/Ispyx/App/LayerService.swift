import AppKit
import CoreGraphics
import CoreText
import QuartzCore
import Foundation
import Darwin

/// One effect window: a memory-mapped BGRA premultiplied buffer shown through a click-through panel.
final class EffectLayer {
    let id: Int
    let width: Int
    let height: Int
    let file: String
    private let base: UnsafeMutableRawPointer
    private let byteCount: Int
    private let panel: ClickThroughPanel
    private let layer: CALayer
    private let colorSpace: CGColorSpace
    private var lastAlpha: Int = -1
    private var lastFrame = NSRect.zero
    /// The client connection that made it (destroyed with it) and the last create/present (see the watchdog).
    let owner: Int32
    private(set) var lastTouch = Date()

    init(id: Int, width: Int, height: Int, owner: Int32) throws {
        self.id = id
        self.owner = owner
        self.width = width
        self.height = height
        let bytes = width * height * 4
        byteCount = bytes
        let path = AppPaths.tempDir + "/layer-\(id).bgra"
        file = path

        let fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0o600)
        if fd < 0 { throw HelperError("Could not create the effect buffer \(path) (errno \(errno)).") }
        if ftruncate(fd, off_t(bytes)) != 0 { // zero-filled
            let e = errno
            close(fd)
            unlink(path)
            throw HelperError("Could not size the effect buffer (errno \(e)).")
        }
        let mapped = mmap(nil, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
        close(fd)
        guard let m = mapped, m != UnsafeMutableRawPointer(bitPattern: -1) else {
            unlink(path)
            throw HelperError("Could not map the effect buffer into memory.")
        }
        base = m
        colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()

        let p = ClickThroughPanel(frame: NSRect(x: 0, y: 0, width: width, height: height))
        let v = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        v.wantsLayer = true // layer-backed: AppKit keeps the layer sized to the view
        guard let l = v.layer else {
            munmap(m, bytes)
            unlink(path)
            throw HelperError("Could not create the effect window layer.")
        }
        l.contentsGravity = .resize
        l.isOpaque = false
        p.contentView = v
        panel = p
        layer = l
    }

    /// Coordinates are the contract's logical desktop space (top-left of the primary screen, y down).
    func present(x: Double, y: Double, alpha: Int, h: Int, w: Int, srcY: Int) {
        lastTouch = Date()
        let sy = max(0, min(height - 1, srcY))
        let ph = max(1, min(height - sy, h))
        let pw = max(1, min(width, w))

        // Image over the visible sub-rectangle: same mapped memory, no copy. bytesPerRow stays the full row.
        let stride = width * 4
        let start = UnsafeRawPointer(base).advanced(by: sy * stride)
        let size = stride * ph
        let provider = CGDataProvider(dataInfo: nil, data: start, size: size, releaseData: { _, _, _ in })
        if let provider = provider {
            let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
            let image = CGImage(width: pw, height: ph, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: stride,
                                space: colorSpace, bitmapInfo: info, provider: provider, decode: nil,
                                shouldInterpolate: false, intent: .defaultIntent)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.contents = image
            CATransaction.commit()
        }

        // Logical top-left -> AppKit bottom-left, flipping about the primary screen's height.
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let frame = NSRect(x: x, y: primaryHeight - y - Double(ph), width: Double(pw), height: Double(ph))
        if frame != lastFrame {
            panel.setFrame(frame, display: false)
            lastFrame = frame
        }
        if alpha != lastAlpha {
            panel.alphaValue = CGFloat(max(0, min(255, alpha))) / 255.0
            lastAlpha = alpha
        }
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    func destroy() {
        panel.orderOut(nil)
        panel.contentView = nil
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.contents = nil
        CATransaction.commit()
        CATransaction.flush()
        unlink(file)
        // Core Animation may still read the last image during its next commit: unmap a little later.
        let b = base
        let n = byteCount
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            munmap(b, n)
        }
    }
}

final class LayerRegistry {
    static let shared = LayerRegistry()
    private var layers = [Int: EffectLayer]()
    private var nextId = 1
    private var nextMask = 1
    private var watchdog: Timer?
    /// The connection whose request is being handled (set by SocketServer around each call), -1 outside a call.
    var currentOwner: Int32 = -1

    /// Effects present a frame at least every 33 ms while they run. A layer left alone this long lost its
    /// layerDestroy (a client that died mid-effect, a dropped message) and would stay on screen for good.
    static let idleLimit: TimeInterval = 3

    func create(width: Int, height: Int) throws -> EffectLayer {
        if width < 1 || height < 1 || width > 16384 || height > 16384 {
            throw HelperError("The effect size \(width)x\(height) is not supported.")
        }
        let id = nextId
        nextId += 1
        let l = try EffectLayer(id: id, width: width, height: height, owner: currentOwner)
        layers[id] = l
        startWatchdog()
        return l
    }

    private func startWatchdog() {
        if watchdog != nil { return }
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.sweepIdle() }
        RunLoop.main.add(t, forMode: .common)
        watchdog = t
    }

    private func sweepIdle() {
        let now = Date()
        for (id, l) in layers where now.timeIntervalSince(l.lastTouch) > LayerRegistry.idleLimit {
            NSLog("Ispyx: effect layer \(id) got no frame for \(Int(LayerRegistry.idleLimit)) s, removing it")
            destroy(id)
        }
        if layers.isEmpty {
            watchdog?.invalidate()
            watchdog = nil
        }
    }

    /// A client connection closed: its effects can never be finished or destroyed by it.
    func destroyOwned(by owner: Int32) {
        for (id, l) in layers where l.owner == owner { destroy(id) }
    }

    func get(_ id: Int) throws -> EffectLayer {
        guard let l = layers[id] else { throw HelperError("Effect layer \(id) does not exist (it was destroyed).") }
        return l
    }

    func destroy(_ id: Int) {
        if let l = layers.removeValue(forKey: id) { l.destroy() }
    }

    func destroyAll() {
        for (_, l) in layers { l.destroy() }
        layers.removeAll()
    }

    func newMaskPath() -> String {
        let n = nextMask
        nextMask += 1
        return AppPaths.tempDir + "/mask-\(n).bin"
    }

    /// Leftovers of an earlier run (layer buffers and text masks).
    static func cleanStaleFiles() {
        let dir = AppPaths.tempDir
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
        for n in names where (n.hasPrefix("layer-") && n.hasSuffix(".bgra")) || (n.hasPrefix("cap-") && n.hasSuffix(".bgra")) || (n.hasPrefix("mask-") && n.hasSuffix(".bin")) {
            unlink(dir + "/" + n)
        }
    }

    /// Text masks are read by the client right after the call; drop old ones so the folder does not grow.
    func pruneMasks() {
        let dir = AppPaths.tempDir
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
        let now = Date()
        for n in names where n.hasPrefix("mask-") && n.hasSuffix(".bin") {
            let p = dir + "/" + n
            if let attrs = try? FileManager.default.attributesOfItem(atPath: p),
               let d = attrs[.modificationDate] as? Date, now.timeIntervalSince(d) > 120 {
                unlink(p)
            }
        }
    }
}

// MARK: text mask

private func fontWeight(_ w: Int) -> NSFont.Weight {
    if w <= 150 { return .ultraLight }
    if w <= 250 { return .thin }
    if w <= 350 { return .light }
    if w <= 450 { return .regular }
    if w <= 550 { return .medium }
    if w <= 650 { return .semibold }
    if w <= 750 { return .bold }
    if w <= 850 { return .heavy }
    return .black
}

/// Renders `text` white-on-black into a one-byte-per-pixel coverage mask (top row first).
private func renderTextMask(text: String, heightPx: Double, weight: Int) throws -> (width: Int, height: Int, data: Data) {
    let font = NSFont.systemFont(ofSize: CGFloat(heightPx), weight: fontWeight(weight))
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1),
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
    var ascent: CGFloat = 0
    var descent: CGFloat = 0
    var leading: CGFloat = 0
    let typoWidth = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
    let w = max(1, Int(ceil(typoWidth)) + 2)
    let h = max(1, Int(ceil(ascent + descent)) + 2)

    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                              space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
        throw HelperError("Could not create a bitmap for the text mask.")
    }
    ctx.setAllowsAntialiasing(true)
    ctx.setShouldAntialias(true)
    ctx.setShouldSmoothFonts(false)
    ctx.setFillColor(gray: 1, alpha: 1)
    ctx.textPosition = CGPoint(x: 1, y: 1 + descent)
    CTLineDraw(line, ctx)
    guard let raw = ctx.data else { throw HelperError("The text mask has no pixel data.") }
    // Row 0 of a bitmap context's memory is the top of the image.
    return (w, h, Data(bytes: raw, count: w * h))
}

// MARK: Router

func registerLayerServices(_ r: Router) {
    r.register("layerCreate") { args in
        let o = try args.object(0)
        guard let wn = o["width"] as? NSNumber, let hn = o["height"] as? NSNumber else {
            throw HelperError("layerCreate needs width and height.")
        }
        let l = try LayerRegistry.shared.create(width: wn.intValue, height: hn.intValue)
        return ["layer": l.id, "file": l.file] as [String: Any]
    }

    r.register("layerPresent") { args in
        let o = try args.object(0)
        guard let idn = o["layer"] as? NSNumber else { throw HelperError("layerPresent needs a layer id.") }
        let l = try LayerRegistry.shared.get(idn.intValue)
        let x = (o["x"] as? NSNumber)?.doubleValue ?? 0
        let y = (o["y"] as? NSNumber)?.doubleValue ?? 0
        let alpha = (o["alpha"] as? NSNumber)?.intValue ?? 255
        let h = (o["height"] as? NSNumber)?.intValue ?? l.height
        let w = (o["width"] as? NSNumber)?.intValue ?? l.width
        let srcY = (o["srcY"] as? NSNumber)?.intValue ?? 0
        l.present(x: x, y: y, alpha: alpha, h: h, w: w, srcY: srcY)
        return true
    }

    r.register("layerDestroy") { args in
        let o = try args.object(0)
        if let idn = o["layer"] as? NSNumber { LayerRegistry.shared.destroy(idn.intValue) }
        return true
    }

    r.register("textMask") { args in
        let o = try args.object(0)
        let text = (o["text"] as? String) ?? ""
        let heightPx = (o["heightPx"] as? NSNumber)?.doubleValue ?? 22
        let weight = (o["weight"] as? NSNumber)?.intValue ?? 600
        LayerRegistry.shared.pruneMasks()
        let m = try renderTextMask(text: text, heightPx: max(4, min(400, heightPx)), weight: weight)
        let path = LayerRegistry.shared.newMaskPath()
        do {
            try m.data.write(to: URL(fileURLWithPath: path))
        } catch {
            throw HelperError("Could not write the text mask: \(error.localizedDescription)")
        }
        return ["width": m.width, "height": m.height, "file": path] as [String: Any]
    }
}

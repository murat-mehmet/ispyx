import AppKit
import Foundation

/// A borderless, click-through, never-key panel above everything (also above full-screen apps and the menu bar).
class ClickThroughPanel: NSPanel {
    init(frame: NSRect) {
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        level = .screenSaver
        isOpaque = false
        backgroundColor = NSColor.clear
        hasShadow = false
        ignoresMouseEvents = true
        hidesOnDeactivate = false
        isFloatingPanel = true
        becomesKeyOnlyIfNeeded = true
        isReleasedWhenClosed = false
        animationBehavior = .none
        canHide = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    }

    required init?(coder: NSCoder) {
        fatalError("ClickThroughPanel is created in code only")
    }

    override var canBecomeKey: Bool { return false }
    override var canBecomeMain: Bool { return false }

    /// AppKit would otherwise pull a window that sticks out of the screen back inside; effects span monitors.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        return frameRect
    }
}

/// The pill drawn inside the banner panel.
private final class BannerView: NSView {
    var text = ""
    var accent = NSColor.systemGreen

    private static let barHeight: CGFloat = 40
    private static let leftPad: CGFloat = 38
    private static let rightPad: CGFloat = 22

    static func textAttributes() -> [NSAttributedString.Key: Any] {
        let para = NSMutableParagraphStyle()
        para.lineBreakMode = .byTruncatingTail
        return [
            .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
            .foregroundColor: NSColor.white,
            .paragraphStyle: para,
        ]
    }

    static func desiredWidth(for text: String, maxWidth: CGFloat) -> CGFloat {
        let size = (text as NSString).size(withAttributes: textAttributes())
        let w = ceil(size.width) + leftPad + rightPad
        return min(maxWidth, max(300, w))
    }

    override func draw(_ dirtyRect: NSRect) {
        let r = bounds.insetBy(dx: 1.5, dy: 1.5)
        let path = NSBezierPath(roundedRect: r, xRadius: r.height / 2, yRadius: r.height / 2)
        // Dark bar with a slight tint of the accent colour, like the Windows banner (dark navy / dark red).
        let base = NSColor(calibratedRed: 0.08, green: 0.09, blue: 0.14, alpha: 0.94)
        base.setFill()
        path.fill()
        accent.withAlphaComponent(0.16).setFill()
        path.fill()
        accent.withAlphaComponent(0.85).setStroke()
        path.lineWidth = 1.5
        path.stroke()

        let dot = NSRect(x: 18, y: (bounds.height - 10) / 2, width: 10, height: 10)
        accent.setFill()
        NSBezierPath(ovalIn: dot).fill()

        let attrs = BannerView.textAttributes()
        let size = (text as NSString).size(withAttributes: attrs)
        let tw = max(10, bounds.width - BannerView.leftPad - BannerView.rightPad)
        let rect = NSRect(x: BannerView.leftPad, y: (bounds.height - size.height) / 2, width: tw, height: size.height)
        (text as NSString).draw(in: rect, withAttributes: attrs)
    }

    static var height: CGFloat { return barHeight }
}

/// overlayShow / overlayHide / overlayVisible.
final class OverlayController {
    static let shared = OverlayController()

    private var panel: ClickThroughPanel?
    private var view: BannerView?

    private func accent(for kind: String) -> NSColor {
        switch kind {
        case "stopped": return NSColor(calibratedRed: 0.93, green: 0.26, blue: 0.26, alpha: 1)
        case "cancelled": return NSColor(calibratedRed: 0.98, green: 0.72, blue: 0.15, alpha: 1)
        default: return NSColor(calibratedRed: 0.20, green: 0.80, blue: 0.42, alpha: 1)
        }
    }

    func show(text: String, kind: String) {
        let screen = NSScreen.screens.first ?? NSScreen.main
        let area = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let width = BannerView.desiredWidth(for: text, maxWidth: min(1400, area.width - 40))
        let height = BannerView.height
        // Centered, 6 points below the menu bar (visibleFrame also skips the notch area).
        let frame = NSRect(x: area.midX - width / 2, y: area.maxY - 6 - height, width: width, height: height)

        if panel == nil {
            let p = ClickThroughPanel(frame: frame)
            let v = BannerView(frame: NSRect(x: 0, y: 0, width: width, height: height))
            p.contentView = v
            panel = p
            view = v
        }
        guard let p = panel, let v = view else { return }
        v.text = text
        v.accent = accent(for: kind)
        p.setFrame(frame, display: false)
        v.frame = NSRect(x: 0, y: 0, width: width, height: height)
        v.needsDisplay = true
        p.alphaValue = 0.96
        p.orderFrontRegardless()
        v.display()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    var visible: Bool { return panel?.isVisible ?? false }
}

func registerOverlayServices(_ r: Router) {
    r.register("overlayShow") { args in
        let o = try args.object(0)
        let text = (o["text"] as? String) ?? ""
        let kind = (o["kind"] as? String) ?? "working"
        OverlayController.shared.show(text: text, kind: kind)
        return true
    }
    r.register("overlayHide") { _ in
        OverlayController.shared.hide()
        return true
    }
    r.register("overlayVisible") { _ in
        return OverlayController.shared.visible
    }
}

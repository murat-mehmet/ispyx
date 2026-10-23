import AppKit
import Foundation

/// Onboarding window for the two permissions Ispyx needs. Re-checks every second while open and closes itself
/// when everything is granted. Also publishes the `permissions` event whenever the missing set changes.
final class PermissionsController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private var timer: Timer?
    private var accessStatus: NSTextField?
    private var screenStatus: NSTextField?
    private var lastEmitted: [String]?

    /// True when any entry of `missing` mentions `key` (case-insensitive): "access" or "screen".
    static func contains(_ missing: [String], _ key: String) -> Bool {
        for m in missing where m.lowercased().contains(key) { return true }
        return false
    }

    /// At launch: show the window when something is missing.
    func startup() {
        let missing = missingPermissions()
        lastEmitted = missing
        if !missing.isEmpty { show() }
    }

    /// A client connected: tell it what is missing.
    func announceIfMissing() {
        let missing = missingPermissions()
        if !missing.isEmpty { EventBus.shared.send("permissions", ["missing": missing]) }
    }

    /// A client reported a missing permission.
    func checkAndShow() {
        let missing = missingPermissions()
        publish(missing)
        if !missing.isEmpty { show() }
    }

    private func publish(_ missing: [String]) {
        if lastEmitted == nil || lastEmitted! != missing {
            lastEmitted = missing
            EventBus.shared.send("permissions", ["missing": missing])
        }
    }

    // MARK: window

    func show() {
        if window == nil { buildWindow() }
        guard let w = window else { return }
        refresh()
        if !w.isVisible { w.center() }
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
        if timer == nil {
            let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in self?.refresh() }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
    }

    private func refresh() {
        let missing = missingPermissions()
        setStatus(accessStatus, granted: !PermissionsController.contains(missing, "access"))
        setStatus(screenStatus, granted: !PermissionsController.contains(missing, "screen"))
        publish(missing)
        if missing.isEmpty { closeWindow() }
    }

    private func setStatus(_ field: NSTextField?, granted: Bool) {
        guard let f = field else { return }
        f.stringValue = granted ? "Allowed" : "Not allowed yet"
        f.textColor = granted ? NSColor.systemGreen : NSColor.systemOrange
    }

    private func closeWindow() {
        timer?.invalidate()
        timer = nil
        window?.orderOut(nil)
    }

    func windowWillClose(_ notification: Notification) {
        timer?.invalidate()
        timer = nil
    }

    private func buildWindow() {
        let width: CGFloat = 520
        let height: CGFloat = 400
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                         styleMask: [.titled, .closable],
                         backing: .buffered, defer: false)
        w.title = "Ispyx permissions"
        w.isReleasedWhenClosed = false
        w.level = .floating
        w.delegate = self
        guard let content = w.contentView else { return }

        func frame(_ x: CGFloat, _ top: CGFloat, _ cw: CGFloat, _ ch: CGFloat) -> NSRect {
            return NSRect(x: x, y: height - top - ch, width: cw, height: ch)
        }

        let title = NSTextField(labelWithString: "Ispyx needs two permissions")
        title.font = NSFont.boldSystemFont(ofSize: 18)
        title.frame = frame(24, 20, width - 48, 26)
        content.addSubview(title)

        let intro = NSTextField(wrappingLabelWithString:
            "Ispyx lets an AI assistant use this Mac on your behalf: look at the screen, move the pointer and type. " +
            "macOS only allows that after you switch on two switches in System Settings. Nothing is switched on until you do it yourself.")
        intro.font = NSFont.systemFont(ofSize: 13)
        intro.frame = frame(24, 56, width - 48, 70)
        content.addSubview(intro)

        // Row 1: Accessibility
        let aTitle = NSTextField(labelWithString: "Accessibility")
        aTitle.font = NSFont.boldSystemFont(ofSize: 13)
        aTitle.frame = frame(24, 140, 200, 18)
        content.addSubview(aTitle)
        let aStatus = NSTextField(labelWithString: "")
        aStatus.font = NSFont.systemFont(ofSize: 13)
        aStatus.alignment = .right
        aStatus.frame = frame(width - 24 - 140, 140, 140, 18)
        content.addSubview(aStatus)
        let aText = NSTextField(wrappingLabelWithString:
            "Needed to move the mouse, click, type and press keys, and to read which window is in front.")
        aText.font = NSFont.systemFont(ofSize: 12)
        aText.textColor = NSColor.secondaryLabelColor
        aText.frame = frame(24, 162, width - 48, 34)
        content.addSubview(aText)
        let aButton = NSButton(title: "Open Accessibility settings", target: self, action: #selector(openAccessibility(_:)))
        aButton.frame = frame(24, 200, 220, 28)
        content.addSubview(aButton)

        // Row 2: Screen Recording
        let sTitle = NSTextField(labelWithString: "Screen Recording")
        sTitle.font = NSFont.boldSystemFont(ofSize: 13)
        sTitle.frame = frame(24, 248, 200, 18)
        content.addSubview(sTitle)
        let sStatus = NSTextField(labelWithString: "")
        sStatus.font = NSFont.systemFont(ofSize: 13)
        sStatus.alignment = .right
        sStatus.frame = frame(width - 24 - 140, 248, 140, 18)
        content.addSubview(sStatus)
        let sText = NSTextField(wrappingLabelWithString:
            "Needed to take screenshots so the assistant can see what is on the screen.")
        sText.font = NSFont.systemFont(ofSize: 12)
        sText.textColor = NSColor.secondaryLabelColor
        sText.frame = frame(24, 270, width - 48, 34)
        content.addSubview(sText)
        let sButton = NSButton(title: "Open Screen Recording settings", target: self, action: #selector(openScreenRecording(_:)))
        sButton.frame = frame(24, 308, 240, 28)
        content.addSubview(sButton)

        let footer = NSTextField(wrappingLabelWithString:
            "In each pane, switch Ispyx on. This window updates by itself and closes when both are allowed. " +
            "If macOS says Ispyx must be quit and reopened after you allow Screen Recording, choose Quit & Reopen, or quit Ispyx from the menu bar and start it again.")
        footer.font = NSFont.systemFont(ofSize: 11)
        footer.textColor = NSColor.secondaryLabelColor
        footer.frame = frame(24, 346, width - 48, 44)
        content.addSubview(footer)

        accessStatus = aStatus
        screenStatus = sStatus
        window = w
    }

    @objc private func openAccessibility(_ sender: Any?) {
        openPane("Privacy_Accessibility")
    }

    @objc private func openScreenRecording(_ sender: Any?) {
        openPane("Privacy_ScreenCapture")
    }

    private func openPane(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?" + anchor) {
            NSWorkspace.shared.open(url)
        }
    }
}

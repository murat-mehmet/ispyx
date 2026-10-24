import AppKit
import Foundation
import ServiceManagement

/// The Ispyx window: running state, the two permissions, the stop key, how to connect a client, open at login.
/// Shown when the user opens the app (not when the MCP server starts it in the background), from the menu bar, and
/// when a permission is missing. Re-checks every second while open. Also publishes the `permissions` event whenever
/// the missing set changes.
final class StatusWindowController: NSObject, NSWindowDelegate {
    /// Clients connected to the socket, and the socket start error if any (set by AppDelegate).
    var clientCount: () -> Int = { 0 }
    var startError: () -> String? = { nil }

    private var window: NSWindow?
    private var timer: Timer?
    private var headline: NSTextField?
    private var subline: NSTextField?
    private var accessStatus: NSTextField?
    private var screenStatus: NSTextField?
    private var accessButton: NSButton?
    private var screenButton: NSButton?
    private var loginCheckbox: NSButton?
    private var copyButton: NSButton?
    private var desktopCopyButton: NSButton?
    private var lastEmitted: [String]?
    /// Close by itself once everything is granted: only when the window was shown because something was missing
    /// while Ispyx runs in the background. Opened by the user, it stays until they close it.
    private var closeWhenGranted = false

    /// True when any entry of `missing` mentions `key` (case-insensitive): "access" or "screen".
    static func contains(_ missing: [String], _ key: String) -> Bool {
        for m in missing where m.lowercased().contains(key) { return true }
        return false
    }

    /// The MCP client entry: Contents/Resources/ispyx inside this bundle.
    static var launcherPath: String { Bundle.main.bundlePath + "/Contents/Resources/ispyx" }

    /// The entry for Claude Desktop's claude_desktop_config.json (inside "mcpServers").
    static var desktopConfigSnippet: String {
        let p = launcherPath.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        return "\"ispyx\": {\n  \"command\": \"" + p + "\"\n}"
    }

    static var desktopConfigPath: String {
        NSHomeDirectory() + "/Library/Application Support/Claude/claude_desktop_config.json"
    }

    static var connectCommand: String {
        let p = launcherPath
        let quoted = p.contains(" ") ? "'" + p.replacingOccurrences(of: "'", with: "'\\''") + "'" : p
        return "claude mcp add ispyx --scope user -- " + quoted
    }

    /// At launch. `background`: started by the MCP server (`--background`), so stay quiet unless something is missing.
    func startup(background: Bool) {
        let missing = missingPermissions()
        lastEmitted = missing
        if !missing.isEmpty || !background {
            show(closeWhenGranted: background)
        }
        // Screen Recording: without a request Ispyx never appears in that list, so make it once at launch.
        if StatusWindowController.contains(missing, "screen") { requestPermission("screenRecording") }
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
        if !missing.isEmpty { show(closeWhenGranted: true) }
    }

    private func publish(_ missing: [String]) {
        if lastEmitted == nil || lastEmitted! != missing {
            lastEmitted = missing
            EventBus.shared.send("permissions", ["missing": missing])
        }
    }

    // MARK: window

    func show(closeWhenGranted autoClose: Bool = false) {
        if window == nil { buildWindow() }
        guard let w = window else { return }
        if !w.isVisible {
            closeWhenGranted = autoClose
            w.center()
        } else if !autoClose {
            closeWhenGranted = false
        }
        refresh()
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
        let accessOK = !StatusWindowController.contains(missing, "access")
        let screenOK = !StatusWindowController.contains(missing, "screen")
        setStatus(accessStatus, granted: accessOK)
        setStatus(screenStatus, granted: screenOK)
        accessButton?.isHidden = accessOK
        screenButton?.isHidden = screenOK

        if let e = startError() {
            headline?.stringValue = "Ispyx could not start"
            subline?.stringValue = e
        } else if !missing.isEmpty {
            headline?.stringValue = "Ispyx needs your permission"
            subline?.stringValue = "Switch Ispyx on in System Settings for the items marked below."
        } else {
            headline?.stringValue = "Ispyx is running"
            let n = clientCount()
            subline?.stringValue = n == 0 ? "Ready. No AI client is connected right now."
                : n == 1 ? "Ready. 1 AI client is connected." : "Ready. \(n) AI clients are connected."
        }
        loginCheckbox?.state = SMAppService.mainApp.status == .enabled ? .on : .off

        publish(missing)
        if missing.isEmpty && closeWhenGranted { closeWindow() }
    }

    private func setStatus(_ field: NSTextField?, granted: Bool) {
        guard let f = field else { return }
        f.stringValue = granted ? "\u{2713} Allowed" : "Not allowed"
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

    // MARK: layout

    private static func label(_ text: String, size: CGFloat = 13, bold: Bool = false, secondary: Bool = false) -> NSTextField {
        let f = NSTextField(wrappingLabelWithString: text)
        f.font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
        if secondary { f.textColor = NSColor.secondaryLabelColor }
        f.isSelectable = false
        return f
    }

    private static func sectionTitle(_ text: String) -> NSTextField {
        let f = NSTextField(labelWithString: text.uppercased())
        f.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        f.textColor = NSColor.secondaryLabelColor
        return f
    }

    private static func separator() -> NSBox {
        let b = NSBox()
        b.boxType = .separator
        return b
    }

    /// One permission: name and status on a line, explanation below, and a button shown while it is missing.
    private func permissionRow(_ name: String, _ text: String, button: String, action: Selector) -> (NSView, NSTextField, NSButton) {
        let title = StatusWindowController.label(name, bold: true)
        let status = NSTextField(labelWithString: "")
        status.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        status.alignment = .right
        status.setContentHuggingPriority(.required, for: .horizontal)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let top = NSStackView(views: [title, spacer, status])
        top.orientation = .horizontal
        let btn = NSButton(title: button, target: self, action: action)
        btn.bezelStyle = .rounded
        let col = NSStackView(views: [top, StatusWindowController.label(text, size: 12, secondary: true), btn])
        col.orientation = .vertical
        col.alignment = .leading
        col.spacing = 4
        top.translatesAutoresizingMaskIntoConstraints = false
        top.widthAnchor.constraint(equalTo: col.widthAnchor).isActive = true
        return (col, status, btn)
    }

    /// A read-only one-line field (selectable, middle-truncated) and a Copy button.
    private func copyRow(_ text: String, action: Selector) -> (NSStackView, NSButton) {
        let field = NSTextField(string: text)
        field.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        field.isEditable = false
        field.isSelectable = true
        field.lineBreakMode = .byTruncatingMiddle
        field.toolTip = text
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let copy = NSButton(title: "Copy", target: self, action: action)
        copy.bezelStyle = .rounded
        copy.setContentHuggingPriority(.required, for: .horizontal)
        let row = NSStackView(views: [field, copy])
        row.orientation = .horizontal
        row.spacing = 8
        return (row, copy)
    }

    private func buildWindow() {
        let width: CGFloat = 480
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 100),
                         styleMask: [.titled, .closable],
                         backing: .buffered, defer: false)
        w.title = "Ispyx"
        w.isReleasedWhenClosed = false
        w.delegate = self
        guard let content = w.contentView else { return }

        // header: app icon, headline, one line of state
        let icon = NSImageView(image: AppDelegate.makeEyeIcon(size: 40))
        icon.contentTintColor = NSColor.controlAccentColor
        icon.setContentHuggingPriority(.required, for: .horizontal)
        let head = StatusWindowController.label("", size: 17, bold: true)
        let sub = StatusWindowController.label("", size: 12, secondary: true)
        let texts = NSStackView(views: [head, sub])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 2
        let header = NSStackView(views: [icon, texts])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 12

        // permissions
        let (aRow, aStatus, aButton) = permissionRow("Accessibility",
            "To move the pointer, click, type and press keys, and to see which window is in front.",
            button: "Open Accessibility Settings\u{2026}", action: #selector(openAccessibility(_:)))
        let (sRow, sStatus, sButton) = permissionRow("Screen Recording",
            "To take screenshots so the assistant can see the screen. macOS may ask you to quit and reopen Ispyx after you allow it.",
            button: "Open Screen Recording Settings\u{2026}", action: #selector(openScreenRecording(_:)))

        // stop key and menu bar
        let usage = StatusWindowController.label(
            "Press \u{2325} Option + Esc to stop whatever the assistant is doing. A second press within 5 seconds shuts the assistant's connection down. " +
            "While the assistant works, a banner shows at the top of the screen. Ispyx lives in the menu bar (the eye icon); this window can be reopened from there.",
            size: 12)

        // connect: Claude Code (a command) and Claude Desktop (a config entry)
        let codeText = StatusWindowController.label("Claude Code: run this once in Terminal.", size: 12)
        let (codeRow, codeCopy) = copyRow(StatusWindowController.connectCommand, action: #selector(copyCommand(_:)))
        let desktopText = StatusWindowController.label(
            "Claude Desktop: add this under \"mcpServers\" in claude_desktop_config.json, then restart Claude Desktop.", size: 12)
        let (desktopRow, desktopCopy) = copyRow(StatusWindowController.desktopConfigSnippet.replacingOccurrences(of: "\n", with: " "),
                                                action: #selector(copyDesktopSnippet(_:)))
        let openConfig = NSButton(title: "Show Config File", target: self, action: #selector(showDesktopConfig(_:)))
        openConfig.bezelStyle = .rounded
        desktopRow.addArrangedSubview(openConfig)
        let connectNote = StatusWindowController.label(
            "The path points into this copy of Ispyx.app: move the app to Applications first, then copy.", size: 11, secondary: true)

        // footer: open at login, close
        let login = NSButton(checkboxWithTitle: "Open Ispyx at login", target: self, action: #selector(toggleLogin(_:)))
        let close = NSButton(title: "Close", target: self, action: #selector(closeClicked(_:)))
        close.bezelStyle = .rounded
        close.keyEquivalent = "\r"
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let footer = NSStackView(views: [login, spacer, close])
        footer.orientation = .horizontal

        let stack = NSStackView(views: [
            header, StatusWindowController.separator(),
            StatusWindowController.sectionTitle("Permissions"), aRow, sRow, StatusWindowController.separator(),
            StatusWindowController.sectionTitle("Using Ispyx"), usage, StatusWindowController.separator(),
            StatusWindowController.sectionTitle("Connect to Claude"), codeText, codeRow, desktopText, desktopRow, connectNote,
            StatusWindowController.separator(),
            footer,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.setCustomSpacing(16, after: header)
        stack.setCustomSpacing(14, after: aRow)
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            stack.widthAnchor.constraint(equalToConstant: width),
        ])
        // full-width rows
        for v in stack.arrangedSubviews where !(v is NSButton) {
            v.translatesAutoresizingMaskIntoConstraints = false
            v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48).isActive = true
        }

        headline = head
        subline = sub
        accessStatus = aStatus
        screenStatus = sStatus
        accessButton = aButton
        screenButton = sButton
        loginCheckbox = login
        copyButton = codeCopy
        desktopCopyButton = desktopCopy
        window = w
    }

    // MARK: actions

    @objc private func openAccessibility(_ sender: Any?) {
        requestPermission("accessibility")
        openPane("Privacy_Accessibility")
    }

    @objc private func openScreenRecording(_ sender: Any?) {
        requestPermission("screenRecording")
        openPane("Privacy_ScreenCapture")
    }

    private func openPane(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?" + anchor) {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func copyCommand(_ sender: Any?) {
        copyToPasteboard(StatusWindowController.connectCommand, button: copyButton)
    }

    @objc private func copyDesktopSnippet(_ sender: Any?) {
        copyToPasteboard(StatusWindowController.desktopConfigSnippet, button: desktopCopyButton)
    }

    private func copyToPasteboard(_ text: String, button: NSButton?) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        button?.title = "Copied"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { button?.title = "Copy" }
    }

    /// Reveals claude_desktop_config.json in Finder, or its folder when the file does not exist yet.
    @objc private func showDesktopConfig(_ sender: Any?) {
        let path = StatusWindowController.desktopConfigPath
        if FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
        } else {
            let dir = (path as NSString).deletingLastPathComponent
            if FileManager.default.fileExists(atPath: dir) {
                NSWorkspace.shared.open(URL(fileURLWithPath: dir))
            } else {
                let alert = NSAlert()
                alert.messageText = "Claude Desktop config not found"
                alert.informativeText = "Install and open Claude Desktop once, then try again. The file is \(path)."
                alert.runModal()
            }
        }
    }

    @objc private func toggleLogin(_ sender: Any?) {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled {
                try service.unregister()
            } else {
                try service.register()
                if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Could not change the login setting"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
        refresh()
    }

    @objc private func closeClicked(_ sender: Any?) {
        window?.close()
    }
}

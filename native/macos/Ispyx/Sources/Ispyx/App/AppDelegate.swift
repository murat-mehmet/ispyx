import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let router = Router()
    private var server: SocketServer?
    private var statusItem: NSStatusItem?
    private var statusLine: NSMenuItem?
    private let status = StatusWindowController()
    private var startError: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()
        registerAllServices()

        let s = SocketServer(router: router)
        s.onHelperError = { [weak self] message in
            // A function failed because of a missing permission: show the onboarding window.
            let m = message.lowercased()
            if m.contains("permission") || m.contains("accessibility") || m.contains("screen recording") {
                self?.status.checkAndShow()
            }
        }
        s.onClientConnected = { [weak self] in
            self?.status.announceIfMissing()
        }
        s.onAllClientsGone = {
            // The client died or left: do not leave effects or the banner on screen.
            LayerRegistry.shared.destroyAll()
            OverlayController.shared.hide()
        }
        do {
            try s.start()
            server = s
        } catch let e as HelperError {
            startError = e.message
        } catch {
            startError = error.localizedDescription
        }
        LayerRegistry.cleanStaleFiles()

        status.clientCount = { [weak self] in self?.server?.clientCount ?? 0 }
        status.startError = { [weak self] in self?.startError }
        // The MCP server starts the app with `open -g -a Ispyx --args --background`: no window then.
        status.startup(background: CommandLine.arguments.contains("--background"))
    }

    /// The user opened Ispyx again while it runs (Finder, Launchpad, `open`): show the window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        status.show()
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        LayerRegistry.shared.destroyAll()
        server?.stop()
    }

    // MARK: services

    private func registerAllServices() {
        let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.1.0"
        router.register("ping") { _ in return "pong" }
        router.register("version") { _ in return version }

        registerOverlayServices(router)
        registerDialogServices(router)
        registerLayerServices(router)

        // Implemented in Sources/Ispyx/Services/.
        registerInputServices(router)
        registerWindowServices(router)
        registerCaptureServices(router)
        registerPasteboardServices(router)
        registerHotkeyServices(router)
    }

    // MARK: menu bar

    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = AppDelegate.makeEyeIcon()
            button.toolTip = "Ispyx"
        }
        let menu = NSMenu()
        menu.delegate = self
        let line = NSMenuItem(title: "Starting...", action: nil, keyEquivalent: "")
        line.isEnabled = false
        menu.addItem(line)
        menu.addItem(NSMenuItem.separator())
        let perms = NSMenuItem(title: "Open Ispyx\u{2026}", action: #selector(showStatus(_:)), keyEquivalent: "")
        perms.target = self
        menu.addItem(perms)
        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "Quit Ispyx", action: #selector(quit(_:)), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item
        statusLine = line
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        statusLine?.title = currentStatusText()
    }

    private func currentStatusText() -> String {
        if let e = startError { return "Not running: \(e)" }
        let missing = missingPermissions()
        if !missing.isEmpty {
            var names = [String]()
            if StatusWindowController.contains(missing, "access") { names.append("Accessibility") }
            if StatusWindowController.contains(missing, "screen") { names.append("Screen Recording") }
            if names.isEmpty { names = missing }
            return "Needs permission: " + names.joined(separator: ", ")
        }
        let n = server?.clientCount ?? 0
        if n == 0 { return "Ready, no client connected" }
        return n == 1 ? "Ready, 1 client connected" : "Ready, \(n) clients connected"
    }

    @objc private func showStatus(_ sender: Any?) {
        status.show()
    }

    @objc private func quit(_ sender: Any?) {
        NSApp.terminate(nil)
    }

    /// A small eye, drawn in code, as a template image (the menu bar tints it).
    static func makeEyeIcon(size: CGFloat = 18) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
            // drawn on an 18 pt grid, scaled for larger sizes
            let t = NSAffineTransform()
            t.scale(by: size / 18)
            t.concat()
            // the round eye of the screenshot animation (src/effects/scan.js) in template form: alpha stands in
            // for its colours (outline ring, half-tone iris, solid pupil, highlight cut out of the iris)
            NSColor.black.setStroke()
            let ring = NSBezierPath(ovalIn: NSRect(x: 1.75, y: 1.75, width: 14.5, height: 14.5))
            ring.lineWidth = 1.5
            ring.stroke()
            NSColor.black.withAlphaComponent(0.5).setFill()
            NSBezierPath(ovalIn: NSRect(x: 4.6, y: 4.2, width: 8.8, height: 8.8)).fill()
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(x: 6.6, y: 6.1, width: 4.8, height: 4.8)).fill()
            NSGraphicsContext.current?.compositingOperation = .clear
            NSBezierPath(ovalIn: NSRect(x: 10.1, y: 9.9, width: 2.2, height: 2.2)).fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            return true
        }
        image.isTemplate = true
        return image
    }
}

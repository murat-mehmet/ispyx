import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let router = Router()
    private var server: SocketServer?
    private var statusItem: NSStatusItem?
    private var statusLine: NSMenuItem?
    private let permissions = PermissionsController()
    private var startError: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()
        registerAllServices()

        let s = SocketServer(router: router)
        s.onHelperError = { [weak self] message in
            // A function failed because of a missing permission: show the onboarding window.
            let m = message.lowercased()
            if m.contains("permission") || m.contains("accessibility") || m.contains("screen recording") {
                self?.permissions.checkAndShow()
            }
        }
        s.onClientConnected = { [weak self] in
            self?.permissions.announceIfMissing()
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

        permissions.startup()
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
        let perms = NSMenuItem(title: "Permissions\u{2026}", action: #selector(showPermissions(_:)), keyEquivalent: "")
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
            if PermissionsController.contains(missing, "access") { names.append("Accessibility") }
            if PermissionsController.contains(missing, "screen") { names.append("Screen Recording") }
            if names.isEmpty { names = missing }
            return "Needs permission: " + names.joined(separator: ", ")
        }
        let n = server?.clientCount ?? 0
        if n == 0 { return "Ready, no client connected" }
        return n == 1 ? "Ready, 1 client connected" : "Ready, \(n) clients connected"
    }

    @objc private func showPermissions(_ sender: Any?) {
        permissions.show()
    }

    @objc private func quit(_ sender: Any?) {
        NSApp.terminate(nil)
    }

    /// A small eye, drawn in code, as a template image (the menu bar tints it).
    static func makeEyeIcon() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            NSColor.black.setStroke()
            NSColor.black.setFill()
            let eye = NSBezierPath()
            eye.move(to: NSPoint(x: 1.5, y: 9))
            eye.curve(to: NSPoint(x: 16.5, y: 9),
                      controlPoint1: NSPoint(x: 5, y: 15),
                      controlPoint2: NSPoint(x: 13, y: 15))
            eye.curve(to: NSPoint(x: 1.5, y: 9),
                      controlPoint1: NSPoint(x: 13, y: 3),
                      controlPoint2: NSPoint(x: 5, y: 3))
            eye.close()
            eye.lineWidth = 1.5
            eye.stroke()
            NSBezierPath(ovalIn: NSRect(x: 6.5, y: 6.5, width: 5, height: 5)).fill()
            return true
        }
        image.isTemplate = true
        return image
    }
}

import AppKit
import Foundation
import ServiceManagement
import WebKit

/// Forwards script messages to a target held weakly: WKUserContentController retains its handlers, so handing it
/// the controller directly would be a retain cycle.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

/// The Ispyx window. It hosts the shared page (Contents/Resources/panel/page.html, the same file the Windows app
/// serves) in a WKWebView: no server, no URL, no port. All visible content comes from the page; this class supplies
/// state and performs actions through `window.ispyx` (injected below):
///   getState()            -> { version, platform, autostart, permissions:[{id,title,detail,granted}], connect:{...} }
///   action(name, value?)  -> close, setAutostart, requestPermission, openPermissionSettings, showConfigFile, copy,
///                            quit, openLog
/// Shown when the user opens the app (not when the MCP server starts it in the background), from the menu bar, and
/// when a permission is missing. Also publishes the `permissions` event whenever the missing set changes.
final class PanelWindowController: NSObject, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    /// Clients connected to the socket, and the socket start error if any (set by AppDelegate).
    var clientCount: () -> Int = { 0 }
    var startError: () -> String? = { nil }

    private var window: NSWindow?
    private var webView: WKWebView?
    private var timer: Timer?
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

    // MARK: lifecycle (same surface the old status window had)

    /// At launch. `background`: started by the MCP server (`--background`), so stay quiet unless something is missing.
    func startup(background: Bool) {
        let missing = missingPermissions()
        lastEmitted = missing
        if !missing.isEmpty || !background {
            show(closeWhenGranted: background)
        }
        // Screen Recording: without a request Ispyx never appears in that list, so make it once at launch.
        if PanelWindowController.contains(missing, "screen") { requestPermission("screenRecording") }
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

    /// Native side of the once-a-second check (the page polls getState() on its own for what it shows).
    private func refresh() {
        let missing = missingPermissions()
        publish(missing)
        if missing.isEmpty && closeWhenGranted { window?.close() }
    }

    func windowDidBecomeKey(_ notification: Notification) {
        refresh()
        // Ask the page to re-read the state now instead of waiting for its next poll (harmless if nobody listens).
        webView?.evaluateJavaScript("window.dispatchEvent(new Event('ispyx-refresh'))", completionHandler: nil)
    }

    func windowWillClose(_ notification: Notification) {
        timer?.invalidate()
        timer = nil
        // Drop the web view with the window so nothing polls while the window is hidden. Done after the close has
        // finished, not inside it.
        DispatchQueue.main.async { [weak self] in self?.tearDown() }
    }

    private func tearDown() {
        // A window opened again in the meantime keeps its web view.
        if let w = window, w.isVisible { return }
        webView?.navigationDelegate = nil
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "ispyx")
        webView?.configuration.userContentController.removeAllUserScripts()
        webView?.stopLoading()
        webView?.removeFromSuperview()
        webView = nil
        window?.delegate = nil
        window = nil
    }

    // MARK: web view

    /// Defines window.ispyx for the page. Promises are settled by __ispyxReply, which Swift calls.
    private static let bridgeScript = """
    (function () {
      var pending = {};
      var next = 1;
      window.__ispyxReply = function (id, ok, payload) {
        var p = pending[id];
        if (!p) { return; }
        delete pending[id];
        if (ok) { p.resolve(payload); }
        else { p.reject(new Error(typeof payload === 'string' ? payload : 'failed')); }
      };
      function send(kind, name, value) {
        return new Promise(function (resolve, reject) {
          var id = next++;
          pending[id] = { resolve: resolve, reject: reject };
          try {
            window.webkit.messageHandlers.ispyx.postMessage({ id: id, kind: kind, name: name, value: value === undefined ? null : value });
          } catch (e) {
            delete pending[id];
            reject(e);
          }
        });
      }
      window.ispyx = {
        getState: function () { return send('state', 'state'); },
        action: function (name, value) { return send('action', name, value); }
      };
    })();
    """

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: PanelWindowController.bridgeScript,
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.add(WeakScriptHandler(self), name: "ispyx")
        config.userContentController = ucc

        let rect = NSRect(x: 0, y: 0, width: 520, height: 720)
        let web = WKWebView(frame: rect, configuration: config)
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]

        let w = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "Ispyx"
        w.isReleasedWhenClosed = false
        w.minSize = NSSize(width: 440, height: 560)
        w.delegate = self
        w.contentView = web

        webView = web
        window = w
        loadPage(web)
    }

    private func loadPage(_ web: WKWebView) {
        let dir = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/panel", isDirectory: true)
        let page = dir.appendingPathComponent("page.html")
        if FileManager.default.fileExists(atPath: page.path) {
            web.loadFileURL(page, allowingReadAccessTo: dir)
        } else {
            web.loadHTMLString("<html><body style=\"font: 14px -apple-system; padding: 24px\">" +
                "Ispyx could not find its page (Contents/Resources/panel/page.html). Build the app with native/macos/build.sh." +
                "</body></html>", baseURL: nil)
        }
    }

    /// Only the bundled page may load in this window; any link to the web opens in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.isFileURL || url.scheme == "about" {
            decisionHandler(.allow)
        } else {
            if url.scheme == "https" || url.scheme == "http" { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    // MARK: bridge

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        let id: Any = body["id"] ?? NSNull()
        let kind = body["kind"] as? String ?? ""
        let name = body["name"] as? String ?? ""
        var value: Any? = body["value"]
        if value is NSNull { value = nil }

        if kind == "state" {
            reply(id, ok: true, payload: stateObject())
            return
        }
        if kind != "action" {
            reply(id, ok: false, payload: "unknown message kind")
            return
        }
        switch name {
        case "close":
            reply(id, ok: true, payload: NSNull())
            DispatchQueue.main.async { [weak self] in self?.window?.close() }
        case "quit":
            reply(id, ok: true, payload: NSNull())
            DispatchQueue.main.async { NSApp.terminate(nil) }
        case "setAutostart":
            let on = (value as? Bool) ?? ((value as? NSNumber)?.boolValue ?? false)
            if let err = setAutostart(on) {
                reply(id, ok: false, payload: err)
            } else {
                reply(id, ok: true, payload: ["autostart": SMAppService.mainApp.status == .enabled])
            }
        case "requestPermission":
            if let p = nativePermissionName(value as? String) {
                requestPermission(p)
                reply(id, ok: true, payload: NSNull())
            } else {
                reply(id, ok: false, payload: "unknown permission")
            }
        case "openPermissionSettings":
            if let p = nativePermissionName(value as? String) {
                // Ispyx only shows up in the pane's list after it has asked once, so ask first (as the old button did).
                if !hasPermission(p) { requestPermission(p) }
                openPane(p == "accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture")
                reply(id, ok: true, payload: NSNull())
            } else {
                reply(id, ok: false, payload: "unknown permission")
            }
        case "showConfigFile":
            showDesktopConfig()
            reply(id, ok: true, payload: NSNull())
        case "copy":
            if let text = value as? String {
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.setString(text, forType: .string)
                reply(id, ok: true, payload: NSNull())
            } else {
                reply(id, ok: false, payload: "copy needs a text")
            }
        case "openLog":
            let path = AppPaths.supportDir + "/ispyx.log"
            if FileManager.default.fileExists(atPath: path) {
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
            }
            reply(id, ok: true, payload: NSNull())
        default:
            reply(id, ok: false, payload: "unknown action")
        }
    }

    /// Page ids ("accessibility", "screen-recording") to the names Permissions.swift uses.
    private func nativePermissionName(_ id: String?) -> String? {
        switch id {
        case "accessibility": return "accessibility"
        case "screen-recording", "screenRecording": return "screenRecording"
        default: return nil
        }
    }

    private func stateObject() -> [String: Any] {
        let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.1.0"
        var perms = [[String: Any]]()
        perms.append([
            "id": "accessibility",
            "title": "Accessibility",
            "detail": "Move the pointer, click and type.",
            "granted": hasPermission("accessibility"),
        ])
        perms.append([
            "id": "screen-recording",
            "title": "Screen Recording",
            "detail": "Take screenshots. macOS may ask you to reopen Ispyx.",
            "granted": hasPermission("screenRecording"),
        ])
        var state: [String: Any] = [
            "version": version,
            "platform": "darwin",
            "autostart": SMAppService.mainApp.status == .enabled,
            "permissions": perms,
            "connect": [
                "claudeCodeCommand": PanelWindowController.connectCommand,
                "desktopConfigJson": PanelWindowController.desktopConfigSnippet,
                "desktopConfigPath": PanelWindowController.desktopConfigPath,
            ],
            "clients": clientCount(),
        ]
        if let e = startError() { state["startError"] = e }
        return state
    }

    /// Sends the answer for message `id` to the page, on the main thread.
    private func reply(_ id: Any, ok: Bool, payload: Any) {
        let send = { [weak self] in
            guard let web = self?.webView else { return }
            let js = "window.__ispyxReply(" + PanelWindowController.jsonText(id) + ", " + (ok ? "true" : "false") +
                ", " + PanelWindowController.jsonText(payload) + ");"
            web.evaluateJavaScript(js, completionHandler: nil)
        }
        if Thread.isMainThread { send() } else { DispatchQueue.main.async(execute: send) }
    }

    private static func jsonText(_ object: Any) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed]),
           let s = String(data: data, encoding: .utf8) {
            return s
        }
        return "null"
    }

    // MARK: actions

    private func openPane(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?" + anchor) {
            NSWorkspace.shared.open(url)
        }
    }

    /// Reveals claude_desktop_config.json in Finder, or its folder when the file does not exist yet.
    private func showDesktopConfig() {
        let path = PanelWindowController.desktopConfigPath
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

    /// Returns an error message, or nil on success.
    private func setAutostart(_ on: Bool) -> String? {
        let service = SMAppService.mainApp
        do {
            if on {
                if service.status != .enabled {
                    try service.register()
                    if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
                }
            } else if service.status == .enabled {
                try service.unregister()
            }
            return nil
        } catch {
            let alert = NSAlert()
            alert.messageText = "Could not change the login setting"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            return error.localizedDescription
        }
    }
}

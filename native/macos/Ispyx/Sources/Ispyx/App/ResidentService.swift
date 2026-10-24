import Foundation

/// Runs the bundled Node core as the resident server (`macos-entry.js --resident`), the one process that does the
/// work, like the tray app on Windows: it connects back to this app's socket, owns the pipe the MCP clients'
/// forwarders (`Contents/Resources/ispyx` = `ispyx mcp`) talk to, and serves the panel's activity and settings, so
/// those work without any AI app connected. Started with the app, stopped when it quits (SIGTERM: the resident tells
/// the forwarders to exit first), started again when it dies. It also leaves by itself when this app is gone
/// (ISPYX_APP_PID).
final class ResidentService {
    static let shared = ResidentService()
    private var process: Process?
    private var stopping = false
    private var startedAt = Date()
    private var delay: TimeInterval = 1

    func start() {
        stopping = false
        if process == nil { launch() }
    }

    private func launch() {
        let res = Bundle.main.bundlePath + "/Contents/Resources"
        let node = res + "/node/bin/node"
        let entry = res + "/core/src/macos-entry.js"
        guard FileManager.default.isExecutableFile(atPath: node), FileManager.default.fileExists(atPath: entry) else {
            NSLog("Ispyx: the bundled Node or server is missing in \(res); no resident")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [entry, "--resident"]
        var env = ProcessInfo.processInfo.environment
        env["ISPYX_APP_PID"] = String(getpid())
        p.environment = env
        // the resident writes its own log (Application Support/Ispyx/ispyx.log)
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in DispatchQueue.main.async { self?.exited(proc) } }
        do {
            try p.run()
            process = p
            startedAt = Date()
        } catch {
            NSLog("Ispyx: could not start the resident: \(error.localizedDescription)")
            retryLater()
        }
    }

    private func exited(_ p: Process) {
        if process === p { process = nil }
        if stopping { return }
        // It ran for a while: start it again at once. It left right away (a permission is missing, or another
        // resident already owns the pipe): back off up to 30 s.
        delay = Date().timeIntervalSince(startedAt) > 30 ? 1 : min(delay * 2, 30)
        retryLater()
    }

    private func retryLater() {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, !self.stopping, self.process == nil else { return }
            self.launch()
        }
    }

    /// At quit: SIGTERM, then SIGKILL if it is still there after 2 s; `done` runs once it is gone. Never blocks the
    /// main thread: while the resident shuts down it still makes calls into this app (releasing held keys, its stop
    /// hotkey), and a blocked main thread would leave it hanging until the SIGKILL, with the forwarders never told.
    func stop(_ done: @escaping () -> Void = {}) {
        stopping = true
        guard let p = process, p.isRunning else { done(); return }
        var finished = false
        let finish = { if !finished { finished = true; done() } }
        let previous = p.terminationHandler
        p.terminationHandler = { proc in
            previous?(proc)
            DispatchQueue.main.async(execute: finish)
        }
        p.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            finish()
        }
    }
}

import Foundation
import Darwin

/// Filesystem locations shared by the app.
enum AppPaths {
    /// ~/Library/Application Support/Ispyx
    static var supportDir: String {
        let base = NSSearchPathForDirectoriesInDomains(.applicationSupportDirectory, .userDomainMask, true).first
            ?? (NSHomeDirectory() + "/Library/Application Support")
        return base + "/Ispyx"
    }

    /// The helper socket. ISPYX_SOCKET overrides it (tests).
    static var socketPath: String {
        if let p = ProcessInfo.processInfo.environment["ISPYX_SOCKET"], !p.isEmpty { return p }
        return supportDir + "/helper.sock"
    }

    /// $TMPDIR/ispyx (no trailing slash), created on demand. Shared pixel files live here.
    static var tempDir: String {
        var t = NSTemporaryDirectory()
        while t.count > 1 && t.hasSuffix("/") { t.removeLast() }
        let dir = t + "/ispyx"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        return dir
    }
}

/// One connected client.
private final class ClientConnection {
    let fd: Int32
    var readSource: DispatchSourceRead?
    var writeSource: DispatchSourceWrite?
    var inBuf = [UInt8]()
    var outBuf = [UInt8]()
    var closed = false
    var processing = false
    init(fd: Int32) { self.fd = fd }
}

/// Unix domain socket server. Newline-delimited JSON, see src/platform/darwin/PROTOCOL.md.
/// Everything runs on the main queue: requests are decoded, run through the Router and answered inline, one at a time.
final class SocketServer {
    private let router: Router
    private var listenFd: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var clients = [Int32: ClientConnection]()
    private var readChunk = [UInt8](repeating: 0, count: 65536)

    /// A handler threw a HelperError (message goes to the client); used to notice missing permissions.
    var onHelperError: ((String) -> Void)?
    var onClientConnected: (() -> Void)?
    var onAllClientsGone: (() -> Void)?

    var clientCount: Int { return clients.count }

    init(router: Router) {
        self.router = router
    }

    // MARK: start / stop

    func start() throws {
        let path = AppPaths.socketPath
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        unlink(path) // stale file from a crashed run (single-instance lock guarantees nobody else is using it)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { throw HelperError("Could not create the helper socket (errno \(errno)).") }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let pathBytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        if pathBytes.count >= capacity {
            close(fd)
            throw HelperError("The socket path is too long: \(path)")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for i in 0..<pathBytes.count { raw[i] = pathBytes[i] }
            raw[pathBytes.count] = 0
        }

        let oldMask = umask(0o177) // socket file created as 0600
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindResult = withUnsafePointer(to: &addr) { p -> Int32 in
            return p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
                return bind(fd, sp, len)
            }
        }
        umask(oldMask)
        if bindResult != 0 {
            let e = errno
            close(fd)
            throw HelperError("Could not bind the helper socket at \(path) (errno \(e)).")
        }
        chmod(path, 0o600)
        if listen(fd, 16) != 0 {
            let e = errno
            close(fd)
            throw HelperError("Could not listen on the helper socket (errno \(e)).")
        }
        setNonBlocking(fd)
        listenFd = fd

        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue.main)
        src.setEventHandler { [weak self] in self?.acceptClients() }
        src.resume()
        acceptSource = src

        EventBus.shared.emit = { [weak self] name, payload in
            guard let self = self else { return }
            if Thread.isMainThread {
                self.broadcast(name, payload)
            } else {
                DispatchQueue.main.async { self.broadcast(name, payload) }
            }
        }
    }

    func stop() {
        EventBus.shared.emit = nil
        for c in Array(clients.values) { closeClient(c, notify: false) }
        acceptSource?.cancel()
        acceptSource = nil
        if listenFd >= 0 {
            close(listenFd)
            listenFd = -1
        }
        unlink(AppPaths.socketPath)
    }

    // MARK: accepting

    private func setNonBlocking(_ fd: Int32) {
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
    }

    private func acceptClients() {
        while true {
            let cfd = accept(listenFd, nil, nil)
            if cfd < 0 { break } // EAGAIN: no more pending
            setNonBlocking(cfd)
            var one: Int32 = 1
            _ = setsockopt(cfd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))

            let conn = ClientConnection(fd: cfd)
            let rs = DispatchSource.makeReadSource(fileDescriptor: cfd, queue: DispatchQueue.main)
            rs.setEventHandler { [weak self, weak conn] in
                guard let self = self, let conn = conn else { return }
                self.readFrom(conn)
            }
            rs.setCancelHandler {
                close(cfd)
            }
            conn.readSource = rs
            clients[cfd] = conn
            rs.resume()
            onClientConnected?()
        }
    }

    private func closeClient(_ conn: ClientConnection, notify: Bool) {
        if conn.closed { return }
        conn.closed = true
        clients.removeValue(forKey: conn.fd)
        conn.writeSource?.cancel()
        conn.writeSource = nil
        conn.readSource?.cancel() // its cancel handler closes the fd
        conn.readSource = nil
        LayerRegistry.shared.destroyOwned(by: conn.fd)
        if notify && clients.isEmpty { onAllClientsGone?() }
    }

    // MARK: reading

    private func readFrom(_ conn: ClientConnection) {
        // Never re-enter for the same client (a handler that spins the run loop would read the next line too early).
        if conn.closed || conn.processing { return }
        let n = readChunk.withUnsafeMutableBytes { raw -> Int in
            return read(conn.fd, raw.baseAddress, raw.count)
        }
        if n == 0 {
            closeClient(conn, notify: true)
            return
        }
        if n < 0 {
            if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { return }
            closeClient(conn, notify: true)
            return
        }
        conn.inBuf.append(contentsOf: readChunk[0..<n])

        conn.processing = true
        defer { conn.processing = false }
        var start = 0
        var i = 0
        let count = conn.inBuf.count
        while i < count {
            if conn.inBuf[i] == 0x0A {
                if i > start {
                    let line = Data(conn.inBuf[start..<i])
                    handleLine(line, conn)
                    if conn.closed { return }
                }
                start = i + 1
            }
            i += 1
        }
        if start > 0 { conn.inBuf.removeSubrange(0..<start) }
        if conn.inBuf.count > 64 * 1024 * 1024 { // a runaway line
            closeClient(conn, notify: true)
        }
    }

    private func handleLine(_ line: Data, _ conn: ClientConnection) {
        var parsed: Any? = nil
        do {
            parsed = try JSONSerialization.jsonObject(with: line, options: [])
        } catch {
            parsed = nil
        }
        guard let obj = parsed as? [String: Any] else { return } // no id to answer to
        var resp = [String: Any]()
        if let id = obj["id"] { resp["id"] = id }
        let fn = obj["fn"] as? String ?? ""
        let args = obj["args"] as? [Any] ?? []
        LayerRegistry.shared.currentOwner = conn.fd
        defer { LayerRegistry.shared.currentOwner = -1 }
        // An async handler (the password window) answers later; other calls from the same client go on meanwhile.
        router.call(fn, args) { [weak self, weak conn] outcome in
            guard let self = self, let conn = conn else { return }
            var resp = resp
            switch outcome {
            case .success(let result):
                resp["ok"] = true
                resp["result"] = result ?? NSNull()
            case .failure(let e as HelperError):
                resp["ok"] = false
                resp["error"] = e.message
                self.onHelperError?(e.message)
            case .failure(let error):
                resp["ok"] = false
                resp["error"] = "The Ispyx app failed: \(error.localizedDescription)"
            }
            self.send(resp, to: conn)
        }
    }

    // MARK: writing

    private func send(_ object: [String: Any], to conn: ClientConnection) {
        if conn.closed { return }
        var obj = object
        if !JSONSerialization.isValidJSONObject(obj) {
            var fallback = [String: Any]()
            if let id = object["id"] { fallback["id"] = id }
            fallback["ok"] = false
            fallback["error"] = "The Ispyx app produced a result that cannot be sent as JSON."
            obj = fallback
            if !JSONSerialization.isValidJSONObject(obj) { return }
        }
        guard var data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else { return }
        data.append(0x0A)
        write(data, to: conn)
    }

    private func write(_ data: Data, to conn: ClientConnection) {
        if conn.closed { return }
        if !conn.outBuf.isEmpty {
            conn.outBuf.append(contentsOf: data)
            return
        }
        var sent = 0
        let total = data.count
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            while sent < total {
                let n = Darwin.write(conn.fd, base + sent, total - sent)
                if n > 0 {
                    sent += n
                } else if n < 0 && errno == EINTR {
                    continue
                } else {
                    break
                }
            }
        }
        if sent >= total { return }
        if errno != EAGAIN && errno != EWOULDBLOCK {
            closeClient(conn, notify: true)
            return
        }
        conn.outBuf.append(contentsOf: data[sent..<total])
        startWriteSource(conn)
    }

    private func startWriteSource(_ conn: ClientConnection) {
        if conn.writeSource != nil { return }
        let ws = DispatchSource.makeWriteSource(fileDescriptor: conn.fd, queue: DispatchQueue.main)
        ws.setEventHandler { [weak self, weak conn] in
            guard let self = self, let conn = conn else { return }
            self.flush(conn)
        }
        conn.writeSource = ws
        ws.resume()
    }

    private func flush(_ conn: ClientConnection) {
        if conn.closed { return }
        var sent = 0
        let total = conn.outBuf.count
        conn.outBuf.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            while sent < total {
                let n = Darwin.write(conn.fd, base + sent, total - sent)
                if n > 0 {
                    sent += n
                } else if n < 0 && errno == EINTR {
                    continue
                } else {
                    break
                }
            }
        }
        if sent < total && errno != EAGAIN && errno != EWOULDBLOCK {
            closeClient(conn, notify: true)
            return
        }
        if sent > 0 { conn.outBuf.removeSubrange(0..<sent) }
        if conn.outBuf.isEmpty {
            conn.writeSource?.cancel()
            conn.writeSource = nil
        }
    }

    private func broadcast(_ name: String, _ payload: [String: Any]) {
        var msg = payload
        msg["event"] = name
        for c in Array(clients.values) { send(msg, to: c) }
    }
}

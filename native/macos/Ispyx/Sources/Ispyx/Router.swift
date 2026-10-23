import Foundation

/// A failure whose message goes straight to the AI caller (plain sentence, says what to do).
struct HelperError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

/// Maps protocol function names (see src/platform/darwin/PROTOCOL.md) to handlers.
/// Arguments and results are JSON values as produced by JSONSerialization (NSNumber, String, [Any], [String: Any], NSNull).
/// Handlers are called on the main thread, one at a time, so they may touch AppKit and CoreGraphics freely.
final class Router {
    typealias Handler = (_ args: [Any]) throws -> Any?
    private var handlers: [String: Handler] = [:]

    func register(_ name: String, _ handler: @escaping Handler) { handlers[name] = handler }

    func call(_ name: String, _ args: [Any]) throws -> Any? {
        guard let handler = handlers[name] else { throw HelperError("The Ispyx app does not know the function \(name). Update the app.") }
        return try handler(args)
    }

    var names: [String] { handlers.keys.sorted() }
}

/// App -> client events (no request id): `stop` when the stop chord is pressed, `permissions` when one is missing.
final class EventBus {
    static let shared = EventBus()
    /// Set by the socket server; sends `{ "event": name, ...payload }` to every connected client.
    var emit: ((_ name: String, _ payload: [String: Any]) -> Void)?
    func send(_ name: String, _ payload: [String: Any] = [:]) { emit?(name, payload) }
}

/// JSON argument helpers so handlers stay short.
extension Array where Element == Any {
    func int(_ i: Int) throws -> Int {
        guard i < count, let n = self[i] as? NSNumber else { throw HelperError("Argument \(i) must be a number.") }
        return n.intValue
    }
    func double(_ i: Int) throws -> Double {
        guard i < count, let n = self[i] as? NSNumber else { throw HelperError("Argument \(i) must be a number.") }
        return n.doubleValue
    }
    func string(_ i: Int) throws -> String {
        guard i < count, let s = self[i] as? String else { throw HelperError("Argument \(i) must be a string.") }
        return s
    }
    func object(_ i: Int) throws -> [String: Any] {
        guard i < count, let o = self[i] as? [String: Any] else { throw HelperError("Argument \(i) must be an object.") }
        return o
    }
    func ints(_ i: Int) throws -> [Int] {
        guard i < count, let a = self[i] as? [Any] else { throw HelperError("Argument \(i) must be an array of numbers.") }
        return try a.enumerated().map { try a.int($0.offset) }
    }
}

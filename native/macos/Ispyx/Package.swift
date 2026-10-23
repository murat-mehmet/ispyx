// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Ispyx",
    platforms: [.macOS(.v13)],
    targets: [
        // One executable target. Sources/Ispyx/App: app shell, socket server, UI (overlay, dialog, layers).
        // Sources/Ispyx/Services: the platform functions (input, windows, capture, pasteboard, hotkey).
        .executableTarget(name: "Ispyx", path: "Sources/Ispyx"),
    ]
)

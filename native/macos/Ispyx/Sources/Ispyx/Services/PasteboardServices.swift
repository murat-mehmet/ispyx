import Foundation
import AppKit

func registerPasteboardServices(_ r: Router) {
    r.register("getClipboardText") { _ in
        let pb = NSPasteboard.general
        let formats: [String] = (pb.types ?? []).map { $0.rawValue }
        var result: [String: Any] = ["formats": formats]
        if let s = pb.string(forType: .string) {
            result["text"] = s
        } else {
            result["text"] = NSNull()
        }
        return result
    }

    r.register("setClipboardText") { args in
        let text = try args.string(0)
        let pb = NSPasteboard.general
        pb.clearContents()
        if !pb.setString(text, forType: .string) {
            throw HelperError("macOS refused to put the text on the clipboard.")
        }
        return true
    }

    r.register("setClipboardFile") { args in
        let path = try args.string(0)
        if !FileManager.default.fileExists(atPath: path) {
            throw HelperError("The file '\(path)' does not exist, so it cannot be put on the clipboard.")
        }
        let pb = NSPasteboard.general
        pb.clearContents()
        let url = NSURL(fileURLWithPath: path)
        if !pb.writeObjects([url]) {
            throw HelperError("macOS refused to put the file on the clipboard.")
        }
        return true
    }
}

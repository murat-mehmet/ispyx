// Sets the banner text over the art from make-banner.mjs with the system font and writes the final PNG.
//   swift text.swift <art.png> <out.png> <scale>
import AppKit

let args = CommandLine.arguments
let art = NSImage(contentsOfFile: args[1])!
let s = CGFloat(Double(args[3])!)
let rep = art.representations[0]
let w = rep.pixelsWide, h = rep.pixelsHigh

let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
art.draw(in: NSRect(x: 0, y: 0, width: w, height: h))

/** Draws text with its top-left at (x, top) in banner points (1x, y from the top). */
func text(_ str: String, _ x: CGFloat, _ top: CGFloat, size: CGFloat, weight: NSFont.Weight, color: NSColor, kern: CGFloat = 0) {
    let font = NSFont.systemFont(ofSize: size * s, weight: weight)
    let a = NSAttributedString(string: str, attributes: [.font: font, .foregroundColor: color, .kern: kern * s])
    a.draw(at: NSPoint(x: x * s, y: CGFloat(h) - top * s - a.size().height))
}

let green = NSColor(srgbRed: 0.42, green: 1, blue: 0.55, alpha: 1)
text("ispyx", 72, 58, size: 104, weight: .heavy, color: .white, kern: -3)
text("Let an AI use your computer the way you do.", 76, 190, size: 25, weight: .semibold, color: NSColor(white: 0.93, alpha: 1))
text("Local MCP server: screen, windows, mouse, keyboard, clipboard.", 76, 226, size: 19, weight: .regular,
     color: NSColor(srgbRed: 0.66, green: 0.78, blue: 0.72, alpha: 1))
text("stdio only  ·  no network port  ·  Windows + macOS", 76, 264, size: 16, weight: .medium, color: green)

NSGraphicsContext.current = nil
try! out.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))

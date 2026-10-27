import AppKit
import Foundation

/// The password window of the auth gate (setup: password + repeat, unlock: password).
/// show() returns at once; the window calls `done` with the result when it ends, so the app keeps answering other calls
/// (the stop key poll among them) while it is open.
final class PasswordDialog: NSObject, NSWindowDelegate {
    static var active = false

    private var window: NSWindow!
    private var passwordField: NSSecureTextField!
    private var confirmField: NSSecureTextField?
    private var valueField: NSTextField!
    private var stepper: NSStepper!
    private var unitPopup: NSPopUpButton!
    private var defaultCheck: NSButton!
    private var countdown: NSTextField!
    private var timer: Timer?
    private var remaining: Int
    private var finished = false
    private var done: (([String: Any]) -> Void)?
    /// The open window, kept alive until it ends.
    private static var current: PasswordDialog?
    private var result: [String: Any] = ["cancel": true, "reason": "closed by the user"]

    init(options: [String: Any], seconds: Int) {
        remaining = max(1, seconds)
        super.init()
        build(options)
    }

    // MARK: layout

    private func build(_ opts: [String: Any]) {
        let setup = (opts["mode"] as? String) == "setup"
        let message = ((opts["message"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var value = 24
        if let n = opts["value"] as? NSNumber { value = max(1, min(100000, n.intValue)) }
        let unit = (opts["unit"] as? String) ?? "hours"

        let width: CGFloat = 400
        let height: CGFloat = setup ? 290 : 250
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                         styleMask: [.titled, .closable],
                         backing: .buffered, defer: false)
        w.title = "Ispyx"
        w.isReleasedWhenClosed = false
        w.level = .floating
        w.delegate = self
        guard let content = w.contentView else { window = w; return }

        func frame(_ x: CGFloat, _ top: CGFloat, _ cw: CGFloat, _ ch: CGFloat) -> NSRect {
            return NSRect(x: x, y: height - top - ch, width: cw, height: ch)
        }
        let labelFont = NSFont.systemFont(ofSize: 13)

        var top: CGFloat = 16
        let titleText = setup
            ? "First setup: choose a password. The tools will not run without it."
            : "A tool call came in. Enter the password to continue."
        let title = NSTextField(wrappingLabelWithString: titleText)
        title.font = NSFont.boldSystemFont(ofSize: 13)
        title.frame = frame(20, top, width - 40, 36)
        content.addSubview(title)
        top += 42

        let msg = NSTextField(wrappingLabelWithString: message)
        msg.font = NSFont.systemFont(ofSize: 12)
        msg.textColor = NSColor.systemRed
        msg.frame = frame(20, top, width - 40, 18)
        content.addSubview(msg)
        top += 28

        let pwLabel = NSTextField(labelWithString: "Password")
        pwLabel.font = labelFont
        pwLabel.frame = frame(20, top + 2, 80, 18)
        content.addSubview(pwLabel)
        let pw = NSSecureTextField(frame: frame(110, top, 270, 24))
        content.addSubview(pw)
        passwordField = pw
        top += 34

        if setup {
            let cfLabel = NSTextField(labelWithString: "Repeat")
            cfLabel.font = labelFont
            cfLabel.frame = frame(20, top + 2, 80, 18)
            content.addSubview(cfLabel)
            let cf = NSSecureTextField(frame: frame(110, top, 270, 24))
            content.addSubview(cf)
            confirmField = cf
            top += 34
        }

        let durLabel = NSTextField(labelWithString: "Stay unlocked for")
        durLabel.font = labelFont
        durLabel.frame = frame(20, top + 2, 120, 18)
        content.addSubview(durLabel)
        let vf = NSTextField(frame: frame(146, top, 60, 24))
        vf.integerValue = value
        content.addSubview(vf)
        valueField = vf
        let st = NSStepper(frame: frame(208, top, 19, 24))
        st.minValue = 1
        st.maxValue = 100000
        st.increment = 1
        st.integerValue = value
        st.valueWraps = false
        st.target = self
        st.action = #selector(stepperChanged(_:))
        content.addSubview(st)
        stepper = st
        let popup = NSPopUpButton(frame: frame(240, top - 1, 140, 26), pullsDown: false)
        popup.addItems(withTitles: ["minutes", "hours", "days"])
        if popup.itemTitles.contains(unit) { popup.selectItem(withTitle: unit) } else { popup.selectItem(withTitle: "hours") }
        content.addSubview(popup)
        unitPopup = popup
        top += 34

        let check = NSButton(checkboxWithTitle: "Make this the new default", target: nil, action: nil)
        check.frame = frame(20, top, width - 40, 22)
        content.addSubview(check)
        defaultCheck = check
        top += 36

        let count = NSTextField(labelWithString: "")
        count.font = NSFont.systemFont(ofSize: 12)
        count.textColor = NSColor.secondaryLabelColor
        count.frame = frame(20, top + 5, 160, 18)
        content.addSubview(count)
        countdown = count

        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelPressed(_:)))
        cancel.frame = frame(width - 20 - 90 - 10 - 100, top, 90, 28)
        cancel.keyEquivalent = "\u{1b}"
        content.addSubview(cancel)
        let ok = NSButton(title: setup ? "Set password" : "Unlock", target: self, action: #selector(okPressed(_:)))
        ok.frame = frame(width - 20 - 100, top, 100, 28)
        ok.keyEquivalent = "\r"
        content.addSubview(ok)

        updateCountdown()
        window = w
    }

    private func updateCountdown() {
        countdown?.stringValue = "Closes in \(remaining) s"
    }

    // MARK: actions

    @objc private func stepperChanged(_ sender: Any?) {
        valueField.integerValue = stepper.integerValue
    }

    @objc private func okPressed(_ sender: Any?) {
        window.makeFirstResponder(nil) // commit text being edited
        var v = valueField.integerValue
        if v < 1 { v = 1 }
        if v > 100000 { v = 100000 }
        let unit = unitPopup.titleOfSelectedItem ?? "hours"
        finish([
            "password": passwordField.stringValue,
            "confirm": confirmField?.stringValue ?? "",
            "value": v,
            "unit": unit,
            "makeDefault": defaultCheck.state == .on,
        ])
    }

    @objc private func cancelPressed(_ sender: Any?) {
        finish(["cancel": true, "reason": "closed by the user"])
    }

    func windowWillClose(_ notification: Notification) {
        finish(["cancel": true, "reason": "closed by the user"])
    }

    private func tick() {
        remaining -= 1
        if remaining <= 0 {
            finish(["cancel": true, "reason": "timed out"])
        } else {
            updateCountdown()
        }
    }

    private func finish(_ r: [String: Any]) {
        if finished { return }
        finished = true
        result = r
        timer?.invalidate()
        timer = nil
        window.delegate = nil
        window.orderOut(nil)
        PasswordDialog.active = false
        PasswordDialog.current = nil
        done?(r)
        done = nil
    }

    // MARK: run

    func show(_ done: @escaping ([String: Any]) -> Void) {
        self.done = done
        PasswordDialog.active = true
        PasswordDialog.current = self
        let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t

        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(passwordField)
    }
}

func registerDialogServices(_ r: Router) {
    r.registerAsync("showDialog") { args, reply in
        let opts = try args.object(0)
        let ms = (args.count > 1 ? (args[1] as? NSNumber)?.doubleValue : nil) ?? 30000
        if PasswordDialog.active {
            throw HelperError("A password window is already open. Answer or close it first.")
        }
        let seconds = Int((ms / 1000.0).rounded(.up))
        PasswordDialog(options: opts, seconds: seconds).show { reply(.success($0)) }
    }
}

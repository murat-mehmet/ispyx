import Foundation
import CoreGraphics
import Carbon.HIToolbox

// The kVK_* constants (Int) come from Carbon.HIToolbox: kVK_Return, kVK_Tab, kVK_Escape, kVK_Command ...
// This file only adds helpers around them.

/// Magic value stored in kCGEventSourceUserData on every event Ispyx posts, so the stop-hotkey tap can ignore them. 'ISPX'.
let ispyxSyntheticMarker: Int64 = 0x49535058

/// The modifier flag a modifier key code stands for, or nil for ordinary keys.
func modifierFlag(forKeyCode code: Int) -> CGEventFlags? {
    switch code {
    case kVK_Command, kVK_RightCommand: return .maskCommand
    case kVK_Shift, kVK_RightShift: return .maskShift
    case kVK_Option, kVK_RightOption: return .maskAlternate
    case kVK_Control, kVK_RightControl: return .maskControl
    case kVK_Function: return .maskSecondaryFn
    default: return nil
    }
}

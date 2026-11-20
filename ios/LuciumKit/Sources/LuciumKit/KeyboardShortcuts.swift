import Foundation

/// The hardware-keyboard shortcuts of the iPad. They are the Mac's own (`src/shared/keybindings.ts`, defaults): a person who has both keeps the same
/// fingers. The accelerator strings are the Mac's (`CmdOrCtrl+Alt+Down`), kept as written so that a contract test can compare them with the Mac's list
/// (`ios/Contracts/shortcut-vectors.json`); this file turns one into a key and modifiers that SwiftUI can bind.
public enum ShortcutCommand: String, CaseIterable, Sendable {
    case newTab, closeTab, restoreClosed, openLocation, tabSearch, nextTab, previousTab
    case nextSpace, previousSpace
    case back, forward, reload, find, zoomIn, zoomOut, zoomReset
    case toggleSidebar, pin, settings

    /// The Mac's default accelerator for the same command (the id is the Mac's command id).
    public var accelerator: String {
        switch self {
        case .newTab: "CmdOrCtrl+T"
        case .closeTab: "CmdOrCtrl+W"
        case .restoreClosed: "CmdOrCtrl+Shift+T"
        case .openLocation: "CmdOrCtrl+L"
        case .tabSearch: "CmdOrCtrl+Shift+A"
        case .nextTab: "CmdOrCtrl+Alt+Down"
        case .previousTab: "CmdOrCtrl+Alt+Up"
        case .nextSpace: "CmdOrCtrl+Alt+Right"
        case .previousSpace: "CmdOrCtrl+Alt+Left"
        case .back: "CmdOrCtrl+["
        case .forward: "CmdOrCtrl+]"
        case .reload: "CmdOrCtrl+R"
        case .find: "CmdOrCtrl+F"
        case .zoomIn: "CmdOrCtrl+Plus"
        case .zoomOut: "CmdOrCtrl+-"
        case .zoomReset: "CmdOrCtrl+0"
        case .toggleSidebar: "CmdOrCtrl+S"
        case .pin: "CmdOrCtrl+D"
        case .settings: "CmdOrCtrl+,"
        }
    }

    /// The key and modifiers of `accelerator`; nil when the string is not one this file understands (a test refuses that).
    public var binding: ShortcutBinding? { ShortcutBinding(accelerator: accelerator) }
}

/// A key with its modifiers, with no UI framework in it: `Lucium/KeyboardCommands.swift` maps it to SwiftUI.
public struct ShortcutBinding: Equatable, Sendable {
    public enum Key: Equatable, Sendable { case character(Character), up, down, left, right }

    public let key: Key
    public let command: Bool
    public let shift: Bool
    public let option: Bool

    public init?(accelerator: String) {
        var command = false, shift = false, option = false
        var key: Key?
        for part in accelerator.split(separator: "+", omittingEmptySubsequences: false).map(String.init) {
            switch part {
            case "CmdOrCtrl": command = true
            case "Shift": shift = true
            case "Alt": option = true
            case "Up": key = .up
            case "Down": key = .down
            case "Left": key = .left
            case "Right": key = .right
            case "Plus": key = .character("+")
            case "": key = .character("+")  // "CmdOrCtrl++" splits to an empty last part
            default:
                guard part.count == 1, let character = part.first else { return nil }
                key = .character(character)
            }
        }
        guard let key else { return nil }
        (self.key, self.command, self.shift, self.option) = (key, command, shift, option)
    }
}

/// Moving through a list with the keyboard: the next and the previous entry, wrapping at the ends, as the Mac does.
public enum ShortcutCycle {
    /// The id after (`step` 1) or before (`step` -1) `current` in `ids`; the first or last when `current` is not in the list; nil for an empty list
    /// or when the list is only `current` (nothing to move to).
    public static func neighbour(of current: String?, in ids: [String], step: Int) -> String? {
        guard !ids.isEmpty, step == 1 || step == -1 else { return nil }
        guard let current, let index = ids.firstIndex(of: current) else { return step == 1 ? ids.first : ids.last }
        let next = ids[(index + step + ids.count) % ids.count]
        return next == current ? nil : next
    }
}

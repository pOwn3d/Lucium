import LuciumKit
import SwiftUI

/// The menu of the hardware keyboard: what an iPad shows when ⌘ is held (the discoverability sheet) and the bar of the menus in a window. The shortcuts
/// are the Mac's (`ShortcutCommand`); each one is a button, so VoiceOver and Voice Control can reach the action without the keys.
struct KeyboardCommands: Commands {
    let model: BrowserModel

    var body: some Commands {
        CommandMenu("shortcut.menu.tabs") {
            item(.newTab, "tabs.new")
            item(.closeTab, "shortcut.close-tab")
            item(.restoreClosed, "shortcut.restore-tab")
            item(.pin, "shortcut.pin")
            item(.tabSearch, "shortcut.show-tabs")
            item(.openLocation, "shortcut.open-location")
            Divider()
            item(.nextTab, "shortcut.next-tab")
            item(.previousTab, "shortcut.previous-tab")
        }
        CommandMenu("shortcut.menu.spaces") {
            item(.nextSpace, "shortcut.next-space")
            item(.previousSpace, "shortcut.previous-space")
        }
        CommandMenu("shortcut.menu.page") {
            item(.back, "bar.back")
            item(.forward, "bar.forward")
            item(.reload, "shortcut.reload")
            item(.find, "page.find")
            Divider()
            item(.zoomIn, "page.zoom.in")
            item(.zoomOut, "page.zoom.out")
            item(.zoomReset, "shortcut.zoom-reset")
        }
        CommandGroup(after: .sidebar) { item(.toggleSidebar, "shortcut.toggle-sidebar") }
        CommandGroup(replacing: .appSettings) { item(.settings, "settings.title") }
    }

    private func item(_ command: ShortcutCommand, _ title: LocalizedStringKey) -> some View {
        let button = Button(title) { model.perform(command) }.disabled(!model.canPerform(command))
        return Group {
            if let binding = command.binding, let key = binding.key.equivalent {
                button.keyboardShortcut(key, modifiers: binding.modifiers)
            } else {
                button
            }
        }
    }
}

extension ShortcutBinding.Key {
    var equivalent: KeyEquivalent? {
        switch self {
        case .character(let character): KeyEquivalent(character)
        case .up: .upArrow
        case .down: .downArrow
        case .left: .leftArrow
        case .right: .rightArrow
        }
    }
}

extension ShortcutBinding {
    var modifiers: EventModifiers {
        var result: EventModifiers = []
        if command { result.insert(.command) }
        if shift { result.insert(.shift) }
        if option { result.insert(.option) }
        return result
    }
}

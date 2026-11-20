import Foundation
import Testing
@testable import LuciumKit

/// The accelerators the iPad listens to, shared with the Mac (`ios/Contracts/shortcut-vectors.json`, also run by `src/shared/ios-contract.test.ts`).
struct ShortcutVectors: Decodable {
    struct Entry: Decodable { let id: String; let accelerator: String }
    let shortcuts: [Entry]

    static func load() throws -> ShortcutVectors {
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/shortcut-vectors.json")
        return try JSONDecoder().decode(ShortcutVectors.self, from: Data(contentsOf: url))
    }
}

@Suite("Keyboard shortcuts of the iPad")
struct KeyboardShortcutsTests {
    @Test func everyCommandHasTheMacsAccelerator() throws {
        let vectors = try ShortcutVectors.load()
        #expect(Set(vectors.shortcuts.map(\.id)) == Set(ShortcutCommand.allCases.map(\.rawValue)))
        for entry in vectors.shortcuts {
            #expect(ShortcutCommand(rawValue: entry.id)?.accelerator == entry.accelerator, "\(entry.id)")
        }
    }

    @Test func everyAcceleratorIsUnderstoodAndNoTwoCommandsShareOne() {
        var seen: [String: ShortcutCommand] = [:]
        for command in ShortcutCommand.allCases {
            #expect(command.binding != nil, "\(command)")
            #expect(command.binding?.command == true, "\(command) needs ⌘ (a bare key would be typed into a page)")
            let key = String(describing: command.binding)
            #expect(seen[key] == nil, "\(command) and \(String(describing: seen[key])) share a key")
            seen[key] = command
        }
    }

    @Test func parsesKeysAndModifiers() {
        #expect(ShortcutCommand.restoreClosed.binding == ShortcutBinding(accelerator: "CmdOrCtrl+Shift+T"))
        #expect(ShortcutCommand.restoreClosed.binding?.shift == true)
        #expect(ShortcutCommand.nextTab.binding?.key == .down)
        #expect(ShortcutCommand.nextTab.binding?.option == true)
        #expect(ShortcutCommand.previousSpace.binding?.key == .left)
        #expect(ShortcutCommand.zoomIn.binding?.key == .character("+"))
        #expect(ShortcutCommand.zoomOut.binding?.key == .character("-"))
        #expect(ShortcutBinding(accelerator: "CmdOrCtrl+Nope") == nil)
    }

    @Test func cyclingWrapsAndHasNothingToMoveToAlone() {
        let ids = ["a", "b", "c"]
        #expect(ShortcutCycle.neighbour(of: "a", in: ids, step: 1) == "b")
        #expect(ShortcutCycle.neighbour(of: "c", in: ids, step: 1) == "a")
        #expect(ShortcutCycle.neighbour(of: "a", in: ids, step: -1) == "c")
        #expect(ShortcutCycle.neighbour(of: nil, in: ids, step: 1) == "a")
        #expect(ShortcutCycle.neighbour(of: "zz", in: ids, step: -1) == "c")
        #expect(ShortcutCycle.neighbour(of: "a", in: ["a"], step: 1) == nil)
        #expect(ShortcutCycle.neighbour(of: "a", in: [], step: 1) == nil)
    }
}

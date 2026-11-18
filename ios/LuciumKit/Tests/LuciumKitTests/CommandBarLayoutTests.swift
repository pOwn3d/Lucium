import Foundation
import Testing
@testable import LuciumKit

@Suite("Command bar: the order of the list")
struct CommandBarLayoutTests {
    private let search = ResolvedInput.search("https://www.google.com/search?q=youtube")
    private let address = ResolvedInput.url("https://youtube.com")

    @Test func theLineTheGoKeyRunsLeadsEvenWhenTabsCommandsAndFavouritesAnswer() {
        for enter in [search, address] {
            let sections = CommandBarLayout.sections(enter: enter, hasTabs: true, hasCommands: true, hasFavorites: true)
            #expect(sections == [.enter(enter), .tabs, .commands, .favorites])
        }
    }

    @Test func aBlockThatHasNothingToShowIsLeftOut() {
        #expect(CommandBarLayout.sections(enter: address, hasTabs: false, hasCommands: false, hasFavorites: false) == [.enter(address)])
        #expect(CommandBarLayout.sections(enter: search, hasTabs: false, hasCommands: true, hasFavorites: true) == [.enter(search), .commands, .favorites])
    }

    @Test func withNoLineForTheGoKeyTheOthersKeepTheirOrder() {
        #expect(CommandBarLayout.sections(enter: nil, hasTabs: true, hasCommands: true, hasFavorites: true) == [.tabs, .commands, .favorites])
        #expect(CommandBarLayout.sections(enter: nil, hasTabs: false, hasCommands: false, hasFavorites: false).isEmpty)
    }

    @Test func theTabsOfTheMacComeAfterTheTabsOfThePhone() {
        #expect(CommandBarLayout.sections(enter: address, hasTabs: true, hasCommands: true, hasFavorites: true, hasMac: true) == [.enter(address), .tabs, .mac, .commands, .favorites])
        #expect(CommandBarLayout.sections(enter: nil, hasTabs: false, hasCommands: false, hasFavorites: false, hasMac: true) == [.mac])
        #expect(CommandBarLayout.sections(enter: nil, hasTabs: true, hasCommands: false, hasFavorites: false) == [.tabs], "a bar with no source of the Mac lists none")
    }
}

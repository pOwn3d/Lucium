import Foundation
import Testing
@testable import LuciumKit

@Suite("Settings screen: sections")
struct SettingsLayoutTests {
    @Test func theSectionsAreListedInTheOrderOfTheDecision() {
        let groups = SettingsLayout.groups(lockAvailable: true)
        #expect(groups.map(\.section) == [.navigation, .privacy, .spaces, .about, .reset])
        #expect(groups.flatMap(\.rows) == [.searchEngine, .tabs, .appearance, .history, .privacy, .passwords, .lock, .spaces, .about, .licenses, .reset])
    }

    @Test func aCopyWithNoLockHasNoLockRowAndKeepsItsPrivacySection() {
        let groups = SettingsLayout.groups(lockAvailable: false)
        #expect(!groups.flatMap(\.rows).contains(.lock))
        #expect(groups.first { $0.section == .privacy }?.rows == [.privacy, .passwords])
    }

    @Test func theSynchronisationIsNotShownUntilThePhaseTwoGivesItAPage() {
        #expect(!SettingsLayout.groups(lockAvailable: true).contains { $0.section == .sync || $0.rows.contains(.sync) })
        #expect(!SettingsLayout.groups(lockAvailable: false).contains { $0.section == .sync })
    }

    @Test func theSynchronisationHasItsPlaceBetweenTheSpacesAndTheLicences() {
        let groups = SettingsLayout.groups(lockAvailable: true, syncAvailable: true)
        #expect(groups.map(\.section) == [.navigation, .privacy, .spaces, .sync, .about, .reset])
        #expect(groups.first { $0.section == .sync }?.rows == [.sync])
    }

    @Test func everyRowIsInOneSectionOnlyAndNoGroupIsEmpty() {
        let all = SettingsLayout.groups(lockAvailable: true, syncAvailable: true)
        #expect(all.flatMap(\.rows).sorted { $0.rawValue < $1.rawValue } == SettingsRow.allCases.sorted { $0.rawValue < $1.rawValue })
        #expect(Set(all.flatMap(\.rows)).count == all.flatMap(\.rows).count)
        for lock in [true, false] { #expect(SettingsLayout.groups(lockAvailable: lock).allSatisfy { !$0.rows.isEmpty }) }
    }
}

// MARK: - The search engine of a profile

private let duck = "https://duckduckgo.com/?q=%s"
private let google = "https://www.google.com/search?q=%s"
private let brave = "https://search.brave.com/search?q=%s"
private let qwant = "https://www.qwant.com/?q=%s"
private let custom = "https://search.example.org/find?q=%s"

/// Three spaces, three profiles: the default one, "work" and "home".
private func state(settings: [String: JSONValue]? = nil) -> BrowserState {
    var state = BrowserState(spaces: [Space(id: "s-default", name: "Perso", emoji: "🏠", profileId: "default"),
                                      Space(id: "s-work", name: "Travail", emoji: "💼", profileId: "work"),
                                      Space(id: "s-home", name: "Maison", emoji: "🧺", profileId: "home")], activeSpaceId: "s-work")
    if let settings { state.rest["settings"] = .object(settings) }
    return state
}

private func settings(of state: BrowserState) -> [String: JSONValue] {
    guard case .object(let settings)? = state.rest["settings"] else { return [:] }
    return settings
}

private func ownKeys(of state: BrowserState, profile: String) -> [String: JSONValue]? {
    guard case .object(let profiles)? = settings(of: state)["profiles"], case .object(let own)? = profiles[profile] else { return nil }
    return own
}

@Suite("Settings screen: the search engine of a profile")
struct SearchEngineChoiceTests {
    @Test func aProfileWithNoEngineOfItsOwnInheritsAndTheDefaultProfileAlwaysHasOne() {
        let before = state()
        #expect(before.searchChoice(forProfile: "work") == .inherited)
        #expect(before.searchChoice(forProfile: "default") == .engine(duck), "no settings at all: DuckDuckGo, as the Mac")
        let withGeneral = state(settings: ["searchUrlTemplate": .string(qwant)])
        #expect(withGeneral.searchChoice(forProfile: "default") == .engine(qwant))
        #expect(withGeneral.searchChoice(forProfile: "work") == .inherited)
        #expect(withGeneral.searchTemplate(forProfile: "work") == qwant, "what a profile that inherits searches with is the general engine")
    }

    @Test func aProfileThatChoseItsOwnEngineShowsItAndSearchesWithIt() {
        var chosen = state(settings: ["searchUrlTemplate": .string(duck)])
        let changed1 = chosen.chooseSearchEngine(.engine(brave), forProfile: "work")
        #expect(changed1)
        #expect(chosen.searchChoice(forProfile: "work") == .engine(brave))
        #expect(chosen.searchTemplate(forSpace: "s-work") == brave)
        #expect(chosen.searchTemplate(forSpace: "s-home") == duck, "another profile is not touched")
    }

    @Test func theChoiceIsWrittenWhereTheMacReadsIt() {
        var chosen = state(settings: ["searchUrlTemplate": .string(duck), "profiles": .object([:])])
        chosen.chooseSearchEngine(.engine(google), forProfile: "default")
        chosen.chooseSearchEngine(.engine(brave), forProfile: "work")
        #expect(settings(of: chosen)["searchUrlTemplate"] == .string(google), "the default profile's engine is the general one")
        #expect(ownKeys(of: chosen, profile: "work")?["searchUrlTemplate"] == .string(brave))
        #expect(ownKeys(of: chosen, profile: "default") == nil, "the default profile has no entry of its own")
    }

    @Test func goingBackToTheDefaultProfilesEngineRemovesTheOverrideAndTheEmptyEntry() {
        var chosen = state(settings: ["searchUrlTemplate": .string(duck), "profiles": .object(["work": .object(["searchUrlTemplate": .string(brave)])])])
        let changed2 = chosen.chooseSearchEngine(.inherited, forProfile: "work")
        #expect(changed2)
        #expect(chosen.searchChoice(forProfile: "work") == .inherited)
        #expect(settings(of: chosen)["profiles"] == .object([:]), "no empty entry is left behind, as the Mac does")
    }

    @Test func theOtherKeysOfAProfileEntryAreKeptWhateverIsChosen() {
        let entry: [String: JSONValue] = ["downloadDir": .string("/Users/me/Work"), "disabledExtensions": .array([.string("abc")]), "searchUrlTemplate": .string(brave)]
        var chosen = state(settings: ["profiles": .object(["work": .object(entry)])])
        chosen.chooseSearchEngine(.engine(qwant), forProfile: "work")
        #expect(ownKeys(of: chosen, profile: "work")?["downloadDir"] == entry["downloadDir"])
        #expect(ownKeys(of: chosen, profile: "work")?["disabledExtensions"] == entry["disabledExtensions"])
        #expect(ownKeys(of: chosen, profile: "work")?["searchUrlTemplate"] == .string(qwant))
        chosen.chooseSearchEngine(.inherited, forProfile: "work")
        #expect(ownKeys(of: chosen, profile: "work") == ["downloadDir": entry["downloadDir"]!, "disabledExtensions": entry["disabledExtensions"]!])
    }

    @Test func nothingElseOfTheStateOrOfItsSettingsMoves() {
        var before = state(settings: ["blockAds": .bool(true), "future": .object(["x": .number(1)]), "profileNames": .object(["work": .string("Bureau")])])
        before.rest["somethingNewer"] = .array([.string("kept")])
        var after = before
        after.chooseSearchEngine(.engine(brave), forProfile: "work")
        after.chooseSearchEngine(.engine(google), forProfile: "default")
        for (key, value) in settings(of: before) { #expect(settings(of: after)[key] == value, "\(key) is not ours to change") }
        #expect(after.rest["somethingNewer"] == before.rest["somethingNewer"])
        #expect(after.spaces == before.spaces && after.tabs == before.tabs)
    }

    @Test func aStateWithNoSettingsStaysANewProfileForThePrivacyRules() {
        // A `settings` that only held an engine would read as an earlier profile: HTTPS first alone, no signal, no tracking parameters removed.
        var chosen = state()
        #expect(chosen.privacy == .newProfile)
        chosen.chooseSearchEngine(.engine(brave), forProfile: "work")
        #expect(chosen.privacy == .newProfile, "choosing an engine must not weaken the protection")
        var general = state()
        general.chooseSearchEngine(.engine(google), forProfile: "default")
        #expect(general.privacy == .newProfile)
        #expect(settings(of: general)["protectionBaseline"] == .string("renforcee"))
    }

    @Test func aStateWhoseSettingsWereAnEarlierProfileKeepsItsLevel() {
        var chosen = state(settings: ["httpsUpgrade": .bool(true)])
        chosen.chooseSearchEngine(.engine(brave), forProfile: "work")
        #expect(chosen.privacy == .earlierProfile)
    }

    @Test func onlyTheEnginesOfTheMacsListCanBeChosen() {
        var before = state()
        for bad in [custom, "javascript:alert('%s')", "https://example.org/?q=", "file:///etc/%s", "", "http://duckduckgo.com/?q=%s"] {
            let changed3 = before.chooseSearchEngine(.engine(bad), forProfile: "work")
            #expect(!changed3, "\(bad)")
            let changed4 = before.chooseSearchEngine(.engine(bad), forProfile: "default")
            #expect(!changed4, "\(bad)")
        }
        #expect(before == state(), "a refused choice leaves the state as it was, settings included")
    }

    @Test func aChoiceThatChangesNothingIsNotAChange() {
        var chosen = state(settings: ["searchUrlTemplate": .string(duck), "profiles": .object(["work": .object(["searchUrlTemplate": .string(brave)])])])
        let before = chosen
        let changed5 = chosen.chooseSearchEngine(.engine(brave), forProfile: "work")
        #expect(!changed5)
        let changed6 = chosen.chooseSearchEngine(.engine(duck), forProfile: "default")
        #expect(!changed6)
        let changed7 = chosen.chooseSearchEngine(.inherited, forProfile: "default")
        #expect(!changed7, "the default profile has nothing to inherit")
        let changed8 = chosen.chooseSearchEngine(.inherited, forProfile: "home")
        #expect(!changed8, "home already inherits")
        #expect(chosen == before)
    }

    @Test func aProfileThatDoesNotExistIsRefused() {
        var chosen = state()
        for id in ["ghost", "", "__proto__", "a b", String(repeating: "x", count: 33)] {
            let changed9 = chosen.chooseSearchEngine(.engine(brave), forProfile: id)
            #expect(!changed9, "\(id)")
        }
        #expect(chosen == state())
    }

    @Test func anEngineOfOnesOwnTheMacWroteIsShownAsItIsAndReplacedByAListedOne() {
        var chosen = state(settings: ["searchUrlTemplate": .string(custom)])
        #expect(chosen.searchChoice(forProfile: "default") == .engine(custom), "it is not hidden: the screen names it")
        #expect(chosen.searchChoice(forProfile: "work") == .inherited)
        let changed10 = chosen.chooseSearchEngine(.engine(duck), forProfile: "default")
        #expect(changed10)
        #expect(settings(of: chosen)["searchUrlTemplate"] == .string(duck))
    }

    @Test func anOverrideLeftOnTheDefaultProfileDoesNotHideTheChoice() {
        // The Mac reads a profile's own engine before the general one, the default profile included: a leftover would win over the choice.
        var chosen = state(settings: ["searchUrlTemplate": .string(duck), "profiles": .object(["default": .object(["searchUrlTemplate": .string(qwant)])])])
        #expect(chosen.searchChoice(forProfile: "default") == .engine(qwant))
        let changed11 = chosen.chooseSearchEngine(.engine(google), forProfile: "default")
        #expect(changed11)
        #expect(chosen.searchChoice(forProfile: "default") == .engine(google))
        #expect(chosen.searchTemplate(forSpace: "s-default") == google)
        #expect(ownKeys(of: chosen, profile: "default") == nil)
    }

    @Test func anOverrideThatNoSearchCanUseReadsAsNoOverride() {
        let broken = state(settings: ["searchUrlTemplate": .string(qwant), "profiles": .object(["work": .object(["searchUrlTemplate": .string("javascript:%s")])])])
        #expect(broken.searchChoice(forProfile: "work") == .inherited)
        #expect(broken.searchTemplate(forProfile: "work") == qwant)
    }

    @Test func everyEngineOfTheListCanBeChosenAndIsTheOneTheMacOffers() {
        #expect(SearchEngine.presets.count == 6)
        for preset in SearchEngine.presets {
            var chosen = state()
            #expect(SearchEngine.isPreset(preset.url))
            let changed12 = chosen.chooseSearchEngine(.engine(preset.url), forProfile: "work")
            #expect(changed12, "a profile that inherits changes by choosing any engine, the general one included")
            #expect(chosen.searchChoice(forProfile: "work") == .engine(preset.url))
            #expect(SearchEngine.name(forTemplate: preset.url) == preset.name)
        }
        #expect(!SearchEngine.isPreset(custom))
    }
}

// MARK: - The vectors shared with the Mac

/// `ios/Contracts/search-vectors.json`, also played against the Mac's own `profileEditor`, `profileSearch` and `cleanProfileOverrides` by
/// `src/renderer/ios-search-contract.test.ts`: the list of engines, and what a choice writes.
struct SearchVectors: Decodable {
    struct Engine: Decodable { let name: String; let url: String }
    struct Case: Decodable {
        struct After: Decodable { let searchUrlTemplate: String; let profiles: JSONValue }
        let name: String
        let before: JSONValue?
        let profile: String
        let choice: String
        let after: After
        let effective: String
    }

    let engines: [Engine]
    let choose: [Case]

    static func load() throws -> SearchVectors {
        // …/ios/LuciumKit/Tests/LuciumKitTests/SettingsTests.swift → …/ios/Contracts/search-vectors.json
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/search-vectors.json")
        return try JSONDecoder().decode(SearchVectors.self, from: Data(contentsOf: url))
    }
}

@Suite("Search engine vectors shared with the Mac")
struct SearchContractTests {
    @Test func vectorsAreNotEmpty() throws {
        let vectors = try SearchVectors.load()
        #expect(vectors.engines.count == 6)
        #expect(vectors.choose.count >= 8)
    }

    @Test func theEnginesAreTheMacsList() throws {
        let vectors = try SearchVectors.load()
        #expect(SearchEngine.presets.map(\.name) == vectors.engines.map(\.name))
        #expect(SearchEngine.presets.map(\.url) == vectors.engines.map(\.url))
    }

    @Test func eachChoiceWritesWhatTheMacWrites() throws {
        for vector in try SearchVectors.load().choose {
            var chosen = state()
            if case .object(let before)? = vector.before { chosen.rest["settings"] = .object(before) }
            let choice: SearchChoice = vector.choice == "inherited" ? .inherited : .engine(vector.choice)
            let changed13 = chosen.chooseSearchEngine(choice, forProfile: vector.profile)
            #expect(changed13, "\(vector.name): changed")
            let written = settings(of: chosen)
            // The Mac's settings always carry both keys; here they are filled the way a reader of the file fills them.
            #expect((written["searchUrlTemplate"] ?? .string(AddressResolver.defaultSearchTemplate)) == .string(vector.after.searchUrlTemplate), "\(vector.name): general engine")
            #expect((written["profiles"] ?? .object([:])) == vector.after.profiles, "\(vector.name): profiles")
            #expect(chosen.searchTemplate(forProfile: vector.profile) == vector.effective, "\(vector.name): effective engine")
        }
    }
}

// MARK: - Rétablir les réglages, and the "modified" mark

@Suite("Settings screen: reset and modified mark")
struct SettingsDefaultsTests {
    @Test func aStateNeverTouchedHasNothingModifiedAndTheResetWritesNothing() {
        var fresh = state()
        #expect(SettingsDefaults.changedRows(in: fresh, profileId: "work").isEmpty)
        #expect(SettingsDefaults.changedRows(in: fresh, profileId: "default").isEmpty)
        let before = fresh
        #expect(!SettingsDefaults.reset(&fresh, profileId: "work"))
        #expect(fresh == before)
    }

    @Test func theMarkNamesTheRowsThatMovedAndNoOther() {
        var moved = state()
        moved.chooseSearchEngine(.engine(brave), forProfile: "work")
        #expect(SettingsDefaults.changedRows(in: moved, profileId: "work") == [.searchEngine])
        #expect(SettingsDefaults.changedRows(in: moved, profileId: "home").isEmpty, "another profile's engine is not this list's")
        moved.privacy.choose(.standard)
        #expect(SettingsDefaults.changedRows(in: moved, profileId: "work") == [.searchEngine, .privacy])
    }

    @Test func theResetPutsTheEngineAndThePrivacyBackAndNothingElse() {
        var moved = state(settings: ["blockAds": .bool(true), "profileNames": .object(["work": .string("Bureau")]),
                                     "profiles": .object(["work": .object(["downloadDir": .string("/Users/me/Work"), "searchUrlTemplate": .string(brave)])])])
        moved.privacy = PrivacySettings(httpsUpgrade: false, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false)
        let spaces = moved.spaces
        #expect(SettingsDefaults.reset(&moved, profileId: "work"))
        #expect(moved.searchChoice(forProfile: "work") == .inherited)
        #expect(ownKeys(of: moved, profile: "work") == ["downloadDir": .string("/Users/me/Work")], "the profile's other keys stay")
        #expect(moved.privacy == .newProfile)
        #expect(settings(of: moved)["blockAds"] == .bool(true))
        #expect(settings(of: moved)["profileNames"] == .object(["work": .string("Bureau")]))
        #expect(moved.spaces == spaces)
        #expect(SettingsDefaults.changedRows(in: moved, profileId: "work").isEmpty)
        #expect(!SettingsDefaults.reset(&moved, profileId: "work"), "a second reset changes nothing")
    }

    @Test func theDefaultProfilesOriginalEngineIsDuckDuckGo() {
        var moved = state()
        moved.chooseSearchEngine(.engine(google), forProfile: "default")
        #expect(SettingsDefaults.changedRows(in: moved, profileId: "default") == [.searchEngine])
        #expect(SettingsDefaults.reset(&moved, profileId: "default"))
        #expect(moved.searchTemplate(forProfile: "default") == duck)
    }

    @Test func theTabSettingsAreMarkedAndPutBackByTheReset() {
        var moved = state()
        let changedArchive = moved.chooseArchiveDelay(.hours(0), forProfile: "work")
        #expect(changedArchive)
        #expect(SettingsDefaults.changedRows(in: moved, profileId: "work") == [.tabs])
        #expect(SettingsDefaults.changedRows(in: moved, profileId: "home").isEmpty, "another profile's delay is not this list's")
        let changedLimit = moved.chooseAwakeTabLimit(8)
        #expect(changedLimit)
        #expect(SettingsDefaults.changedRows(in: moved, profileId: "home") == [.tabs], "the limit belongs to the device, whatever the profile")
        let didReset = SettingsDefaults.reset(&moved, profileId: "work")
        #expect(didReset)
        #expect(moved.archiveChoice(forProfile: "work") == .inherited)
        #expect(moved.awakeTabLimit == SleepPlanner.defaultCap)
        #expect(SettingsDefaults.changedRows(in: moved, profileId: "work").isEmpty)
        #expect(moved.archiveChoice(forProfile: "default") == .hours(12), "the reset of a profile does not touch the default one")
    }

    @Test func theDefaultProfilesArchiveDelayGoesBackToTwelveHours() {
        var moved = state()
        moved.chooseArchiveDelay(.hours(168), forProfile: "default")
        #expect(SettingsDefaults.changedRows(in: moved, profileId: "default") == [.tabs])
        let didReset = SettingsDefaults.reset(&moved, profileId: "default")
        #expect(didReset)
        #expect(moved.archiveChoice(forProfile: "default") == .hours(12))
    }

    @Test func aResetOnAnUnknownProfileStillRestoresThePrivacy() {
        var moved = state()
        moved.privacy.choose(.standard)
        #expect(SettingsDefaults.reset(&moved, profileId: "nobody"))
        #expect(moved.privacy == .newProfile)
    }
}

@Suite("Settings screen: about links")
struct AboutLinksTests {
    @Test func theLinksAreTheProjectsSiteInTheLanguageOfTheInterface() {
        #expect(AboutLinks.site(languageCode: "fr").absoluteString == "https://lucium.app/")
        #expect(AboutLinks.site(languageCode: "en").absoluteString == "https://lucium.app/en/")
        #expect(AboutLinks.help(languageCode: "fr").absoluteString == "https://lucium.app/communaute/")
        #expect(AboutLinks.help(languageCode: "en").absoluteString == "https://lucium.app/en/community/")
        #expect(AboutLinks.help(languageCode: nil).absoluteString == "https://lucium.app/en/community/", "any other language reads the English site")
    }
}

// MARK: - Tabs: archive delay and awake tabs

@Suite("Settings screen: the archive delay of a profile")
struct ArchiveDelayChoiceTests {
    @Test func theDefaultProfileShowsTwelveHoursWhenTheStateSaysNothingAndAnotherInherits() {
        let before = state()
        #expect(before.archiveChoice(forProfile: "default") == .hours(12), "the Mac's default")
        #expect(before.archiveChoice(forProfile: "work") == .inherited)
        #expect(state(settings: ["autoArchiveHours": .number(168)]).archiveChoice(forProfile: "work") == .inherited)
        #expect(state(settings: ["autoArchiveHours": .number(168)]).archiveChoice(forProfile: "default") == .hours(168))
    }

    @Test func theChoiceIsWhatTheSweepUses() {
        var chosen = state(settings: ["autoArchiveHours": .number(12)])
        let r1 = chosen.chooseArchiveDelay(.hours(168), forProfile: "work")
        #expect(r1)
        #expect(chosen.autoArchiveHours(forSpace: "s-work") == 168)
        #expect(chosen.autoArchiveHours(forSpace: "s-home") == 12, "another profile is not touched")
        let r2 = chosen.chooseArchiveDelay(.hours(0), forProfile: "default")
        #expect(r2)
        #expect(chosen.autoArchiveHours(forSpace: "s-default") == 0, "never")
        #expect(chosen.autoArchiveHours(forSpace: "s-home") == 0, "a profile that inherits follows the general delay")
    }

    @Test func theChoiceIsWrittenWhereTheMacReadsIt() {
        var chosen = state(settings: ["autoArchiveHours": .number(12), "profiles": .object([:])])
        chosen.chooseArchiveDelay(.hours(24), forProfile: "default")
        chosen.chooseArchiveDelay(.hours(0), forProfile: "work")
        #expect(settings(of: chosen)["autoArchiveHours"] == .number(24), "the default profile's delay is the general one")
        #expect(ownKeys(of: chosen, profile: "work")?["autoArchiveHours"] == .number(0))
        #expect(ownKeys(of: chosen, profile: "default") == nil)
    }

    @Test func goingBackToTheDefaultProfilesDelayRemovesTheOverrideAndKeepsTheOtherKeys() {
        let entry: [String: JSONValue] = ["downloadDir": .string("/Users/me/Work"), "autoArchiveHours": .number(168)]
        var chosen = state(settings: ["autoArchiveHours": .number(12), "profiles": .object(["work": .object(entry), "home": .object(["autoArchiveHours": .number(24)])])])
        let r3 = chosen.chooseArchiveDelay(.inherited, forProfile: "work")
        #expect(r3)
        #expect(ownKeys(of: chosen, profile: "work") == ["downloadDir": entry["downloadDir"]!])
        let r4 = chosen.chooseArchiveDelay(.inherited, forProfile: "home")
        #expect(r4)
        #expect(ownKeys(of: chosen, profile: "home") == nil, "no empty entry is left behind, as the Mac does")
    }

    @Test func anOverrideLeftOnTheDefaultProfileDoesNotHideItsChoice() {
        var chosen = state(settings: ["autoArchiveHours": .number(12), "profiles": .object(["default": .object(["autoArchiveHours": .number(168)])])])
        #expect(chosen.archiveChoice(forProfile: "default") == .hours(168))
        let r5 = chosen.chooseArchiveDelay(.hours(24), forProfile: "default")
        #expect(r5)
        #expect(chosen.archiveChoice(forProfile: "default") == .hours(24))
        #expect(chosen.autoArchiveHours(forSpace: "s-default") == 24)
    }

    @Test func aDelayThatIsNotOfferedAnUnknownProfileAndANoOpChangeNothing() {
        var chosen = state(settings: ["autoArchiveHours": .number(12)])
        let before = chosen
        let r6 = chosen.chooseArchiveDelay(.hours(5), forProfile: "work")
        #expect(!r6)
        let r7 = chosen.chooseArchiveDelay(.hours(24), forProfile: "ghost")
        #expect(!r7)
        let r8 = chosen.chooseArchiveDelay(.inherited, forProfile: "default")
        #expect(!r8)
        let r9 = chosen.chooseArchiveDelay(.hours(12), forProfile: "default")
        #expect(!r9)
        #expect(chosen == before)
    }

    @Test func aDelayTheMacWroteThatIsNotOfferedIsShownAndKeptUntilAnotherIsChosen() {
        var chosen = state(settings: ["autoArchiveHours": .number(48)])
        #expect(chosen.archiveChoice(forProfile: "default") == .hours(48))
        let r10 = chosen.chooseArchiveDelay(.hours(168), forProfile: "default")
        #expect(r10)
        #expect(chosen.archiveChoice(forProfile: "default") == .hours(168))
    }

    @Test func nothingElseOfTheStateMovesAndAStateWithNoSettingsStaysANewProfile() {
        var before = state()
        before.rest["somethingNewer"] = .array([.string("kept")])
        var after = before
        after.chooseArchiveDelay(.hours(0), forProfile: "work")
        #expect(after.privacy == .newProfile, "choosing a delay must not weaken the protection")
        #expect(after.rest["somethingNewer"] == before.rest["somethingNewer"])
        #expect(after.spaces == before.spaces && after.tabs == before.tabs)
        var known = state(settings: ["blockAds": .bool(true), "future": .object(["x": .number(1)])])
        let beforeKnown = known
        known.chooseArchiveDelay(.hours(24), forProfile: "default")
        for key in ["blockAds", "future"] { #expect(settings(of: known)[key] == settings(of: beforeKnown)[key]) }
    }
}

@Suite("Settings screen: tabs kept awake")
struct AwakeTabLimitTests {
    @Test func theStateSaysNothingUntilALimitIsChosen() {
        #expect(state().awakeTabLimit == nil)
        #expect(state(settings: ["sleepAwakeMax": .number(12)]).awakeTabLimit == 12, "a number the Mac wrote")
        #expect(state(settings: ["sleepAwakeMax": .number(0)]).awakeTabLimit == 0, "no limit")
        for bad in [JSONValue.number(-1), .number(2.5), .number(501), .string("4"), .bool(true)] {
            #expect(state(settings: ["sleepAwakeMax": bad]).awakeTabLimit == nil, "\(bad) is not a limit")
        }
    }

    @Test func theChoiceIsWrittenAsTheMacWritesItAndTouchesNothingElse() {
        var chosen = state(settings: ["blockAds": .bool(true)])
        let r11 = chosen.chooseAwakeTabLimit(8)
        #expect(r11)
        #expect(settings(of: chosen)["sleepAwakeMax"] == .number(8))
        #expect(settings(of: chosen)["blockAds"] == .bool(true))
        #expect(chosen.awakeTabLimit == 8)
        let r12 = chosen.chooseAwakeTabLimit(0)
        #expect(r12)
        #expect(chosen.awakeTabLimit == 0)
    }

    @Test func aLimitThatIsNotOfferedOrAlreadyInForceChangesNothing() {
        var chosen = state(settings: ["sleepAwakeMax": .number(8)])
        let before = chosen
        let r13 = chosen.chooseAwakeTabLimit(5)
        #expect(!r13)
        let r14 = chosen.chooseAwakeTabLimit(8)
        #expect(!r14)
        var fresh = state()
        let sameAsDefault = fresh.chooseAwakeTabLimit(SleepPlanner.defaultCap)
        #expect(!sameAsDefault, "the application's own default is already in force")
        #expect(chosen == before)
    }

    @Test func aStateWithNoSettingsStaysANewProfile() {
        var chosen = state()
        chosen.chooseAwakeTabLimit(2)
        #expect(chosen.privacy == .newProfile)
    }
}

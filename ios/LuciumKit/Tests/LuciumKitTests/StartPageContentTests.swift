import Testing
@testable import LuciumKit

@Suite("What the start page shows")
struct StartPageContentTests {
    /// Three spaces: two of the profile "work" (they share its favourites), one of the profile "home". Favourites are written in the order a
    /// person added them, the two profiles interleaved.
    private func state(favorites: [Favorite]) -> BrowserState {
        var state = BrowserState(revision: 2,
                                 spaces: [Space(id: "s1", name: "Work", emoji: "💼", profileId: "work"),
                                          Space(id: "s2", name: "Work too", emoji: "🧩", profileId: "work"),
                                          Space(id: "s3", name: "Home", emoji: "🏠", profileId: "home")],
                                 activeSpaceId: "s1", activeTabBySpace: ["s1": nil, "s2": nil, "s3": nil])
        state.favorites = favorites
        return state
    }

    private func favorite(_ id: String, profile: String) -> Favorite {
        Favorite(id: id, url: "https://\(id).example/", title: id, profileId: profile)
    }

    private func content(_ state: BrowserState, space: String = "s1", covered: Bool = false, isPrivate: Bool = false) -> StartPageContent {
        StartPageContent.make(in: state, space: space, covered: covered, isPrivate: isPrivate)
    }

    @Test func theFavouritesOfTheProfileAreListedInTheOrderOfTheStateAndThoseOfAnotherProfileAreNot() {
        let work1 = favorite("agenda", profile: "work"), home = favorite("recettes", profile: "home"), work2 = favorite("notes", profile: "work")
        let state = state(favorites: [work1, home, work2])
        #expect(content(state, space: "s1") == .favorites([work1, work2]), "the profile of the space, in the order they were added")
        #expect(content(state, space: "s2") == .favorites([work1, work2]), "two spaces of one profile list the same favourites")
        #expect(content(state, space: "s3") == .favorites([home]), "the other profile has its own")
    }

    @Test func aProfileWithNoFavouriteGetsTheSentenceThatSaysHowToAddOneEvenWhenAnotherProfileHasSome() {
        let state = state(favorites: [favorite("agenda", profile: "work")])
        #expect(content(state, space: "s3") == .noFavorites)
        #expect(content(self.state(favorites: []), space: "s1") == .noFavorites)
        #expect(content(state, space: "nowhere") == .noFavorites, "a space that does not exist lists nothing")
    }

    @Test func aLockedSpaceShowsNothingOfItsProfile() {
        let state = state(favorites: [favorite("agenda", profile: "work")])
        #expect(content(state, covered: true) == .hidden, "the lock hides the favourites, and does not say there are none")
        #expect(content(self.state(favorites: []), covered: true) == .hidden)
        #expect(content(state, covered: true, isPrivate: true) == .hidden, "the lock comes before everything")
    }

    @Test func aPrivateTabIsNotOfferedTheFavouritesOfTheSpace() {
        let state = state(favorites: [favorite("agenda", profile: "work")])
        #expect(content(state, isPrivate: true) == .privateTab, "opening one would leave the private tab for a page with the profile's cookies")
        #expect(content(self.state(favorites: []), isPrivate: true) == .privateTab, "and the private tab is not told to add favourites either")
    }
}

import Testing
@testable import LuciumKit

private func tab(_ id: String, _ shown: Double, selected: Bool = false, loading: Bool = false, media: Bool = false, capturing: Bool = false,
                 keepAwake: Bool = false) -> AwakeTab {
    AwakeTab(id: id, lastShownAt: shown, isSelected: selected, isLoading: loading, isPlayingMedia: media, isCapturing: capturing, keepAwake: keepAwake)
}

@Suite("Which tabs go to sleep")
struct SleepPlannerTests {
    @Test func nothingSleepsUnderTheCap() {
        let awake = [tab("a", 1), tab("b", 2), tab("c", 3, selected: true)]
        #expect(SleepPlanner.tabsToSleep(awake, cap: 3).isEmpty)
    }

    @Test func theLeastRecentlyShownGoFirstAndTheSelectedTabNever() {
        let awake = [tab("old", 1, selected: true), tab("b", 20), tab("c", 30), tab("d", 10), tab("e", 40)]
        // Five awake, cap three: two go, the oldest of the others. The selected tab is the oldest of all and stays.
        #expect(SleepPlanner.tabsToSleep(awake, cap: 3) == ["d", "b"])
    }

    @Test func aTabThatLoadsPlaysCapturesOrIsKeptAwakeIsSparedEvenOverTheCap() {
        let awake = [tab("sel", 50, selected: true), tab("load", 1, loading: true), tab("play", 2, media: true), tab("call", 3, capturing: true),
                     tab("keep", 4, keepAwake: true), tab("idle", 5)]
        #expect(SleepPlanner.tabsToSleep(awake, cap: 2) == ["idle"], "the others stay: a call or a video is not cut for a number")
    }

    @Test func underMemoryPressureOnlyTheSelectedTabIsSpared() {
        let awake = [tab("sel", 50, selected: true), tab("load", 1, loading: true), tab("play", 2, media: true), tab("keep", 4, keepAwake: true)]
        #expect(Set(SleepPlanner.tabsToSleep(awake, cap: 4, underPressure: true)) == ["load", "play", "keep"])
    }

    @Test func aTieIsBrokenByIdSoThatTheAnswerDoesNotDependOnTheOrder() {
        let awake = [tab("b", 1), tab("a", 1), tab("c", 1, selected: true)]
        #expect(SleepPlanner.tabsToSleep(awake, cap: 1) == ["a", "b"])
        #expect(SleepPlanner.tabsToSleep(awake.reversed(), cap: 1) == ["a", "b"])
    }

    @Test func aCapBelowOneStillKeepsTheSelectedTab() {
        let awake = [tab("sel", 1, selected: true), tab("b", 2)]
        #expect(SleepPlanner.tabsToSleep(awake, cap: 0) == ["b"])
    }
}

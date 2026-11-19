import LuciumKit
import SwiftUI
import WebKit

/// The blocker, as the person's switches shape it (docs/ios.md, section 6.6). WebKit judges every request from the rule lists attached to a web view and
/// the application cannot switch a rule off, so a switch is a list that is attached or taken away: `BlockerPlan` (`LuciumKit`) says which, for a page, and
/// this puts it on the views. A page's own request is judged by what its view carries when the page starts, so the lists are chosen when the navigation is
/// decided (the site of the exceptions is the page's) and again when a switch changes.
extension BrowserModel {
    /// The lists a page is given: the ones its site and the switches ask for, in the order they were compiled. A page of no address yet has the lists of
    /// every site that is not on the list of exceptions.
    func blockerLists(for page: String?) -> [WKContentRuleList] {
        let settings = privacySettings
        var lists = blockerParts.filter { BlockerPlan.wants($0.part, settings: settings, page: page) }.map(\.list)
        if let guardList, BlockerPlan.wants(BlockerPlan.Part(source: .youtube, kind: .network), settings: settings, page: page) { lists.append(guardList) }
        return lists
    }

    /// Makes the lists of a view the ones its page needs: what is no longer wanted comes off, what is new goes on. A view that already has the right
    /// ones is not touched.
    func applyBlocker(to view: WKWebView, page: String?) {
        let wanted = blockerLists(for: page)
        let have = attachedBlockers[ObjectIdentifier(view)] ?? []
        guard wanted.map(ObjectIdentifier.init) != have.map(ObjectIdentifier.init) else { return }
        let controller = view.configuration.userContentController
        let keep = Set(wanted.map(ObjectIdentifier.init))
        for list in have where !keep.contains(ObjectIdentifier(list)) { controller.remove(list) }
        let kept = Set(have.map(ObjectIdentifier.init))
        for list in wanted where !kept.contains(ObjectIdentifier(list)) { controller.add(list) }
        attachedBlockers[ObjectIdentifier(view)] = wanted
    }

    /// What a page gets before it loads: the lists of its site, and the plan of the page guard with the person's switches.
    func preparePage(in view: WKWebView, for url: URL?) {
        applyBlocker(to: view, page: url?.absoluteString)
        pageGuard?.settings = privacySettings.guardSettings
        pageGuard?.prepare(view, for: url)
    }

    /// A switch changed: every awake view takes the lists its current page asks for, with no reload (a page that is open keeps what it was loaded with,
    /// and its next request is judged by the new lists).
    func blockerSwitchesChanged(from old: PrivacySettings, to new: PrivacySettings) {
        pageGuard?.settings = new.guardSettings
        for (id, view) in webViews { applyBlocker(to: view, page: state.tabs.first { $0.id == id }.flatMap { $0.isBlank ? nil : $0.url }) }
        if new.blockMode != compiledBlockerMode { Task { await switchBlockerMode() } }
    }

    /// Compiles the network lists of the mode the person chose (the first time a few seconds; WebKit keeps the result) and puts them on the views. The
    /// lists of the old mode stay on the views until the new ones are ready, so the blocker is never off in between.
    func switchBlockerMode() async {
        guard let embedded, !blockerModeBusy else { return }
        blockerModeBusy = true
        defer { blockerModeBusy = false }
        // A person who switches back and forth while this runs gets the last choice: the loop runs again when the choice moved on.
        while privacySettings.blockMode != compiledBlockerMode {
            let mode = privacySettings.blockMode
            let outcome = await embedded.compile(in: store, mode: mode)
            guard !outcome.parts.isEmpty else {
                // Kept on the old mode's lists, and said where it happened; `compiledBlockerMode` stays, so the next change of the mode tries again.
                print("[blocker] the lists of the \(mode.rawValue) mode did not compile, the blocker keeps the \(compiledBlockerMode.rawValue) ones: \(outcome.failures.map(\.file))")
                return
            }
            blockerParts = outcome.parts
            listFailures = outcome.failures
            compiledBlockerMode = mode
            for (id, view) in webViews {
                // The lists are other objects now: the old ones come off whatever the page says (the rules of YouTube do not change with the mode), and
                // the lists the page asks for go on.
                let controller = view.configuration.userContentController
                var staying: [WKContentRuleList] = []
                for list in attachedBlockers[ObjectIdentifier(view)] ?? [] {
                    if list === guardList { staying.append(list) } else { controller.remove(list) }
                }
                attachedBlockers[ObjectIdentifier(view)] = staying
                applyBlocker(to: view, page: state.tabs.first { $0.id == id }.flatMap { $0.isBlank ? nil : $0.url })
            }
        }
    }
}

import Foundation

/// What the page « Synchronisation » says about the last session that went through (docs/synchronisation.md §13.3): which categories crossed and which did not, how
/// much the phone took from the Mac, and what was left aside. Pure, so that the sentences the page shows are proved here and the screen only gives them words.
///
/// It exists because « À jour » alone cannot be told from « nothing happened »: a category ticked on this phone and not on the Mac crosses nothing, and the first real
/// trial (19 November 2026, card 494) showed a phone whose person saw only « À jour » and could not tell what had crossed.
public enum SyncLastExchange {
    public enum Line: Equatable, Sendable {
        /// The categories that crossed (both devices ticked them).
        case exchanged([SyncCategory])
        /// Ticked on this phone and not on the Mac: nothing of them crossed.
        case notExchanged([SyncCategory])
        /// How many things the state took from the Mac.
        case received(Int)
        /// Both devices already held the same thing.
        case nothingNew
        /// How many Today tabs of the Mac arrived on this phone (§27, card 510): said apart from « received », which counts every kind.
        case todayTabsReceived(Int)
        /// How many Today tabs of this phone were kept to itself because the shared set was full (§27.4: the limit of 200).
        case todayTabsUnshared(Int)
        /// How many things of the Mac were not taken (refused at the door, or refused by the state when written).
        case leftAside(Int)
    }

    /// The lines of a session, in the order the page shows them. `ticked` is what this phone has ticked now.
    public static func lines(of summary: SyncExchangeSummary, ticked: [SyncCategory]) -> [Line] {
        var lines: [Line] = []
        let crossed = SyncCategory.allCases.filter(summary.categories.contains)
        lines.append(.exchanged(crossed))
        let missing = SyncCategory.allCases.filter { ticked.contains($0) && !summary.categories.contains($0) }
        if !missing.isEmpty { lines.append(.notExchanged(missing)) }
        if summary.taken > 0 { lines.append(.received(summary.taken)) } else if !crossed.isEmpty { lines.append(.nothingNew) }
        if crossed.contains(.todayTabs) {
            if summary.todayTabsTaken > 0 { lines.append(.todayTabsReceived(summary.todayTabsTaken)) }
            if summary.todayTabsUnshared > 0 { lines.append(.todayTabsUnshared(summary.todayTabsUnshared)) }
        }
        let aside = summary.refusedReceived.count + summary.rejectedByApply.count
        if aside > 0 { lines.append(.leftAside(aside)) }
        return lines
    }
}

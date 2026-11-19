import Foundation

/// The book of marks and its file, held for the phone (docs/synchronisation.md §9.2): the model gives it the state each time the state is written (the marks of a
/// gesture are made then, not when a session happens to carry it away), and a session brings it up to date again before it freezes its snapshot. It follows the state
/// only while the synchronisation is on: off, nothing is given to it and nothing runs.
///
/// A lock and not an actor: the model calls it from the main thread in the middle of a write of the state, and a session from its own task; both are short and in
/// memory, and neither may wait for the other to be scheduled.
public final class SyncMarkKeeper: @unchecked Sendable {
    private let lock = NSLock()
    private var book: SyncMarkBook
    private var lastView: SyncTrackedView?
    /// The Today tabs that could enter the shared set, as of the last look: a new one is a change that asks for a session (§27.12).
    private var lastWaiting: Set<String> = []
    /// How many Today tabs the last freeze left out only because the shared set was full (§27.4, the limit of 200): « non partagés : n » on the page. 0 when the category was not common.
    private var unshared = 0
    /// A session is writing what the merge decided into the state: looking at the state now would mark what the Mac wrote as the phone's own change. Until `adopt`.
    private var holding = false
    private let file: SyncMarksFile
    private let log: @Sendable (String) -> Void

    /// Reads the book of the file. A file that cannot be read starts an empty book (every field then takes a mark of now: a loss of the order of old changes, never of
    /// data), and the reason is logged.
    public init(device: String, file: SyncMarksFile, log: @escaping @Sendable (String) -> Void = { print("[sync] \($0)") }) {
        self.file = file
        self.log = log
        switch file.load(device: device) {
        case .loaded(let loaded): book = loaded
        case .none: book = SyncMarkBook(device: device)
        case .unreadable(let why):
            log("the marks of this phone could not be used, they start again: \(why)")
            book = SyncMarkBook(device: device)
        }
    }

    /// The state was written: the book is brought up to it and written. A write that fails is told in the log and tried again at the next change: the marks are in
    /// memory meanwhile. True when what is synchronised changed since the last look (a tab opened in Today or a page loaded is not): the phone then asks for a session
    /// (§8.1, « après un changement local »).
    /// `opening`: the person ticked the Today tabs here, so a tab that could be shared and is not yet (it enters at the next freeze, after twenty seconds) is a change too.
    @discardableResult
    public func observe(_ state: BrowserState, now: Int, opening: Bool = false) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if holding { return false }
        var opened = false
        if opening {
            let waiting = SyncStateView.waitingForAdmission(in: state, admitted: book.admitted)
            opened = !waiting.subtracting(lastWaiting).isEmpty
            lastWaiting = waiting
        }
        let view = SyncStateView.trackedView(of: state, admitted: book.admitted)
        if view == lastView { return opened }
        book.update(view, now: now)
        lastView = view
        save()
        return true
    }

    /// What the last freeze left to this phone because of the limit of the shared set.
    public var lastUnshared: Int {
        lock.lock()
        defer { lock.unlock() }
        return unshared
    }

    /// The snapshot a session freezes: the book is brought up to the state first, so that no change of the person lacks its mark.
    public func freeze(_ state: BrowserState, categories: Set<SyncCategory>, withheld: Set<String>, base: SyncSnapshot?, now: Int) -> SyncSnapshot {
        lock.lock()
        defer { lock.unlock() }
        // A new session never inherits a hold that a session before it left behind: the book follows the state again.
        holding = false
        // The shared set of Today tabs is decided here, once the freeze starts and only when the category is common: the admission is sticky, so what enters stays until the tab goes.
        if categories.contains(.todayTabs) {
            let admission = SyncStateView.admission(of: state, admitted: book.admitted, adopted: book.adoptedTabs, locked: withheld, now: now)
            book.admit(Set(admission.admitted))
            unshared = admission.refused.filter { $0.reason == .full }.count
        }
        let view = SyncStateView.trackedView(of: state, admitted: book.admitted)
        if view != lastView {
            book.update(view, now: now)
            lastView = view
            save()
        }
        return SyncStateView.snapshot(of: state, marks: book, categories: categories, withheld: withheld, base: base)
    }

    /// The session is about to write into the state: the book is not brought up to the state until `adopt` has taken what the merge decided (the next look then sees
    /// only what the person changed since).
    public func hold() {
        lock.lock()
        defer { lock.unlock() }
        holding = true
    }

    /// The state now holds what the merge decided (or as much of it as the person's changes allowed): the book takes the marks of the merged snapshot. The file is
    /// written, and a failure is the caller's: a session that could not keep its marks must not say it is done.
    public func adopt(_ merged: SyncSnapshot, exchanged: (String) -> Bool = { _ in true }, aside: SyncAside = .nothing) throws {
        lock.lock()
        defer { lock.unlock() }
        holding = false
        book.adopt(merged, exchanged: exchanged, aside: aside)
        // What the state holds is compared with the book again at the next observation: what a session wrote is the book's own, what the person changed meanwhile is not.
        lastView = nil
        try file.save(book)
    }

    /// The mark a change made now would get, for the tests.
    var currentBook: SyncMarkBook {
        lock.lock()
        defer { lock.unlock() }
        return book
    }

    private func save() {
        do {
            try file.save(book)
        } catch {
            log("the marks were not written, they are kept in memory and written at the next change: \(error)")
        }
    }
}

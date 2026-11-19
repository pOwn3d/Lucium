import Foundation

/// How the person asked one tab's page to be shown: the desktop version of the site, and the size of the page's text (the page zoom).
///
/// The choice is **per tab**, not per site: it follows the tab through sleep and restart, and a new tab starts from the defaults. It is the iPhone's
/// own (the Mac's zoom is a per-site Tweak and its state file has no such field), so it is kept in the tab's folder (`TabSideStore`, kind `display`) and
/// never in `state.json`: nothing a Mac or a synchronisation writes can change it. A private tab keeps it in memory only (the model's rule).
public struct PageDisplay: Codable, Equatable, Sendable {
    /// The zoom steps, in percent. The ends are the Mac's bounds for the zoom of a site (`BOOST_ZOOM_MIN` 0.5, `BOOST_ZOOM_MAX` 3).
    public static let zoomSteps = [50, 75, 85, 100, 115, 125, 150, 175, 200, 250, 300]
    public static let defaultZoom = 100

    /// Ask the site for its desktop version instead of its mobile one.
    public var desktop: Bool
    /// The zoom, in percent: always one of `zoomSteps`.
    public private(set) var zoomPercent: Int

    public init(desktop: Bool = false, zoomPercent: Int = PageDisplay.defaultZoom) {
        self.desktop = desktop
        self.zoomPercent = Self.nearestStep(to: zoomPercent)
    }

    public static let standard = PageDisplay()

    /// True when nothing was changed: there is then nothing to keep.
    public var isStandard: Bool { self == .standard }
    public var zoomFactor: Double { Double(zoomPercent) / 100 }
    public var canZoomIn: Bool { zoomPercent < Self.zoomSteps.last! }
    public var canZoomOut: Bool { zoomPercent > Self.zoomSteps.first! }
    public var isZoomed: Bool { zoomPercent != Self.defaultZoom }

    public mutating func zoomIn() {
        guard let next = Self.zoomSteps.first(where: { $0 > zoomPercent }) else { return }
        zoomPercent = next
    }

    public mutating func zoomOut() {
        guard let next = Self.zoomSteps.last(where: { $0 < zoomPercent }) else { return }
        zoomPercent = next
    }

    public mutating func resetZoom() { zoomPercent = Self.defaultZoom }

    /// A value read from a file is never trusted: a percentage that is not a step (a hand-edited or damaged file) becomes the nearest step, and
    /// one beyond the ends the end.
    private static func nearestStep(to value: Int) -> Int {
        zoomSteps.min { abs($0 - value) < abs($1 - value) } ?? defaultZoom
    }

    private enum CodingKeys: String, CodingKey { case desktop, zoomPercent }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(desktop: try container.decodeIfPresent(Bool.self, forKey: .desktop) ?? false,
                  zoomPercent: try container.decodeIfPresent(Int.self, forKey: .zoomPercent) ?? Self.defaultZoom)
    }

    /// What a file holds, or the standard display when it holds nothing readable. `unreadable` is true when there was data that did not read, so
    /// that the caller can say so in the log.
    public static func read(_ data: Data?) -> (display: PageDisplay, unreadable: Bool) {
        guard let data else { return (.standard, false) }
        guard let value = try? JSONDecoder().decode(PageDisplay.self, from: data) else { return (.standard, true) }
        return (value, false)
    }

    public func encoded() throws -> Data { try JSONEncoder().encode(self) }
}

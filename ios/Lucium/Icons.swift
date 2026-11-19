import LuciumKit
import SwiftUI

/// The icons of the project: drawn on a grid of 20 px, one line of 1.5 px with round ends, kept as vector images of the asset catalogue
/// (`Assets.xcassets/Icons`). The symbols of the system are not used (docs/ios.md, decision of 17 November 2026). An icon takes the colour
/// of the text around it, as a template image does.
enum Icon: String {
    case link = "icon-link", reload = "icon-reload", back = "icon-back", forward = "icon-forward", tabs = "icon-tabs"
    case search = "icon-search", folder = "icon-folder", chevron = "icon-chevron", close = "icon-close"
    // Drawn before this file by the screens of the spaces (`ProjectIcon`): the same set, the same catalogue folder.
    case plus = "IconPlus", person = "IconPerson", check = "IconCheck"
    case commands = "icon-commands", pin = "icon-pin", archive = "icon-archive", star = "icon-star", restore = "icon-restore"
    case trash = "icon-trash", rename = "icon-rename", folderPlus = "icon-folder-plus", more = "icon-more", sidebar = "icon-sidebar", download = "icon-download"
    case settings = "icon-settings", bookmark = "icon-bookmark", later = "icon-later"

    var image: Image { Image(rawValue) }
}

/// An icon at a size. The image is a template: it is drawn in the foreground style of its context.
struct IconView: View {
    let name: String
    var size: CGFloat = 20
    /// How much the text of the person is larger than the default: the icons follow it, up to one and a half times (a bigger icon would crowd the line).
    @ScaledMetric(relativeTo: .body) private var factor: CGFloat = 1

    init(_ icon: Icon, size: CGFloat = 20) {
        self.name = icon.rawValue
        self.size = size
    }

    /// An icon named by a string (the style of a space keeps the name of its icon).
    init(named name: String, size: CGFloat = 20) {
        self.name = name
        self.size = size
    }

    var body: some View {
        Image(name)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size * min(factor, 1.5), height: size * min(factor, 1.5))
            .accessibilityHidden(true)
    }
}

/// The tile of a site: its letter on one of eight colours (the same host always has the same one), the picture a site would have being fetched
/// only when the person asked for it (docs/ios.md, table of connections). A blank tab has a neutral tile.
struct SiteTile: View {
    let address: String
    var size: CGFloat = 22
    @ScaledMetric(relativeTo: .body) private var factor: CGFloat = 1

    var body: some View {
        let host = AddressResolver.host(of: address)
        let letter = TileStyle.letter(forHost: host)
        let size = size * min(factor, 1.5)
        RoundedRectangle(cornerRadius: Radius.tile(size: size), style: .continuous)
            .fill(letter == nil ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(Color("tile-\(TileStyle.colorIndex(forHost: host))")))
            .frame(width: size, height: size)
            .overlay {
                if let letter {
                    Text(verbatim: letter).font(.system(size: size * 0.5, weight: .bold)).foregroundStyle(Color.onTile)
                } else {
                    IconView(.plus, size: size * 0.55).foregroundStyle(.secondary)
                }
            }
            .accessibilityHidden(true)
    }
}

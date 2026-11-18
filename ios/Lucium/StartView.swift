import LuciumKit
import SwiftUI

/// The page of a blank tab (docs/ios.md, "La page de démarrage"): a field that opens the command bar, the favourites of the profile as tiles four to a
/// row (the sheet's own `FavoriteTile`), and under everything a short sentence about what stays on the device. It lies on the colours of the space,
/// laid pale as on the sheet of tabs. The page is drawn here, not in the web view: the view of a blank tab holds an empty document, so nothing is
/// loaded and no site's picture is fetched for a tile (they are letters, docs/ios.md §3).
struct StartView: View {
    @Bindable var model: BrowserModel
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // A scroll view that is at least as tall as the room, so that the sentence stays at the foot of a short page and a tall one (the largest
        // text, a landscape phone) scrolls.
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 24) {
                    searchField
                    favorites
                    Spacer(minLength: 24)
                    Text("start.privacy")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 16)
                .padding(.top, 24)
                .padding(.bottom, 16)
                // A wide window (an iPad) keeps the page as wide as a phone's, centred: four tiles across 800 points would be four large slabs.
                .frame(maxWidth: 560, minHeight: geometry.size.height, alignment: .top)
                .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background {
            ZStack {
                Color(.systemBackground)
                LinearGradient(colors: model.colors(of: model.activeSpace).map { $0.opacity(0.35) }, startPoint: .topLeading, endPoint: .bottomTrailing)
            }
            .ignoresSafeArea(.container, edges: .top)
        }
    }

    /// What a card of this page lies on: the ground, a little see-through, so that the colours of the space show round it.
    private var card: Color { Color(.systemBackground).opacity(0.72) }

    /// Not a field: a tap opens the command bar, the one place an address is typed, which the address pill of the bar opens too.
    private var searchField: some View {
        Button { model.commandBarShown = true } label: {
            HStack(spacing: 10) {
                IconView(.search, size: 18).foregroundStyle(.secondary)
                Text("bar.address.placeholder")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(minHeight: 48)
            .background(card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.1), lineWidth: 1) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var favorites: some View {
        switch model.startPage {
        case .favorites(let favorites):
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: StartPageContent.columns), spacing: 8) {
                ForEach(favorites) { favorite in FavoriteTile(model: model, favorite: favorite, height: 60, fill: card) }
            }
            // One group for VoiceOver, named: the tiles are read as its members, by their titles.
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("start.favorites"))
        case .noFavorites:
            Text("start.favorites.empty")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 8)
        case .privateTab:
            HStack(spacing: 8) {
                ProjectIcon(name: .privateMask, size: 18)
                Text("spaces.private.detail").font(.subheadline).multilineTextAlignment(.leading)
            }
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
        case .hidden:
            EmptyView()
        }
    }
}

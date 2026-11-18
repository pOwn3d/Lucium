import LuciumKit
import SwiftUI

/// Approach C of the mockups (`C1 · Navigation`): the address pill, and under it the spaces as round buttons, then back, forward and the tabs.
/// Every target is 44 pt, the minimum Apple asks for a finger. The pill is a button: it opens the command bar (`CommandBar`), where the address
/// is typed; the reload button sits inside it, as on the drawing. The gear of the settings (decision of 18 November 2026) is beside the pill, not in
/// the row below: that row already holds seven buttons, and an eighth would not fit a narrow phone or a fourth space.
struct BottomBar: View {
    @Bindable var model: BrowserModel

    var body: some View {
        VStack(spacing: 4) {
            DownloadStrip(downloads: model.downloads)
            HStack(spacing: 6) {
                addressPill
                barButton(.settings, label: "settings.title", enabled: true) { model.openSettings() }
            }
            HStack(spacing: 2) {
                ForEach(model.spaces) { space in spaceButton(space) }
                Spacer(minLength: 0)
                barButton(.back, label: "bar.back", enabled: model.canGoBack, action: model.goBack)
                barButton(.forward, label: "bar.forward", enabled: model.canGoForward, action: model.goForward)
                PageActionsMenu(model: model)
                barButton(.tabs, label: "bar.tabs.of \(model.activeSpace.name)", enabled: true) { model.tabsSheetShown = true }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 4)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    private var addressPill: some View {
        HStack(spacing: 0) {
            Button { model.commandBarShown = true } label: {
                HStack(spacing: 0) {
                    AddressLabel(model: model)
                    Spacer(minLength: 0)
                }
                .font(.subheadline)
                .lineLimit(1)
                .padding(.leading, 14)
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("bar.address.placeholder"))
            .accessibilityValue(Text(verbatim: model.host))
            Button { model.reloadOrStop() } label: {
                IconView(model.isLoading ? .close : .reload, size: 18).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel(Text(model.isLoading ? "bar.stop" : "bar.reload"))
        }
        .frame(height: 44)
        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contextMenu {
            if let site = model.siteOfActivePage {
                Button("sitedata.menu \(site)") { model.siteDataAsked = site }
            }
        }
    }

    private func spaceButton(_ space: Space) -> some View {
        let selected = space.id == model.activeSpace.id
        return Button { model.selectSpace(space.id) } label: {
            SpacePastille(space: space, colors: model.colors(of: space), size: 30, selected: selected)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("spaces.title") { model.spacesSheetShown = true }
            Button("spaces.private.new") { model.newPrivateTab() }
        }
        .accessibilityLabel(Text("bar.space.of \(space.name)"))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func barButton(_ icon: Icon, label: LocalizedStringKey, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { IconView(icon).frame(width: 44, height: 44).contentShape(Rectangle()) }
            .buttonStyle(.plain)
            .foregroundStyle(enabled ? Color.primary : Color.secondary.opacity(0.5))
            .disabled(!enabled)
            .accessibilityLabel(Text(label))
    }
}

/// What the address pill says while idle: the icon of the page (a mask for a private tab) and the host only (what the Mac's address place shows); the
/// whole address is typed in the command bar. The bottom bar and the iPad's page toolbar both draw it.
struct AddressLabel: View {
    let model: BrowserModel

    var body: some View {
        HStack(spacing: 6) {
            if model.activeTab?.isPrivate == true {
                ProjectIcon(name: .privateMask, size: 16).foregroundStyle(.secondary)  // what a private tab is, always in sight
            } else {
                IconView(.link, size: 15).foregroundStyle(.secondary)
            }
            if model.host.isEmpty {
                Text("bar.address.placeholder").foregroundStyle(.secondary)
            } else {
                Text(verbatim: model.host)
            }
        }
    }
}

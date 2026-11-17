import LuciumKit
import SwiftUI

/// Approach C of the mockups: an address pill, and under it the spaces as round buttons, then back, forward and the tabs.
/// Every target is 44 pt, the minimum Apple asks for a finger.
struct BottomBar: View {
    @Bindable var model: BrowserModel
    @FocusState private var addressFocused: Bool

    var body: some View {
        VStack(spacing: 4) {
            addressPill
            HStack(spacing: 2) {
                ForEach(model.spaces) { space in spaceButton(space) }
                Spacer(minLength: 0)
                barButton("chevron.backward", label: "bar.back", enabled: model.canGoBack, action: model.goBack)
                barButton("chevron.forward", label: "bar.forward", enabled: model.canGoForward, action: model.goForward)
                Button { model.tabsSheetShown = true } label: {
                    Image(systemName: "square.on.square").frame(width: 44, height: 44)
                }
                .accessibilityLabel(Text("bar.tabs.of \(model.activeSpace.name)"))
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 4)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    private var addressPill: some View {
        HStack(spacing: 6) {
            if model.activeTab?.isPrivate == true {
                ProjectIcon(name: .privateMask, size: 16).foregroundStyle(.secondary)  // what a private tab is, always in sight
            } else {
                Image(systemName: "link").foregroundStyle(.secondary).imageScale(.small)
            }
            TextField("bar.address.placeholder", text: addressBinding)
                .focused($addressFocused)
                .keyboardType(.webSearch)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit { model.submitAddress() }
            Button { model.reloadOrStop() } label: {
                Image(systemName: model.isLoading ? "xmark" : "arrow.clockwise").frame(width: 32, height: 32)
            }
            .accessibilityLabel(Text(model.isLoading ? "bar.stop" : "bar.reload"))
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 12))
        .contextMenu {
            if let site = model.siteOfActivePage {
                Button("sitedata.menu \(site)") { model.siteDataAsked = site }
            }
        }
    }

    /// Idle, the pill shows the host only (what the Mac's address place shows); typing, the whole address.
    private var addressBinding: Binding<String> {
        Binding(
            get: { addressFocused || model.host.isEmpty ? model.addressText : model.host },
            set: { model.addressText = $0 }
        )
    }

    private func spaceButton(_ space: Space) -> some View {
        let selected = space.id == model.activeSpace.id
        return Button { model.selectSpace(space.id) } label: {
            SpacePastille(space: space, colors: model.colors(of: space), size: 30, selected: selected)
                .frame(width: 44, height: 44)
        }
        .accessibilityLabel(Text("bar.space.of \(space.name)"))
        .contextMenu {
            Button("spaces.title") { model.spacesSheetShown = true }
            Button("spaces.private.new") { model.newPrivateTab() }
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func barButton(_ symbol: String, label: LocalizedStringKey, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).frame(width: 44, height: 44) }
            .disabled(!enabled)
            .accessibilityLabel(Text(label))
    }
}

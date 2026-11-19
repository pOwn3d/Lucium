import LuciumKit
import SwiftUI

/// The privacy settings: the protection level of the Mac in its three steps, the blocker's switches and mode, the two lists of sites (where nothing is
/// blocked, and whose data is erased on close), and the three options the levels are made of. They are written under the Mac's own names in the state
/// file, so the file stays the Mac's (docs/ios.md, "Vie privée"). A page of the settings screen: it is pushed on its navigation stack.
struct PrivacyForm: View {
    @Bindable var model: BrowserModel
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Form {
            Section {
                // Three names do not fit side by side at the largest text sizes: a menu then.
                if typeSize.isAccessibilitySize {
                    Picker("privacy.level.title", selection: level) { levelTags }.pickerStyle(.menu)
                } else {
                    Picker("privacy.level.title", selection: level) { levelTags }.pickerStyle(.segmented)
                }
            } header: {
                Text("privacy.level.title")
            } footer: {
                Text(levelHelp)
            }
            Section {
                Toggle("privacy.ads", isOn: flag(\.blockAds))
                    .frame(minHeight: 44)
                Toggle("privacy.banners", isOn: flag(\.blockCookieBanners))
                    .frame(minHeight: 44)
                Picker("privacy.mode.title", selection: mode) {
                    Text("privacy.mode.standard").tag(BlockMode.standard)
                    Text("privacy.mode.strict").tag(BlockMode.strict)
                }
                .frame(minHeight: 44)
            } header: {
                Text("privacy.blocker.title")
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    Text("privacy.ads-help")
                    Text("privacy.banners-help")
                    Text(model.privacySettings.blockMode == .strict ? "privacy.mode.strict-help" : "privacy.mode.standard-help")
                    if model.blockerModeBusy { Text("privacy.mode.busy") }
                    Text("privacy.blocker.lists")
                }
            }
            Section {
                NavigationLink {
                    BlockExceptionsPage(model: model)
                } label: {
                    LabeledContent { SiteCount(count: model.privacySettings.blockExceptions.count) } label: { Text("privacy.exceptions.title") }
                        .frame(minHeight: 44)
                }
                NavigationLink {
                    ClearOnClosePage(model: model)
                } label: {
                    LabeledContent { Text(model.privacySettings.clearOnClose.enabled ? "settings.lock.on" : "settings.lock.off") } label: { Text("privacy.clear.title") }
                        .frame(minHeight: 44)
                }
            }
            Section {
                Toggle("privacy.https", isOn: flag(\.httpsUpgrade))
            } footer: {
                Text("privacy.https-help")
            }
            Section {
                Toggle("privacy.gpc", isOn: flag(\.sendGpc))
            } footer: {
                Text("privacy.gpc-help")
            }
            Section {
                Toggle("privacy.strip", isOn: flag(\.stripTrackingParams))
            } footer: {
                Text("privacy.strip-help")
            }
        }
        .navigationTitle("settings.privacy")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder private var levelTags: some View {
        Text("privacy.level.standard").tag(ProtectionLevel?.some(.standard))
        Text("privacy.level.enhanced").tag(ProtectionLevel?.some(.enhanced))
        Text("privacy.level.strict").tag(ProtectionLevel?.some(.strict))
    }

    /// The level the settings add up to: no segment is selected when they match none (the footer then says so).
    private var level: Binding<ProtectionLevel?> {
        Binding(
            get: { model.privacySettings.level },
            set: { chosen in
                guard let chosen else { return }
                model.updatePrivacy { $0.choose(chosen) }
            }
        )
    }

    private var mode: Binding<BlockMode> {
        Binding(get: { model.privacySettings.blockMode }, set: { chosen in model.updatePrivacy { $0.blockMode = chosen } })
    }

    private func flag(_ keyPath: WritableKeyPath<PrivacySettings, Bool>) -> Binding<Bool> {
        Binding(
            get: { model.privacySettings[keyPath: keyPath] },
            set: { value in model.updatePrivacy { $0[keyPath: keyPath] = value } }
        )
    }

    private var levelHelp: LocalizedStringKey {
        switch model.privacySettings.level {
        case .standard?: "privacy.level.standard-effect"
        case .enhanced?: "privacy.level.enhanced-effect"
        case .strict?: "privacy.level.strict-effect"
        case nil: "privacy.level.custom"
        }
    }
}

/// How many sites a list holds, or « None ».
struct SiteCount: View {
    let count: Int

    var body: some View {
        if count == 0 { Text("privacy.sites.none") } else { Text("privacy.sites.count \(count)") }
    }
}

extension View {
    /// What the privacy rules tell the person (a line that goes away by itself) and ask of them (a certificate that was refused).
    func privacyPrompts(_ model: BrowserModel) -> some View { modifier(PrivacyPromptsModifier(model: model)) }
}

private struct PrivacyPromptsModifier: ViewModifier {
    @Bindable var model: BrowserModel

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let notice = model.privacyPrompts.notice {
                    Text(verbatim: notice)
                        .font(.footnote)
                        .padding(10)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Radius.l))
                        .padding(.horizontal, Gap.m)
                        .onTapGesture { model.privacyPrompts.notice = nil }
                        .accessibilityAddTraits(.isStaticText)
                }
            }
            .alert("privacy.refused.title", isPresented: refusalShown, presenting: model.privacyPrompts.refusal) { refusal in
                Button("privacy.refused.back", role: .cancel) {}
                Button("privacy.refused.http", role: .destructive) { model.navigationPolicy.continueOverHttp(refusal) }
            } message: { refusal in
                Text("privacy.refused.message \(refusal.host)")
            }
    }

    private var refusalShown: Binding<Bool> {
        Binding(
            get: { model.privacyPrompts.refusal != nil },
            set: { shown in if !shown { model.privacyPrompts.refusal = nil } }
        )
    }
}

import LuciumKit
import SwiftUI

/// The privacy settings: the protection level of the Mac in two of its three steps, and the three options it is made of. They are written under the
/// Mac's own names in the state file, so the file stays the Mac's (docs/ios.md, "Vie privée"). A page of the settings screen: it is pushed on its
/// navigation stack.
struct PrivacyForm: View {
    @Bindable var model: BrowserModel

    var body: some View {
        Form {
            Section {
                Picker("privacy.level.title", selection: level) {
                    Text("privacy.level.standard").tag(ProtectionLevel?.some(.standard))
                    Text("privacy.level.enhanced").tag(ProtectionLevel?.some(.enhanced))
                }
                .pickerStyle(.segmented)
            } header: {
                Text("privacy.level.title")
            } footer: {
                Text(levelHelp)
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
            // The blocker has no switch of its own: this says where its lists come from, since the page is named after it.
            Section {} footer: { Text("privacy.blocker") }
        }
        .navigationTitle("settings.privacy")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The level the settings add up to: no segment is selected when they match neither (the footer then says so).
    private var level: Binding<ProtectionLevel?> {
        Binding(
            get: { model.privacySettings.level },
            set: { chosen in
                guard let chosen else { return }
                model.updatePrivacy { $0.choose(chosen) }
            }
        )
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
        case nil: "privacy.level.custom"
        }
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
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                        .padding(.horizontal, 12)
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

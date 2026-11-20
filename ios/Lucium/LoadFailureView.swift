import LuciumKit
import SwiftUI

/// The screen of a page that did not load: what happened in one sentence, and « Try again ». It replaces the blank page WebKit leaves.
/// The Mac says the same things in `src/shared/error-pages.ts`; a refused certificate keeps its own prompt (`PrivacyScreen`).
struct LoadFailureView: View {
    let failure: LoadFailure
    let retry: () -> Void
    /// « Open over HTTP » for a device of the person's own network whose secure connection failed (`LoadFailure.httpAddress`).
    var openOverHttp: () -> Void = {}
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Image("icon-reload")
                    .resizable().scaledToFit().frame(width: 44, height: 44)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                Text(Self.title(failure.kind))
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text(Self.text(failure.kind, site: failure.site))
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if failure.suggestsLocalNetworkSettings {
                    // iOS keeps a refused « Local Network » permission to itself: the page just does not load. The sentence says so, once, and the button
                    // goes to the Settings of the application (the Mac says the same in `errpage.sur-macos-lucium-doit-etre-autorise-a`).
                    Text("loadfailure.local-network.hint")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                if failure.retryAddress != nil {
                    Button(action: retry) {
                        Text("loadfailure.retry").frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .frame(maxWidth: 360)
                    .padding(.top, 8)
                }
                if failure.httpAddress != nil {
                    Button(action: openOverHttp) {
                        Text("privacy.refused.http").frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: 360)
                }
                if failure.suggestsLocalNetworkSettings, let settings = URL(string: UIApplication.openSettingsURLString) {
                    Button { openURL(settings) } label: {
                        Text("loadfailure.local-network.settings").frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: 360)
                }
            }
            .padding(24)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Color(.systemBackground))
        .accessibilityElement(children: .contain)
    }

    /// Written out key by key: the catalogue test reads the keys from the sources, and a key built from the kind would be invisible to it.
    static func title(_ kind: LoadFailure.Kind) -> LocalizedStringKey {
        switch kind {
        case .offline: "loadfailure.offline.title"
        case .hostNotFound: "loadfailure.host-not-found.title"
        case .timedOut: "loadfailure.timed-out.title"
        case .cannotConnect: "loadfailure.cannot-connect.title"
        case .connectionLost: "loadfailure.connection-lost.title"
        case .tooManyRedirects: "loadfailure.too-many-redirects.title"
        case .badAddress: "loadfailure.bad-address.title"
        case .secureConnection: "loadfailure.secure-connection.title"
        case .certificate: "loadfailure.certificate.title"
        case .other: "loadfailure.other.title"
        }
    }

    static func text(_ kind: LoadFailure.Kind, site: String) -> LocalizedStringKey {
        switch kind {
        case .offline: "loadfailure.offline.text \(site)"
        case .hostNotFound: "loadfailure.host-not-found.text \(site)"
        case .timedOut: "loadfailure.timed-out.text \(site)"
        case .cannotConnect: "loadfailure.cannot-connect.text \(site)"
        case .connectionLost: "loadfailure.connection-lost.text \(site)"
        case .tooManyRedirects: "loadfailure.too-many-redirects.text \(site)"
        case .badAddress: "loadfailure.bad-address.text \(site)"
        case .secureConnection: "loadfailure.secure-connection.text \(site)"
        case .certificate: "loadfailure.certificate.text \(site)"
        case .other: "loadfailure.other.text \(site)"
        }
    }
}

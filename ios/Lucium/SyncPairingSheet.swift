import LuciumKit
import SwiftUI

/// "Add a Mac" (docs/synchronisation.md §4.1): the camera reads the QR the Mac shows, or the person types the address and the code under it. Either way the text
/// goes through `SyncPairingCode` (strict, local addresses only) before anything is sent, and the controller does the rest. The pairing waits for the person to say
/// yes on the Mac, and this sheet says so.
struct SyncPairingSheet: View {
    let controller: SyncController
    @Environment(\.dismiss) private var dismiss
    @State private var mode: Mode
    @State private var camera = CameraAccess.current()
    @State private var address = ""
    @State private var code = ""
    @State private var message: LocalizedStringKey?
    @State private var working = false
    @State private var lastScanned: String?

    enum Mode: Hashable { case scan, type }

    init(controller: SyncController, initialMode: Mode = .scan) {
        self.controller = controller
        _mode = State(initialValue: initialMode)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("sync.pairing.mode", selection: $mode) {
                        Text("sync.pairing.mode.scan").tag(Mode.scan)
                        Text("sync.pairing.mode.type").tag(Mode.type)
                    }
                    .pickerStyle(.segmented)
                    .disabled(working)
                }
                if case .comparing(let proposal) = controller.pairingStep, working {
                    compareSection(proposal)
                } else if working {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text(controller.pairingStep == .waitingForMac ? "sync.pairing.waiting" : "sync.pairing.connecting")
                        }
                        .accessibilityElement(children: .combine)
                        Button("sync.pairing.cancel", role: .cancel) { controller.cancelPairing() }
                            .frame(minHeight: 44)
                    }
                } else if mode == .scan {
                    scanSection
                } else {
                    typeSection
                }
                if let message, !working {
                    Section { Text(message).foregroundStyle(.red).accessibilityAddTraits(.isStaticText) }
                }
                Section { Text("sync.pairing.footer").font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle("sync.pairing.title")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("tabs.cancel") { controller.cancelPairing(); dismiss() } } }
            .task(id: mode) { await openCameraIfNeeded() }
        }
        .interactiveDismissDisabled(working)
    }

    // MARK: The code to compare (§4.6)

    /// « Appairer avec « Mac » ? Code : XXXXXX »: shown once the Mac has proved it holds the secret and before anything is kept. A Mac whose code is not the one on the
    /// real Mac's sheet is not the person's Mac (a QR from a poster, a message): « Annuler » keeps nothing.
    @ViewBuilder private func compareSection(_ proposal: SyncPairingProposal) -> some View {
        Section {
            Text("sync.pairing.compare.title \(proposal.macName)")
                .font(.headline)
            VStack(alignment: .leading, spacing: 4) {
                Text("sync.pairing.compare.code")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(proposal.code)
                    .font(.system(.largeTitle, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
                    // Read letter by letter, never as a word.
                    .accessibilityLabel(Text(proposal.code.map(String.init).joined(separator: " ")))
            }
            .accessibilityElement(children: .combine)
            Text("sync.pairing.compare.hint").font(.footnote).foregroundStyle(.secondary)
            Button("sync.pairing.compare.accept") { controller.answerComparison(true) }
                .frame(minHeight: 44)
            Button("sync.pairing.compare.cancel", role: .cancel) { controller.answerComparison(false) }
                .frame(minHeight: 44)
        }
    }

    // MARK: The camera

    @ViewBuilder private var scanSection: some View {
        switch camera {
        case .allowed:
            Section {
                QRScannerView { text in scanned(text) }
                    .frame(height: 300)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel(Text("sync.pairing.camera.label"))
            } footer: {
                Text("sync.pairing.scan.hint")
            }
        case .undetermined:
            Section { Text("sync.pairing.camera.asking") }
        case .denied:
            Section {
                Text("sync.pairing.camera.denied")
                Button("sync.pairing.type.instead") { mode = .type }.frame(minHeight: 44)
            }
        case .unavailable:
            Section {
                Text("sync.pairing.camera.unavailable")
                Button("sync.pairing.type.instead") { mode = .type }.frame(minHeight: 44)
            }
        }
    }

    private func openCameraIfNeeded() async {
        guard mode == .scan, camera == .undetermined else { return }
        camera = await CameraAccess.request()
    }

    /// A QR was seen. The same text is not tried twice in a row (the camera reports it many times a second); a text that is not a pairing code is said, once.
    private func scanned(_ text: String) {
        guard !working, text != lastScanned else { return }
        lastScanned = text
        switch SyncPairingCode.parse(qr: text) {
        case .success(let parsed): start(parsed)
        case .failure(let failure): message = SyncTexts.error(failure.code)
        }
    }

    // MARK: The typed code

    @ViewBuilder private var typeSection: some View {
        Section {
            TextField("sync.pairing.address.placeholder", text: $address)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .textContentType(.none)
                .frame(minHeight: 44)
            TextField("sync.pairing.code.placeholder", text: $code)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .textContentType(.none)
                .frame(minHeight: 44)
            Button("sync.pairing.go") { submitTyped() }
                .frame(minHeight: 44)
                .disabled(address.isEmpty || code.isEmpty)
        } footer: {
            Text("sync.pairing.type.hint")
        }
    }

    private func submitTyped() {
        guard let parts = SyncPairingCode.parse(address: address) else {
            message = SyncTexts.error(.invalidCode)
            return
        }
        switch SyncPairingCode.parse(typedCode: code, host: parts.host, port: parts.port) {
        case .success(let parsed): start(parsed)
        case .failure(let failure): message = SyncTexts.error(failure.code)
        }
    }

    // MARK: Pairing

    private func start(_ parsed: SyncPairingCode) {
        message = nil
        working = true
        Task {
            let result = await controller.pair(with: parsed)
            working = false
            switch result {
            case .success: dismiss()
            case .failure(let failure):
                message = SyncTexts.pairing(failure)
                // A code that has been tried is not scanned again by itself: the person points the camera at a new one.
                lastScanned = nil
            }
        }
    }
}

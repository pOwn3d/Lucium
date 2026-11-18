import AVFoundation
import SwiftUI
import UIKit

/// The camera, as far as the pairing needs it: read a QR code and nothing else (no photo, no video, no microphone). The permission is asked when the person
/// opens the scanner, with the sentence of `NSCameraUsageDescription` (`InfoPlist.xcstrings`); a refusal leaves the typed code (docs/synchronisation.md §4.3).
enum CameraAccess: Equatable {
    case allowed
    case undetermined
    case denied
    /// No camera (the simulator, an iPad with none): the typed code is the way.
    case unavailable

    static func current() -> CameraAccess {
        guard AVCaptureDevice.default(for: .video) != nil else { return .unavailable }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .allowed
        case .notDetermined: return .undetermined
        default: return .denied
        }
    }

    static func request() async -> CameraAccess {
        guard AVCaptureDevice.default(for: .video) != nil else { return .unavailable }
        return await AVCaptureDevice.requestAccess(for: .video) ? .allowed : .denied
    }
}

/// The live picture of the camera, which reports the text of each QR code it sees. The reading and the checking of that text are `SyncPairingCode.parse(qr:)`: this
/// only hands the text over.
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        let controller = QRScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: QRScannerController, context: Context) { controller.onCode = onCode }
}

final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: (String) -> Void = { _ in }
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "app.lucium.sync.camera")
    private var preview: AVCaptureVideoPreviewLayer?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        isAccessibilityElement = false
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            print("[sync] the camera cannot be used for the scanner")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        // Only QR codes: nothing else a camera could read is of any use here.
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let session = self.session
        sessionQueue.async { if !session.isRunning { session.startRunning() } }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let session = self.session
        sessionQueue.async { if session.isRunning { session.stopRunning() } }
    }

    /// The output delivers on the main queue (`setMetadataObjectsDelegate(self, queue: .main)`), which is where the controller lives.
    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let text = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
        MainActor.assumeIsolated { onCode(text) }
    }
}

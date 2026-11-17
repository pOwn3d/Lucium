// swift-tools-version: 6.0
// LuciumKit: the pure logic of the iOS application (no UIKit, no WebKit). It builds and tests on the Mac host with `swift test`,
// without any simulator: this is where the state format, the address rules and, later, the sync protocol live (docs/ios.md).
import PackageDescription

let package = Package(
    name: "LuciumKit",
    platforms: [.iOS("26.0"), .macOS("26.0")],
    products: [
        .library(name: "LuciumKit", targets: ["LuciumKit"]),
    ],
    targets: [
        .target(name: "LuciumKit"),
        .testTarget(
            name: "LuciumKitTests",
            dependencies: ["LuciumKit"],
            // The same vectors are read by the Mac's tests (src/shared/ios-contract.test.ts): one file, two implementations.
            resources: []
        ),
    ]
)

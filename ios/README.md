# Lucium for iOS (foundation)

The iPhone and iPad application: native Swift and SwiftUI on WebKit. This folder holds the groundwork only: a web view, the bottom bar of
the mockups (approach C), per-space profiles, an embedded content blocker, and the tests that prove the chain. **Nothing here is signed or
published** (`AGENTS.md`, section 7). The study and the decisions of the project lead (17 November 2026) are in [docs/ios.md](../docs/ios.md) (in French).

```
project.yml      the Xcode project, described for XcodeGen (Lucium.xcodeproj is generated and not committed)
Contracts/       vectors shared with the Mac: src/shared/ios-contract.test.ts runs them against the TypeScript, LuciumKit against the Swift
LuciumKit/       Swift package: pure logic (state format, address rules). `swift test` runs it on the Mac, with no simulator
Lucium/          the application (SwiftUI, WebKit, Localizable.xcstrings, blocker rules)
LuciumTests/     XCTest bundle hosted by the application (runs on a simulator)
```

## Check it

```sh
brew install xcodegen          # a development tool (MIT), never shipped
nice -n 15 scripts/ios-check.sh [folder-for-screenshots]
```

The script runs the package tests, generates the project, boots a simulator **in the background** (`xcrun simctl boot`: **no window**,
never `Simulator.app`), runs `xcodebuild test`, optionally takes a screenshot in French and in English, then shuts the simulator down and
deletes it. It is heavy (several minutes, a good part of the CPU): say so before running it on a machine somebody is using, run one at a
time, and run `xcrun simctl shutdown all` if it was interrupted. It signs nothing and sends nothing.

## Rules that apply here

- Every visible text is a key of `Lucium/Localizable.xcstrings`, in French and in English (`AGENTS.md`, section 3).
- No colour is written in the Swift sources: system colours and the asset catalogue (`AGENTS.md`, section 4).
- No telemetry, no account, no network call of our own, no online service (`AGENTS.md`, section 5).
- The code here is under GPL-3.0-or-later with the additional permission that lets the maintainer hand it out through the App Store and TestFlight ([ADDITIONAL-PERMISSION-APP-STORE.txt](../ADDITIONAL-PERMISSION-APP-STORE.txt)). Code that other people hold, such as a filter list, keeps its own license, which the application shows.
- Pure logic goes in `LuciumKit`. What the Mac also does is tested by the shared vectors, not by a second opinion.

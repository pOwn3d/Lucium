# Lucium for iOS (foundation)

The iPhone and iPad application: native Swift and SwiftUI on WebKit. This folder holds the groundwork only: a web view, the bottom bar of
the mockups (approach C), per-space profiles, an embedded content blocker, and the tests that prove the chain. **Nothing here is signed or
published** (`AGENTS.md`, section 7). The study and the decisions of the project lead (17 November 2026) are in [docs/ios.md](../docs/ios.md) (in French).

```
project.yml      the Xcode project, described for XcodeGen (Lucium.xcodeproj is generated and not committed)
Contracts/       files shared with the Mac. Address vectors: src/shared/ios-contract.test.ts runs them against the TypeScript, LuciumKit against the Swift.
                 state-reference.json: a state file written by the Mac's own store (src/main/ios-state-contract.test.ts), which LuciumKit reads, writes back and compares
LuciumKit/       Swift package: pure logic (state format and file, tab operations, sleep rule, address rules). `swift test` runs it on the Mac, with no simulator
Lucium/          the application (SwiftUI, WebKit, Localizable.xcstrings, blocker rules): one web view per awake tab, sleeping tabs, saved state
Lucium/FilterLists/   the filter lists converted for WebKit, and their registry: generated, not committed (see below)
LuciumTests/     XCTest bundle hosted by the application (runs on a simulator); Fixtures/ is the converted proof list
```

## The filter lists of the blocker

The blocker carries the lists of the Mac (EasyList, EasyPrivacy, uBlock filters…), converted to WebKit's content rules and embedded: nothing is downloaded on the phone, and they change with the application only. They are other people's work and are not committed: `node scripts/ios-filter-lists.mjs` fetches them from their public addresses, converts them (`scripts/ios-filter-lists/`), and writes `Lucium/FilterLists/` with a registry of where each comes from, which the application shows on its licenses screen. Without that folder the application runs with a short built-in list; a build that is handed out needs it. `node scripts/ios-filter-lists.mjs --from DIR` reads `DIR/<id>.txt` instead of fetching. With the folder present, `scripts/ios-check.sh` also compiles every list with WebKit. Details: [docs/ios.md](../docs/ios.md), section 6.3 (in French).

## Check it

```sh
brew install xcodegen          # a development tool (MIT), never shipped
nice -n 15 scripts/ios-check.sh [folder-for-screenshots]
```

The script runs the package tests, generates the project, boots a simulator **in the background** (`xcrun simctl boot`: **no window**,
never `Simulator.app`), runs `xcodebuild test`, optionally takes a screenshot in French and in English, then shuts the simulator down and
deletes it. It is heavy (several minutes, a good part of the CPU): say so before running it on a machine somebody is using, run one at a
time, and run `xcrun simctl shutdown all` if it was interrupted. It signs nothing and sends nothing.

On GitHub the same script runs in [`.github/workflows/ios.yml`](../.github/workflows/ios.yml), on a macOS runner, for a pull request that changes `ios/` or the script (and on demand). It is not a required check of `main`.

## Rules that apply here

- Every visible text is a key of `Lucium/Localizable.xcstrings`, in French and in English (`AGENTS.md`, section 3).
- No colour is written in the Swift sources: system colours and the asset catalogue (`AGENTS.md`, section 4).
- No telemetry, no account, no network call of our own, no online service (`AGENTS.md`, section 5).
- The code here is under GPL-3.0-or-later with the additional permission that lets the maintainer hand it out through the App Store and TestFlight ([ADDITIONAL-PERMISSION-APP-STORE.txt](../ADDITIONAL-PERMISSION-APP-STORE.txt)). Code that other people hold, such as a filter list, keeps its own license, which the application shows.
- Pure logic goes in `LuciumKit`. What the Mac also does is tested by the shared vectors, not by a second opinion.
- The state format is held by `Contracts/state-reference.json`. When the Mac's format changes on purpose, `pnpm test` refuses the file until it is rewritten (`pnpm exec vitest run src/main/ios-state-contract.test.ts -u`), then `swift test` in `LuciumKit/` says whether the iPhone still reads it: a field the Swift model does not type goes through `rest` and passes.

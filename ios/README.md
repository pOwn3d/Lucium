# Lucium for iOS (foundation)

The iPhone and iPad application: native Swift and SwiftUI on WebKit. This folder holds the groundwork only: a web view, the bottom bar of
the mockups (approach C), per-space profiles, an embedded content blocker, and the tests that prove the chain. **Nothing here is signed or
published** (`AGENTS.md`, section 7). The study and the decisions of the project lead (17 November 2026) are in [docs/ios.md](../docs/ios.md) (in French).

```
project.yml      the Xcode project, described for XcodeGen (Lucium.xcodeproj is generated and not committed)
Contracts/       files shared with the Mac. Address vectors: src/shared/ios-contract.test.ts runs them against the TypeScript, LuciumKit against the Swift.
                 state-reference.json: a state file written by the Mac's own store (src/main/ios-state-contract.test.ts), which LuciumKit reads, writes back and compares.
                 theme-vectors.json: the theme a hue makes, the id a profile name makes, which ids are valid (src/shared/ios-contract.test.ts against the Mac, LuciumKit against the Swift)
                 file-name-vectors.json: the name of a downloaded file, the number that makes it unique, the name of a page saved as PDF (src/shared/ios-file-names-contract.test.ts runs it against the Mac's file-names.ts, download-paths.ts and pdf-source.ts)
                 privacy-vectors.json: tracking parameters, HTTPS first and the one rewrite of a navigation (src/shared/ios-privacy-contract.test.ts runs it against src/shared/privacy.ts)
                 library-vectors.json (pinning, folders, Today, the archive, favourites: scenarios played against the Mac's reducer and against LuciumKit) and match-vectors.json (the score of the command bar)
LuciumKit/       Swift package: pure logic (state format and file, tab operations, sleep rule, address rules, spaces and profiles, private tabs, the data of a site, the privacy rules and their settings, the lock, the lists of a space, the command bar's search, file names, the download rule and the list of downloads). `swift test` runs it on the Mac, with no simulator
Lucium/          the application (SwiftUI, WebKit, Localizable.xcstrings, blocker rules, the icons of the project): one web view per awake tab, sleeping tabs, saved state, spaces and profiles, private tabs, the bar, the tabs sheet, the command bar, the archive, the privacy rules on every navigation
                 (PrivacyNavigation.swift) and their settings sheet (PrivacyScreen.swift); downloads (Downloads.swift: `WKDownload` to `Documents/Downloads`, which the Files app shows; DownloadsSheet.swift; DownloadNavigation.swift), and the page actions (PageActions.swift: share, save as PDF);
                 Info.plist holds what a build setting cannot (App Transport Security for web content, the downloads folder shown in Files)
Lucium/FilterLists/   the filter lists converted for WebKit, and their registry: generated, not committed (see below)
Lucium/Guard/    the page guard's runtime and rules: generated from the Mac's sources and committed (see below)
LuciumTests/     XCTest bundle hosted by the application (runs on a simulator); Fixtures/ is the converted proof list
```

## The filter lists of the blocker

The blocker carries the lists of the Mac (EasyList, EasyPrivacy, uBlock filters…), converted to WebKit's content rules and embedded: nothing is downloaded on the phone, and they change with the application only. They are other people's work and are not committed: `node scripts/ios-filter-lists.mjs` fetches them from their public addresses, converts them (`scripts/ios-filter-lists/`), and writes `Lucium/FilterLists/` with a registry of where each comes from, which the application shows on its licenses screen. Without that folder the application runs with a short built-in list; a build that is handed out needs it. `node scripts/ios-filter-lists.mjs --from DIR` reads `DIR/<id>.txt` instead of fetching. With the folder present, `scripts/ios-check.sh` also compiles every list with WebKit. Details: [docs/ios.md](../docs/ios.md), section 6.3 (in French).

## The lock

Spaces and the application can be locked with Face ID, Touch ID or the passcode of the device (`LocalAuthentication`; Lucium keeps no secret of its own). It locks the interface, not the disk: a locked space has no tab on screen and its pages are asleep, the application is covered at launch and every time it is left, and a window above everything hides the screen from the system's picture for the app switcher. Turning a lock on or off asks the owner, a refusal or a change that cannot be saved changes nothing, and a device with no passcode cannot use the lock. The choices are in `lock.json` next to the state, never in `state.json`. The rules and the controller are in `LuciumKit` (`LockSettings.swift`, `LockController.swift`) and are proved there with an owner that agrees and one that refuses; details in [docs/ios.md](../docs/ios.md), section 4.5 (in French).

## The page guard

What runs **in** a page before its own scripts (docs/ios.md, section 6.4): the scriptlets that the filter lists name for a site, our own YouTube rules, and the style sheet of the consent walls. The code is the Mac's own (`src/preload/guard-world.ts`, the scriptlet library of `src/shared/scriptlets.ts`): `node scripts/ios-guard.mjs` writes `Lucium/Guard/guard-runtime.js` and `guard-rules.json` from it. They are ours and small, so they are committed, and a test (`scripts/ios-filter-lists/guard-files.test.ts`) keeps them equal to what the Mac's sources give: after a change of those sources, run the script and commit the result. The scriptlets of the lists are a table written by `scripts/ios-filter-lists.mjs` next to the rules (`<list>.scriptlets.json`, not committed); `PageGuard` looks up the plan of each page as it is about to load and swaps the one user script of the guard on the web view. Nothing is downloaded: the runtime and the table are in the application. Only the main frame is covered.

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
- No colour is written in the Swift sources: system colours and the asset catalogue (`AGENTS.md`, section 4). The colour of a space is read from the theme in the state.
- No icon of the system (SF Symbols) in a screen: the project's icons are vectors of the asset catalogue (`Icon*`, drawn by `ProjectIcon`). A new one is an SVG with its `Contents.json` in `Assets.xcassets/Icons`; `src/shared/ios-contract.test.ts` refuses a symbol of the system, an icon named and not drawn, and a drawing never used.
- No telemetry, no account, no network call of our own, no online service (`AGENTS.md`, section 5).
- The code here is under GPL-3.0-or-later with the additional permission that lets the maintainer hand it out through the App Store and TestFlight ([ADDITIONAL-PERMISSION-APP-STORE.txt](../ADDITIONAL-PERMISSION-APP-STORE.txt)). Code that other people hold, such as a filter list, keeps its own license, which the application shows.
- `Lucium/PrivacyInfo.xcprivacy` says what the code does: no tracking, no data collected, and a reason for every API of Apple's "required reason" list that the code calls. `src/shared/ios-privacy-manifest.test.ts` reads the Swift sources and the manifest together, so a call to such an API without its declaration (or a declaration nothing calls) fails `pnpm test`.
- A connection of the application's own gets its line in the iOS table of the README (`Connections of the iOS version`), off by default with its switch, in the same change.
- A file is written, read or removed only inside `Documents/Downloads`, under a name `FileNames` cleaned (`DownloadsModel.inside` checks every path), and no download starts unless a page, a link or a response asks for one. Nothing else is kept in `Documents`.
- Pure logic goes in `LuciumKit`. What the Mac also does is tested by the shared vectors, not by a second opinion.
- The state format is held by `Contracts/state-reference.json`. When the Mac's format changes on purpose, `pnpm test` refuses the file until it is rewritten (`pnpm exec vitest run src/main/ios-state-contract.test.ts -u`), then `swift test` in `LuciumKit/` says whether the iPhone still reads it: a field the Swift model does not type goes through `rest` and passes.

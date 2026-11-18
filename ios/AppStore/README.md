# The App Store listing of Lucium for iPhone and iPad

What the maintainer pastes into App Store Connect, and the script that takes the pictures. **Nothing here is sent to Apple by the project**: creating the app, filling the page and uploading are the maintainer's, from their own account (`AGENTS.md`, section 7; the list of what to create is in [docs/ios.md](../../docs/ios.md), section 10.2, in French). The texts were written on 18 November 2026 against what `main` does that day; the list of what to re-read before a submission is at the end.

```
metadata/en-US/    the texts of the primary language (English, decision of 17 November 2026)
metadata/fr-FR/    the same files in French
metadata/review/   the notes for the App Review team (English; Apple's reviewers read English)
```

The icon is not here: it is `ios/Lucium/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` (a full-bleed 1024 px square with no alpha channel, drawn from the logo by `pnpm icons:logo`, which App Store Connect takes from the build). The pictures are not committed either (they show the application and go stale with it): `scripts/ios-store-shots.sh` takes them (below).

## The fields

One text per file, named as App Store Connect names the field; the limit is App Store Connect's, and `src/shared/ios-store-listing.test.ts` holds each file to it.

| App Store Connect, tab *Version* (per language) | File | Limit |
|---|---|---|
| Promotional Text | `promotional_text.txt` | 170 |
| Description | `description.txt` | 4000 |
| Keywords | `keywords.txt` | 100 **bytes** (an accent costs two), commas without spaces |
| Support URL | `support_url.txt` | |
| Marketing URL | `marketing_url.txt` | |
| What's New in This Version | `release_notes.txt` | 4000 |
| Copyright | `copyright.txt` | |

| App Store Connect, tab *App Information* (per language) | File | Limit |
|---|---|---|
| Name | `name.txt` | 30 |
| Subtitle | `subtitle.txt` | 30 |
| Privacy Policy URL | `privacy_url.txt` | |

*App Review Information › Notes*: `metadata/review/notes.txt` (4000 bytes). The contact (name, phone, e-mail) is the maintainer's and is typed in App Store Connect, never written here. *Sign-in required*: no.

The privacy policy of the iOS application is a page of the project's site, in each language (`/en/privacy-ios/`, `/vie-privee-ios/`), kept in the site's own repository; the files here only give its address.

## What is answered where, and what is not yet verified

Taken from [docs/ios.md](../../docs/ios.md) (sections 7, 9 and 10) and from the code of `ios/`. A line marked *to confirm* is a proposal read from the study, not something the Apple page was read for.

| Question of App Store Connect | Answer proposed |
|---|---|
| Primary language | English (U.S.), with a French localisation |
| Category | Utilities (the category's own description cites web browsing; guideline 2.3) |
| Price | Free. No in-app purchase, no subscription, no donation button (guideline 3.2.2) |
| App Privacy | **Data Not Collected**. The privacy manifest (`PrivacyInfo.xcprivacy`) says the same: no tracking, no data collected, no tracking domain |
| Export compliance (encryption) | **Exempt** (decision of the project lead, 18 November 2026): the application uses only the encryption that iOS provides for HTTPS (WebKit) and none of its own (CryptoKit only makes SHA-256 identifiers). `ITSAppUsesNonExemptEncryption` is set to `false` in `ios/Lucium/Info.plist`, so App Store Connect does not ask for each build, and `src/shared/ios-store-listing.test.ts` refuses a cipher API in the sources. The page of Apple on the exemption was not readable when the study was written (docs/ios.md, section 9.5): read it again before the first submission |
| Age rating | *to confirm*: the questionnaire is mandatory; a browser opens any web page, so expect to answer that it gives unrestricted web access, and let App Store Connect compute the rating. The questions on web content were not read |
| Trader status (Digital Services Act) | The maintainer's own declaration, for ConsilioWeb; to be made even when the application is not offered in the European Union (docs/ios.md, section 9.5) |
| Content rights | A browser shows pages of other people: the answer is the maintainer's |
| Default browser | **Not requested in this version.** The review notes say so; the day it is, the notes and the Info.plist change together |

## The pictures

`nice -n 15 scripts/ios-store-shots.sh [folder]` (default `out-ios-store/`, which Git ignores). Sizes App Store Connect takes: **1320 × 2868** for an iPhone of 6.9 inches, **2064 × 2752** for an iPad of 13 inches (a store accepts a few others; these are the ones the script writes and checks). Output: `<folder>/<en-US|fr-FR>/<iphone-6.9|ipad-13>/<NN-name>.png`, five per device and language, in this order:

| File | What it shows |
|---|---|
| `01-browse.png` | a page, with the bottom bar: Spaces, page actions, back, forward, tabs |
| `02-tabs.png` | the tabs sheet: pinned tabs, folders, today, archive |
| `03-spaces.png` | Spaces and profiles |
| `04-commands.png` | the command bar, with the keyboard |
| `05-privacy.png` | the privacy settings: protection level, HTTPS first, Global Privacy Control, tracking parameters |

How it is made, so that it can be trusted and redone:

- The real application, in a simulator that is created, booted **in the background** (no window, never `Simulator.app`) and deleted by the script, in the language of the picture (the device itself is set to it, so that the status bar of an iPad writes its date in that language). Nothing is signed and nothing is sent to Apple.
- The screens are the application's own (`BrowserScreen` and its sheets), drawn by `LuciumTests/StoreScreenshotTests`, which is skipped in every other run. The picture is taken from outside with `xcrun simctl io … screenshot`, because only the simulator draws the status bar (9:41, full battery), the Dynamic Island and the home indicator; the test and the script agree through files (`ready-…`, `done-…`).
- The demo data is the test's own: titles on reserved `.example` domains, a page drawn from a string (the address bar reads `journal.example`), no real site, no product or company name, no account, nothing taken from a real profile. `src/shared/ios-store-listing.test.ts` refuses any host that is not `.example` in that test.
- Each picture is checked against the size of its device, and rewritten without its alpha channel (the simulator writes one, the store takes none): `scripts/ios-store-shots/finish.mjs`.
- The simulator draws the Dynamic Island in some pictures of an iPhone and not in others (it is not part of the screen it renders, and nothing here controls it). A set whose pictures disagree is taken again, up to three times (`finish.mjs --island` exit 3).
- One simulator at a time on a machine others use (`AGENTS.md`, section 1): the script is heavy, about three minutes for all twenty pictures once the project is built.

Retake them when the interface changes, and always before a submission. The iPad pictures are portrait, where the bottom bar of the iPhone is kept on the larger screen. **There is no picture of the permanent sidebar of an iPad held in landscape**, which is what an iPad listing would like to show: a headless simulator cannot be turned. An iPad in windowed mode refuses an application's request to change orientation (`requestGeometryUpdate`: "the current windowing mode does not allow for programmatic changes to interface orientation"), `XCUIDevice` refuses in a unit test ("Not authorized for performing UI testing actions"), and `simctl` has no command for it; turning it needs `Simulator.app` or a UI-testing target, neither of which is used here. The offscreen picture of the sidebar in `docs/images/` is not a screen of the device.

## Before a submission: what to read again

Found while writing these texts, and not fixed here (each belongs to another piece of work):

1. **The start page still says "Foundation mockup"** (`start.title`, `start.body` in `Localizable.xcstrings`): the first thing a reviewer sees. It needs a real start page before any build leaves the maintainer's Mac.
2. **The texts describe `main` of 18 November 2026**, downloads, sharing, saving as a PDF and the iPad sidebar included. Take the pictures again after any change of the interface, and read the texts again against the list of functions.
3. **The privacy page of the site lists two connections that the code does not make yet** (search suggestions and site icons, "on by default"), while the README of the project, which follows the code, lists neither. The policy must say what the application does the day it is submitted: either the code gets them first, with their switches and their line in the README, or the page is corrected. The notes for the review say "no connection of its own", and a test reads the sources to hold them to it.
4. Sections 5.1.1, 5.1.2 and 5.2 of the review guidelines were read only in summary (docs/ios.md, section 9); the age rating and the export compliance are the two *to confirm* lines above.
5. The name "Lucium" has to be free in App Store Connect (docs/ios.md, section 10.2).

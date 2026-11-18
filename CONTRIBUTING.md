# Contributing to Lucium

Thank you for wanting to help. Lucium is a free, community-driven browser, and it only moves forward through contributions of all sizes: a precise bug report, a careful measurement, a typo fixed, a feature built.

English · [Français](CONTRIBUTING.fr.md) (the two say the same thing and change in the same commit)

You can write in English or in French in issues, discussions and pull requests.

## Contents

- [How the collaboration works](#how-the-collaboration-works)
- [Report a bug](#report-a-bug)
- [Propose a feature](#propose-a-feature)
- [What is out of scope, by decision](#what-is-out-of-scope-by-decision)
- [The no-reuse rule](#the-no-reuse-rule)
- [Measuring a browser without touching your data](#measuring-a-browser-without-touching-your-data)
- [Set up your environment](#set-up-your-environment)
- [Build the application yourself](#build-the-application-yourself)
- [Conventions of the repository](#conventions-of-the-repository)
- [Commits and pull requests](#commits-and-pull-requests)
- [License of your contributions](#license-of-your-contributions)

## How the collaboration works

Lucium has **one maintainer** ([GOVERNANCE.md](GOVERNANCE.md)). You propose a change with an issue or a pull request; the maintainer reviews it, corrects it if needed, merges it into `main`, then builds and publishes the version. Nobody else publishes.

**Every change reaches `main` through a pull request, the maintainer's own included.** Nobody pushes to `main` directly; its history is linear and its commits are signed ([the rules of `main`](GOVERNANCE.md#the-rules-of-main)).

1. **Fork** the repository on GitHub.
2. Create a **branch** in your fork, from an up-to-date `main`: `feat/short-name`, `fix/short-name`, `docs/short-name`.
3. Make your change, with its tests, and run the checks (see below). **Sign off every commit** with `git commit -s` ([why](#license-of-your-contributions)).
4. Open a **pull request** against `main`, with a title in [Conventional Commits](#commits-and-pull-requests) form, and fill in the template. Leave "Allow edits by maintainers" checked: the maintainer may push small fixes to your branch rather than ask for each one.
5. **The required checks** run on the pull request, with no secret: the type check (the job `Type check`), the lint (`Lint`), the unit tests on Linux and on macOS (`Unit tests (Linux)`, `Unit tests (macOS)`), an unsigned build of the application on macOS (`Build (macOS, unsigned)`), the sign-off of every commit (`DCO`) and the form of the title (`PR title`). A pull request is merged only when all of them pass; on a pull request that changes only documents (`*.md`, `docs/`) the two macOS jobs are skipped, and GitHub counts a skipped job as passed. For a first contribution they start once the maintainer has approved the run. What opens a window is not required on a pull request: the end-to-end tests (`pnpm test:e2e`) run every night on `main`; the engine chain (`pnpm test:engine`) runs every week, on a version tag and on demand.
6. **The maintainer reviews** your work, asks for changes or approves, then merges it (squash merge). One person does this, in their free time: see [docs/community/maintainers.md](docs/community/maintainers.md) for the response times aimed at, which are targets and not guarantees.
7. Your contribution appears in the [CHANGELOG](CHANGELOG.md) and ships with the next release. Releases are built, signed, notarized and published by the maintainer alone, from their own Mac, after reviewing everything that goes in ([GOVERNANCE.md](GOVERNANCE.md)): merging into `main` delivers nothing to users by itself.

For anything bigger than a small fix, **open an issue or a discussion first** so that nobody spends days on something that cannot be merged. Keep pull requests small and about one thing; a draft pull request is a good way to ask for early feedback.

New here? Look for issues labeled `good first issue` and `help wanted`. Improving a document, a message or a test is as welcome as code.

Where to talk: [GitHub Discussions](https://github.com/pOwn3d/Lucium/discussions) for questions and ideas, [issues](https://github.com/pOwn3d/Lucium/issues) for bugs, feature requests and what you miss from your previous browser. See [SUPPORT.md](SUPPORT.md) and [docs/community/index.md](docs/community/index.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Report a bug

Use the **Bug report** form when you open an issue. A good report has:

- the Lucium version (the one Lucium › About Lucium shows, or the commit if you built it) and your macOS version and chip;
- the shortest steps that reproduce the problem, what you expected, what happened;
- the page or extension involved, preferably a small test page;
- the terminal output if you started the app with `pnpm start` or `pnpm dev`.

**Remove personal data** from everything you attach: tab titles, addresses, account names, file paths containing your user name. Look at your screenshots before sending them.

A **security vulnerability** is never reported in a public issue: follow [SECURITY.md](SECURITY.md).

## Propose a feature

Open a **Feature request** issue (or a discussion for a rough idea). Describe the problem first, then your proposal. Check the [roadmap](docs/roadmap.md) (in French): the idea may be done, planned or excluded.

The project has two priorities, in this order: be faithful to Lucium's layout and behavior, then add new features. A feature that departs from them is welcome when it is an addition (a new setting, a new menu entry) and not a silent change of an existing behavior.

## What is out of scope, by decision

These decisions are firm (see [GOVERNANCE.md](GOVERNANCE.md)). A proposal or pull request for any of them will be closed:

- an **AI assistant** built into the browser (chat, "ask" bar, agents acting on pages), and any call to an online AI provider; the one thing allowed is the page summary by a local model (Ollama on the user's own computer), as an option, off by default;
- a **user account**, or anything that requires signing in to use the browser;
- **cloud synchronization or sharing** that goes through a server;
- **telemetry**, analytics, crash reporting that sends data;
- anything that breaks [the no-reuse rule](#the-no-reuse-rule);
- a paid tier, advertising, or an affiliate link.

Installing any extension a user chooses is not an exception to these: extension support is generic.

## The no-reuse rule

Lucium reproduces **observable behavior and layout**: how things look, where they are, what they do.

A contribution must contain **no code, image, font, icon, sound, string table or data file taken from another browser or from any other proprietary product**, in whole or in part, even modified. It must not be written from decompiled or disassembled code of such a product. Icons and graphics are drawn for Lucium (see `src/shared/icons.ts`). Free assets are fine when their license is compatible with GPL-3.0-or-later and recorded in [docs/licences-tierces.md](docs/licences-tierces.md).

If you are not sure whether something may be used, ask in the pull request before pushing more work. Copied material is removed as soon as it is found, which can mean rewriting history.

## Measuring a browser without touching your data

A measurement, on Lucium or on another browser you use, follows these rules:

- **Observe, never modify.** Do not edit the files of a browser's data folder (under `~/Library/Application Support`), and do not change your real spaces to measure something. Create a throwaway space with neutral tabs (for example `example.com`) and measure there. Quit a browser before Lucium imports its data, and work on a copy of its files (`StorableSidebar.json` for a sidebar with spaces).
- **Measure what you can observe**: the macOS Accessibility Inspector (position, size, identifiers), screenshots taken at scale 1 (1 point = 1 pixel), pixel sampling for colors, 60 fps screen recordings for animation timing. Do not decompile or disassemble another browser, and do not copy resources out of its bundle.
- **Say how each value was obtained**, with these tags: `[A]` accessibility, `[P]` pixels, `[I]` identifier, `[V]` seen on screen, `[D]` deduced (to be confirmed). Give the conditions: window size, light or dark, space theme, hover or active state, browser version.
- **Say what you could not measure**, and why. A guess marked `[D]` is useful; a guess presented as a measurement is harmful.
- **No personal data in what you write down or attach.** Write `<space>` instead of the name of one of your spaces. No tab titles, addresses or history. Do not commit raw screenshots of your own browser: they show your data. A cropped image of neutral content is acceptable, an extracted asset is not.
- **Where to put it**: in the description of the pull request that implements the change, with each value and how it was obtained.

If you only want to flag something missing, the **Missing from your previous browser** issue form is enough: give numbers when you have them.

## Set up your environment

Requirements: macOS (Apple silicon is the tested platform), Node.js 26 (see `.nvmrc`; `nvm use` or any version manager that reads it), and pnpm 12.16.1 (the `packageManager` field of `package.json`).

```bash
git clone https://github.com/<your-account>/lucium.git     # your fork
cd lucium
git remote add upstream https://github.com/pOwn3d/Lucium.git
pnpm install
pnpm dev                 # run the app with reload
```

If Electron complains that its binary is missing, run `node node_modules/electron/install.js` once.

**`pnpm dev` and `pnpm start` open your real profile, on purpose.** Without an option, a development session reads and writes the data folder of the installed application, `~/Library/Application Support/Lucium` (spaces, tabs, settings, history, cookies, password vault), and encrypts the cookies as the installed builds do (Electron's `EnableCookieEncryption` fuse, one way: [docs/drm.md](docs/drm.md)). Code you are writing (a reducer, a migration, a clean-up of files) then acts on that profile. To try something risky, give Electron a test profile after `--`:

```bash
pnpm dev -- --user-data-dir="$(mktemp -d)"                                       # a blank profile, thrown away
pnpm dev -- --user-data-dir="$HOME/Library/Application Support/lucium-dev"    # a test profile kept between sessions
```

The same form works for `pnpm start`. Before a session on your real profile that touches the state or its migrations, make a copy of the folder (docs/drm.md gives the `ditto` command).

Before every pull request:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:engine
```

- `pnpm typecheck`, `pnpm lint` and `pnpm test` (Vitest, pure logic) are quick and open no window. They are required checks of every pull request. The unit tests run on Linux and on macOS: some only run on macOS and are skipped on Linux. `pnpm build` is a required check too, on macOS: it catches what the bundler cannot resolve (an import, an asset, a page), which the type check and the unit tests do not see.
- `pnpm test:coverage` runs the same unit tests and measures which lines of the product they run (summary in the terminal, pages in `coverage/index.html`). It is not a required check and has no threshold: use it to find code that no test runs. The engine suites and the E2E tests are not in the figure.
- `pnpm test:engine` starts a real Electron: it opens windows and **takes the focus**. Run it when you are not using the machine. In CI it runs every week, on a version tag and on demand (workflow **Smoke (macOS)**, the macOS minutes are expensive), never on a pull request, so it is on you to run it when your change touches windows, views, menus, extensions or anything in `src/main/`. If you cannot (no Mac), say so in the pull request and the maintainer will run it.
- `pnpm test:engine` does not run everything, and `src/main/smoke-suites.ts` is the one table that says which suite runs where and why. Two suites need an application of their own and have their command: `pnpm test:engine:webstore` (in the chain the web store suite is counted as skipped: the probe extensions the chain loads would send its pages to the real store) and `pnpm test:engine:extwindows` (extensions in three profiles and three windows, with probes of its own). `pnpm test:engine:all` runs the chain, then those two. The others are started apart, after `pnpm build`, with `LUCIUM_SMOKE_ONLY=<name> electron . --smoke --user-data-dir="$(mktemp -d)"`: `webstore-live` and `favicons-measure` use the real Internet (read only, counts only), `surface-real` needs a copy of the real extension in `LUCIUM_EXTENSIONS`, and `perf` is the target of `pnpm perf`, which measures for minutes (the chain only checks its preparation). A name that no suite has is refused (exit code 2) instead of starting the whole chain.
- What a run of the chain tells you. The interface is pinned to French, whatever the language of your Mac: the checks read French menus and titles. Each check is written to the log as it is made (`ok`, `FAIL`, or `skip` with the reason: a skipped check is counted apart and is never a pass). Each suite has a time limit (10 minutes, more for the two long ones; `LUCIUM_SMOKE_SUITE_TIMEOUT_MS` changes it): a suite that does not return is counted as failed and named, and the chain goes on. A suite that ends without one check, or whose probe extension is not loaded, fails. The run stops, fails and says why when the displays of the Mac go to sleep, its screen is locked, it goes to sleep, the main process does not run for a minute, or the application is asked to quit: the suite under way is cut short, no other starts, and the report holds the suites made (the checks drive real windows and read what is drawn, so every check after a locked screen would fail for a reason that is not the application's). Keep the screen on and unlocked (`caffeinate -d` keeps the displays on, not a screen locked by hand). The run ends with one line per suite and the names of those that failed. It puts your clipboard back after each suite and removes its throw-away profile; a run you interrupt does neither. `pnpm compat:compare` then sets the report of the run (`out-engine/report.json`) against the reference of the engine (`compat/baseline-electron-<version>.json`) and lists what the run lost.
- The chain builds with `LUCIUM_KEEP_NAMES=1` (the main process keeps the names of its functions and classes): the zero-cost checks of the optional features (`LUCIUM_SMOKE_ONLY=features`) tell whose a timer is by those names, so build the same way before running them apart.
- `pnpm test:e2e` (Playwright, `tests/e2e/`) builds the application and drives it: about 160 tests, some fifteen minutes. It opens windows and **takes the focus**. Each test starts its own copy with a temporary data folder, never your profile, and its pages come from a local server. The application the tests start reaches nothing outside the machine: it resolves the names of the tests only, and the blocker downloads no list. In CI it runs every night on `main` and by hand (workflow **E2E**, macOS), and is not a required check of a pull request. The visual test of the Settings (`tests/e2e/settings.spec.ts`) compares with pictures made on the machine that compares (the screen, the fonts and the version of macOS change the pixels): the ones of the CI are in Git (`*-darwin-ci.png`), the ones of your machine are not (`*-darwin-local.png`). Each picture holds a whole category, down to its last row, not only what the window shows. A missing reference picture fails the test: on your machine the first run draws them and fails, the next one compares; `pnpm test:e2e tests/e2e/settings.spec.ts --update-snapshots` draws them again. Look at the pictures before you trust the comparison.

Useful reading: [docs/architecture.md](docs/architecture.md) (structure, the engine port) and [docs/fonctions.md](docs/fonctions.md) (every feature, its switch and its cost). They are in French.

## Build the application yourself

Anyone can build Lucium on their own Mac, **with no account of any kind**: no castLabs account, no Apple developer account, no key. What you build is the **standard variant**: the same code as the official build, on the official Electron pinned in `package.json`. The official builds are not the same thing, and only the maintainer makes them.

Besides the requirements above, you need the Xcode Command Line Tools (`xcode-select --install`): `pnpm package` compiles three small native helpers with `clang` and `swiftc`.

```bash
pnpm install --frozen-lockfile
pnpm package             # dist/mac-arm64/Lucium.app, for Apple silicon
```

`pnpm package` runs `electron-vite build`, then `pnpm build:native` (the helpers), then `electron-builder --mac --dir --arm64`: the steps of the required check `Build (macOS, unsigned)`. Nothing is signed (`identity: null` in `electron-builder.yml`) and nothing is sent anywhere.

| | Standard variant (the one you make) | Official build (the maintainer's) |
|---|---|---|
| Electron | the official one, pinned in `package.json` | the "Electron for Content Security" of castLabs, which can load the Widevine module (the DRM variant, [docs/drm.md](docs/drm.md), in French) |
| Protected videos (Netflix and the like) | do not play: the standard variant has no Widevine module | play; only Netflix is checked, before each version |
| Signature | none: not signed with a Developer ID, not notarized | signed through castLabs' signing service (EVS), then with the maintainer's Developer ID, and notarized by Apple |
| First launch | opens normally on the Mac that built it; on another Mac, macOS blocks it until you choose *Open Anyway* ([README](README.md#building-from-the-sources)) | no warning |
| Updates | none: it carries no update address, so you pull and build again | from the signed update feed of lucium.app |
| Touch ID for the password vault | unavailable (the keychain helper needs a provisioning profile of the maintainer's developer team): the vault opens with its passphrase | available |

**The official builds are made by the maintainer alone**, on their own Mac, with `scripts/build-drm-release.sh`. That takes an EVS account of castLabs, an Apple Developer ID and the maintainer's keychain. No contribution needs them, no check of a pull request uses them, and a build made with other keys is not an official build. You never have to run that script to contribute. If your change touches protected video, say in the pull request that you could not test it: the maintainer checks that Netflix plays on the official build before every version ([release process](docs/community/release-process.md)).

**A build you make opens the data of an installed Lucium.** It has the name and the identifier of Lucium, so it reads and writes the same data folder, `~/Library/Application Support/Lucium`, as `pnpm dev` does. To try it on a blank profile, give it a test profile as above: `open -n dist/mac-arm64/Lucium.app --args --user-data-dir="$(mktemp -d)"`.

If you hand out a build you made, change the name, the logo, the identifier, the update feed and the contact addresses: [TRADEMARKS.md](TRADEMARKS.md#if-you-hand-out-a-modified-version) says which.

## Conventions of the repository

- **Pure logic goes in `src/shared/`, tested.** Files there do not import Electron. Each module has its test next to it (`name.test.ts`, Vitest).
- **What the interface does over time is tested in a document.** A static render shows what a component draws, not its effects, its listeners, its timers or what a click changes. For these, a test file of `src/renderer/` starts with `// @vitest-environment happy-dom` and mounts the component with `dom.test-support.ts` (see `lock-settings.test.ts`, `hover-card-effects.test.ts`). The other tests keep running in plain Node.
- **A test that needs a folder asks `tempDir()` for it** (`src/main/temp-dir.ts`): the folder is removed after the test. A bare `mkdtempSync` leaves it behind, and a development machine fills up with them.
- **One reducer.** Every change of the persisted state goes through `src/shared/sidebar.ts`. The shape of the state is in `src/shared/model.ts`, and what is accepted when a state file is loaded is in `src/shared/state-clean.ts`: a hand-edited or corrupted file must never crash the app.
- **One engine port.** Everything that drives web content or extensions goes through `src/main/engine/types.ts` (`Engine`, `Page`). Its implementation over Electron lives in `src/main/engine/` (`electron-engine.ts`, `electron-page.ts` and the helpers listed, each with its reason, in `src/main/engine-port.test.ts`, which refuses any new one); `src/shared/` never imports Electron. The shell (`src/main/shell/`), the preloads and the root of `src/main/` still import Electron for windows and menus. This is what keeps a Chromium update from breaking the rest.
- **The renderer is not trusted.** The main process revalidates every IPC message (`src/main/shell/ipc.ts`, `src/shared/ipc-policy.ts`). A new channel comes with its validation and its test.
- **Security rules for code.** These apply to every change, not only to the security reports:
  - a secret (API key, token, password) is never written to the state file, the logs, a URL, a test snapshot or the screen; it is stored encrypted with the system's keychain (`safeStorage`) and only the main process reads it back;
  - nothing leaves the machine without the user's explicit choice: a new network call is off by default, appears in the table of connections of the [README](README.md), and is listed in the pull request;
  - text from a web page or a model is shown as text: no `innerHTML` with content that is not ours, no interpretation of HTML from a model, and no `eval`, `new Function` or code loaded from a remote address;
  - a file read at start-up or imported (state, Tweak, theme, list, bookmark) is validated and limited in size, and a corrupted file never crashes the app;
  - a dependency with an install script, or a security advisory, is raised in the pull request before it is merged.
- **Every guard has a test, and the test is proven by mutation.** A guard is any check that refuses, limits or validates: a size limit, a URL filter, a permission check, a "never do X" rule. Write the test, then **remove or invert the guard and check that the test fails**, then put the guard back. Say that you did it in the pull request. A test that passes with and without the guard protects nothing.
- **Engine behavior gets a smoke check.** What only a real Electron can show (windows, views, sessions, extensions) is checked in `src/main/smoke-*.ts`, run by `pnpm test:engine`.
- **Interface changes come with numbers.** A user interface change says what it follows (sizes, colors, timings, with how they were observed), or states that it is a deliberate addition.
- **The interface is in French and in English, and translatable.** Every user-visible text is in the two catalogues, `src/shared/i18n-fr.ts` and `src/shared/i18n-en.ts`, under the same key, and is read with `t('area.key')`: a new text comes in both languages, in the same commit, and a test fails when a key is in one catalogue only ([docs/community/translations.md](docs/community/translations.md)). Write each sentence whole, without building it from pieces whose order depends on grammar, and put no text in an image.
- **Colors go through tokens.** A stylesheet writes no color of its own: it takes a role of `src/renderer/tokens.css` (ground, text, accent…), which follows the light and the dark scheme, or, for the few windows that are not on the roles, a fixed color of `src/renderer/palette.css`. `src/renderer/stylesheets.test.ts` refuses a color written in a migrated sheet.
- **Language of the files.** Code comments are in **English**. Documents in `docs/` are in French, those of `docs/community/` in English; community files at the root are in English, and the README, this guide, GOVERNANCE and TRADEMARKS also have a French version.
- **Style.** TypeScript in strict mode. The linter (`pnpm lint`, [oxlint](https://oxc.rs)) is a required check; there is no formatter: follow the code around yours (2 spaces, no semicolons, single quotes). `.editorconfig` sets the basics.
- **The rules of the linter** are the short list of `.oxlintrc.jsonc`: a hook called in a branch, an effect that reads a value it does not list, a promise nobody waits for, a name declared and never read. An exception is one line, with its reason: `// oxlint-disable-next-line react-hooks/exhaustive-deps -- why`. A comment that excuses nothing is an error. Every TypeScript file belongs to one of the `tsconfig.*.json` projects, so that the linter reads it with its types: a new folder is added to one of them.
- **Coding assistants.** If you work with one, [AGENTS.md](AGENTS.md) holds the rules it must follow. You remain the author of what you submit, and the one who signs it off.
- **Comments explain why**, not what. Remove commented-out code.
- **Dependencies.** Adding one needs a reason in the pull request, a license compatible with GPL-3.0-or-later recorded in [docs/licences-tierces.md](docs/licences-tierces.md), and no install script (`pnpm-workspace.yaml` lists the only packages allowed to run build scripts). `pnpm-lock.yaml` is committed, in the same commit as `package.json`.
- **Versions.** In `package.json`, what the application ships (`dependencies`) and Electron are pinned to an exact version, without `^` or `~`: they run in the browser, and `koffi` and Electron are native code. The development tools (`devDependencies` other than Electron) take a caret range (`^x.y.z`); what is installed is fixed by `pnpm-lock.yaml` all the same (`pnpm install --frozen-lockfile` in CI). Updates come from Dependabot (`.github/dependabot.yml`, one pull request per group), or by hand with `pnpm up <name>@<version>`.
- **Documentation.** Update the docs when behavior changes, and add a line to the topmost section of the [CHANGELOG](CHANGELOG.md) (the version being prepared, or `## [Unreleased]` after a release) for anything a user would notice, and the same line in French to [CHANGELOG.fr.md](CHANGELOG.fr.md), which the application shows in its « What's new » sheet. `README.md` and `README.fr.md` change together, in the same commit; so do `CONTRIBUTING.md` and `CONTRIBUTING.fr.md`, `GOVERNANCE.md` and `GOVERNANCE.fr.md`, `TRADEMARKS.md` and `TRADEMARKS.fr.md`. A connection the application makes by itself is listed in the table of the README, with its switch and its default.
- **Do not fix unrelated things** in the same pull request. Open an issue for them.

## Commits and pull requests

Commit messages and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org), **in English**:

```
<type>(<scope>): <what changed, imperative, lower case, no final period>

<optional body: why, and what was considered>
```

- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
- Scope is the area, for example `sidebar`, `command-bar`, `engine`, `extensions`, `blocker`, `import`, `settings`, `docs`.
- Examples: `fix(sidebar): keep the selection when a folder closes`, `feat(blocker): add a per-site exception`, `docs(community): describe the release process`.
- A breaking change to the state file or to a setting is flagged with `!` (`feat(state)!: ...`) and explained in the body.

The maintainer squash-merges, so your pull request title is what lands in the history: a required check verifies its form. Several commits on your branch are fine, each with its sign-off (next section). The maintainer's own changes come by pull request and follow the same format.

## License of your contributions

**Copyright © 2026 ConsilioWeb and contributors.** Lucium is released under **GPL-3.0-or-later** ([LICENSE](LICENSE)), with two additional permissions: one lets it be combined and handed out with the Widevine module, which the variant that plays protected videos needs ([ADDITIONAL-PERMISSION.txt](ADDITIONAL-PERMISSION.txt)); the other lets the maintainer hand out the iPhone and iPad application through Apple's App Store and TestFlight ([ADDITIONAL-PERMISSION-APP-STORE.txt](ADDITIONAL-PERMISSION-APP-STORE.txt)). By submitting a contribution you agree that it is distributed under that license, with those permissions. **You keep your copyright**: nothing is assigned to the project or to ConsilioWeb, and there is **no contributor license agreement** (CLA). [NOTICE](NOTICE) says who holds what; the name and the logo are a separate matter, in [TRADEMARKS.md](TRADEMARKS.md): the logo files are not under the GPL, and only the maintainer changes them.

What is asked of you is the [Developer Certificate of Origin 1.1](https://developercertificate.org): you certify that you wrote the contribution or have the right to submit it under this license. You do it with a `Signed-off-by: Your Name <email>` line at the end of **every commit** of your pull request (`git commit -s` adds it; `git rebase --signoff main` adds it to commits already made). A required check refuses a pull request with a commit that lacks it. The line is text, not a cryptographic signature: it needs no key. You can use your GitHub `noreply` address in it, since the commit history is public.

Source files do not need a license header. Third-party code that you add keeps its own license and header.

---

Questions about this guide: open a [discussion](https://github.com/pOwn3d/Lucium/discussions).

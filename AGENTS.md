# Instructions for coding assistants

These are the rules of Lucium for a coding assistant (an AI tool that reads and writes the code on someone's behalf). They hold whatever the tool is. A person who contributes with one stays the author of the contribution and answers for it: [CONTRIBUTING.md](CONTRIBUTING.md) is the full guide, and this page is what an assistant must not get wrong.

Lucium is a web browser for macOS, built on Electron. The interface is drawn by the project; pure logic is in `src/shared/`, the main process in `src/main/`, the interface in `src/renderer/` ([docs/architecture.md](docs/architecture.md), in French).

## 1. Open no window without the person's agreement

The person you work for is using the machine. These commands start a real application: they open windows, take the keyboard focus, and some of them last minutes.

| Command | What it does |
|---|---|
| `pnpm dev`, `pnpm start` | Start Lucium **on the real profile** of the installed application (tabs, history, cookies, password vault) |
| `pnpm test:engine`, `pnpm test:engine:webstore`, `pnpm test:engine:extwindows`, `pnpm test:engine:all`, `pnpm test:engine:release` | Start a real Electron and drive it through the engine checks |
| `pnpm verify:app <app>` without `--no-launch` | Starts the built application twice, for a moment, to see it refuse two switches (it opens no window when the build is right; with `--no-launch` it only reads the bundle) |
| `pnpm test:e2e` | Builds the application and drives it with Playwright, some fifteen minutes |
| `pnpm perf`, `pnpm bench:browsers`, `pnpm captures:site`, `pnpm film:site` | Start the application, or other browsers, to measure or to record |
| `electron . --smoke …` | One engine check alone |

Never run one of them on your own initiative. Ask first, say what will open and for how long, and wait for the answer. Never quit, restart or reinstall the Lucium that is installed on the machine.

What you may run freely opens nothing: `pnpm typecheck`, `pnpm lint`, `pnpm test` (Vitest, pure logic). If a change can only be shown by a real application, write the check (`src/main/smoke-*.ts`, `tests/e2e/`), say that you did not run it, and leave the run to the person or to the scheduled workflows (the end-to-end tests every night, the engine chain every week).

## 2. Prove every fix: a test, then a mutation

A fix without a test that fails without it is not done.

1. Write the test that shows the behavior: next to the module, `name.test.ts`.
2. **Remove or invert the fix and run the test: it must fail.** A test that passes with and without the fix protects nothing.
3. Put the fix back; the test passes.
4. Say in the pull request which test proves the fix and that you saw it fail.

The same holds for every guard you add (a size limit, a URL filter, a permission check, a refusal). A change of text or of style alone needs no new test.

No error is swallowed: a `catch` has a visible consequence (a message, a log line with its context, or the error passed on), and a test forces it.

## 3. Every text of the interface in French and in English

The interface is in both languages, read from two catalogues with exactly the same keys: `src/shared/i18n-fr.ts` and `src/shared/i18n-en.ts`.

- A new text gets a key in **both** files, in the same commit, and is read with `t('area.key')`. Never write a visible text in the code.
- Write whole sentences. Do not build one from pieces whose order depends on grammar; a count is a pair `key.one` / `key.other`; no text in an image.
- Translate the meaning, in plain words. French is not a copy of English, nor the reverse.
- `src/shared/i18n.test.ts` fails when a key is in one catalogue only, when the `{variables}` differ, or when French is left in the English catalogue. See [docs/community/translations.md](docs/community/translations.md).

Code comments are in English and say why, not what. The documents of `docs/` are in French, those of `docs/community/` and of the root in English. Documents that exist in both languages change together: `README`, `CONTRIBUTING`, `GOVERNANCE`, `TRADEMARKS`, `CHANGELOG`.

## 4. Colors go through tokens

A stylesheet writes no color of its own, neither a hex value nor `rgb()`.

- Take a role of `src/renderer/tokens.css` (ground, text, border, accent…): the roles follow the light and the dark scheme.
- Only for the few windows that are not on the roles, take a fixed color of `src/renderer/palette.css`, and add one there when none fits.
- `src/renderer/stylesheets.test.ts` refuses a color written in a migrated sheet, and a custom property that does not exist.

## 5. No telemetry, no account, no online AI service

These are principles of the project ([GOVERNANCE.md](GOVERNANCE.md)). Do not add, and do not propose:

- **telemetry**, analytics, usage counters, or a crash report that sends data;
- an **account**, a sign-in, or a synchronization that goes through a server;
- an **online AI service**: no call to a hosted model, no new provider, no assistant, chat or agent in the browser;
- a paid tier, advertising or an affiliate link.

More generally, nothing leaves the machine without the user's explicit choice. A new network call is off by default, has its switch, is listed in the table of connections of the README, and is named in the pull request. If the task seems to need one of the things above, stop and say so instead of building it.

## 6. The rest, in short

- **No reuse.** No code, image, icon, font, sound or text taken from another browser or another proprietary product, and nothing written from decompiled code. Do not reproduce code from memory when you cannot name its license.
- **Structure.** Pure logic in `src/shared/`, which never imports Electron. Every change of the persisted state goes through the reducer (`src/shared/sidebar.ts`). Everything that drives web content or extensions goes through the engine port (`src/main/engine/types.ts`). The main process revalidates every IPC message: a new channel comes with its validation and its test.
- **Secrets.** Never read, print, copy or write the value of a secret, and never put one in the state file, a log, a URL or a test. Do not read the keychain or `~/.ssh`.
- **Dependencies.** Do not add one without saying why: its license must be compatible with GPL-3.0-or-later and recorded in `docs/licences-tierces.md`, and it must have no install script.
- **Lint.** `pnpm lint` is oxlint with the short list of rules of `.oxlintrc.jsonc`. Fix what it reports. An exception is one line with its reason (`// oxlint-disable-next-line <rule> -- why`); never switch a rule off in the configuration, and leave the `lint-witness.ts` files as they are: they break the rules on purpose, to prove the linter still sees it.
- **Scope.** Do what was asked. Report an unrelated problem; do not fix it in the same change.
- **Honesty.** Say what you ran and what you did not, what you verified and what you assume. Do not write in a document that something is in place when it is only planned.

## 7. Git, releases and the sign-off

- Commit, push or open a pull request only when the person asks. Commit messages and pull request titles follow Conventional Commits, in English ([CONTRIBUTING.md](CONTRIBUTING.md#commits-and-pull-requests)).
- Every change reaches `main` through a pull request. Never push to `main`, force-push, or rewrite a published history.
- **The `Signed-off-by` line is the person's statement, not yours.** It certifies the [Developer Certificate of Origin](https://developercertificate.org): only the person who submits the work can make it. Do not add it for them unless they ask, and add no line that credits a tool as an author.
- **Never build, sign, notarize or publish a version.** That is the maintainer's alone, on their Mac ([docs/community/release-process.md](docs/community/release-process.md)): do not run `scripts/build-drm-release.sh`, `scripts/make-dmg.mjs`, `scripts/publish-update.mjs` or `scripts/electron-upgrade.mjs`, and do not add a secret or a signing step to a workflow.

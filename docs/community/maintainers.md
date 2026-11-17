# Maintainers' guide

For whoever reviews and merges: one person today. See [GOVERNANCE.md](../../GOVERNANCE.md) for the roles, the rules of `main` and the decisions.

## Reviewing a pull request

**Response times aimed at** (targets, not guarantees: one maintainer, in their free time):

| Step | Target |
|---|---|
| First human reply to a pull request or an issue (thanks, a question, a label) | 7 days |
| Review of a pull request that is ready and passing CI | 14 days |
| Answer to a contributor who replied to a review | 7 days |
| Security report: acknowledgement / first assessment | 7 / 14 days ([SECURITY.md](../../SECURITY.md)) |
| Pull request waiting on its author with no news | after 30 days, ask whether they want to continue; close after 30 more days, kindly, saying it can be reopened |

If you cannot keep up, say so on the pull request instead of staying silent.

**What a review checks** (the pull request template lists the same points):

1. **Scope and fit.** Does it serve the project's goals? Is it in the excluded scope (AI assistant, online AI service, account, cloud sync, telemetry)? Is it one topic?
2. **No reuse.** Anything that looks copied from another browser or another proprietary product: code, an icon, an image, a font, a string table, a plist? Compare with what the author says in the template. If in doubt, ask for the source. Copied material is removed, and history rewritten if needed.
3. **Conventions** ([CONTRIBUTING.md](../../CONTRIBUTING.md)): pure logic in `src/shared/` and tested; changes through the reducer; engine port respected; IPC revalidated in the main process; every new text in both catalogues, French and English; every new color a token.
4. **Tests.** Every guard has a test. Ask whether the author checked by mutation (removed the guard, saw the test fail). When in doubt, do it yourself: it takes a minute.
5. **Measured UI changes.** UI changes give their values and how they were observed, or say they are a deliberate addition. Observations follow the method of the measuring section of [CONTRIBUTING.md](../../CONTRIBUTING.md#measuring-a-browser-without-touching-your-data) and contain no personal data.
6. **Security.** New IPC channels, new `chrome.*` APIs, new URL schemes, file reads, imports, anything that loads or executes content: read the code, not only the description.
7. **Dependencies and CI files.** Review changes to `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (`allowBuilds`) and `.github/` with extra care: they run code on CI and on every contributor's machine. A new dependency needs its license in `docs/licences-tierces.md` and no install script.
8. **Docs and changelog.** Behavior change means docs updated; user-visible change means a line in the topmost section of the changelog (the version being prepared, or `[Unreleased]`), in `CHANGELOG.md` and in `CHANGELOG.fr.md`.
9. **Privacy of attachments.** Screenshots and logs show no personal data. If they do, ask the author to replace them and edit the comment to remove them.

Be kind and specific. Say what is good. Separate what must change from what is a suggestion. Prefer a question to an order.

## Running the engine test on a pull request

The required checks of a pull request open no window. The engine chain (`pnpm test:engine`) runs in the workflow **Smoke (macOS)**: every week, on a version tag and on demand. The end-to-end tests run in the workflow **E2E**: every night on `main` and on demand. Neither runs on a pull request. The workflow **Linux** (`linux.yml`) is the Linux counterpart: the unsigned AppImage and deb for x64 and arm64, started on an Ubuntu 24.04 runner, and the end-to-end suite under Xvfb. It runs on a pull request that touches the code, every night and on demand, and opens nothing on your machine; read it on a change to the packaging, the sandbox or the platform layer. For a change that touches `src/main/`, windows, menus, extensions or an Electron version bump:

- if the branch is in the main repository (Dependabot's are), run **Smoke (macOS)** from the Actions tab on that branch (*Run workflow*): it runs the chain, the comparison with the reference of the engine and the two suites that run apart; or
- check the branch out locally and run `pnpm test:engine` when you are not using the machine (it opens windows and takes the focus), then `pnpm compat:compare`, which sets the report of the run against `compat/baseline-electron-<version>.json` and lists what the run lost.

The runner is a virtual machine with one screen of 1024 × 768 points at scale 1, which leaves a window about 675 points tall; the checks were written and run on a Retina screen, so some suites cannot pass there. They are named, each with its reason, in `compat/runner-limits.json` (a part of the principal suite as `main:<part>`), and **Smoke (macOS)** does not run them (`LUCIUM_SMOKE_SKIP`): a suite that fails there leaves open what the suites after it are sensitive to. Any other suite that fails stops the run (`scripts/smoke-runner-verdict.mjs`); read the step *Verdict of the chain*, which lists the suites that were not run with their reason. The comparison with the reference (`compat:compare --limits … --informational`) is printed and does not decide on a runner: the reference was recorded on a Retina Mac, and some names carry the scale of the screen. After an Electron bump, that step is the one to read. Nothing on a Mac reads the list or leaves a suite out: `pnpm test:engine`, `pnpm compat:compare` and `pnpm test:engine:release` run and judge every suite, and that is where what the runner cannot show is shown before a release.

Do not run code from a fork on a machine that holds secrets without reading it first.

## Merging

- Merge only when: every required check is green (the five jobs of CI: `Type check`, `Lint`, `Unit tests (Linux)`, `Unit tests (macOS)`, `Build (macOS, unsigned)`; `DCO`: the sign-off of every commit; `PR title`: the form of the title), you have reviewed it, and no conversation is unresolved. When there is more than one maintainer, a maintainer other than the author approves.
- **Squash and merge.** The pull request title becomes the commit subject; read it, and keep the contributor as the author.
- **The squash keeps the sign-off.** The `DCO` check reads the commits of the pull request, and the squash replaces them by one commit: on `main`, the only trace of the certificate is the `Signed-off-by` line of that commit. Before you confirm the merge, read the message GitHub proposes: its last lines must be the `Signed-off-by: Name <email>` of every author of the pull request, as trailers (after a blank line, nothing below them). If they are missing, paste them from the commits of the pull request. Never write one for a contributor who did not sign off: ask them to (`git rebase --signoff main`).
- Delete the branch after merging.
- Thank the contributor. First-time contributors especially.
- Your own changes come by pull request too ([GOVERNANCE.md](../../GOVERNANCE.md#the-rules-of-main)): the same required checks, the same squash merge. While there is one maintainer nobody else approves them: read your own diff as you would read someone else's before merging.
- **Your own commits carry your sign-off, and only yours.** Git has no `commit.signoff` setting (only `format.signOff`, for patches): use `git commit -s`, or a `prepare-commit-msg` hook that adds your `Signed-off-by` with `git interpret-trailers`. A contributor signs their own commits; you never write the line for them, and the squash keeps theirs (above).
- **The first export to the public repository is one commit, signed by the maintainer in their own name**: they are its author and the one who submits it.
- The scheduled runs (the end-to-end tests and the Linux suite every night, the engine chain every week) are not required checks, so nothing stops a merge when one is red: read them, and a release starts by reading them ([release-process.md](release-process.md)).

## Issues and labels

Labels used by the issue forms and this guide (create them once in the repository settings; a label named in a form but missing is silently not applied):

`bug`, `enhancement`, `arc-gap`, `triage`, `community-public`, `needs-triage`, `extension`, `good first issue`, `help wanted`, `needs-info`, `documentation`, `dependencies`, `security` (only for already-public, fixed matters), `out-of-scope`, `duplicate`, `wontfix`.

The board of the public site mirrors the issues labeled `community-public`, which every issue form sets: an issue shows there as soon as it
is opened, with its state and its votes, so that nobody posts it a second time. Remove the label to take an issue off the site (spam,
personal data). How the site receives them (webhook and hourly catch-up) is in the README of the site repository, `lucium-website`.

Triage: remove `triage` once the issue is understood. Ask for what is missing and add `needs-info`. Close with a short, kind explanation when it is out of scope (link [GOVERNANCE.md](../../GOVERNANCE.md)), a duplicate, or when information was requested and nothing came for 30 days. Label small, well-described tasks `good first issue`.

## Dependabot

Pull requests from Dependabot are grouped (Electron, tooling, React, GitHub Actions).

- **Electron bump**: this is how Chromium is updated. Run the engine test (see above), read `pnpm compat:compare`, and record the new reference with `pnpm compat:baseline` once the differences are accepted. Also read the Electron release notes for breaking changes.
- **Any other bump**: read the changelog of major versions; check that the license did not change.
- **`electron-chrome-extensions` bump**: the package is patched (`patches/electron-chrome-extensions@<version>.patch`, named in `patchedDependencies` of `pnpm-workspace.yaml`). The key names one exact version, so Dependabot cannot carry the patch to the next one: its pull request arrives without it, `src/main/shell/extension-patch.test.ts` fails, and an application built that way warns at start-up (`ece-router.ts`). Write the patch again on the branch of the pull request:
  1. `pnpm patch electron-chrome-extensions@<new version>` prints a folder with the files of the new version.
  2. Make in that folder the changes of the old patch (read it: it touches `dist/cjs/index.js`, `dist/esm/index.mjs` and `dist/chrome-extension-api.preload.js`).
  3. `pnpm patch-commit <that folder>` writes the new patch file and its key; delete the old patch file and its key.
  4. Put the new version where the old one is named (`extension-patch.test.ts`, the two messages of `ece-router.ts`), then `pnpm install` and `npx vitest run src/main/shell/extension-patch.test.ts`.
  5. Run the engine test (see above): the extensions are what this package carries.
- **GitHub Actions bump**: pins are commit hashes with the version in a comment; check that the comment and the hash agree.
- **Title of a Dependabot pull request**: Dependabot styles it after the history (the style of its own last commit, else of the recent ones), and nothing in `dependabot.yml` sets the case of the first word: "Bump" with a capital is possible, and the `PR title` check accepts it from the bot only (`pr-conventions.yml`). The squash commit keeps the title as it is; edit it before merging if you want the lower case.

## Code scanning alerts (CodeQL)

The alerts are in Security › Code scanning. CodeQL reads everything but the test harnesses (Vitest tests, the engine test `src/main/smoke*.ts`, their `*test-support*.ts` helpers): none of them is in the application, and `.github/codeql/codeql-config.yml` says why for each, which `src/main/workflow-hygiene.test.ts` keeps true. `scripts/` (the release tooling), `tests/e2e/` and `compat/` stay read.

- **A real flaw** is fixed with a test that fails without the fix ([AGENTS.md](../../AGENTS.md), section 2). Example: the pattern of `sniffImage` that a crafted icon could make take exponential time.
- **A false positive** is dismissed on GitHub with a reason (`false positive`, `used in tests` or `won't fix`) and a comment in English that says which input no third party controls, or why the escaping is right. Never leave one open, never dismiss one without the comment.
- **Met several times, and why they are false here**:
  - `js/bad-code-sanitization` on a script built with `JSON.stringify(value)` (`media-scripts.ts`, `boost.ts`, `site-data.ts`…): the rule fears `</script>`, `<!--` and U+2028 inside code written into an HTML document. These scripts go to `executeJavaScript` or `page.evaluate`, as a string literal that cannot be closed from inside, and U+2028 is valid in one since ES2019. If such a script is ever written into a document, escape `<`, `>`, U+2028 and U+2029 first.
  - `js/insufficient-password-hash` on an HMAC keyed with the output of scrypt (`export-crypto.ts`), or on a hash of the path of the vault (`vault-keychain.ts`): the passphrase never goes through SHA-256 alone, and a path is not a password.
  - `js/incomplete-multi-character-sanitization` in the release tooling (`verify-app.ts`, `mac-sign-order.ts`): XML comments are removed from the property lists of the build the maintainer has just made, to read them; nothing is rendered, and no third party writes them.

## Repository settings to apply once (GitHub)

These are the settings of the public repository, to apply when it is created. They are the rules that [GOVERNANCE.md](../../GOVERNANCE.md#the-rules-of-main) and [CONTRIBUTING.md](../../CONTRIBUTING.md) state: check each against what those documents say.

- Default branch `main`, under a **ruleset** that applies to everyone, administrators included (no bypass):
  - **require a pull request** before merging;
  - **require status checks**, seven of them, under the names of their jobs (a required check whose name matches no job blocks every pull request; a test compares this table with the workflows):

    | Required check | Workflow | What it checks |
    |---|---|---|
    | `Type check` | CI (`ci.yml`) | `pnpm typecheck`: the application, the end-to-end tests, the configuration files and the scripts |
    | `Lint` | CI (`ci.yml`) | `pnpm lint`: the rules of `.oxlintrc.jsonc` |
    | `Unit tests (Linux)` | CI (`ci.yml`) | `pnpm test`, on Linux |
    | `Unit tests (macOS)` | CI (`ci.yml`) | `pnpm test`, on macOS, with the tests that only run there |
    | `Build (macOS, unsigned)` | CI (`ci.yml`) | `pnpm build`, then the application packaged as a folder, unsigned; nothing is kept |
    | `DCO` | Pull request conventions (`pr-conventions.yml`) | every commit of the pull request carries the `Signed-off-by` line of its author |
    | `PR title` | Pull request conventions (`pr-conventions.yml`) | the title follows Conventional Commits |

    The two macOS jobs of CI are skipped while the repository is private (a skipped required check counts as passed): set these rules on the public repository.

    Other jobs run on every pull request and are **not** in the required checks, because [GOVERNANCE.md](../../GOVERNANCE.md#the-rules-of-main) does not list them: `Scan for Secrets` and `Report unverified findings` (Secret Scanning; the second never fails on a finding), and, on a public repository only, `Dependency review` and the four jobs of CodeQL (`CodeQL (javascript-typescript)`, `CodeQL (actions)`, `CodeQL (c-cpp)`, `CodeQL (swift)`). Read them before merging. Requiring one of them is a change of the rules of `main`: it goes into GOVERNANCE.md and into this table in the same pull request;
  - **require linear history** and **signed commits**;
  - **block force pushes and deletion**.
  - Required approvals: none while there is one maintainer (GitHub does not let an author approve their own pull request: one required approval would block every pull request of the maintainer). One, from a code owner, as soon as there are two maintainers.
  - To check on the first pull request of a contributor: that a squash merge is accepted under *signed commits* when the person who merges is not the author.
- What opens a window is **not** in the required checks, and runs on no pull request: `Engine checks (macOS, Apple silicon)` (Smoke (macOS): every week, on a tag `v*` and on demand; the engine chain, its comparison, the two suites run apart and the unsigned application) and `playwright` (E2E: every night and on demand). Neither are the jobs of Build (draft) (on a tag `v*` and on demand).
- Merge options: allow **squash merging only**; automatically delete head branches. The pull request title is the subject of the squash commit. For its message, choose the default that carries the messages of the commits, so that their `Signed-off-by` lines are proposed, and check on the first pull request of a contributor that they are there ([Merging](#merging)).
- Enable **Discussions** (the issue forms link to them), **private vulnerability reporting**, **Dependabot alerts and security updates**, and the **dependency graph**.
- Actions: workflow permissions "read repository contents" by default; **require approval to run workflows from fork pull requests** (at least for first-time contributors).
- Secrets: **none, and none to add.** No workflow signs, notarizes or publishes, so none needs a secret ([release-process.md](release-process.md#signing-and-notarization)). The signing identity, the notary profile and the access to the update server stay on the maintainer's Mac.
- Two-factor authentication is required for all maintainers.
- When the repository is made public, check that the CodeQL workflow starts (it is skipped on a private repository); the checklist is in [release-process.md](release-process.md#publishing-the-repository).

## Repository address

The public repository is `https://github.com/pOwn3d/Lucium`. It starts from one commit that holds the tree and no earlier history ([public-repository.md](public-repository.md), [release-process.md](release-process.md#publishing-the-repository)). Its address is written in these places:

- the application reads it from `REPOSITORY_URL` in `src/shared/about.ts` (the links of the About group: source, issues, releases);
- the site server reads `GITHUB_OWNER` and `GITHUB_REPO` (defaults `pOwn3d` and `Lucium`, set in the environment of the server: the README of the site repository);
- the documents, the issue templates, the site pages, `electron-builder.yml` (`extraMetadata.homepage`) and the user agents of `scripts/electron-watch.mjs` and `scripts/electron-upgrade.mjs` carry it as text.

To change the address, replace it everywhere at once, then run the tests:

```bash
git grep -l 'pOwn3d/Lucium' | xargs sed -i '' 's#pOwn3d/Lucium#OWNER/REPO#g'
pnpm test
```

## Handling conduct and security reports

Conduct reports arrive at contact@lucium.app: [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md) describes the steps. Keep them confidential. A report about the only maintainer has no independent reader inside the project, and the Code of Conduct says so.

Security reports arrive at contact@lucium.app and through GitHub's private vulnerability reporting: [SECURITY.md](../../SECURITY.md) gives the response times aimed at. Work in a private advisory fork, and publish the advisory and a changelog entry with the version that carries the fix.

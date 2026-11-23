# Release process

How a version of Lucium is published: what people download, where it is made, and what GitHub holds.

**Who.** The maintainer alone builds, signs, notarizes and publishes a version, on their own Mac ([GOVERNANCE.md](../../GOVERNANCE.md)). No workflow does any of it and none holds a signing, notarization or server secret. Nobody else publishes.

**State today.** The 0.2.x versions were published on lucium.app only, from the private repository that came before the public one: they have no tag and no GitHub Release. Tags and Releases start with the public repository. The Release workflow has therefore never run on a tag: the first public version is its first real run. Until then, only its script that reads the sums is run, by the unit tests, on annotations made for them (`src/main/workflow-hygiene.test.ts`); what can be tried on GitHub is [below](#try-the-release-workflow-without-releasing-once-before-the-first-tag).

## What a release is

- **The download of reference is the disk image published on lucium.app**: `Lucium-X.Y.Z-arm64.dmg`, signed with the project's Developer ID, notarized by Apple, the ticket stapled ([The disk image](#the-disk-image)). It is what the download page of the site offers, and the only download the project points to.
- **The update archive**, `Lucium-X.Y.Z-arm64.zip`, holds the same application. The update feed of lucium.app names it, and installed copies fetch it from there ([Updates of the DRM variant](#updates-of-the-drm-variant)). It is made by `scripts/build-drm-release.sh --notarize`: the DRM variant (the Electron of castLabs), signed by EVS, then with the Developer ID, notarized, stapled ([docs/drm.md](../drm.md), sections 4, 8 and 12).
- **A signed, annotated Git tag `vX.Y.Z`** on `main` (or `vX.Y.Z-beta.1` for a pre-release), following [Semantic Versioning](https://semver.org). Its annotation carries the SHA-256 sums of the disk image and of the update archive: a sum written there is bound to the tag and signed with it, and does not come from the server that serves the file. Below 1.0.0 any version may change behavior or the state file format.
- **A GitHub Release** on that tag. It holds the notes (the matching section of [CHANGELOG.md](../../CHANGELOG.md)), the SHA-256 sums of the disk image and of the update archive, written in the notes and read from the annotation of the tag, and a link to the download page of lucium.app. **It holds no file and no application, with one exception** ([the unsigned beta of Windows and Linux](#the-one-exception-the-unsigned-beta-of-windows-and-linux)): neither a build made by CI, nor a copy of the files of the site, nor a `.sha256` file. One place serves the application; the sums of the Release let anyone check what they downloaded there.
- Versions below 1.0.0, and versions with a suffix, are flagged *pre-release* on GitHub.

Nothing of the build is in CI: the EVS account, the Developer ID and the notary profile stay in the keychain of the maintainer's Mac.

[`.github/workflows/release.yml`](../../.github/workflows/release.yml) runs when a tag `v*` is pushed. It builds nothing and installs nothing. It checks that the tag is the version of `package.json`, that the tag is annotated, that its annotation holds the sum of a file of the version (and never two different sums for one file), and that the changelog has a section for the version. Then it creates the Release as a **draft, with the notes and no file**: the notes are the section of the changelog, the link to lucium.app, the sums, and whether GitHub could verify the signature of the tag. Nothing is public until the maintainer publishes the draft.

**Never attach an application to a Release, least of all one a workflow built.** What a workflow builds is unsigned: nothing seals `app.asar` (the integrity fuse compares it with a hash kept in `Info.plist`, which can be rewritten with it), the keychain helper refuses the app (no Touch ID for the password vault), the helper of the system's translation is accepted on its identifier alone, and Gatekeeper's warning teaches people to bypass it. It is also not the variant that plays protected videos. Such a build is a check that the commit builds, kept as an artifact of the run and named as unsigned; the workflow attaches no file, and a test keeps it so (`src/main/release-chain-files.test.ts`).

### The one exception: the unsigned beta of Windows and Linux

The rule above has **one exception, and only this one**: the Windows installer and the Linux packages (`.deb` and AppImage) of a version published as an **unsigned beta** may be attached to the Release of that version. Nothing else may: the Mac application, the disk image and the update archive stay off the Release, and no other build of any system is ever attached.

**Why.** On 18 November 2026 the maintainer decided to publish Windows and Linux as a beta (version 1.1.4, `docs/plateformes.md` section 8.3). There is no signing certificate for Windows, nothing of these builds is signed, and the sole place that serves the Mac download, lucium.app, does not serve them: the Release is where they can be hosted, checked against published SHA-256 sums and linked from the download page today. The rule's reasons are kept by the conditions below, not by leaving the files out: the people who download them are told they are unsigned (SmartScreen warns on Windows; the notes and the download page say so), they get no promise of automatic updates, and the files are not presented as the reference build.

**Conditions.** All of them, each time:

- The files are built by the CI workflows `windows.yml` and `linux.yml`, started by hand on the **tag** of the version (never on `main`), with no secret and no signing step, and each file is **copied, not rebuilt**. `release.yml` still attaches nothing, and `build.yml` still keeps its check builds as artifacts of the run: a test keeps it so (`src/main/release-chain-files.test.ts`). A person attaches the files, with `gh release upload`, after the Release is published.
- Each file is named `…-beta-unsigned.<ext>`, and a `SHA256SUMS` file lists them. Each sum is checked against the log of the CI run that built the file and against the digest GitHub computes for the upload.
- The Release notes say, in a section of their own and without removing anything the workflow wrote, that Windows and Linux are a beta and unsigned.
- The download page of the site shows the same sums, the warning of SmartScreen and the fact that updates are done by hand ([docs/plateformes.md](../plateformes.md), section 8.3, « Pour refaire une bêta »).
- This ends when Windows is signed and Windows and Linux have been tried on real machines: they are then released like the Mac, and this section is removed.

## Try the release workflow without releasing (once, before the first tag)

The workflow runs on a tag and nowhere else: started by hand on a branch, it stops at its first step. So nothing of it can be tried on GitHub before a tag exists, and the first tag pushed creates a draft. A draft is public to nobody: if it is wrong, delete it and the tag, fix the cause and tag again.

1. Once a tag exists: Actions tab > **Release** > *Run workflow*, and choose that **tag** in *Use workflow from*. It runs the same checks and writes the notes on the page of the run. It creates no Release and no tag.
2. Read the notes on the page of the run: the section of the changelog, the link to lucium.app, the two sums.

## Steps for a release

1. **Check the state.** The required checks of `main` are green. Run the **Smoke (macOS)** workflow manually on the commit the version starts from, and read the result: it is the one macOS workflow of the engine checks ([smoke-macos.yml](../../.github/workflows/smoke-macos.yml): unit tests on macOS, `pnpm test:engine`, `pnpm compat:compare` against `compat/baseline-*.json`, `pnpm test:engine:webstore`, `pnpm test:engine:extwindows`, `pnpm package`, on a macOS runner on Apple silicon, with the standard Electron). The runner has a screen of 1024 × 768 at scale 1, so the suites that still cannot pass there, named in `compat/runner-limits.json`, are not run by that workflow (the step *Verdict of the chain* lists them with their reason): they are judged at step 6, on the Mac. It starts by hand (Actions tab > *Smoke (macOS)* > *Run workflow*), every week and on every pushed tag `v*`, so the tag of the version gets a second run of it. Read the last night of the end-to-end tests too (workflow **E2E**), or start it by hand if the commit is newer than the night. Both open windows and never have to run on the maintainer's Mac.
2. **Decide the version.** Breaking change of the state file, settings or shortcuts: raise the minor (below 1.0.0). Otherwise the patch.
3. **Prepare the changelog.** In [CHANGELOG.md](../../CHANGELOG.md) and [CHANGELOG.fr.md](../../CHANGELOG.fr.md), the topmost section becomes `## [X.Y.Z] - YYYY-MM-DD`: replace `Unreleased` by the date in the heading of the version being prepared (`## [1.0.0] - Unreleased`), or rename `## [Unreleased]` when the changes were gathered there. Update the links at the bottom, and the table of supported versions in [SECURITY.md](../../SECURITY.md) (the new version is the one supported; the previous one is not). The release workflow **fails if the section for the version is missing or empty**; the notes of the update feed are the first paragraph of the French section.
4. **Bump the version** in `package.json` (`"version": "X.Y.Z"`). The workflow fails if the tag and this version differ.
5. **Open the pull request** `chore(release): vX.Y.Z` with those files, and merge it once its required checks pass: a release commit reaches `main` like any other change ([GOVERNANCE.md](../../GOVERNANCE.md#the-rules-of-main)).
6. **Run the engine suites on the merged commit**, on a Mac that is not in use (they open windows for a long while): `pnpm test:engine:release`. It runs the chain, its comparison with the reference of the engine, and the two suites that run apart, then writes `out-engine/release-run.json` with the commit and the result of each. The publication reads that record and refuses a version whose suites did not pass on the commit it was built from ([The conditions of a publication](#the-conditions-of-a-publication)). It starts nothing while a tracked file is modified, or while a file Git does not track lies in `src/`, `resources/`, `native/` or `build/`.
7. **Build on the Mac**, from that same commit, the working tree clean, `node_modules` installed by `pnpm install --frozen-lockfile` alone (the script refuses one npm has touched), Lucium closed: `LUCIUM_SIGN_IDENTITY="Developer ID Application: …" LUCIUM_KEYCHAIN_PROFILE=… LUCIUM_NOTARY_PROFILE=… scripts/build-drm-release.sh --notarize --no-install --update-feed https://lucium.app/updates/darwin-arm64/feed.json --test-feed https://test.lucium.app/updates/darwin-arm64/feed.json` ([docs/drm.md](../drm.md), sections 4 and 12; the three variables are names, never secrets, and must be the same for every build a feed serves). `--update-feed` is the stable channel, `--test-feed` the test channel: **both** addresses are sealed into every build, whichever channel the version is published to first. The script refuses to go on at the first failure: castLabs' fuse set checked before EVS, `evs-vmp verify-pkg` before and after the Developer ID signature, `codesign --verify --deep --strict`, Apple's answer `Accepted`, `stapler validate`, `spctl --assess`. It writes the update archive, `dist-drm/Lucium-X.Y.Z-arm64.zip`, and beside it the **build record**, `dist-drm/Lucium-X.Y.Z-arm64.build.json`: the commit the archive was built from and its SHA-256. It also writes `dist-drm/Lucium-X.Y.Z-arm64.zip.sha256`, the line `shasum -a 256` prints for the archive named without its folder: no sum is made by hand.
8. **Check the built app**: `pnpm verify:app dist-drm/mac-arm64/Lucium.app` ([Checking the built app](#checking-the-built-app)). It reads the bundle (signature, identifier, version, engine, entitlements, provisioning profile of the keychain service, notarization, license texts, no file of the tests), then starts it twice, for a moment and without a window, to see it refuse `--smoke` and `--remote-debugging-port`. Every line must say `ok`.
9. **Make the disk image**, the download of reference, from that very app: `node scripts/make-dmg.mjs` writes `dist-drm/Lucium-X.Y.Z-arm64.dmg` and its `.sha256` ([The disk image](#the-disk-image)).
10. **Test it on a clean Mac** before anything is published, installed from the disk image: first launch without any warning; open a page, the Settings; **Netflix plays 30 s** (no version is published if it does not); Touch ID unlocks the vault; a local HTML file and a local PDF open; quit; check the default-browser registration from `/Applications`. A different Mac or user account than the one that built it is best. If you cannot, say so in the notes. Try the extensions of the checklist below on the same build.
11. **Tag** the merged commit on `main` with a signed, annotated tag whose annotation carries the two sums, check it, then push it:

   ```sh
   git tag -s vX.Y.Z -m "vX.Y.Z" -m "$(cat dist-drm/Lucium-X.Y.Z-arm64.dmg.sha256 dist-drm/Lucium-X.Y.Z-arm64.zip.sha256)"
   git tag -v vX.Y.Z          # the signature, and the annotation with its two lines of sums
   git push origin vX.Y.Z
   ```

   `-s` makes the annotated tag that `-a` makes, and signs it. The workflow keeps the lines of the annotation that are exactly `<64 hexadecimal digits>  Lucium-X.Y.Z-arm64.dmg` or `…-arm64.zip`, as `shasum -a 256` prints them for a file named without its folder: this is why the build script and `make-dmg.mjs` run `shasum` inside `dist-drm/`. A line that names `dist-drm/Lucium-…` is not read. A tag without annotation, or whose annotation names no file of the version, fails the run.
12. **Wait for the workflows.** The tag starts four of them. **Release** creates the **draft** Release with the notes and no file. **Build (draft)** type-checks, runs the unit tests and packages the tagged commit, unsigned, with nothing kept. **Smoke (macOS)** runs the engine checks again. **SBOM** lists the dependencies. If Release fails, fix the cause, delete the tag (`git push --delete origin vX.Y.Z` and locally) and the draft if one exists, and tag again.
13. **Read the draft.** Its notes end with the two sums, read from the annotation of the tag, and say whether GitHub verified the signature of the tag. Compare them with the two `.sha256` files of `dist-drm/`. Attach nothing to the draft: neither a `.sha256` file, nor the disk image, the archive or any other build (the beta files of Windows and Linux, when the version has them, are the [one exception](#the-one-exception-the-unsigned-beta-of-windows-and-linux): attached by hand to the published Release, never to the draft).
14. **Publish the update on the test channel** with one command, `node scripts/publish-update.mjs` (try it first with `--dry-run`): the archive on the update server, checked online, the disk image and its sum beside it, then the feed that names the archive ([Publishing the update](#publishing-the-update)). It first reads [the conditions of a publication](#the-conditions-of-a-publication), and ends by adding a line to the journal.
15. **Let the version stay on the test channel, one day at least, and try it there.** On a copy that follows the test channel ("Receive test versions"), in real use: **Netflix plays**, **Touch ID unlocks the vault**, and **the update from the previous version installs** (start from the previous version, let it offer this one, click "Install", check the version in the About window). Then fill in the attestation beside the archive, `dist-drm/Lucium-X.Y.Z-arm64.attestation.json` ([The lock between the channels](#the-lock-between-the-channels)).
16. **Publish the same archive on the stable channel**: `node scripts/publish-update.mjs --channel stable` (first with `--dry-run`). It refuses a version that was not published on the test channel, this very archive, a day ago or more, and a version whose attestation is missing or incomplete.
17. **Check what the site serves.** Download the disk image from lucium.app, in a browser, so that macOS adds the quarantine mark. Then `shasum -a 256 Lucium-X.Y.Z-arm64.dmg`, compared with the sum in the notes of the draft, `spctl -a -t open --context context:primary-signature -v` on the image (`accepted`, `source=Notarized Developer ID`), and on the app it holds, `LUCIUM_TEAM_ID=<team> pnpm verify:app "/Volumes/Lucium X.Y.Z/Lucium.app" --no-launch` (the same checks as at step 8, on what people download; `--no-launch` because a mounted image is only read).
18. **Update the Homebrew cask**, once the tap exists ([homebrew.md](homebrew.md)), and only now that the disk image is on lucium.app and checked: `node scripts/make-cask.mjs --tap <checkout of pOwn3d/homebrew-lucium>` writes `Casks/lucium.rb` from the image, its sum and the two records of the release (it refuses an image whose sum is not its own, and a build or an image the records do not show notarized). In the tap: `brew style --cask Casks/lucium.rb`, commit, push. Then try it on a Mac: `brew update`, `brew upgrade --cask --greedy pOwn3d/lucium/lucium` (or `brew install --cask pOwn3d/lucium/lucium`), and launch Lucium once.
19. **Publish the draft Release.** Read its notes first: they link to the download page of lucium.app, and they describe no file that the Release does not hold.
20. **After:** open a new `## [Unreleased]` section at the top of both changelogs for the next changes; announce in the Discussions.

Hot fix: same steps with a patch version, from `main`. There is no maintenance branch: only the latest release is supported ([SECURITY.md](../../SECURITY.md)). A security fix that cannot wait a day on the test channel goes to stable with `--security-fix "<reason>"`: it is still published on the test channel first and attested, and the reason is kept in the journal ([The lock between the channels](#the-lock-between-the-channels)).

## Extensions to try by hand before each release

The engine tests load probe extensions written for them, never the real ones, and the real ones change without notice. At step 10, install each of these from the Chrome Web Store in the built app and check its line. One line each: what to do, and what must happen. Use test accounts for the password managers, and launch the build with `--user-data-dir="$(mktemp -d)"` if you do not want it to touch your own profile. What is expected without the desktop application (biometric unlock, `nativeMessaging`) is in [extensions-compatibilite.md](../extensions-compatibilite.md): it is not a failure here.

| Extension | Do | Must happen |
|---|---|---|
| Dashlane | On a page with a login form, open the popup, unlock it with the master password, click the login field and choose the suggestion | The popup opens and unlocks; the identifier and the password are filled in the form |
| Bitwarden | On a page with a login form, open the popup, unlock it with the master password, then use the autofill of the popup (or the inline menu of the field) | The popup opens and unlocks; the identifier and the password are filled in the form |
| 1Password | Signed in with the account password (no desktop application), open the popup, then fill a login form from the suggestion of the field | The popup opens and unlocks; the login is filled in the form |
| uBlock Origin Lite | Open a page known for its ads, open the popup, switch the filtering of the site off, reload, switch it on again, reload | With the filtering on the ads are gone and the popup shows the filtering level of the site; with it off they come back |
| Dark Reader | Open a light page, switch Dark Reader on from the popup, then off | The page turns dark at once, and light again when switched off; the choice is kept after a reload |
| Grammarly | Signed in, type a sentence with a spelling mistake in a text field of a page (a comment box, a mail form) | The mistake is underlined in the field and Grammarly's card offers the correction |

If a line fails, note the extension, its version and what happened, check whether the previous release did the same (the engine, an update of Electron, or the extension itself), and decide before publishing anything. A regression of the engine blocks the release; an extension that changed on its own side does not, but is reported in [extensions-compatibilite.md](../extensions-compatibilite.md).

## Publishing the repository

Once, before the repository is made public. The public repository is not the private one opened: it starts from **one commit**, an export of the tree with no earlier history.

The export is made by `node scripts/export-public.mjs`, and [public-repository.md](public-repository.md) says what it does and why:

- It is `git archive HEAD`, which leaves out every path that `.gitattributes` marks `export-ignore` (the maintainer's notes and working plans). `src/main/public-tree.test.ts` lists what it holds and refuses anything internal in it: an internal note, a home folder, a key, a host or a tool of the maintainer.
- The private repository is never added as a remote of the public one, and none of its branches or tags is pushed there. The script adds no remote and pushes nothing.
- The author and the committer of the first commit are GitHub noreply addresses, and the commit is signed.

What the script checks before it makes the commit (`--check` makes the same controls and creates nothing):

- The working tree is clean and `HEAD` is the commit that was read.
- A secret scan of the **whole tree**, unverified findings included (not only the commits of a push, and not only the secrets a service confirms).
- No internal path, no key file, no home folder, host or tool of the maintainer, no finding of an unpublished report, no former name of the project.
- The identity and the signature above, and a ceiling on the weight of the tree.

What stays to check by hand on the exported tree:

- A search for personal data that no rule names: e-mail addresses other than the project's (`contact@lucium.app`), host names, private notes.
- No file comes from another browser or another proprietary product, and every third-party component is in [docs/licences-tierces.md](../licences-tierces.md); `THIRD-PARTY-NOTICES.txt` is regenerated (`pnpm notices`).
- [LICENSE](../../LICENSE), [NOTICE](../../NOTICE) and [TRADEMARKS.md](../../TRADEMARKS.md) are there, and the copyright line is the same in NOTICE, in the About window and in the package metadata. What NOTICE says is not settled yet (the license of the background videos) is settled, or the files are left out.
- The governance documents say what is in place: [GOVERNANCE.md](../../GOVERNANCE.md), [CONTRIBUTING.md](../../CONTRIBUTING.md), [SECURITY.md](../../SECURITY.md), [SUPPORT.md](../../SUPPORT.md), [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md), [AGENTS.md](../../AGENTS.md), each read against the settings below.
- The README says how to build without a DRM account: the standard build, what it lacks, and that the published builds are the maintainer's.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass on the export itself, unpacked in an empty folder.

On GitHub, when the repository exists:

- Apply the settings of [maintainers.md](maintainers.md#repository-settings-to-apply-once-github): the ruleset of `main` (pull request required for everyone, required checks, linear history, signed commits), squash merging only, Discussions, private vulnerability reporting, two-factor authentication. Create the labels.
- Check that each required check has the name of a job that exists (the five jobs of CI, `DCO` and `PR title`: [maintainers.md](maintainers.md#repository-settings-to-apply-once-github)), and that every workflow of `.github/workflows/` has run once: the checks of a pull request, the DCO and title checks, the security workflows (CodeQL and the dependency review are skipped while a repository is private).
- Open a trial pull request from a fork: the required checks start after approval, a commit without sign-off and a badly formed title are both refused, the squash merge is accepted, and the squash commit on `main` carries the `Signed-off-by` line.
- Write to `contact@lucium.app` and check that both arrive.
- Read what the Release workflow can and cannot try before the first tag ([above](#try-the-release-workflow-without-releasing-once-before-the-first-tag)).
- Set the address of the repository wherever it is written ([maintainers.md](maintainers.md#repository-address)). The site links to the repository only from that day.

## Signing and notarization

Every change comes through a pull request; **the production build and the publication of an update are the maintainer's alone**, made on their Mac after reviewing and checking everything that goes in. The DRM variant, the build people download, is signed and notarized there: EVS, then the Developer ID identity of that Mac's keychain, then Apple's notary service with a keychain profile (`scripts/build-drm-release.sh --notarize`, [docs/drm.md](../drm.md), sections 8 and « Notarisation »), then published with `scripts/publish-update.mjs` (below). This is a decision, not a step left to take: no workflow signs, notarizes or publishes an update, and no workflow holds a signing, notarization or server secret. Do not add one.

- The Developer ID certificate and the App Store Connect key stay in that Mac's keychain and in a password manager, never in the repository (`.gitignore` blocks `*.p12` and `*.p8` as a safety net). Renew the certificate before it expires. What to do if one of them leaks: [If a signing key or a session is compromised](#if-a-signing-key-or-a-session-is-compromised).
- The Electron upgrade notarizes on that Mac too: `node scripts/electron-upgrade.mjs <version> --sign --notarize` (or `pnpm electron:upgrade …`) uses the keychain profile named in `LUCIUM_NOTARY_PROFILE`, made once with `xcrun notarytool store-credentials <name>`. The step runs only with `--notarize` (`NOTARIZATION_ENABLED` in the script turns it off altogether).
- Before handing a build out: `pnpm verify:app <Lucium.app>` ([Checking the built app](#checking-the-built-app); it runs `codesign --verify --deep --strict`, `spctl --assess --type execute` and `xcrun stapler validate`, among others), then a first launch from a downloaded copy without any warning.

Whatever a workflow builds is **not signed** and is attached to no Release by a workflow (above, save [the beta of Windows and Linux](#the-one-exception-the-unsigned-beta-of-windows-and-linux), whose files a person attaches): it only proves that the commit builds.

## Updates of the DRM variant

A DRM build made with `scripts/build-drm-release.sh --notarize --update-feed <https address>` carries the address of a release file (Squirrel.Mac's `json` format) and installs a newer version from it, through Electron's `autoUpdater`, **only after the user's click**: "Install" in the notice of the background check (which reads that address 20 s after launch then once a day while "Check for updates automatically" is on, the default), or Lucium › Check for Updates…. The built application never installs from any other address (not `LUCIUM_UPDATE_FEED`, not the `updateFeedUrl` setting). `--update-feed` is the stable channel; adding `--test-feed <https address>` seals a second address, the test channel, which the "Receive test versions" setting (off by default) picks instead. The full procedure, in French, is [docs/drm.md](../drm.md), section 12. What a release needs:

- **The same signing variables for every build a feed serves.** `LUCIUM_SIGN_IDENTITY` names the Developer ID identity: Squirrel checks the downloaded app against the designated requirement of the running one (same identifier, same team), so set it rather than let the script take the first identity of the keychain. `LUCIUM_KEYCHAIN_PROFILE` is the provisioning profile of the keychain helper: an update built without it would install a helper without its entitlements, and Touch ID would stop working. `LUCIUM_NOTARY_PROFILE` names the `notarytool` keychain profile. All three are names or paths, never secrets.
- **The same fuses.** `--update-feed` is refused with `--original-fuses`: every build a feed reaches keeps castLabs' set, the one that encrypts the cookies.
- **A higher version.** The version is `package.json`'s; `ElectronSquirrelPreventDowngrades` (electron-builder.yml) makes Squirrel refuse an older one.
- **The archive, then the file.** `node scripts/make-update-feed.mjs dist-drm/Lucium-<version>-arm64.zip <https folder of the channel>/ > dist-drm/feed.json` writes the release file from the notarized archive (version, address, size, SHA-256, date, and short notes in French and in English: the section of the version in `CHANGELOG.fr.md` and in `CHANGELOG.md`, cut after a whole title when they are long). An interface in English shows the English notes and opens the English download page; a Lucium older than 1.0 does not know that part of the file and keeps the French one. Publish the archive first, check it (`curl -sI`, its SHA-256), then the file. `node scripts/publish-update.mjs` does all of it (next section).
- **A signed feed.** From 1.0 on, a copy believes a release file only when a key built into it signed that file: without a valid signature it offers no update and says of no version that it was withdrawn, on the stable channel, on the test channel and for an address given by hand alike. `scripts/publish-update.mjs` signs the file; a file written by hand is not signed. The key, its backup and its change are in [The key of the update feed](#the-key-of-the-update-feed).
- **A stable address.** It is built into every installed copy: moving it means publishing, at the old address, a build that carries the new one.

## The disk image

`node scripts/make-dmg.mjs` makes the download of reference, the one the site offers to people who do not come through the update feed: `dist-drm/Lucium-<version>-arm64.dmg`, a disk image that holds `Lucium.app` and a link to `Applications`, signed with the Developer ID, notarized by Apple and stapled, and `dist-drm/Lucium-<version>-arm64.dmg.sha256` beside it (the line `shasum -a 256 -c` reads), with `dist-drm/Lucium-<version>-arm64.dmg.json`, a record that stays on the Mac: the sum of the image and the sum of the executable of the app it holds, which the publication compares with the archive. It is made of the app that the build already notarized, `dist-drm/mac-arm64/Lucium.app` (the one the update archive holds), never of a rebuilt one.

```sh
node scripts/make-dmg.mjs --dry-run   # every command printed, none that copies, signs or sends run
node scripts/make-dmg.mjs             # a few minutes: Apple's notary service answers in the middle
```

It needs the identity and the profile of the build, both names and never secrets: `LUCIUM_SIGN_IDENTITY` (a `Developer ID Application: …` identity of the keychain; without it, the first one, as `scripts/build-drm-release.sh` chooses) and `LUCIUM_NOTARY_PROFILE` (the `notarytool` keychain profile; `lucium` by default). In order, and stopping at the first thing that is wrong:

1. **Checks the app**: its `Info.plist` has the version of `package.json` and the notarization ticket is stapled.
2. **Copies it** (`ditto`) with a link to `/Applications` into a staging folder of the temporary folder, and checks the copy: same signature (`CDHash`), `codesign --verify --deep --strict`, ticket.
3. **Makes the image** (`hdiutil create -volname "Lucium <version>" -fs HFS+ -format UDZO`), **signs it** (`codesign --sign … --timestamp`) and **has Apple notarize it** (`xcrun notarytool submit … --wait`: the answer must be `Accepted`), then **staples the ticket** (`xcrun stapler staple`, `validate`).
4. **Asks Gatekeeper** (`spctl -a -t open --context context:primary-signature -v`): it must say `source=Notarized Developer ID`.
5. Only then **moves the image to `dist-drm/`** and writes its sum there. The work folder, with its copy of the app, is removed whatever happens, so a run that fails before this step leaves nothing in `dist-drm/`.

`scripts/publish-update.mjs` publishes the image and its sum beside the archive when both files are there ([Publishing the update](#publishing-the-update)).

## Checking the built app

`pnpm verify:app <path of Lucium.app>` checks the application that is handed out, as it is on disk. The suites of the project run from the sources, on the standard Electron: what exists only in the package is checked here, on the bundle itself, whatever the build said of it. It opens no window.

```sh
pnpm verify:app dist-drm/mac-arm64/Lucium.app                            # the app the build made
pnpm verify:app "/Volumes/Lucium X.Y.Z/Lucium.app" --no-launch           # the app of the downloaded disk image, only read
pnpm verify:app <Lucium.app> --team <id>                                 # the build of another team (a modified version)
pnpm verify:app /Applications/Lucium.app --no-launch --any-team          # an installed copy, only read, whoever signed it
```

The team expected is the one that signs the official builds, `9A9AUX9UHT`, which the README publishes (`OFFICIAL_TEAM_ID` in `src/main/verify-app.ts`); `--team <id>` or the environment variable `LUCIUM_TEAM_ID` names another, for a modified version. The team is never read from the signature being checked: it would be the team of whoever signed it. `--any-team` takes its place to look at a copy whose signer is not known: the team is then only compared between the pieces, the output says that the signer was not compared, and it is not the check of a build to hand out. `--any-team` is refused beside a team.

One line per check, `ok` or `FAIL` with what was found; every check is made, whatever the one before found. Exit code 0 when all passed, 1 when one failed, 2 when the arguments are wrong.

| Check | What must be true |
|---|---|
| signature | `codesign --verify --deep --strict` accepts the bundle, every nested piece and every sealed resource. An installed copy that carries the icon chosen in Settings › About and updates › App icon fails it on the Finder attribute of its root, and the line says so: the build handed out carries none ([docs/drm.md](../drm.md), section 8) |
| signer | a Developer ID Application certificate, the hardened runtime, the team of the official builds, or the one named by `--team` or `LUCIUM_TEAM_ID` (with `--any-team`, the team is read from the signature and only compared between the pieces) |
| designated requirement | it names the identifier `app.lucium.browser` and the team: what an update is checked against, and what macOS ties the granted permissions to |
| identifier, version, address schemes, downgrades | `Info.plist` has the identifier of `electron-builder.yml`, the version of `package.json` (or `--version`), the schemes `http`, `https` and `lucium` and no other, and `ElectronSquirrelPreventDowngrades` |
| engine | the framework in the bundle is the stable castLabs build (`+wvcus`) of the Electron pinned in `package.json`, never a prerelease (the rule of the build, `src/main/drm-engine-guard.ts`) |
| fuses | castLabs' set, read in the binary: `RunAsNode`, `NODE_OPTIONS` and the inspector off, the app loaded from `app.asar` only and its integrity checked, the cookies encrypted |
| app.asar integrity, unpacked files, test files | the hash of the header of `app.asar` is the one `Info.plist` seals; every file it leaves outside (the preloads of the pages) is in `app.asar.unpacked`; no engine suite, test helper, test file or test runner is in the package |
| license texts | `LICENSE`, `NOTICE`, `ADDITIONAL-PERMISSION.txt`, `THIRD-PARTY-NOTICES.txt`, `LICENSE.electron.txt` and `LICENSES.chromium.html` are in `Contents/Resources` |
| entitlements | the app and its four helpers are each signed with the exact set of their plist (`src/main/mac-sign-order.ts`): the renderer and GPU helpers keep library validation |
| translation helper | `Contents/Helpers/LuciumTranslate.app` is signed by the team, with no entitlement |
| keychain service, keychain profile | `Contents/XPCServices/LuciumKeychain.xpc` has its own entitlements (`native/vault-keychain/entitlements.plist.in`), and the provisioning profile embedded in it authorizes them: its application, its access group, every Mac, not expired. Without them Touch ID is unavailable |
| Gatekeeper, notarization ticket | `spctl --assess` answers `accepted`, `source=Notarized Developer ID`; `xcrun stapler validate` finds the ticket |
| refuses `--smoke`, refuses `--remote-debugging-port` | started with each switch on a throw-away data folder, the app leaves with code 1 and a line `[launch] refused` that names the switch, and writes no `DevToolsActivePort` |

The last two lines are the only ones that start the app. They are made only when every line above passed (an app that is not the expected build is not run), never with `--no-launch`, and the output then says that the switches were not checked. The data folder of each launch is made for it and removed. The command reads the bundle, runs `codesign`, `spctl`, `stapler` and `plutil` on it, and writes nothing in it; it reads no keychain.

## The conditions of a publication

`scripts/publish-update.mjs` sends nothing until each condition below is met. They are read from files that the steps of a release leave: all local, so `--dry-run` reads them too, and a dry run that passes is a real run that would. The rules are in `src/main/release-gate.ts`, with their tests.

| Condition | The file it reads | What makes it |
|---|---|---|
| The archive holds the app that was checked | `Lucium-X.Y.Z-arm64.zip` and `mac-arm64/Lucium.app` beside it | The same build: the executable in the archive is the built one, byte for byte, so its signature is. An app built again after the archive was made is refused |
| The archive carries no custom icon | `Lucium-X.Y.Z-arm64.zip` (`zipinfo -1`) | No `Lucium.app/Icon\r` in it: the icon chosen in Settings › About and updates › App icon is put on a running copy, and an archive made by hand from such a copy would hand it to every copy it updates. The build archives the app before anything runs it |
| The build has a commit | `dist-drm/Lucium-X.Y.Z-arm64.build.json` (`--build-record`) | `scripts/build-drm-release.sh --notarize` writes it: the commit, the SHA-256 and the size of the archive. Refused: no record, the record of another archive, or a build made while a tracked file was modified or while a file Git does not track lay in a folder the build reads (`src/`, `resources/`, `native/`, `build/`: such a file can be in the archive, and the commit does not hold it) |
| The tag names that commit | `git` | When a tag `vX.Y.Z` exists it must name the commit of the build. No tag is said and kept in the journal, not refused: the versions made before the public repository have none |
| The changelogs carry the date | `CHANGELOG.md`, `CHANGELOG.fr.md` | The heading of the version is `## [X.Y.Z] - YYYY-MM-DD` in both (step 3). `Unreleased` is refused |
| The engine suites passed on that commit | `out-engine/release-run.json` (`--engine-run`) | `pnpm test:engine:release` (step 6). Refused: no record, another commit, a suite that failed, a run that lost a check against the reference |
| For `stable`: the version waited on the test channel | the journal | [The lock between the channels](#the-lock-between-the-channels) |
| For `stable`: the maintainer tried it | `dist-drm/Lucium-X.Y.Z-arm64.attestation.json` (`--attestation`) | [The lock between the channels](#the-lock-between-the-channels) |

No option lifts a condition by habit. Two ways out exist, each with a reason of 20 characters or more, said aloud by the run and written in the journal:

- `--no-engine-run "<reason>"` publishes without the record of the engine suites: for instance when they ran in the **Smoke (macOS)** workflow of the tag (name the run in the reason).
- `--security-fix "<reason>"`, below.

### The lock between the channels

A version reaches the stable channel only after the test channel:

1. **The same archive was published there.** The journal must hold a complete publication of the version on the channel `test`, with the SHA-256 of the archive being published. An archive built again is another archive.
2. **It waited.** That publication is 24 hours old or more. `--min-test-hours <n>` sets another wait, never less than one hour.
3. **It was not withdrawn from there since.** A version [withdrawn](#withdrawing-a-version) from the test channel lost its passage: only the publications of the archive made after the last withdrawal count, and the wait starts again at the first of them. A withdrawal that stopped half way (`partial`) counts as one. `--security-fix` does not lift this. A version withdrawn by mistake is published on the test channel again.
4. **The maintainer attests what was tried on it**, in a file beside the archive, `Lucium-X.Y.Z-arm64.attestation.json`. When the file is missing, the refusal prints it, ready to fill in:

   ```json
   {
     "version": "X.Y.Z",
     "archiveSha256": "<the SHA-256 of the archive>",
     "attestedBy": "<who made the checks>",
     "attestedAt": "2026-11-12T09:30:00Z",
     "checks": {
       "netflixPlays": true,
       "touchIdUnlocksTheVault": true,
       "updateFromPreviousVersion": true
     },
     "updatedFrom": "<the version the update was installed from>"
   }
   ```

   Each check must be `true`: anything else is refused, and the check is named. The attestation is the one of this version and of this very archive, it names who made the checks, and its date is after the version reached the test channel (what is tried is what the channel serves) and not in the future. `updatedFrom` is an earlier version. For a version that no earlier one can update to (a new bundle identifier), `updateFromPreviousVersion` may be `{ "notApplicable": "<why, in 20 characters or more>" }` instead of `true`; the two other checks have no such form.

**A security fix that cannot wait**: `node scripts/publish-update.mjs --channel stable --security-fix "<what the fix closes>"`. It waives the wait and nothing else: the version must still have been published on the test channel, and the attestation must still be complete. The run says what was waived, and the reason is kept in the journal with the publication.

### The journal of the publications

Every publication adds one line to a journal, a file that stays **outside the repository**: `~/Library/Application Support/lucium-secrets/publish-journal.jsonl` by default, the environment variable `LUCIUM_PUBLISH_JOURNAL` or `--journal <path>` for another. Its folder is made when it does not exist. One JSON object per line:

```json
{"at":"2026-11-12T12:00:00.000Z","version":"X.Y.Z","channel":"stable","outcome":"published","holds":"everything","commit":"<40 hexadecimal digits>","archive":{"name":"Lucium-X.Y.Z-arm64.zip","sha256":"…","size":140000000},"dmg":{"name":"Lucium-X.Y.Z-arm64.dmg","sha256":"…","size":150000000},"tag":{"name":"vX.Y.Z","signatureVerified":true},"engineRun":{"endedAt":"…","reportSha256":"…"},"stable":{"testPublishedAt":"…","minTestHours":24,"attestedBy":"…","attestedAt":"…","securityFix":null}}
```

- `at`, `version`, `channel`, `commit`, and the name, SHA-256 and size of the archive and of the disk image (`dmg` is `null` when none was published).
- `tag`: the tag of the version and whether Git verified its signature, or `null`.
- `engineRun`: the run the publication rests on, or `{"waived":"<reason>"}` with `--no-engine-run`.
- `stable`, for the stable channel: since when the archive was on the test channel, the wait that was asked, who attested and when, and the reason of `--security-fix` when it waived the wait.
- `outcome` is `published` when everything is online and checked. A publication that stopped half way adds a line `partial`, whose `holds` says what the server holds; it never counts as a passage through the test channel.

The line is written last, after the feed was read back online. If it cannot be written, the run fails and prints the line to add by hand: the lock of the stable channel reads this file. A dry run writes nothing and shows the line. A line that cannot be read stops a publication on the stable channel until the file is repaired. Keep the file: it is the only trace of what was published, when, and from which commit.

[A withdrawal](#withdrawing-a-version) adds a line of its own to the same file, with a `type` that no line of a publication has:

```json
{"at":"2026-11-21T08:00:00.000Z","type":"withdrawal","version":"X.Y.Z","channel":"stable","outcome":"withdrawn","offers":"earlier version","to":"X.Y.W"}
```

- `offers` is what the channel offers afterwards: `earlier version` (the feed went back to `to`), `unchanged` (the feed offered another version and was left as it was) or `nothing` (`--to none`). `to` is `null` in the last two cases.
- `outcome` is `withdrawn` when the files of the version answer 404 and the feed was checked; `partial` when the withdrawal stopped after it changed the server.
- It is not a publication: it names no archive and no commit, and it never counts as a passage through a channel. It does not stop a later publication on its own channel. A withdrawal from the test channel closes [the lock between the channels](#the-lock-between-the-channels) for that version until its archive is published there again.

## Publishing the update

`node scripts/publish-update.mjs` publishes an update that is already built, in one command. It does by itself what was done by hand (docs/drm.md, section 12), in the same order, and **stops at the first thing that is wrong**, saying what it is and what the server holds at that point. It never publishes the feed unless the archive was published and answers with the right bytes.

```sh
# Before: build with the three variables of the previous section, then check the notes of the version in CHANGELOG.fr.md
LUCIUM_SIGN_IDENTITY=… LUCIUM_KEYCHAIN_PROFILE=… LUCIUM_NOTARY_PROFILE=… \
  scripts/build-drm-release.sh --notarize --no-install \
    --update-feed https://lucium.app/updates/darwin-arm64/feed.json \
    --test-feed https://test.lucium.app/updates/darwin-arm64/feed.json

node scripts/publish-update.mjs --dry-run                    # every command printed, none that touches the network or the server run
node scripts/publish-update.mjs                              # dist-drm/Lucium-<version of package.json>-arm64.zip, on the channel "test"
node scripts/publish-update.mjs --channel stable --dry-run   # the same archive, for the stable channel
```

### The file of the servers

The repository knows, for each channel, its name and its https folder (they are public: every installed copy reads them): `test` is `https://test.lucium.app/updates/darwin-arm64/`, `stable` is `https://lucium.app/updates/darwin-arm64/`. **The server and the folder of each channel are not in the repository.** They are in a JSON file that stays on the maintainer's Mac:

```json
{
  "test": { "host": "user@host", "folder": "/absolute/folder/of/the/test/channel" },
  "stable": { "host": "user@host", "folder": "/absolute/folder/of/the/stable/channel" }
}
```

- `host` is the `user@host` that `ssh` and `scp` connect to; `folder` is the absolute folder of that server that the web server publishes at the https folder of the channel (the archive and `feed.json` are written there). Both are checked before they go into a command: a host that is not `user@host`, a folder that is not an absolute path of plain characters (letters, digits, `. _ - /`, no `..`), a value that is not a string, or any other key (the address is the repository's: a `baseUrl` in the file would only look as if it were used) is refused.
- **The folder may be readable by root only** (its own mode, or a folder above it, keeps the account out). The account of `host` writes it through `sudo -n`, and **reads it through `sudo -n` too**: the names it holds, the feed in place, a kept feed, the weight of an archive, the files to set aside. A read the account made itself would not fail, it would find nothing (a file test is false in a folder nobody may enter), and a channel that offers a version would read as a channel without a feed. When `sudo -n` is refused, the command stops with a status and a message (`cannot read the folder of the channel: sudo -n is refused on the server`), and the channel is not touched. A channel that has no feed yet, or no folder yet, is still read as a channel without a feed.
- **Where it is**: `~/Library/Application Support/lucium-secrets/publish-channels.json` by default; the environment variable `LUCIUM_PUBLISH_CONFIG` names another file, and `--config <path>` comes before both. The script reads that one file and nothing else in its folder, and **never writes it**: create and edit it by hand, and keep it out of every repository.
- **Nothing is guessed.** A missing file, a file that is not one JSON object, or a channel that is not in it is refused, before anything is checked or sent; the message names the file and the shape above. Only the channel being published to is looked at: `stable` may be missing while `test` is published.

What it does, in order:

1. **Checks the build** (local, also in a dry run): the archive is `Lucium-<version>-arm64.zip` for the version of `package.json`; the built app (`dist-drm/mac-arm64/Lucium.app`) has that version in its `Info.plist` and a notarization ticket stapled (`xcrun stapler validate`); the Electron fuses of the built app, read in `Electron Framework`, are those of the installed app (`/Applications/Lucium.app`, only read), cookie encryption included. Optionally `--build-log <file>`, a saved output of the build, must say `Notarized, stapled`.
2. **Reads [the conditions of a publication](#the-conditions-of-a-publication)** (local, also in a dry run): the archive holds the built app, the build record names its commit, the changelogs carry the date, the engine suites passed on that commit, and, for `stable`, the version waited on the test channel and is attested.
3. **Writes `dist-drm/feed.json`** with `scripts/make-update-feed.mjs`, given the https folder of the channel being published (not the other channel's: a build seals both addresses, the release file names only the archive of the channel it is published to), and checks that it names the archive, at that address, with its SHA-256 and its size.
   Then it **reads the feed in place** on the server (through `sudo -n`: a refusal stops the publication here, it is not a channel without a feed), before anything is sent, writes in `dist-drm/feed.json` [the versions withdrawn from the channel](#what-a-copy-on-the-withdrawn-version-is-told) (those the feed in place lists and those the journal shows as withdrawn and not published again; the journal is read here on every channel), and stops when the channel already offers this version with another archive (the archive of a version has one name: installing this one would replace the file the feed in place names, and every copy that installs the update would refuse it until the new feed is there; build under a new number, or `--withdraw` the version first), or when it offers a higher version (a publication never goes back: that is what `--withdraw` does). A version before 1.0.0, the first these channels serve, is refused at step 1.
   Last, it **signs the feed** ([The key of the update feed](#the-key-of-the-update-feed)): the private key is read at this step and at no other, and `dist-drm/feed.json` is written again with its signature. A key that is missing, that other accounts can read, or whose public half is not in `src/main/update-feed-keys.ts` stops the publication here, before anything is sent. A dry run signs too (it shows that the key is there and is the right one) and writes nothing.
4. **Sends** the archive and the feed to a private folder of the server (`scp`), and compares the SHA-256 computed there (`sha256sum`) with the local one. The folder is made first, by `mktemp -d /tmp/lucium-publish.XXXXXXXXXX`, mode `0700`: no other account of the server can read a copy, or put its own file under the name the next steps install, between the check and the installation. The path the server prints is used only when it is such a folder (`/tmp/lucium-publish.` and ten letters or digits, nothing else); anything else stops the publication before anything is sent. The disk image and its sum go to the same folder.
5. **Publishes the archive**: first the folder of the channel is made if it does not exist (`sudo -n install -d -o root -g root -m 755`, which is idempotent: a new channel needs no manual step), then the archive is written under a temporary name and renamed, `root:root` `0644`. It is downloaded back from its address and its SHA-256 and size are compared.
6. **Publishes the disk image and its sum**, when [`scripts/make-dmg.mjs`](#the-disk-image) left `Lucium-<version>-arm64.dmg` and its `.sha256` beside the archive: after the archive, in the same folder, written under a temporary name and renamed the same way. Before anything is sent it checks that the image has its ticket stapled, that the sum is the image's (one line, its name, its SHA-256), and that the image holds the app of the archive: `Lucium-<version>-arm64.dmg.json`, the record `make-dmg.mjs` writes with the image, must name this image and the executable the archive holds (an image left from an earlier build of the same version is refused; so is an image without its record); the copy on the server is hashed, the image is downloaded back from its address and its SHA-256 and size are compared, and the sum read back must be the local one. An image without its sum, or a sum without its image, stops everything before anything is sent. No file, or `--no-dmg`: this step is skipped.
7. **Keeps the feed in place**: the feed the folder holds is read and, when it offers another version than the one being published, copied beside itself as `feed-<its version>.json`. That kept feed is what [a withdrawal](#withdrawing-a-version) goes back to. A feed that cannot be read on the server, or that cannot be copied, stops the publication: the feed is not replaced. A channel with no feed yet has nothing to keep; running the command again for the same version keeps nothing more; a feed in place that is not a release file is kept as `feed.json.replaced`, with a warning.
8. **Publishes the feed** the same way, reads it back from its address and checks `currentRelease`, the address, the SHA-256, the size and the list of the withdrawn versions, and that what the web answers is, byte for byte, the file that was signed (a copy checks the signature on the bytes it receives). The feed does not name the image: no installed copy ever installs it.
9. Removes the private folder of the server (`rm -rf --` on its path; a failure there is only a warning, with the command to run by hand: everything is published and checked). A publication that stops after the folder was made, at any step, removes it too before it says why it stopped.
10. **Adds one line to [the journal](#the-journal-of-the-publications)**.

Options: `--withdraw <version>` and `--to <version>|none`, which publish nothing ([Withdrawing a version](#withdrawing-a-version)); `--dry-run`; `--channel test|stable` (`test` by default: a version goes to the test channel first, then, after [the lock between the channels](#the-lock-between-the-channels), the same archive to `stable`; the server and the folder of the channel come from [the file of the servers](#the-file-of-the-servers)); `--config <path>` (that file, see above); `--no-dmg` (does not publish the disk image even when it is there); `--ssh-key <path>` (default: the environment variable `LUCIUM_PUBLISH_SSH_KEY`, else `~/.ssh/id_ed25519`; passed to `ssh` and `scp` by its path, never opened by the script); `--installed-app <app>`; `--app <app>`; `--build-log <file>`; for the conditions, `--build-record <file>`, `--engine-run <file>`, `--no-engine-run "<reason>"`, `--attestation <file>`, `--min-test-hours <n>`, `--security-fix "<reason>"` and `--journal <path>`. `ssh` and `scp` run with `BatchMode=yes`: they never ask for a password, a passphrase that is not in the agent, or a host key, they fail and say so.

When it stops, the last lines say what the server holds:

- *Nothing is published*: the build, a condition, the copy or the installation of the archive failed. Fix the cause and run it again; the private folder the copies were sent to was removed when the run stopped (when it could not be, a warning above gives the command that removes it).
- *The archive is published and the feed is not*: the archive answered wrongly, or the feed was not installed. No installed copy is offered the update. Run it again.
- *The archive and the disk image are published and the feed is not*: the image or its sum did not answer right, or the feed was not installed. Run it again.
- *The feed is already published, and it does not check out*: look at the feed at its address at once. Put the right file back by running the command again; the feed it replaced is in the folder of the channel, as `feed-<its version>.json`.
- *Everything is published and checked online. Only the journal lacks its line*: add the line the run printed to the journal by hand.

The script does not refuse to replace an archive of the same name that is already published (running it again after a failure is the normal case); do not build a different archive under a version that was published. A version that must no longer be offered is withdrawn: [Withdrawing a version](#withdrawing-a-version).

## Withdrawing a version

A version that breaks something serious (the profile, protected video, a security flaw of its own) is withdrawn: it stops being offered and downloaded. **Nothing makes an installed copy go back by itself**, and nothing should: the installer refuses a bundle older than the running one (`ElectronSquirrelPreventDowngrades`, electron-builder.yml), because a feed that could push an older build could push a vulnerable one. So a withdrawal has three parts, and only the first is one command.

| Who | What a withdrawal changes for them |
|---|---|
| A copy that runs a version **below** the one the feed goes back to | It is offered that earlier version, as before the bad one was published |
| A copy that runs the earlier version | "Lucium is up to date" |
| A copy that already runs the **withdrawn** version | It is told: "This version has been withdrawn", with the version to install ([below](#what-a-copy-on-the-withdrawn-version-is-told)). It still stays on the withdrawn version until its user installs another one: nothing goes back by itself |
| A copy that downloaded the withdrawn version and has not restarted | It drops it once it reads the feed again: at the next background check, at Lucium › Check for Updates…, or when it quits (5 s at most, with "Check for updates automatically" on). It removes the launchd job Squirrel set to install it at the quit and the files Squirrel prepared, says "Version X was withdrawn: it is not installed", and offers the version the feed offers (`docs/drm.md`, section 12). This path is tested on stand-ins only, not yet on a real update. A copy that quits offline, before the feed answers, or with the automatic check off still installs it |
| Someone who downloads from the site | The disk image of the withdrawn version answers 404; the download pages must be pointed to another version (below) |

### 1. Stop offering it: `--withdraw`

```sh
node scripts/publish-update.mjs --withdraw 1.0.2 --channel stable --dry-run   # reads the server, changes nothing, prints what it would run
node scripts/publish-update.mjs --withdraw 1.0.2 --channel stable
node scripts/publish-update.mjs --withdraw 1.0.2                              # the test channel too, if the version is still there
```

It publishes nothing, and uses the same [file of the servers](#the-file-of-the-servers) and the same key as a publication. **It is not a publication**: none of [the conditions of a publication](#the-conditions-of-a-publication) is read, on any channel (no build record, no engine run, no wait on the test channel, no attestation), and the options that name them are refused beside `--withdraw`. A version that must go is not held back. In order, stopping at the first thing that is wrong and saying what the channel offers then:

1. **Reads the channel**: the names of its folder and the feed in place (through `sudo -n`, like every read of that folder). (A dry run does this too: unlike a dry run of a publication, it connects to the server, because there is nothing to check locally. It changes nothing there.)
2. **Puts the feed of an earlier version back**, when the feed offers the withdrawn version. The earlier version is `--to <version>`, else the highest one whose feed the folder keeps (`feed-<version>.json`, kept by each publication: step 7 of [Publishing the update](#publishing-the-update)) below the withdrawn one. Before anything is written it checks that this kept feed is a release file of that version, names the archive of that version in this channel, and that the archive is still on the server with the SHA-256 and the size the feed says. The feed in place is copied aside (`feed-<withdrawn>.json.withdrawn`), the kept feed is written the way a publication writes a feed (a temporary name, then renamed), and it is read back from the web, with a request to its archive, which must answer.
   The feed that is written is the kept one with one thing more: the withdrawn version in its list of withdrawn versions (`withdrawn`, see [below](#what-a-copy-on-the-withdrawn-version-is-told)), with the versions the feed in place and the kept feed listed already. The list is read back from the web with the rest of the feed, and must be the one that was written.
   Either way the feed that is written is **signed again** here, and its source (the kept feed, or the one in place) must be a feed that was signed here: a kept feed without a valid signature (kept before the feeds were signed, or changed on the server) is not gone back to, and the withdrawal stops and says so. Name another version with `--to`, publish a higher version, or take the feed away with `--to none`, which signs nothing.
   A feed that offers **another** version keeps offering it: only the withdrawn version is added to its list, the same way (written under a temporary name, renamed, read back), and nothing else of it changes. A feed that lists the version already is left as it is. That is the case after a fix was published over the bad version, and it is why the command can be run again after a failure.
3. **Sets the files of the withdrawn version aside**: the archive, the disk image, its sum and the kept feed of that version are renamed `*.withdrawn`, in the same folder. The site serves from that folder only names that end with `.zip`, `.dmg`, `.sha256` or `.json`, so they answer 404, which the command checks. Nothing is deleted: remove the `*.withdrawn` files by hand once they are of no use. This step never runs while the feed still names the withdrawn archive.
4. **Adds one line to [the journal](#the-journal-of-the-publications)**, of the type `withdrawal` (`--journal <path>` or `LUCIUM_PUBLISH_JOURNAL` for another file, as for a publication). A dry run writes nothing; a withdrawal that stopped before it changed the server writes nothing; one that stopped after adds a line `partial`. If the line cannot be written once everything is withdrawn, the run fails, says that only the journal lacks its line, and prints it.

What it refuses, leaving everything as it was: a version that is not three numbers; `--to` a version that is not **below** the withdrawn one, or that is before 1.0.0 (the earlier versions are another application, with another identifier: no feed of these channels may name one); a kept feed that is missing, is not the feed of its version, or names an archive that is gone or changed; a feed in place that is not a release file.

**When there is no earlier version** (the first one of a channel is the bad one), there is nothing to go back to and the command says so. `--to none` then takes the feed away: nothing is offered, the background check stays silent, and Check for Updates… says that the check failed (the feed answers 404) until a version is published. It is never the default. A channel without a feed has no list either: the copies on the withdrawn version are told nothing until the next publication, which takes the list from the journal.

A withdrawn version is never gone back to: its kept feed is renamed with its other files, so the next withdrawal skips it. Run `--withdraw` for a bad version **even when a fix was already published over it**, for that reason and for its disk image.

### What a copy on the withdrawn version is told

The feed lists the versions withdrawn from its channel, in a key of Lucium's own that Squirrel.Mac ignores:

```json
{ "currentRelease": "1.0.1", "page": "…", "en": { … }, "releases": [ … ], "withdrawn": ["1.0.2"] }
```

It travels in the feed a copy reads anyway (the daily look, when "Check for updates automatically" is on, and Check for Updates…): **no other request is made**, and a copy with the automatic look off learns it only when its user checks. It is under the same checks as the rest of the feed, no more: read over https from the address built into the application, bounded in size, written by the same command with the same key, and read back from the web after each change. The feed has no signature of its own; the archive it names is what the hash and the code signature protect. A list could at worst make a copy say "withdrawn" and open the download page the same feed names.

| Who writes the list | When |
|---|---|
| `--withdraw` | Adds the withdrawn version to the feed that stays (the one it goes back to, or the one in place when it offers another version) |
| A publication | Carries the list of the feed in place into the new feed, with the versions [the journal](#the-journal-of-the-publications) shows as withdrawn from this channel and not published there again since (what a channel left without a feed could not carry). Never the version being published: publishing a version again is what takes it out of the list |

A copy reads the list only when it is an array of versions of digits and dots; a list that holds anything else is not believed at all. When the running version is in it and the feed offers another version:

- the notice of the daily look says "This version has been withdrawn. Install Lucium X.Y.Z.", under the rules of every notice of an update (at most once a day, three times, never in a private window or during a share);
- Check for Updates… says "This version has been withdrawn" and names the version to install;
- when that version is **above** the running one, "Install" downloads it as any update. When it is **below** (the feed went back), the button opens the download page: Squirrel.Mac installs no older bundle, so the way back is the disk image, by hand ([below](#what-a-user-can-do-meanwhile-and-what-happens-to-their-data)).

Only the versions that read the list say so: a copy of a version published before the list existed still reads "up to date". Never edit the list by hand on the server: a publication or a withdrawal writes it, and the journal is what the next publication adds to it.

### 2. The download pages of the site

The feed does not name the disk image, and the pages of the site that offer it (`/telecharger/`, `/en/download/`) name its file, size and sum by hand. After step 1 their link answers 404. In the repository of the site: point both pages (and the constant of their test) to the version the feed went back to, whose image and sum are still in the folder, and deploy. Do it at once: until then a visitor cannot download anything.

The Homebrew cask names the image too, and answers 404 the same way: in the tap, `git revert` the commit of the withdrawn version and push, so that the cask names the version the feed went back to ([homebrew.md](homebrew.md#at-each-stable-release)).

### 3. The copies that already run it: a higher version

The copies that run the withdrawn version say so and name the version to install, but they change nothing by themselves. Publish a higher version as soon as it can be built: the fix, or, when the fix is not ready, **the code of the previous version under a new number** (check out the tag of the previous version on a branch, raise the version in `package.json`, add its section to the changelogs, build, publish on the test channel, try it, then on stable). It goes through the whole of [Steps for a release](#steps-for-a-release): a build made in a hurry is how a second bad version is published. Until it is out, the copies that run the withdrawn version stay on it.

If the withdrawn version writes something the previous code does not read, that build is "an older version started over the state of a newer one": see below. The number is higher, but the code is older.

### What a user can do meanwhile, and what happens to their data

Someone who cannot wait installs the previous version by hand: its disk image is still at `https://lucium.app/updates/darwin-arm64/Lucium-<version>-arm64.dmg`; quit Lucium, drag the application to Applications, replace. The data folder (`~/Library/Application Support/Lucium`) is not touched by that.

What the application does when a version is started over data another version wrote (`src/main/store.ts`, `keepStateOfOtherVersion`; the state file says which version wrote it):

- **Before it writes anything**, it copies `state.json` (spaces, tabs, folders, settings) to `state.json.version-change-<date>-from-<the version that wrote it>`, beside it. The three most recent such copies are kept. This holds for an update as for a way back.
- **On the way back** (the running version is the older one), it tells the user so at launch, with the place of the copy. An older version reads the file, keeps the settings it does not know, but does not keep what it does not know inside a tab, a space or a folder: the copy is where that survives. If the copy cannot be made (a full disk), the older version writes nothing over the file for that run and says so. While such a copy is kept, the older version deletes nothing that the state no longer names (backgrounds, the storage of containers and of removed profiles).
- **Back on the newer version**, it offers that copy once: Help › Restore Data… with the file named in the message puts it back (after a copy of the current state).
- A state file of a newer **format** (not only a newer version) is not read at all: it is set aside whole (`state.json.future-<time>`), the older version starts with new data and says where the file is; the newer version restores it with Help › Restore Data….

The other files of the profile (history, quick notes, the password vault, the copies of the session) keep their own rules and were not changed for this.

### Rehearse it

This procedure is only worth what its last rehearsal was. Rehearse it on the **test** channel, with two versions that are really published there:

1. `node scripts/publish-update.mjs --withdraw <the higher one> --dry-run`: the kept feed of the lower version is found and checked, the three commands that change the server are printed and not run.
2. The same without `--dry-run`, then on a Mac that runs the lower version with "Receive test versions" on: Check for Updates… says "up to date". On a copy of the higher version: "up to date" too, and nothing is downloaded.
3. Publish the higher version again (`node scripts/publish-update.mjs`): the archive, the image and the feed come back under their names, and the copy of the lower version is offered it. Remove the `*.withdrawn` files of the folder by hand. Its wait before the stable channel starts again from this publication.
4. Once, with a throwaway profile: start the higher version, then the lower one over the same data folder, and read the message and the copy; then the higher one again, and restore the copy it offers.

## The key of the update feed

The server that holds `feed.json` is not the party an installed copy believes. A copy believes a feed when one of the public keys compiled into it signed that feed. Without that, whoever can write on the server, or answer in its place, could offer a "version", name a download page of their own, or tell every copy that its version was withdrawn.

**What the signature covers, and what it does not.** It covers everything Lucium itself reads and shows: the version offered, its notes, its size, the download page, and the list of withdrawn versions. A feed without a valid signature is refused whole: nothing is offered, no version is said withdrawn, Check for Updates… says "The update feed has no valid signature: no update is offered.", the background check shows nothing, and one line goes to the error log (Settings › About and updates › More settings › Lucium status) with the address and the reason. It does **not** cover the second reading of the feed that Squirrel.Mac makes by itself when the user clicks "Install": that reading is protected as before, by the Developer ID signature of the archive (same identifier, same team), by the size and the SHA-256, and by the refusal of an older version. Nor does it stop someone from serving again an older feed that was signed in its day: such a feed offers a version that is not above the running one, so nothing is installed from it, but it does not carry the versions withdrawn since.

**Where the signature is.** In the file itself, as its last key, so that the feed and its signature are replaced in one rename and Squirrel.Mac still reads one JSON object:

```
{
  "currentRelease": "1.0.1",
  …
  "signatures": ["<88 characters of base64>"]
}
```

It is defined on bytes, not on what a JSON reader makes of them (`src/main/update-feed-signature.ts`): a signed feed ends with `,\n  "signatures": ["…"(, "…")*]\n}\n`, one to four signatures; what was signed is everything before that, followed by `\n}\n`, which is the feed as it was before it was signed. Each signature is the Ed25519 signature (`node:crypto`, no dependency) of exactly those bytes. A copy checks the signatures, then reads **only** the signed bytes.

**Which system a feed is for.** One key signs the feeds of every system, so a signed feed of one system served at the address of another is a valid feed. What keeps a copy from taking it is written in the signed bytes: `"platform"` (`darwin`, `win32`, `linux`), `"arch"` (`arm64`, `x64`) and `"kind"` (the installer the feed names: `zip` for macOS, `nsis` for Windows, `appimage` or `deb` for Linux), as in `{ "currentRelease": "1.2.0", "platform": "win32", "arch": "x64", "kind": "nsis", … }`. A copy refuses a feed that is for another system, that gives part of the three, that names an installer its system does not take, or that gives none of them while the copy is not a Mac; the feeds of macOS written before these keys existed carry none of them and are read as before, by a Mac only. A feed for Windows or Linux must also give the `sha256` (64 lowercase hexadecimal digits) and the `size` of its installer, read by the copy; on every system a `sha256` of another shape makes the feed unreadable. The folders are `updates/darwin-arm64/`, `updates/win32-x64/`, `updates/linux-x64/` and `updates/linux-arm64/`, on `lucium.app` (stable) and `test.lucium.app` (test). The Windows and Linux builds of CI carry the addresses of their own folder (`MAIN_VITE_UPDATE_FEED`, `MAIN_VITE_UPDATE_FEED_TEST`, given by the Build step of `windows.yml` and `linux.yml`, never by a `.env` file), and **nothing reads them yet**: those builds still check nothing and install nothing, and the publication that writes these feeds is not written (`src/shared/update-target.ts` holds the format; card 850, lot 0 of the automatic updates of Windows and Linux).

**Where the keys are.**

| | Where | Who reads it |
|---|---|---|
| The public key(s) | `src/main/update-feed-keys.ts`, in the repository; compiled into `app.asar`, which the integrity fuse and the Developer ID signature seal | Every copy. Not a secret |
| The private key | `~/Library/Application Support/lucium-secrets/feed-key.pem` on the Mac that publishes, mode 600, outside the repository | `scripts/publish-update.mjs` only, at the moment it signs. Never printed, never copied by a script, never read by a coding assistant |

While `src/main/update-feed-keys.ts` holds no key, `scripts/build-drm-release.sh` stops before the build when it is given `--update-feed` or `--notarize`, `pnpm verify:app` fails its check "update feed keys", and `scripts/publish-update.mjs` refuses to sign. After the build, the script and `pnpm verify:app` both look for each key in `app.asar`.

### Making the key (once)

1. On the Mac that publishes: `node scripts/feed-key.mjs`. It makes the pair, writes the private key (mode 600, in a folder of mode 700), and prints the public key only. It never replaces a key that is there.
2. Put the public key it prints in the list `UPDATE_FEED_PUBLIC_KEYS` of `src/main/update-feed-keys.ts`, and commit. `node scripts/feed-key.mjs --check` checks the list (it reads no private key); `node scripts/feed-key.mjs --show` prints again the public key of the private key that is there.
3. Back the private key up (below) **before** the first publication.

### Backing it up

A lost private key cannot be made again, and every installed copy then refuses every feed: people would have to download a build with a new key by hand. So keep one copy of `feed-key.pem` away from this Mac: on an encrypted disk kept offline, or printed and locked away. Not in the repository, not in a cloud folder, not in a message, not in a password manager that syncs through a server you do not control. Bring it back with `cp`, then `chmod 600`: the publication refuses a key that other accounts can read. After a change of key, back up the new one and destroy the copies of the one that is gone.

### Changing the key

Planned, with no hurry (a new Mac is not a reason: move the file). A copy carries one key, or two during the change; a feed carries one signature for each private key of the folder (`feed-key.pem`, `feed-key-next.pem`, `feed-key-previous.pem`), and a copy takes it when one of them is by a key it carries.

1. `node scripts/feed-key.mjs --next` makes `feed-key-next.pem` and prints its public key. Back it up.
2. Add that public key **after** the current one in `UPDATE_FEED_PUBLIC_KEYS` (two keys), commit, build and publish a version, say N. Its feed is signed with both keys. Every copy from N on carries both.
3. At a later version, once N has had the time to reach the copies: in the folder of the keys, `mv feed-key.pem feed-key-previous.pem` then `mv feed-key-next.pem feed-key.pem`; remove the old public key from the list (one key again), commit, build and publish. The feeds are now signed with the new key and with the previous one, so the copies older than N, which only carry the old key, still take them and update.
4. When the copies older than N are no longer to be served (a few months), delete `feed-key-previous.pem` and its backups. From then on a copy older than N believes no feed: it must be updated by hand.

Never remove a public key from the list while the feeds are signed by its private key alone: every copy built after that would refuse them. The publication checks this before it sends anything.

### If the private key is lost

Nothing can be signed, and no installed copy believes a feed any more. Make a new key (`node scripts/feed-key.mjs`, after moving the unusable file away if there is one), put its public key in the list in place of the old one, build, publish, and say on the download page that the copies installed before must be replaced by hand. This is the one case where an update cannot reach the installed copies: it is why the backup exists.

### If the private key may have leaked

Alone, the key gives nothing: a signed feed must still reach a copy, from the address sealed into it, over https. With the server as well (or its place on the network), its holder can make the copies believe a feed: offer a version, name a download page of their own, say that a version was withdrawn. They still cannot make "Install" install anything that the team did not sign.

1. **Stop publishing**, and check the server as in [If a signing key or a session is compromised](#if-a-signing-key-or-a-session-is-compromised) (step 2): the feed of each channel must be the one that was published.
2. In the folder of the keys: `mv feed-key.pem feed-key-previous.pem`, then `node scripts/feed-key.mjs` makes a new `feed-key.pem`. Back the new one up.
3. Put the new public key in `UPDATE_FEED_PUBLIC_KEYS` **in place of** the leaked one, commit, build and publish a version higher than every published one. Its feed is signed with the new key and with the leaked one: the copies already installed only carry the leaked one, and this is the only way an update reaches them. The new build no longer believes the leaked key.
4. Keep `feed-key-previous.pem` only for as long as the installed copies need to move to that version; it gives its thief nothing they do not have. Then delete it and its backups.
5. **Tell people**: a copy that stays on a version built before the change still believes the leaked key. The advisory names the first version that does not.

## The build Mac and the dependencies

**No token of the npm registry on the build Mac.** Lucium publishes nothing to npm (`"private": true` in `package.json`). A token in `~/.npmrc` (a line `//registry.npmjs.org/:_authToken=…`) can be read by the install script of every package `pnpm-workspace.yaml` allows to run one (`electron`), by every development tool run from the repository, and by a compromised release of any of them, which could then publish to npm under the maintainer's name. Check without printing the value: `grep -c '_authToken' ~/.npmrc` must print `0` (or say there is no such file). If a token is there and nothing uses it any more, revoke it on npmjs.com (Access Tokens) and remove the line. If another project publishes with it, replace it with a granular token limited to that package, with two-factor authentication for publishing, kept in a password manager and given only to the command that publishes, never left in `~/.npmrc`.

**The advisories and deprecations the build tools carry.** `pnpm audit --prod` (what the application ships) reports nothing. On 12 November 2026, `pnpm audit` reports one moderate advisory, and the registry marked five packages of the lockfile as deprecated; four are left, none of them in the application:

- `minimatch` 9.0.9 and 10.2.6 (GHSA-g3hv-75wg-m249, denial of service by a crafted pattern, fixed in 11.0.1), brought by `electron-builder` 26.18.0 (the latest) through `app-builder-lib` and `@electron/universal`. The patterns it reads are the project's own (`electron-builder.yml`). Forcing 11 by an override would change a major version inside the chain that packages and signs the application: not done; it goes when `electron-builder` takes it.
- `glob` 7.2.3, `inflight` 1.0.6, `rimraf` 2.6.3 (through `@electron/asar` 3.4.1 and `electron-winstaller`) and `boolean` 3.2.0 (through `@electron/get` and `global-agent`): the same chain, the same answer.
- `tldts-core` 7.4.20, which the application ships (the lists of public suffixes, through `tldts` and `tldts-experimental` 7.4.19): deprecated because tldts' release of 7.4.20 failed half-way (tldts issue 2735), not for a defect. Fixed on 12 November 2026: `tldts`, `tldts-experimental` and `tldts-core` are at 7.4.22, a day after it was published (`.github/dependabot.yml` would have waited five days for a patch release); the change from 7.4.19 is the updated list of suffixes and the IPv6 unspecified address.

Run `pnpm audit` and `pnpm audit --prod` again before a release, and write here what changed.

## If a signing key or a session is compromised

Everything that makes a build Lucium's is on one Mac: the Developer ID certificate and its private key, the keychain profile of Apple's notary service, the session of the EVS account, the SSH key that publishes to the server, the key that signs the update feed, and the key that signs the tags. This is what to do when one of them may have leaked (a stolen or lost Mac, a backup that got out, malware on that Mac). **It is written down and has never been rehearsed**: read it once before the day it is needed, and correct it after the first time it is used.

Squirrel.Mac installs any build signed by the same team (`src/main/shell/update-source.ts`). Someone who holds the Developer ID key cannot push an update by that alone, because a build only reads the feeds sealed into it; someone who holds the key **and** can write to the server can. So the first two things to protect are the certificate and the server.

1. **Stop publishing.** No build, no `scripts/publish-update.mjs`, until the steps below are done.
2. **The server.** Remove the publishing key from the server's `authorized_keys` and make a new one. Then compare what the server serves with what was published: `feed.json` of each channel, and the SHA-256 of every archive and disk image against the journal of the publications ([The journal of the publications](#the-journal-of-the-publications)) and the sums in the annotations of the tags. A file that differs is a file someone else put there: [withdraw the version](#withdrawing-a-version) and keep a copy of the file for the report.
3. **The Developer ID certificate.** Ask Apple to revoke it: from the developer account (Certificates, Identifiers & Profiles) when the account allows it for this kind of certificate, else by writing to Apple (product-security@apple.com). Check Apple's current page before acting, the rule has changed over the years. Know what revoking does: macOS may then refuse to open the builds signed with that certificate, the genuine ones included. Publish the next build first whenever the leak leaves the time for it.
4. **A new certificate, same team.** Make a new Developer ID Application certificate in the same developer account and set `LUCIUM_SIGN_IDENTITY` to it. The team identifier does not change, so the copies already installed accept the next update. If the developer account itself is lost and a new team must sign, they do not: the update fails for everyone, and people must download the new build by hand from lucium.app. Say so on the download page and in the notes.
5. **The notary credentials.** Revoke the app-specific password (account.apple.com) or the App Store Connect key that the keychain profile holds, make a new one, and store it again with `xcrun notarytool store-credentials <name>` ([docs/drm.md](../drm.md), section 8). Read the history of the notary service (`xcrun notarytool history`) for submissions that are not yours.
6. **The EVS session.** Change the password of the EVS account and sign in again (`evs-account`, [docs/drm.md](../drm.md), section 3). A leaked session lets someone get a build of their own signed for Widevine; it does not let them sign as Lucium.
7. **The key of the update feed.** A stolen Mac or a backup that got out takes `feed-key.pem` with it: follow [If the private key may have leaked](#if-the-private-key-may-have-leaked).
8. **The key of the tags.** Revoke the key that signs the tags and publish the new one where the old one was published. The sums of a release are trusted because the tag that carries them is signed.
9. **Publish a version signed with the new certificate**, higher than every version published so far, by the usual steps, and withdraw every version built or published while the key was exposed.
10. **Tell people.** A security advisory on the repository and a line on the site: what leaked, since when, which versions are safe, what to do (update, or download again). Without an account of what happened, a revoked certificate looks like a broken application.

## The commands by hand

A feed written and sent by hand carries no signature, and no copy from 1.0 on believes it: the signature is made by `scripts/publish-update.mjs` alone. The commands below are what the script runs; they are kept for reading what it does, and for the archive and the disk image.

The commands by hand, if the script cannot be used, are those of docs/drm.md, section 12: `scripts/make-update-feed.mjs`, `mktemp -d /tmp/lucium-publish.XXXXXXXXXX` on the server, `scp` into that folder, `sha256sum` there, `install` under a temporary name then `mv` for the archive and then for the feed (`sudo -n`, `root:root` `0644`), a check of both from the web, and the folder removed (`rm -rf --` on its path).

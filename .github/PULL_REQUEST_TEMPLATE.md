<!--
Thank you for contributing. English or French, both are fine. The pull request title must follow Conventional Commits, in English
(for example `fix(sidebar): keep the selection when a folder closes`): it becomes the commit message of the squash merge, and a required
check verifies its form. Read CONTRIBUTING.md first if you have not. If a coding assistant helped, it follows AGENTS.md.
-->

## What and why

<!-- What changes for the user, and why. Link the issue: "Closes #123". -->

## How it was checked

<!-- Commands you ran and what you saw. If you could not run `pnpm test:engine` (it needs macOS and opens windows), say so. -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass. `pnpm test:engine` passes, or I explain above why I could not run it.
- [ ] Every new guard (validation, limit, security check, refusal) has a test, and I **checked that the test fails without the guard** (removed or inverted it, saw the failure, put it back).
- [ ] Pure logic is in `src/shared/` (no Electron import there); state changes go through the reducer; anything touching web content or extensions goes through the engine port.
- [ ] UI change: it follows Lucium's existing layout (I give below the values and how they were observed), or I say below that it is a deliberate addition.
- [ ] Every new text of the interface is in both catalogues, French and English, under the same key (`src/shared/i18n-fr.ts`, `src/shared/i18n-en.ts`), and every new color is a token (`src/renderer/tokens.css`, `src/renderer/palette.css`).
- [ ] **No code, image, font, icon, sound or data file from another browser or from any proprietary product** was copied or adapted, and none was decompiled to write this.
- [ ] Nothing in the excluded scope: no AI assistant, no online AI service, no account, no cloud sync, no telemetry. No new connection, or it is off by default and listed below.
- [ ] No new dependency, or I justify it below (license compatible with GPL-3.0-or-later, listed in `docs/licences-tierces.md`; no install script).
- [ ] Docs updated if behavior changed, and an entry added to the topmost section of `CHANGELOG.md` and of `CHANGELOG.fr.md` (the version being prepared, or `## [Unreleased]` after a release) for anything a user would notice.
- [ ] Screenshots or recordings (if any) show no personal data.
- [ ] I have the right to submit this work, and I submit it under the project's license, GPL-3.0-or-later with its additional permission for the Widevine module (`ADDITIONAL-PERMISSION.txt`), keeping my copyright ([Developer Certificate of Origin](https://developercertificate.org)). **Every commit carries my `Signed-off-by` line** (`git commit -s`): a required check refuses the pull request otherwise.

## Notes for the reviewer

<!-- Trade-offs, things you are unsure about, parts that are better read first. Deliberate change of an existing behavior, new dependency justification. -->

# Governance

How Lucium is run. It is deliberately short and will grow with the project.

English · [Français](GOVERNANCE.fr.md). The two say the same thing and change in the same commit.

## Roles

- **Contributors**: anyone who opens an issue, a discussion or a pull request. No permission is needed. Contributors keep the copyright of their work, which is distributed under GPL-3.0-or-later (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- **Maintainers**: review and merge pull requests, triage issues, enforce the [Code of Conduct](CODE_OF_CONDUCT.md), handle security reports. They are listed in [`.github/CODEOWNERS`](.github/CODEOWNERS). Being a maintainer does not allow pushing to `main`: see [the rules of `main`](#the-rules-of-main).
- **Lead maintainer**: has the last word when maintainers disagree and keeps the project's direction consistent with the principles below.
- **Releases**: the production build and the publication of an update are the lead maintainer's alone. They review and check everything that goes into a version, then build, sign, notarize and publish it from their own Mac; no workflow does it and none holds the secrets it needs ([release process](docs/community/release-process.md#signing-and-notarization)). Nobody else publishes a version of Lucium.

**Today there is one maintainer**, who is also the lead: [@pOwn3d](https://github.com/pOwn3d). A contributor proposes a change with an issue or a pull request; the maintainer reviews it, corrects it if needed, merges it into `main`, then builds and publishes the version. With one maintainer, nobody inside the project reviews the maintainer's own changes a second time, and nobody inside it hears a complaint about the maintainer: this document does not promise otherwise.

Lucium was created by [ConsilioWeb](https://consilioweb.fr). It is not a commercial product: there is no paid edition and there will not be one.

## The rules of `main`

These are the rules of the public repository.

- **Every change comes through a pull request**, for everyone, the maintainer included. Nobody pushes to `main` directly.
- **A pull request is merged only when its required checks pass**: type check, lint, unit tests on Linux and on macOS, an unsigned build of the application on macOS, the sign-off of every commit (the [Developer Certificate of Origin](https://developercertificate.org)), and a title in [Conventional Commits](https://www.conventionalcommits.org) form.
- **The history is linear and its commits are signed.** Force pushes to `main` and its deletion are refused for everyone.
- **The engine chain and the end-to-end tests are not required checks.** They drive a real application, open its windows and take a long while. The end-to-end tests run every night on `main`; the engine chain runs every week, on a version tag and on demand. Both are read before a release ([release process](docs/community/release-process.md)).
- **Review.** The maintainer reviews the pull request of a contributor before merging it. While there is one maintainer, the maintainer's own pull requests have no second reviewer: the required checks are what they must pass. As soon as there are two maintainers, a pull request needs the approval of a maintainer other than its author.

## How decisions are made

- **Everything is in the repository.** A change is a pull request; the reasons of a decision are written in the issue, in the pull request or in `docs/`.
- **Small changes** (a fix, a doc, a test): a pull request, merged once it is reviewed and its checks pass.
- **Significant changes** (architecture, a new dependency, a change to a user-visible behavior, a change to the state file format): proposed in an issue or a discussion, open for comment for at least **7 days** before a decision, and recorded in the issue or in `docs/`. A change to the principles follows the rule of the principles below.
- We look for **consensus**. When there is none, maintainers decide by majority; the lead maintainer breaks ties and decides alone while there is only one maintainer. The reasons are written down.
- Any decision can be reopened with new facts.

## Becoming a maintainer

There is no quota and no formal exam. A contributor is invited by the existing maintainers after a track record of:

- several merged contributions over a few months, of good quality and in line with the conventions;
- helpful, constructive reviews and issue triage;
- a good understanding of the principles and the structure of the project;
- respect of the Code of Conduct.

A maintainer must enable two-factor authentication on their GitHub account and agree to follow this document. Rights are granted through GitHub (and `CODEOWNERS`). They cover reviewing and merging; building and publishing a version stays the lead maintainer's.

A maintainer who is inactive for a long period (about a year) and does not answer is moved to emeritus status and loses the rights, with thanks. They can come back on request.

## Copyright, license and name

**Copyright © 2026 ConsilioWeb and contributors.** Lucium is distributed under **GPL-3.0-or-later** ([LICENSE](LICENSE)). ConsilioWeb holds the copyright of the code it wrote; each contributor keeps the copyright of what they contribute. Contributions come in under the same license and with its additional permission for the Widevine module ([ADDITIONAL-PERMISSION.txt](ADDITIONAL-PERMISSION.txt)), with a Developer Certificate of Origin sign-off and **no assignment**: there is no contributor license agreement. [NOTICE](NOTICE) says who holds what and which components are under another license.

The license covers the code. It gives no right to the name "Lucium" or to the logo as the signs of this project: [TRADEMARKS.md](TRADEMARKS.md) says what a modified version has to change.

## Principles that are not negotiable

These define what Lucium is. They are not decided by a vote or by a pull request.

1. **Free software, for good.** GPL-3.0-or-later. No paid edition, no feature behind payment, no relicensing to a proprietary license, no advertising.
2. **No built-in AI assistant.** No chat and no agent acting on pages. The one exception is a page summary by a local model, as an option: the model runs on the user's own computer (Ollama), stays off until the user turns it on, and is asked only at an address of that computer. No online AI provider is called, and the project runs and pays for no AI service.
3. **No account** required to use the browser.
4. **No telemetry** and no usage data sent to anyone.
5. **No cloud synchronization** that goes through a service operated by the project or a company.
6. **No reuse of proprietary code or assets**, those of other browsers included: only observable behavior and layout are reproduced.

Changing one of them would change the nature of the project: it takes an explicit amendment of this file, a public discussion of at least 30 days and the agreement of all maintainers.

Anyone who disagrees remains free to fork the project, which is what the license is for.

## Changes to this document

By pull request, with the same rules as a significant change; a change to a principle follows the previous section. [GOVERNANCE.fr.md](GOVERNANCE.fr.md) changes in the same commit.

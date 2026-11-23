# Code signing policy

How the Windows installer of Lucium would be signed, by whom, and what is checked before a file is signed.

> **Status: a proposal, not in force.** No Windows file of Lucium is signed today, and none is published: the Windows installer that a workflow builds ([windows.yml](../../.github/workflows/windows.yml)) is an unsigned check build, and SmartScreen warns about it ([plateformes.md](../plateformes.md), in French). The project has not applied to the [SignPath Foundation](https://signpath.org/terms) yet, and has not been accepted. This page is the policy the project would follow if it is; the Foundation asks for it to be public before it decides. Nothing below is in place until the status line of this page says so. Today the maintainer alone builds, signs and publishes ([release-process.md](release-process.md)), and no workflow holds a signing secret ([GOVERNANCE.md](../../GOVERNANCE.md)): carrying out this policy changes those documents, in a pull request of its own, after the maintainer has decided it.

## The statement

When the project is accepted, this sentence is the one to publish on the home page and on the download page, as the Foundation's conditions require:

> Code signing policy. Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

The certificate is issued to SignPath Foundation, not to the project or to its maintainer: once a file is signed, Windows names **SignPath Foundation** as its publisher.

## What is signed

| File | Signed with the SignPath Foundation certificate |
|---|---|
| `Lucium-Setup-X.Y.Z-x64.exe`, the Windows installer | yes |
| `Lucium.exe`, the application, taken out of the package before it is made | yes, if the Foundation agrees (see the note below) |
| The libraries of Electron and Chromium in the package (`ffmpeg.dll`, `libEGL.dll`…) | no: they are upstream binaries, which the Foundation's conditions let a signed package include unsigned |
| The macOS disk image and archive | no, and not through SignPath: the maintainer signs them with their Apple Developer ID and has Apple notarize them ([release-process.md](release-process.md#signing-and-notarization)) |

`Lucium.exe` is the executable of Electron with Lucium's name, icon, resources and version information. Whether the Foundation accepts to sign it, or only the installer, is a question the application puts to them; this table follows their answer.

Only builds of this repository are signed: the Foundation's conditions allow nothing built elsewhere or from the source of another project, and the signing configuration refuses any file whose product name is not `Lucium`.

## How a file is signed

1. The maintainer prepares a version as [release-process.md](release-process.md) describes, and tags the merged commit of `main`.
2. A workflow of this repository, started by hand from that tag, builds the Windows package **on GitHub-hosted runners only**. It reads no secret except the token that submits a signing request, kept in a protected GitHub environment that only the maintainer can release.
3. The workflow uploads the unsigned files as an artifact of its own run and submits them to SignPath. SignPath checks that the request comes from this repository, from that workflow run and from that commit, and refuses it otherwise: the files cannot be signed from anywhere else, and the token alone cannot sign anything of its own.
4. **The maintainer approves each signing request by hand** in SignPath, with two-factor authentication. The workflow waits for it and signs nothing before.
5. The signed files come back as an artifact of the run. The workflow publishes nothing and attaches nothing to a GitHub Release; the maintainer downloads the installer, checks its signature, and publishes it on [lucium.app](https://lucium.app) with its SHA-256 sum in the notes of the release, like the macOS image.

A change to the workflow, to the build scripts or to the signing configuration is reviewed like any code, with extra care: what is signed is what these files produce.

## Roles

| Role | Who | What it means |
|---|---|---|
| Committers and reviewers | [@pOwn3d](https://github.com/pOwn3d) | Reviews and merges every pull request of a contributor (`.github/CODEOWNERS`); the changes of the maintainer come by pull request too, under the required checks of `main` ([GOVERNANCE.md](../../GOVERNANCE.md#the-rules-of-main)) |
| Approvers | [@pOwn3d](https://github.com/pOwn3d) | Approves or refuses each signing request |

There is one maintainer today, so one person holds the three roles of the Foundation (authors, reviewers, approvers): nobody inside the project reviews the maintainer's own changes a second time, and this page does not promise otherwise. When a second maintainer joins, they are added to the roles above. Every person with a role uses two-factor authentication on GitHub and on SignPath.

## Privacy policy

Lucium has no account and no telemetry, and sends nothing about its use to anyone. What it connects to by itself, with each switch and default, is in the [privacy section of the README](../../README.md#privacy). The Windows build is made without a built-in update address, and Lucium has no update installer for Windows, so an installed copy makes no update request by itself. The spelling dictionaries are fetched only when the user turns the checker on.

## What the installer changes on the computer

Before this page applies, the installer is documented here, as the Foundation asks that a system change be announced. The installer of the current user adds, under `HKEY_CURRENT_USER`, the registry entries that let Windows list Lucium among the web browsers (*Default apps*) and open `lucium://` addresses. It does **not** make Lucium the default browser: the user chooses that in Windows settings. The uninstaller (Windows' list of installed apps, or `Uninstall Lucium.exe` in the folder of the application) removes the entries and the files of the application; the user's data is kept. A run of the installer and of the uninstaller, with the registry read before and after, is part of every pull request that touches the code ([windows.yml](../../.github/workflows/windows.yml), job *Installer (Windows, unsigned)*).

## What the project promises

- The software contains no malware and no potentially unwanted program, and no tool whose purpose is to find or use security flaws of other software.
- It is released under GPL-3.0-or-later ([LICENSE](../../LICENSE)). [NOTICE](../../NOTICE) names what the package carries that is not under the GPL. Besides the components of other authors, each under its own free license, there are the logo and the icons made from it, and the nine background videos with their posters, which the project hands out but does not license for reuse. Whether that counts as a "component" under the Foundation's rules is asked in the application.
- Each signed file carries the product name `Lucium` and the version of the release, set in the build and checked by SignPath.
- The project helps the Foundation to look into a report of a violation of its code of conduct.

## Reporting a problem with a signed file

Write to contact@lucium.app ([SECURITY.md](../../SECURITY.md)), or to the Foundation at support@signpath.io, with a concise report and the proof. A signed file that breaks this policy is withdrawn and its version is replaced; the Foundation can revoke the certificate it lent the project.

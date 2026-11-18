# Name and logo of Lucium

[Version française](TRADEMARKS.fr.md)

The code of Lucium is free software under the GPL-3.0-or-later: you may copy it, change it and hand out your own version ([LICENSE](LICENSE)). The license covers the code. It does not cover the name or the logo, and it does not give the right to present another build as Lucium. This page says what is reserved, which files are outside the GPL, what a modified version has to change, and what stays allowed.

It is a policy of the project, written by its maintainer, not a legal opinion. It restricts nothing the GPL grants for the code.

## What is reserved

- **The name "Lucium"**, alone or in a product name ("Lucium DRM", "Lucium Browser").
- **The logo**, "the spaces in a fan": five rounded tabs opening from a point of light, in its eight color versions, and the icons, favicons and pictures made from it.

Both are used by [ConsilioWeb](https://consilioweb.fr), which maintains the project, to say one thing: *this build was made and published by the maintainer of Lucium.* Only the official builds carry them: the ones the maintainer builds and publishes, on [lucium.app](https://lucium.app).

You may not use the name or the logo, or something close enough to be confused with them, as the name or the icon of a build that is not an official one.

No trademark is registered for the name or the logo today. They are reserved by this policy, by the copyright of the drawing, and by the law that protects a sign people know a product by.

## The logo files are not under the GPL

The drawing of the logo is not free software. **Copyright © 2026 ConsilioWeb, all rights reserved**, for these files of the repository:

| Files | What they are |
|---|---|
| `scripts/logo/fan-logo.ts` | The drawing itself: the shapes, their proportions and the eight sets of colors |
| `build/icon.icns` | The icon of the application, rendered from the drawing |
| `resources/app-icons/*.png` | The eight icons offered in the Settings, rendered from the drawing |
| `ios/Lucium/Assets.xcassets/AppIcon.appiconset/*.png` | The icon of the iPhone and iPad application, rendered from the drawing |

The same holds for the favicons and the pictures of the site made from the drawing. The rest of `scripts/logo/` (the script that renders the icons, the test that checks them) is code under the GPL, and so are the icons of the menus and of the interface.

Without asking, you may:

- keep these files in a copy of the repository, a fork included, and pass them on unchanged with the source code;
- build Lucium with them for your own use;
- pass on an official build as it is;
- show the logo to talk about Lucium (see below);
- change `scripts/logo/fan-logo.ts` to put a drawing of your own in the place of this one, which is what a modified version has to do.

Anything else needs the maintainer's agreement: changing the logo, handing out a build of yours that carries it, using it for another product.

## If you hand out a modified version

A build you keep for yourself needs none of this. As soon as you give your build to someone else, change these five things, so that nobody takes it for an official build and so that it does not use the project's services:

| What | Why | Where it is today |
|---|---|---|
| **The name** | People must be able to tell your build from Lucium. | `productName` in `package.json` and `electron-builder.yml`, the texts of `src/shared/i18n-fr.ts` and `src/shared/i18n-en.ts` |
| **The logo and the icons** | Same reason, and these files are not under the GPL. | Your own drawing in `scripts/logo/fan-logo.ts`, then `pnpm icons:logo`, which writes `build/icon.icns`, `resources/app-icons/` and the icon of the iOS application again |
| **The application identifier** | With the identifier of Lucium, your build would open the profile, the keychain entries and the system permissions of an installed Lucium. | `appId` in `electron-builder.yml` (`app.lucium.browser`), the identifiers of the helpers in `native/`, `src/main/vault-keychain.ts` and `src/main/translate/system.ts`, the `lucium` address scheme |
| **The update feed** | The feed on `lucium.app` serves official builds, signed by the maintainer. Your build must not ask it for updates. | The address given to `scripts/build-drm-release.sh --update-feed` and `--test-feed`, and the channels of `src/main/publish-update.ts`. A build made without these options follows no feed. |
| **The contact addresses** | Reports about your build must reach you, not the maintainer of Lucium. | The community pages in `src/shared/problem-report.ts`, the repository and the company in `src/shared/about.ts`, `contact@lucium.app` in the documents, the package metadata in `electron-builder.yml` |

Keep the copyright notices and the license texts as they are ([LICENSE](LICENSE), [NOTICE](NOTICE), `THIRD-PARTY-NOTICES.txt`): the GPL asks for it, and it is not a use of the name that this page restricts.

## What stays allowed

- **Saying where your version comes from**: "based on Lucium", "a fork of Lucium", "built from the source code of Lucium". Say it in a sentence, not in the name of your product.
- **Descriptive use**: writing about Lucium, comparing it, teaching with it, reviewing it, linking to it, naming it in a bug report.
- **Showing the logo to talk about Lucium**: an article, a talk, a comparison, a list of browsers, unmodified and without suggesting that the project endorses you.
- **Everything the GPL grants for the code.** The logo files are not part of it.

## What is not allowed without asking

- Naming a modified build "Lucium", or a name that contains it or looks like it.
- Using the logo, or a variation of it, as the icon of another application, another project or a company.
- Suggesting that the project or its maintainer made, checked or endorses your build, your product or your service.
- Registering the name or the logo, alone or combined, as a trademark, a domain name or an account name meant to pass for the project.

## Names of others

macOS, Chromium, Electron, Widevine, Netflix and the other names that appear in the code and the documents belong to their owners. Lucium is not affiliated with them. Nothing here grants a right to them.

## Asking

For a use this page does not cover, or to report a build that passes for Lucium, write to the maintainer, [ConsilioWeb](https://consilioweb.fr). Today the project has one maintainer, who answers alone.

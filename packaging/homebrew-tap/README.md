# Homebrew tap of Lucium

[Lucium](https://lucium.app/) is a free web browser for Macs with Apple silicon, macOS 13 or later. This tap holds its Homebrew cask.

```sh
brew install --cask pOwn3d/lucium/lucium
```

Installing with the full name trusts this one cask of the tap, and nothing else ([Homebrew's tap trust](https://docs.brew.sh/Tap-Trust)). To install it later by its short name, `brew install --cask lucium`, trust it first: `brew tap pOwn3d/lucium`, then `brew trust --cask pOwn3d/lucium/lucium`.

## What the cask does

- It downloads the disk image the download page of lucium.app offers, `https://lucium.app/updates/darwin-arm64/Lucium-<version>-arm64.dmg`, checks its SHA-256, and copies `Lucium.app` to `/Applications`. That image is signed with the project's Developer ID and notarized by Apple: Gatekeeper checks it as it would a download from the site. The cask runs no script and never removes the quarantine mark.
- Lucium updates itself (Lucium › Check for Updates…). The cask says so (`auto_updates true`), so `brew upgrade` leaves it alone; `brew upgrade --greedy` installs the version of the cask when it is newer than the one you have.
- `brew uninstall --cask lucium` removes the application and keeps your data. `brew uninstall --zap --cask lucium` also moves to the Trash the data folder (`~/Library/Application Support/Lucium`: your spaces, tabs, history, password vault and extensions), the caches and the preferences of Lucium. It does not remove the items Lucium keeps in the keychain, nor your downloads.

## How the cask is made

The cask is not written by hand. The maintainer generates it from the files of the release, once the disk image is published on lucium.app: `node scripts/make-cask.mjs --tap <this repository>`, in the repository of Lucium. The script takes the SHA-256 from the sum published beside the image, checks it against the image, and refuses to write anything when the build or the image is not shown notarized by the records of the release. How it works, and the steps of a release: `docs/community/homebrew.md` and `docs/community/release-process.md` in the repository of Lucium.

## Reporting a problem

A problem with Lucium itself: see [lucium.app](https://lucium.app/). A security problem: write to contact@lucium.app, never in a public issue.

## License

The cask is distributed under the terms of the GNU General Public License, version 3 or later (GPL-3.0-or-later), as Lucium. Copyright © 2026 ConsilioWeb and contributors. "Lucium" and its logo are not covered by that license.

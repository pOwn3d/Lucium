# Homebrew

How Lucium is offered through Homebrew, and how the maintainer keeps the cask up to date. En français : [docs/homebrew.md](../homebrew.md).

**State today: nothing is published.** The tap does not exist yet. It will be created once version 1.0.0 is published on the stable channel; until it exists, no page of the project tells anyone to install Lucium with Homebrew. What is in this repository is ready for that day: the generator of the cask, its tests, and the model of the tap.

## Our own tap, not `homebrew/cask` (for now)

Lucium is installed from a tap of the project: the repository `github.com/pOwn3d/homebrew-lucium`, whose `Casks/lucium.rb` is the cask.

```sh
brew install --cask pOwn3d/lucium/lucium
```

Not from Homebrew's own repository, `homebrew/cask`, because Lucium does not meet its conditions yet ([Acceptable Casks](https://docs.brew.sh/Acceptable-Casks) and [Package Acceptance Policy](https://docs.brew.sh/Package-Acceptance-Policy), as the documentation and the code of `brew audit --new` installed with Homebrew 7.0.13 say them):

- **Notability.** A project submitted by its own author needs at least 90 forks, 90 watchers or 225 stars on GitHub (30, 30 or 75 when someone else submits it). The public repository does not exist yet.
- **Age.** A code repository less than 30 days old is normally not accepted, and `brew audit --new` refuses a homepage whose domain was registered less than 30 days ago.
- **What it already meets**: a download published by the project on its own site, signed with a Developer ID and notarized, which passes Gatekeeper; a working `livecheck` (required for a new cask); no cask of `homebrew/cask` is named `lucium` (Homebrew's list of casks on this Mac, 2026-11-11).

When the public repository has the audience and the age, the cask can be proposed to `homebrew/cask`. Its maintainers decide; the tap stays until then, and afterwards the tap's cask can be deprecated in favor of the official one.

### Tap trust

Since Homebrew 6, the casks of a tap that is not Homebrew's own load only when trusted ([Tap Trust](https://docs.brew.sh/Tap-Trust)). Installing with the full name, `pOwn3d/lucium/lucium`, trusts that one cask. To use the short name (`brew install --cask lucium`), trust it first: `brew tap pOwn3d/lucium`, then `brew trust --cask pOwn3d/lucium/lucium`.

## What the cask says

The cask is generated, never written by hand (below). For version 1.0.0 it reads:

| Stanza | Value | Why |
|---|---|---|
| `version`, `sha256` | the version, and the SHA-256 of the disk image | read from `Lucium-<version>-arm64.dmg.sha256`, the sum `scripts/make-dmg.mjs` wrote |
| `url` | `https://lucium.app/updates/darwin-arm64/Lucium-#{version}-arm64.dmg` | where `scripts/publish-update.mjs --channel stable` publishes the image, beside the archive; the name changes only with the version |
| `name`, `desc`, `homepage` | `Lucium`, `Web browser with a vertical sidebar`, `https://lucium.app/` | the description follows Homebrew's guidelines: what it is, no praise |
| `livecheck` | `strategy :json` on `https://lucium.app/updates/darwin-arm64/feed.json`, key `currentRelease` | the feed installed copies read: the version it offers is the latest stable one |
| `auto_updates true` | | Lucium updates itself (Squirrel.Mac): `brew upgrade` leaves it alone, `brew upgrade --greedy` installs the cask's version when it is newer |
| `depends_on arch: :arm64`, `depends_on macos: :ventura` | Apple silicon, macOS 13 or later | the `LSMinimumSystemVersion` of the Electron inside (13.0 in the 0.3.0 app): read it again at every upgrade of Electron. Homebrew 7 deprecates the string form `">= :ventura"`: the symbol alone means "this version or later" |
| `app` | `Lucium.app` | |
| `zap trash:` | the seven paths below | |

No `preflight`, `postflight` or `uninstall` script: the cask copies the application, nothing else, and never touches the quarantine mark. Gatekeeper checks the notarized image as it would a download from the site.

`brew uninstall --zap --cask lucium` moves to the Trash, and nothing else:

| Path | What it is |
|---|---|
| `~/Library/Application Support/Lucium` | the data folder: profile, state, history, password vault, extensions (Electron's `userData`, `productName` of `package.json`) |
| `~/Library/Caches/app.lucium.browser` | the download cache of the updater |
| `~/Library/Caches/app.lucium.browser.ShipIt` | the update the updater prepares ([docs/drm.md](../drm.md), section 12) |
| `~/Library/HTTPStorages/app.lucium.browser` | the network storage of the updater |
| `~/Library/Preferences/app.lucium.browser.plist` | the preferences macOS keeps for the application |
| `~/Library/Preferences/ByHost/app.lucium.browser.ShipIt.*.plist` | the preferences the updater keeps for this Mac |
| `~/Library/Saved Application State/app.lucium.browser.savedState` | the state of the windows AppKit saves (macOS 13 to 15) |

The first six were seen on the maintainer's Mac for the application (under the identifier it had before it was renamed: the same files); the first is Electron's `userData` for the `productName` Lucium, and `src/main/shell/squirrel-staging.ts` works in the third. The seventh is where AppKit keeps the windows of an application on macOS 13 to 15; the maintainer's Mac, on a later macOS, has no such folder. Every path is one entry, named after Lucium, directly inside a folder of `~/Library` that other applications share: never the shared folder itself, never a folder of another application (a test refuses it). Not trashed: the items Lucium keeps in the keychain (Electron's "Lucium Safe Storage", the key of the vault; Homebrew cannot remove them), the downloads, and the crash reports macOS keeps in its own folders.

## Generating the cask

```sh
node scripts/make-cask.mjs --tap ../homebrew-lucium                                  # the image of package.json's version, in dist-drm/
node scripts/make-cask.mjs --tap ../homebrew-lucium dist-drm/Lucium-1.0.0-arm64.dmg   # that image
```

It reads local files only (it downloads nothing, publishes nothing, commits nothing), and writes `Casks/lucium.rb` in the checkout of the tap. Beside the image, it reads:

- `Lucium-<version>-arm64.dmg.sha256`: the cask takes its SHA-256 from this sum. The image is hashed too, and a sum that is not the image's is refused;
- `Lucium-<version>-arm64.build.json`, the build record: `scripts/build-drm-release.sh` writes it only with `--notarize`, once Apple accepted the app. It must be the record of this version and of its archive, built from a clean commit;
- `Lucium-<version>-arm64.dmg.json`, the record of the image: `make-dmg.mjs` writes it only once the image is notarized, stapled and accepted by Gatekeeper. It must describe this very image.

Neither record carries a "notarized" flag: their presence is the evidence. The script does not run `stapler` or `spctl` again (`publish-update.mjs` did before publishing the image, and step 17 of the release checks the file the site serves), and it does not check that the image is online: run it after the publication on the stable channel. When a file is missing or wrong it says every problem at once, writes nothing and ends with 1.

The code is `src/main/homebrew-cask.ts`, with its tests beside it (`homebrew-cask.test.ts`: the file produced line for line, the refusals, the sum, the name of the application, `zap` without a shared folder, https only).

## At each stable release

After step 17 of [release-process.md](release-process.md#steps-for-a-release) (the disk image is on lucium.app and checked):

1. `node scripts/make-cask.mjs --tap <checkout of pOwn3d/homebrew-lucium>`;
2. in the tap: `brew style --cask Casks/lucium.rb`, then `git commit -m "chore(cask): lucium X.Y.Z"` and `git push`;
3. on a Mac: `brew update`, then `brew upgrade --cask --greedy pOwn3d/lucium/lucium` (or `brew install --cask pOwn3d/lucium/lucium` the first time), and launch Lucium once.

`brew audit --cask --strict --online pOwn3d/lucium/lucium` adds what only the network can check: the image answers at its address, the minimum macOS read in the application matches `depends_on`, livecheck finds the version of the cask. It needs the tap and the cask trusted on that Mac. The first `brew style` or `brew audit` installs the Ruby gems Homebrew uses for them (RuboCop and others, from rubygems.org, into Homebrew's own folder).

**After a withdrawal** (`publish-update.mjs --withdraw`), the image of the withdrawn version answers 404, and so does the cask that names it. Put back the cask of the version the feed went back to: in the tap, `git revert` the commit of the withdrawn version, then push. A cask is never pointed at a version the stable feed does not offer.

## First time: creating the tap

1. Create the public repository `pOwn3d/homebrew-lucium` on GitHub, empty. The name must start with `homebrew-`: `brew` finds `pOwn3d/lucium` there.
2. Copy into it the model of this repository, [`packaging/homebrew-tap/`](../../packaging/homebrew-tap/) (its `README.md` and the folder `Casks/`), and the `LICENSE` of Lucium.
3. `node scripts/make-cask.mjs --tap <that checkout>`, `brew style --cask Casks/lucium.rb`, commit, push.
4. On a Mac: `brew install --cask pOwn3d/lucium/lucium`, launch Lucium, then `brew uninstall --cask lucium`.
5. Only then add the line `brew install --cask pOwn3d/lucium/lucium` to the READMEs and to the download pages of the site.

## Updating the tap by a workflow: not recommended

A workflow of the tap could run `livecheck` and update the cask by itself. `brew bump-cask-pr` is made for that in `homebrew/cask` (Homebrew's autobump runs only on its own taps), and a workflow could do the same in ours. It is not recommended:

- the SHA-256 would be computed from what the server serves at that moment, not read from the sum of the release; that sum is also signed in the annotation of the tag. A server that served another file would have it accepted;
- the workflow needs to write to the tap (`contents: write`, or a token for `bump-cask-pr`), and the project keeps no publishing right in a workflow ([release-process.md](release-process.md));
- the cask would change before the maintainer's trial installation. One command at step 18 of each release costs less than such a workflow and its permissions.

What would help: a **read-only** scheduled workflow in the tap that runs `brew livecheck --cask` and `brew audit --cask --online` and fails when the cask lags behind the feed or its image answers 404 (after a withdrawal). It writes nothing and needs no secret: GitHub notifies the maintainer when it fails. Not made yet.

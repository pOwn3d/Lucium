// Publishes an update that is already built: the archive, then the feed that names it, in one command and in the order that cannot break an
// installed copy. It does what docs/drm.md (section 12) and docs/community/release-process.md describe by hand:
//
//   node scripts/publish-update.mjs                      the archive of package.json's version, in dist-drm/, on the channel "test"
//   node scripts/publish-update.mjs dist-drm/Lucium-0.2.12-arm64.zip --channel stable --dry-run
//
// What it does, and stops at the first thing that is wrong (it says what, and what the server holds then):
//   1. checks the build: the archive's name and the built app's version are package.json's, the notarization ticket is stapled, and the
//      Electron fuses of the new app are those of the installed one (the cookies are encrypted in both: docs/drm.md, section 6);
//   2. reads the conditions of a publication (src/main/release-gate.ts), all local, also in a dry run:
//        - the archive holds the app that was checked (the same executable, hence the same signature);
//        - the archive carries no custom icon (no Lucium.app/Icon\r: the icon of Settings, put on a running copy, never goes out);
//        - the build record beside the archive (dist-drm/Lucium-<version>-arm64.build.json, written by scripts/build-drm-release.sh --notarize)
//          names this archive by its SHA-256 and the commit it was built from, the working tree clean; a tag v<version>, when there is one,
//          names that commit;
//        - CHANGELOG.md and CHANGELOG.fr.md carry the date of the version, not « Unreleased »;
//        - the record of the engine run (out-engine/release-run.json, written by `pnpm test:engine:release`) shows that the suites passed on
//          that commit;
//        - for the channel "stable": the journal holds a complete publication of this very archive on the channel "test", one day old or more,
//          and the maintainer's attestation beside the archive (dist-drm/Lucium-<version>-arm64.attestation.json) is complete: Netflix plays,
//          Touch ID unlocks the vault, the update from the previous version installs;
//   3. writes dist-drm/feed.json with scripts/make-update-feed.mjs, and checks it against the archive's SHA-256 and size;
//      then reads the feed in place on the server, before anything is sent: a version the channel already offers with another archive is refused
//      (the archive of a version has one name: the file under the feed in place would be replaced), and so is a version below the one it offers;
//      then SIGNS the feed (src/main/update-feed-signature.ts): the installed copies believe a feed only when a key they carry signed it. The
//      private key is read here and nowhere else, from the folder below; without it, or with a key the builds do not carry the public half
//      of (src/main/update-feed-keys.ts), nothing is sent;
//   4. makes a private folder on the server (mktemp -d, /tmp/lucium-publish.XXXXXXXXXX, mode 0700: the path it prints is checked before any command
//      uses it), sends the archive and the feed there (scp), and checks the copy (sha256sum);
//   5. publishes the ARCHIVE (written under a temporary name, then renamed, root:root 0644), downloads it back and compares its SHA-256;
//   6. then the DISK IMAGE and its sum, when scripts/make-dmg.mjs left them beside the archive (dist-drm/Lucium-<version>-arm64.dmg and its .sha256;
//      checked first: notarization ticket stapled, the sum is the image's, and its record (.dmg.json) names the executable of the archive): in the same folder, the same way, downloaded back and compared;
//   7. keeps the feed in place under the name of its version (feed-<version>.json, in the same folder): what a withdrawal goes back to;
//   8. only then publishes the FEED the same way, reads it back from the web and checks version, SHA-256 and size, and that it is byte for
//      byte the feed that was signed. The feed lists the versions
//      withdrawn from the channel ("withdrawn": those the feed in place listed, and those of the journal), for the copies that still run one;
//   9. removes the private folder of the server. A publication that stops once the folder is made removes it too, and says so when it cannot;
//  10. adds one line to the journal: the date, the version, the channel, the commit, the SHA-256 and size of the archive and of the disk image,
//      the tag, the engine run, and for "stable" what let the version in. A publication that stopped half way adds a line that says what the server
//      holds; it never counts as a passage through a channel.
//
// The installers of Windows and Linux go through the same script (docs/community/release-process.md, « Publishing the installers of Windows and Linux »):
//
//   node scripts/publish-update.mjs Lucium-Setup-1.1.7-x64.exe --platform win32-x64 --sha256 <sum of the CI run> --dry-run
//
//   --platform win32-x64|linux-x64-appimage|linux-x64-deb|linux-arm64-appimage|linux-arm64-deb   the file is the installer of that system, copied from the CI run on the tag;
//                          its extension is the kind's (.exe, .AppImage, .deb: Linux has one feed and one folder per kind); its folder of the server is "folders" of the channel in the file of the servers; the Mac's options
//                          (--app, --installed-app, --build-log, --build-record, --no-dmg) are refused with it
//   --sha256 <sum>         with --platform: the SHA-256 the CI run logged; the file must have it, and without it nothing is published
//   (with --withdraw: --platform names the system whose channel the version is taken out of)
//
// Withdrawing a version that must no longer be offered (docs/community/release-process.md, "Withdrawing a version"). It publishes nothing:
//
//   node scripts/publish-update.mjs --withdraw 1.0.1 --channel stable --dry-run     reads the server, changes nothing, prints what it would run
//   node scripts/publish-update.mjs --withdraw 1.0.1 --channel stable
//
//   1. reads the folder of the channel and its feed;
//   2. when the feed offers that version, puts back the kept feed of an earlier version (after checking that feed and its archive on the server),
//      and checks it online; a feed that offers another version keeps offering it. Either way the feed that stays lists the version as
//      withdrawn ("withdrawn"): a copy that runs it reads that in the feed and says "This version has been withdrawn". The feed that is written
//      is signed again; its source (the feed in place, or the kept one) must be a feed that was signed here, or the withdrawal stops;
//   3. renames the archive, the disk image, its sum and the kept feed of the withdrawn version (*.withdrawn: they answer 404), and checks it;
//   4. adds one line to the journal, of the type "withdrawal": the date, the version, the channel, what the channel offers now and the version
//      the feed went back to. It is not a publication: no condition is read (no build record, no engine run, no wait, no attestation).
//   It never makes an installed copy go back: a copy that runs a later version than the feed installs nothing by itself.
//
// Options:
//   --withdraw <version>   withdraws this version from the channel instead of publishing (with --channel, --config, --ssh-key, --journal, --dry-run only)
//   --to <version>|none    with --withdraw: the version the feed goes back to (default: the highest kept feed below the withdrawn version);
//                          "none" takes the feed away, when there is no earlier version: nothing is offered, and a check for updates fails
//   --no-dmg               does not publish the disk image, even when it is there (without this option, an image without its sum, or a sum
//                          without its image, is refused)
//   --dry-run              prints every command and runs none that touches the network or the server; the checks that only read local files
//                          are made, and nothing is written. A dry run that succeeds is a real run that would pass its local checks.
//   --channel test|stable  where to publish (default: test). Each channel has its own https folder (in the repository) and its own server and folder
//                          (in the file below); the release file is written for the https folder of the channel being published.
//   --config <path>        the JSON file that holds the server and the folder of each channel, outside the repository:
//                            { "test": { "host": "user@host", "folder": "/abs/path" }, "stable": { "host": "user@host", "folder": "/abs/path" } }
//                          Default: the environment variable LUCIUM_PUBLISH_CONFIG, else
//                          ~/Library/Application Support/lucium-secrets/publish-channels.json. It is only read, never written; a missing file or
//                          channel is refused (nothing is guessed).
//   The private key of the feed: feed-key.pem (and feed-key-next.pem, feed-key-previous.pem during a change of key) in
//                          ~/Library/Application Support/lucium-secrets/, or in the folder the environment variable LUCIUM_FEED_KEY_DIR
//                          names. Made by `node scripts/feed-key.mjs`, mode 600. Read to sign, never printed, never written.
//   --ssh-key <path>       the key for ssh and scp (default: the environment variable LUCIUM_PUBLISH_SSH_KEY, else
//                          ~/.ssh/id_ed25519). Passed by path to ssh; this script never opens it.
//   --installed-app <app>  the app whose fuses the new build must equal (default /Applications/Lucium.app). It is only read.
//   --app <app>            the built app the archive was made from (default: mac-arm64/Lucium.app beside the archive)
//   --build-log <file>     a saved output of scripts/build-drm-release.sh; it must say "Notarized, stapled" (more evidence than the ticket)
//   --build-record <file>  the build record (default: Lucium-<version>-arm64.build.json beside the archive)
//   --engine-run <file>    the record of the engine run (default: out-engine/release-run.json of the repository)
//   --no-engine-run "<reason>"   publishes without the record of the engine run; the reason, 20 characters or more, is written in the journal
//   --journal <path>       the journal of the publications, one JSON line each (default: the environment variable LUCIUM_PUBLISH_JOURNAL, else
//                          ~/Library/Application Support/lucium-secrets/publish-journal.jsonl, outside the repository). Its folder is made when missing.
//   --attestation <file>   the maintainer's attestation, for the channel "stable" (default: Lucium-<version>-arm64.attestation.json beside the
//                          archive). When it is missing, the refusal shows the file to fill in.
//   --min-test-hours <n>   how long a version stays on the channel "test" before "stable": 24 by default, never less than 1
//   --security-fix "<reason>"    for a security fix that cannot wait: the channel "stable" without the wait. The version must still have been
//                          published on the channel "test" and attested; the reason, 20 characters or more, is written in the journal.
//
// The https folders of the channels are in src/main/publish-update.ts. Exit code: 0 published (or dry run done), 1 a step failed,
// 2 the arguments or the file of the servers are wrong.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { configPathOf, describeFailure, describeWithdrawFailure, parsePublishArgs, publish, readChannelFile, realDeps, resolveInput, resolveWithdrawal, withdraw } = await import('../src/main/publish-update.ts')
// The conditions of a publication. Node resolves no import between two TypeScript files, so this script hands the module to the publication.
const gate = await import('../src/main/release-gate.ts')
// The keys of the feed, handed over the same way: the public ones the builds carry, and the folder of the private ones.
const { FEED_KEY_FOLDER, feedKeysIn } = await import('../src/main/update-feed-signature.ts')
const { UPDATE_FEED_PUBLIC_KEYS } = await import('../src/main/update-feed-keys.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const usage = () => console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))

const parsed = parsePublishArgs(process.argv.slice(2))
if (!parsed.ok) {
  console.error(`Error: ${parsed.message}`)
  usage()
  process.exit(2)
}
if (parsed.options.help) {
  usage()
  process.exit(0)
}
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
// The one file read for the servers; the default path is the maintainer's own, so the tests always give another.
const servers = readChannelFile(configPathOf(parsed.options, { cwd: process.cwd(), home: homedir(), fromEnv: process.env.LUCIUM_PUBLISH_CONFIG }), (path) => readFileSync(path, 'utf8'))
const feedKeys = feedKeysIn(process.env.LUCIUM_FEED_KEY_DIR?.trim() || join(homedir(), ...FEED_KEY_FOLDER), UPDATE_FEED_PUBLIC_KEYS)
const deps = realDeps((line) => console.log(line), { exists: existsSync, readText: (path) => readFileSync(path, 'utf8'), writeText: (path, text) => writeFileSync(path, text) }, gate, feedKeys)

if (parsed.options.withdraw !== null) {
  const withdrawal = resolveWithdrawal(parsed.options, { cwd: process.cwd(), home: homedir(), servers, sshKeyFromEnv: process.env.LUCIUM_PUBLISH_SSH_KEY, journalFromEnv: process.env.LUCIUM_PUBLISH_JOURNAL })
  if (!withdrawal.ok) {
    console.error(`Error: ${withdrawal.message}`)
    process.exit(2)
  }
  const outcome = await withdraw(withdrawal.input, deps)
  if (!outcome.ok) {
    console.error(`\n${describeWithdrawFailure(outcome, withdrawal.input)}`)
    process.exit(1)
  }
  process.exit(0)
}

const resolved = resolveInput(parsed.options, {
  cwd: process.cwd(),
  root,
  home: homedir(),
  version,
  servers,
  sshKeyFromEnv: process.env.LUCIUM_PUBLISH_SSH_KEY,
  journalFromEnv: process.env.LUCIUM_PUBLISH_JOURNAL
})
if (!resolved.ok) {
  console.error(`Error: ${resolved.message}`)
  process.exit(2)
}

const result = await publish(resolved.input, deps)
if (!result.ok) {
  console.error(`\n${describeFailure(result, resolved.input.channel)}`)
  process.exit(1)
}

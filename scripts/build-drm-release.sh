#!/bin/bash
# Build DRM variant with EVS signature (required for Netflix production)
# Builds the castLabs variant under the name and identifier of the normal app, signs it, checks it, then installs it in /Applications.
# The order of the signatures never changes: EVS (VMP) first, then the Developer ID of Apple when the keychain has one (docs/drm.md).
#
#   scripts/build-drm-release.sh                    builds, signs, checks and installs /Applications/Lucium.app (only when Lucium is closed;
#                                                   never forced)
#   scripts/build-drm-release.sh --no-install       builds, signs and checks, then stops before /Applications
#   scripts/build-drm-release.sh --notarize         also sends the signed app to Apple's notary service with the keychain profile named in
#                                                   LUCIUM_NOTARY_PROFILE (made once by `xcrun notarytool store-credentials`, docs/drm.md),
#                                                   staples the ticket, checks it, and writes dist-drm/Lucium-<version>-arm64.zip, the file to hand out;
#                                                   needs a Developer ID identity; combines with --no-install
#   scripts/build-drm-release.sh --original-fuses   the earlier build, castLabs' fuses left open (package-drm.mjs --no-fuses): the
#                                                   way back, together with the backup of the profile (docs/drm.md); combines with --no-install;
#                                                   signed ad hoc for this Mac only: refused with LUCIUM_SIGN_IDENTITY or --notarize
#   scripts/build-drm-release.sh --update-feed URL  builds the address of the update feed (https, Squirrel.Mac's release file, made by
#                                                   scripts/make-update-feed.mjs) into the app: electron-vite writes MAIN_VITE_UPDATE_FEED into
#                                                   app.asar, checked there after the build. Lucium › Rechercher les mises à jour… then reads it and
#                                                   installs from it, only when asked (src/main/shell/update-source.ts). Needs a Developer ID identity
#                                                   (Squirrel installs only what the same team signed); refused with --original-fuses, so that every
#                                                   build an update can install has castLabs' set (cookies encrypted). Without it, no address is built
#                                                   in, whatever the environment says. The version is the one of package.json (docs/drm.md, « Mise à jour »).
#                                                   This is the STABLE channel, the one a build follows by default.
#   scripts/build-drm-release.sh --test-feed URL    builds a second address into the app, the TEST channel (MAIN_VITE_UPDATE_FEED_TEST): the same
#                                                   rules as --update-feed (https, Developer ID, no --original-fuses, checked in app.asar), and it needs
#                                                   --update-feed too, since a build follows the stable channel until its user ticks « Recevoir les
#                                                   versions de test » in Réglages › Général (shown only by a build that carries this address). Neither
#                                                   address ever comes from the environment, a .env file, the settings or a file of the profile.
#
# With --update-feed or --notarize, the public key of the update feed must be in src/main/update-feed-keys.ts (node scripts/feed-key.mjs makes
# the pair and prints it): the script stops before the build without it, and after the build when app.asar does not hold it.
#
# The fuses, by default (docs/drm.md): castLabs' set, package-drm.mjs --castlabs-fuses, the one set EVS signs besides
# castLabs' defaults. RunAsNode, NODE_OPTIONS and the inspector are off, the app is loaded from app.asar only and its integrity checked, and the
# cookies are encrypted. Cookie encryption is one way: from the first launch the cookies of the profile are encrypted, and a build without the fuse
# no longer reads them. The script says so before installing and recommends a backup of the profile; it neither makes it nor reads the profile.
#
# The Developer ID identity: LUCIUM_SIGN_IDENTITY when it is set, otherwise the first "Developer ID Application" given by
# `security find-identity -v -p codesigning`. Only its name is read (it is written in every app it signs); the key stays in the keychain.
# Without one, the app is signed ad hoc, and the script says so: signed again by package-drm.mjs after its fuses are closed, or the signature of the
# castLabs binary with --original-fuses.

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

NO_INSTALL=0
FUSES=--castlabs-fuses
NOTARIZE=0
UPDATE_FEED=""
TEST_FEED=""
while [ $# -gt 0 ]; do
  arg="$1"
  case "$arg" in
    --no-install) NO_INSTALL=1 ;;
    --notarize) NOTARIZE=1 ;;
    --original-fuses) FUSES=--no-fuses ;;
    --update-feed)
      if [ $# -lt 2 ]; then echo "❌ --update-feed needs an address: --update-feed https://…/feed.json"; exit 2; fi
      UPDATE_FEED="$2"
      shift ;;
    --update-feed=*) UPDATE_FEED="${arg#--update-feed=}" ;;
    --test-feed)
      if [ $# -lt 2 ]; then echo "❌ --test-feed needs an address: --test-feed https://…/feed.json"; exit 2; fi
      TEST_FEED="$2"
      shift ;;
    --test-feed=*) TEST_FEED="${arg#--test-feed=}" ;;
    *) echo "❌ Unknown option: $arg (known: --no-install, --notarize, --original-fuses, --update-feed <https address>, --test-feed <https address>)"; exit 2 ;;
  esac
  shift
done
# The update feeds, checked before the two minutes of the build. Built into every copy installed from this build, for as long as it stays installed:
# one plain https address each (no space, quote, query or fragment), and castLabs' fuses only, so that an update never brings a build that no longer
# reads the encrypted cookies (docs/drm.md, « Chiffrement des cookies »).
FEED_PATTERN='^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/%-]*$'
# A build with castLabs' fuses open (RunAsNode, NODE_OPTIONS and the inspector on) is the way back on this Mac only: never signed with the Developer ID
# under the production identifier, never notarized. Signed by the team, Squirrel would install it from any feed that names it.
if [ "$FUSES" != "--castlabs-fuses" ] && [ -n "${LUCIUM_SIGN_IDENTITY:-}" ]; then
  echo "❌ --original-fuses is never signed with a Developer ID: castLabs' fuses are open in it, and Squirrel installs whatever the team signed. Unset LUCIUM_SIGN_IDENTITY"
  exit 2
fi
if [ "$FUSES" != "--castlabs-fuses" ] && [ "$NOTARIZE" = 1 ]; then
  echo "❌ --original-fuses cannot be notarized: it is signed ad hoc, for this Mac only (the way back of docs/drm.md)"
  exit 2
fi
if [ -n "$UPDATE_FEED" ]; then
  if ! [[ "$UPDATE_FEED" =~ $FEED_PATTERN ]] || [ "${#UPDATE_FEED}" -gt 500 ]; then
    echo "❌ --update-feed takes one plain https address (https://host/path/feed.json), not: $UPDATE_FEED"
    exit 2
  fi
  if [ "$FUSES" != "--castlabs-fuses" ]; then
    echo "❌ --update-feed cannot be combined with --original-fuses: every build reached by the feed keeps castLabs' set, the one that encrypts the cookies"
    exit 2
  fi
fi
# The test channel: the same address rules, and never alone (the stable address is the channel a build follows by default). Needing --update-feed, it
# is refused with --original-fuses and without a Developer ID by the checks of that address, which come first.
if [ -n "$TEST_FEED" ]; then
  if ! [[ "$TEST_FEED" =~ $FEED_PATTERN ]] || [ "${#TEST_FEED}" -gt 500 ]; then
    echo "❌ --test-feed takes one plain https address (https://host/path/feed.json), not: $TEST_FEED"
    exit 2
  fi
  if [ -z "$UPDATE_FEED" ]; then
    echo "❌ --test-feed needs --update-feed too: a build follows the stable channel until its user chooses the test one"
    exit 2
  fi
fi
# electron-vite writes MAIN_VITE_* into the main process, from this environment or from the .env files Vite reads for a build (.env, .env.local,
# .env.production, .env.production.local): the addresses come from --update-feed and --test-feed or from nowhere, never from the shell or a forgotten
# file. The pattern has no boundary after the name, so that MAIN_VITE_UPDATE_FEED_TEST is refused as MAIN_VITE_UPDATE_FEED is.
if grep -qs '^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}MAIN_VITE_UPDATE_FEED' .env .env.local .env.production .env.production.local; then
  echo "❌ A .env file of the project sets MAIN_VITE_UPDATE_FEED or MAIN_VITE_UPDATE_FEED_TEST: remove it, the addresses are given by --update-feed and --test-feed only"
  exit 2
fi
if [ -n "$UPDATE_FEED" ]; then export MAIN_VITE_UPDATE_FEED="$UPDATE_FEED"; else unset MAIN_VITE_UPDATE_FEED; fi
if [ -n "$TEST_FEED" ]; then export MAIN_VITE_UPDATE_FEED_TEST="$TEST_FEED"; else unset MAIN_VITE_UPDATE_FEED_TEST; fi
# The profile is a name: the credentials stay in the keychain. Checked before the two minutes of the build.
NOTARY_PROFILE="$(printf '%s' "${LUCIUM_NOTARY_PROFILE:-}" | tr -d '[:space:]')"
if [ "$NOTARIZE" = 1 ] && [ -z "$NOTARY_PROFILE" ]; then
  echo "❌ --notarize needs LUCIUM_NOTARY_PROFILE: the name of the keychain profile made by xcrun notarytool store-credentials (never a secret)"
  exit 2
fi

# The tools that build and sign are the ones of pnpm-lock.yaml. `npm install` leaves its own marker and its own copies of packages at the root of
# node_modules, which pnpm neither manages nor removes: a build would then be made beside versions the lockfile does not name.
if [ -e node_modules/.package-lock.json ]; then
  echo "❌ node_modules was touched by npm (node_modules/.package-lock.json): the tools of this build must be those of pnpm-lock.yaml."
  echo "   Install them again, then run this script again:  rm -rf node_modules && pnpm install --frozen-lockfile"
  exit 2
fi

APP="dist-drm/mac-arm64/Lucium.app"

# The key of the update feed. A copy believes a feed only when a public key built into it signed that feed (src/main/update-feed-keys.ts): a build
# that follows a feed (--update-feed) or that is handed out (--notarize) without one would refuse every update for as long as it stays installed.
# Asked before the two minutes of the build; `--check` reads no private key. The keys it prints are looked for in app.asar once it is built.
FEED_KEYS=""
if [ -n "$UPDATE_FEED" ] || [ "$NOTARIZE" = 1 ]; then
  if ! FEED_KEYS="$(node scripts/feed-key.mjs --check)" || [ -z "$FEED_KEYS" ]; then
    echo "❌ No build with an update feed, and no build to hand out, without the public key of the feed in src/main/update-feed-keys.ts."
    echo "   Run once: node scripts/feed-key.mjs   then put the public key it prints in that file, commit, and run this script again."
    exit 2
  fi
  echo "🔏 Public key(s) of the update feed built in: $(tr '\n' ' ' <<<"$FEED_KEYS")"
fi

# The commit this build is of, asked before the build: the record written beside the archive names it, and scripts/publish-update.mjs refuses an
# archive that has no record or was built from a modified tree (src/main/release-gate.ts). Two words: the commit, then 0 or 1 (a tracked file is modified, or
# a file Git does not track lies in a folder the build reads: src, resources, native, build).
BUILD_START=""
if [ "$NOTARIZE" = 1 ]; then
  if ! BUILD_START="$(node scripts/build-record.mjs start)"; then
    echo "❌ --notarize writes the archive to hand out, with the commit it was built from: Git must be able to name it"
    exit 1
  fi
  if [ "${BUILD_START##* }" = 1 ]; then
    echo "⚠️  Tracked files are modified, or files Git does not track lie in src/, resources/, native/ or build/ (git status names them): this build is of no commit, and scripts/publish-update.mjs will refuse its archive. Commit or remove them first to publish it."
  fi
fi

echo "═══════════════════════════════════════════════════════════════"
echo "🎬 Lucium DRM Build with EVS Signature"
echo "═══════════════════════════════════════════════════════════════"

# Step 0: the signing identity, looked for before the two minutes of the build.
echo ""
echo "🔑 Step 0: Looking for a Developer ID identity..."
IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
if [ "$FUSES" != "--castlabs-fuses" ]; then
  # castLabs' fuses open: no identity is looked for, whatever the keychain holds (see the refusals above).
  SIGN_IDENTITY=""
  echo "   --original-fuses: no Developer ID, the build is signed ad hoc and runs on this Mac only"
elif [ -n "${LUCIUM_SIGN_IDENTITY:-}" ]; then
  # Chosen by the maintainer: it must be a valid identity of the keychain, never replaced by another one in silence.
  # Its whole name, between the quotes `security` prints it in: a part of a name would pass here and codesign would sign with whatever it matches.
  if ! grep -qF -- "\"$LUCIUM_SIGN_IDENTITY\"" <<<"$IDENTITIES"; then
    echo "❌ LUCIUM_SIGN_IDENTITY is not a valid code-signing identity of the keychain (security find-identity -v -p codesigning)"
    exit 1
  fi
  SIGN_IDENTITY="$LUCIUM_SIGN_IDENTITY"
else
  SIGN_IDENTITY="$(sed -n 's/^ *[0-9][0-9]*) [0-9A-F]\{40\} "\(Developer ID Application: .*\)"$/\1/p' <<<"$IDENTITIES" | head -n 1)"
  FOUND="$(grep -c '"Developer ID Application: ' <<<"$IDENTITIES" || true)"
  if [ "${FOUND:-0}" -gt 1 ]; then
    echo "   $FOUND Developer ID Application identities: the first one is used (set LUCIUM_SIGN_IDENTITY to choose)"
  fi
fi
if [ -n "$SIGN_IDENTITY" ]; then
  # The name without the team identifier, so that the output can be pasted anywhere.
  echo "✅ Developer ID: $(sed -E 's/ \([A-Z0-9]{10}\)$//' <<<"$SIGN_IDENTITY") (signed after EVS, hardened runtime, the entitlements of each piece: src/main/mac-sign-order.ts)"
  NEW_SIGNATURE="developer-id"
else
  if [ "$FUSES" = "--castlabs-fuses" ]; then
    echo "⚠️  No Developer ID Application identity in the keychain: the app is signed ad hoc again after its fuses are closed (not tried)."
  else
    echo "⚠️  No Developer ID Application identity in the keychain: the app keeps its current signature (ad hoc, from the castLabs binary)."
  fi
  echo "   It plays Netflix on this Mac, but it cannot be notarized and Gatekeeper refuses it on another Mac."
  NEW_SIGNATURE="adhoc"
fi
if [ "$NOTARIZE" = 1 ] && [ "$NEW_SIGNATURE" != "developer-id" ]; then
  echo "❌ --notarize needs a Developer ID Application identity: Apple notarizes only an app signed by one"
  exit 2
fi
# Squirrel.Mac checks a downloaded update against the designated requirement of the running app: an ad hoc signature names one binary, never the next.
if [ -n "$UPDATE_FEED" ] && [ "$NEW_SIGNATURE" != "developer-id" ]; then
  echo "❌ --update-feed needs a Developer ID Application identity: Squirrel installs only an update signed by the same team as the running app"
  exit 2
fi
if [ -n "$UPDATE_FEED" ]; then
  echo "🔄 Update feed built in (stable channel): $UPDATE_FEED (keep LUCIUM_SIGN_IDENTITY and LUCIUM_KEYCHAIN_PROFILE the same for every build it serves)"
fi
if [ -n "$TEST_FEED" ]; then
  echo "🔄 Test update feed built in (test channel): $TEST_FEED"
fi

# macOS ties the permissions it granted to the signature of the app: when the signature changes kind, the app is a new one for it.
INSTALLED_APP="/Applications/Lucium.app"
INSTALLED_SIGNATURE="none"
if [ -d "$INSTALLED_APP" ]; then
  if codesign -dv "$INSTALLED_APP" 2>&1 | grep -q '^Signature=adhoc'; then INSTALLED_SIGNATURE="adhoc"; else INSTALLED_SIGNATURE="developer-id"; fi
fi
if [ "$INSTALLED_SIGNATURE" != "none" ] && [ "$INSTALLED_SIGNATURE" != "$NEW_SIGNATURE" ]; then
  echo ""
  echo "⚠️  The signature changes ($INSTALLED_SIGNATURE → $NEW_SIGNATURE): for macOS this is a new app."
  echo "   macOS may ask again for the permissions already granted to ${INSTALLED_APP#/Applications/}: screen recording, accessibility, camera,"
  echo "   microphone, local network (and Full Disk Access, the keychain, automation). Grant them again after the first"
  echo "   launch (System Settings › Privacy & Security). Builds signed later by the same Developer ID should keep them."
fi

# Step 1: build, EVS signature, Developer ID signature, checks (all in package-drm.mjs, in this order).
echo ""
echo "📦 Step 1: Building and signing the DRM variant..."
# EVS signs castLabs' fuses and one set besides them, castLabs' set: --castlabs-fuses writes it and checks it before EVS; --original-fuses
# (package-drm.mjs --no-fuses) keeps castLabs' fuses (see package-drm.mjs).
# --as-lucium keeps the name and the identifier (app.lucium.browser) of the normal app: macOS grants the local network
# access per identifier, so a build under another identifier loses it ("ce site ne répond pas" on .local addresses).
# --vmp: EVS signature then `evs-vmp verify-pkg`. --apple: Developer ID signature piece by piece without --deep (the keychain helper of Touch ID keeps
# its own, made by native/vault-keychain/build.sh with LUCIUM_KEYCHAIN_PROFILE), then `codesign --verify --deep --strict`, the helper's signature,
# the entitlements and `evs-vmp verify-pkg` again, on the final package. Any failure ends package-drm.mjs with an error, and this script before installing.
FLAGS=("$FUSES" --as-lucium --vmp)
if [ -n "$SIGN_IDENTITY" ]; then FLAGS+=(--apple); fi
# What goes to Apple is signed with a timestamp on every piece, or not built: without one Apple refuses it, after the build, EVS and the upload.
if [ "$NOTARIZE" = 1 ]; then FLAGS+=(--timestamp-required); fi
# Before it builds anything, package-drm.mjs checks the engine (src/main/drm-engine-guard.ts): the stable castLabs build ("+wvcus") of the Electron
# pinned in package.json, never a prerelease; another stable version only with build/drm-engine-exception.json. This script has no option for it.
if ! LUCIUM_SIGN_IDENTITY="$SIGN_IDENTITY" node scripts/package-drm.mjs "${FLAGS[@]}"; then
  echo "❌ Build, signature or check failed: nothing is installed"
  echo "   Engine: a line \"package-drm: the castLabs build is …\" above means the engine was refused (docs/drm.md, « Le garde-fou du moteur »)"
  echo "   EVS: if the session has expired, run evs-account refresh (in the tools' environment, docs/drm.md)"
  exit 1
fi

if [ ! -d "$APP" ]; then
  echo "❌ Build failed: $APP not found"
  exit 1
fi

echo "✅ Build complete"

# Step 2: what was checked (by package-drm.mjs, after the last signature).
echo ""
echo "🔍 Step 2: Checks"
if [ "$NEW_SIGNATURE" = "developer-id" ]; then
  echo "✅ After the Developer ID signature: codesign --verify --deep --strict, the keychain helper's own signature, entitlements of every piece (library validation on in the renderer and GPU helpers), evs-vmp verify-pkg"
else
  # The ad hoc signature of the castLabs binary does not seal the resources: `codesign --strict` fails on it whatever is done, so it is not run.
  echo "✅ EVS signature verified (evs-vmp verify-pkg); codesign --verify --strict is not run on an ad hoc signature"
fi
# The public keys of the update feed are in app.asar, as text like the addresses below: a build without them would believe no feed.
if [ -n "$FEED_KEYS" ]; then
  while IFS= read -r FEED_KEY; do
    if ! LC_ALL=C grep -a -q -F -- "$FEED_KEY" "$APP/Contents/Resources/app.asar"; then
      echo "❌ The public key $FEED_KEY of the update feed is not in $APP/Contents/Resources/app.asar: this build would refuse every feed. Nothing is installed"
      exit 1
    fi
  done <<<"$FEED_KEYS"
  echo "✅ Public key(s) of the update feed in app.asar: a feed is believed only when one of them signed it"
fi
# The update feeds are in app.asar (sealed by the integrity fuse and the signature; the archive is not compressed: the addresses are there as text), and
# Info.plist refuses a downgrade (ElectronSquirrelPreventDowngrades, electron-builder.yml): a build that would not install what the feed names stops here.
if [ -n "$UPDATE_FEED" ]; then
  if ! LC_ALL=C grep -a -q -F -- "$UPDATE_FEED" "$APP/Contents/Resources/app.asar"; then
    echo "❌ The update feed is not in $APP/Contents/Resources/app.asar: electron-vite did not write MAIN_VITE_UPDATE_FEED. Nothing is installed"
    exit 1
  fi
  if [ -n "$TEST_FEED" ] && ! LC_ALL=C grep -a -q -F -- "$TEST_FEED" "$APP/Contents/Resources/app.asar"; then
    echo "❌ The test update feed is not in $APP/Contents/Resources/app.asar: electron-vite did not write MAIN_VITE_UPDATE_FEED_TEST. Nothing is installed"
    exit 1
  fi
  if [ "$(/usr/libexec/PlistBuddy -c 'Print :ElectronSquirrelPreventDowngrades' "$APP/Contents/Info.plist" 2>/dev/null)" != "true" ]; then
    echo "❌ Info.plist lacks ElectronSquirrelPreventDowngrades: an update could install an older build. Nothing is installed"
    exit 1
  fi
  echo "✅ Update feed in app.asar: $UPDATE_FEED; downgrades refused (ElectronSquirrelPreventDowngrades)"
  if [ -n "$TEST_FEED" ]; then echo "✅ Test update feed in app.asar: $TEST_FEED"; fi
else
  echo "   No update feed built in: Check for Updates… reads a feed given by hand at most, and installs nothing (--update-feed builds one in)"
fi

# The cookies, before anything is installed: castLabs' set encrypts them, in the profile the installed app opens (the normal app opens it too).
# Said only: the profile is neither read nor copied here, the backup is the maintainer's to make.
if [ "$FUSES" = "--castlabs-fuses" ]; then
  echo ""
  echo "🍪 This build encrypts the cookies of the profile (fuse EnableCookieEncryption, part of castLabs' set)."
  echo "   ONE WAY: from its first launch, the cookies are encrypted as they are written; a build without the fuse"
  echo "   (--original-fuses, an older build) no longer reads them. macOS may ask for access to the keychain."
  echo "   Recommended before the first launch, the app closed: a backup of the profile (this script does not make it):"
  echo '     ditto "$HOME/Library/Application Support/Lucium" "$HOME/Library/Application Support/lucium-profile-backups/$(date +%Y%m%d-%H%M%S)"'
  echo "   Going back: restore that backup AND rebuild with scripts/build-drm-release.sh --original-fuses (docs/drm.md)."
fi

# Step 2b: notarization, after the last signature and before anything is installed. notarytool takes a zip, not a folder: the zip sent is a
# throw-away copy, the ticket is stapled to the app itself. Stapling writes a file the signatures do not seal; EVS is checked again all the same.
if [ "$NOTARIZE" = 1 ]; then
  echo ""
  echo "📮 Step 2b: Notarizing with the keychain profile « $NOTARY_PROFILE »..."
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/lucium-notarize-XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$WORK/notarize.zip"
  set +e
  xcrun notarytool submit "$WORK/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json > "$WORK/answer.json"
  SUBMIT_STATUS=$?
  set -e
  ANSWER_STATUS="$(plutil -extract status raw -o - "$WORK/answer.json" 2>/dev/null || true)"
  ANSWER_ID="$(plutil -extract id raw -o - "$WORK/answer.json" 2>/dev/null || true)"
  if [ "$SUBMIT_STATUS" != 0 ] || [ "$ANSWER_STATUS" != "Accepted" ]; then
    echo "❌ Apple did not accept the app (${ANSWER_STATUS:-notarytool exit code $SUBMIT_STATUS}): nothing is installed"
    if [ -n "$ANSWER_ID" ]; then echo "   The reason: xcrun notarytool log $ANSWER_ID --keychain-profile \"$NOTARY_PROFILE\""; fi
    exit 1
  fi
  echo "✅ Accepted by Apple (submission $ANSWER_ID)"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute -vv "$APP"
  EVS="${LUCIUM_EVS_BIN:-$HOME/Library/Application Support/lucium-drm-tools/evs-venv/bin}/evs-vmp"
  if [ -t 0 ]; then "$EVS" verify-pkg "$(dirname "$APP")"; else "$EVS" -n verify-pkg "$(dirname "$APP")"; fi
  VERSION="$(node -p "require('./package.json').version")"
  ARCHIVE="dist-drm/Lucium-$VERSION-arm64.zip"
  rm -f "$ARCHIVE"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
  # Its SHA-256, in a file beside it, as make-dmg.mjs writes the one of the disk image: the line the annotation of the tag carries. Run inside
  # the folder, so that the line names the file without its folder (the release workflow reads no other form). Never a sum typed by hand.
  (cd "$(dirname "$ARCHIVE")" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
  echo "✅ Notarized, stapled and checked: $ARCHIVE is the file to hand out (its SHA-256: $ARCHIVE.sha256)"
  # The build record, beside the archive: its SHA-256 and the commit asked before the build. Unquoted on purpose: the two words of `start`.
  # shellcheck disable=SC2086
  node scripts/build-record.mjs write "$ARCHIVE" $BUILD_START
  if [ -n "$UPDATE_FEED" ]; then
    # The release file Squirrel reads, written from this very archive (its SHA-256 and size): published after the archive, never before. One file per
    # channel the version goes to (the archive is published in the folder of each).
    echo "   The release file of the stable feed: node scripts/make-update-feed.mjs $ARCHIVE ${UPDATE_FEED%/*}/ > dist-drm/feed.json"
    if [ -n "$TEST_FEED" ]; then echo "   The release file of the test feed: node scripts/make-update-feed.mjs $ARCHIVE ${TEST_FEED%/*}/ > dist-drm/feed-test.json"; fi
  fi
fi

# Step 3: Install in place, only when the app is closed (never forced). The previous app is kept in a backup folder.
# A process named Lucium stops the install (pgrep reads CFBundleExecutable; the development copy of scripts/dev-electron.mjs is named Lucium too,
# on purpose: it opens the same profile).
echo ""
if [ "$NO_INSTALL" = 1 ]; then
  echo "⏭️  Step 3: Not installed (--no-install): the build is in $APP"
  exit 0
fi
echo "📥 Step 3: Installing in /Applications..."
if pgrep -x Lucium >/dev/null; then
  echo "⚠️  Lucium is running: the build is ready in $APP, not installed. Quit it and run this script again."
  exit 0
fi
BACKUPS="$HOME/Library/Application Support/lucium-app-backups"
BACKUP="$BACKUPS/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
if [ -d /Applications/Lucium.app ]; then mv /Applications/Lucium.app "$BACKUP/"; fi
ditto "$APP" /Applications/Lucium.app
echo "✅ Installed: /Applications/Lucium.app. Previous app: $BACKUP"
# The older copies go, once the new app is in place: each weighs about 300 MB and stays runnable with the flaws it had. The newest stay, as the way back
# (docs/drm.md); LUCIUM_APP_BACKUPS_KEEP says how many (3 when it is not set). The build is installed either way: a copy that cannot be removed is only said.
if PRUNED="$(bash "$PROJECT_ROOT/scripts/prune-app-backups.sh" "$BACKUPS" "${LUCIUM_APP_BACKUPS_KEEP:-3}")"; then
  if [ -n "$PRUNED" ]; then echo "$PRUNED" | sed 's/^/   older copy /'; fi
else
  echo "⚠️  The older copies in $BACKUPS could not be pruned: remove them by hand."
fi
# What the script cannot do for the maintainer: macOS keeps these by identifier, and a build whose identifier or signature changed is a new app for it.
echo ""
echo "👉 By hand, when macOS took this build for a new app (its identifier or its signature changed):"
echo "   - Dock: if the Lucium tile shows a question mark, remove it, then drag /Applications/Lucium.app to the Dock."
echo "   - Login Items: if System Settings › General › Login Items no longer lists Lucium, add it again."
echo "   - Default web browser: System Settings › Desktop & Dock › Default web browser should say Lucium; open a link from another app to check."

echo ""
echo "═══════════════════════════════════════════════════════════════"
if [ "$NEW_SIGNATURE" = "developer-id" ]; then
  echo "✅ DRM Build Complete, Signed (EVS + Developer ID) and Installed"
  echo "   Check that Netflix plays before relying on it (docs/drm.md)."
else
  echo "✅ DRM Build Complete, Signed (EVS, ad hoc) and Installed (Netflix ready)"
fi
echo "═══════════════════════════════════════════════════════════════"

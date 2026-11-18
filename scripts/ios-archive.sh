#!/usr/bin/env bash
# Archives the iOS application and sends it to App Store Connect, for TestFlight (docs/ios.md, section 10). This is the MAINTAINER's step, on the
# maintainer's Mac (AGENTS.md, section 7): it signs and it sends. No assistant and no workflow runs it without --dry-run.
#
#   scripts/ios-archive.sh                    checks, archives, exports and SENDS the build to App Store Connect (internal TestFlight only)
#   scripts/ios-archive.sh --export-only      the same, but writes the .ipa and sends nothing: out-ios-archive/export-<build>/
#   scripts/ios-archive.sh --refresh-lists    first fetches and converts the filter lists again (node scripts/ios-filter-lists.mjs)
#   scripts/ios-archive.sh --dry-run          runs the checks for real and only PRINTS what would be built, signed and sent
#   --build N        the build number (CFBundleVersion); default: the minutes since 1 January 2026 UTC, which grows at every send
#   --team ID        the Apple team; default: LUCIUM_IOS_TEAM, else the team of the project (docs/ios.md, section 10.1)
#   --allow-external lets App Store Connect hand the build to external testers too (default: internal testers only, for good: Apple cannot undo it)
#
# What it does, in this order, and stops at the first that fails:
#   1. refuses unless ios/Lucium/FilterLists/ is whole and ios/Lucium/Guard/ is there (docs/ios.md, section 6.3): an archive without the filter lists
#      would hand testers the short built-in list instead of the blocker;
#   2. generates the Xcode project (xcodegen);
#   3. archives it in Release, signed automatically with the team (`-allowProvisioningUpdates`: Xcode talks to Apple and makes the profiles);
#   4. reads the archive back: the right application, the right build number, the filter lists and the page guard inside;
#   5. exports it, and sends it (ExportOptions.plist: method app-store-connect, destination upload).
# The build number is given on the command line and never committed. Nothing secret is read or written here: the signing goes through the account
# that Xcode is signed in with (Xcode > Settings > Accounts) and the keychain of the Mac, which this script never opens.
#
# It is heavy (a Release build of Swift: several minutes and a good part of the CPU) and it may ask for the keychain password once. It opens no window.
# Output goes to out-ios-archive/ (LUCIUM_IOS_OUT; Git ignores it), with a log per step.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cli=(node "$root/scripts/ios-archive/cli.mjs")
# The team of ConsilioWEB (docs/ios.md, section 10.1). Not a secret: it is in every signature. docs/ios.md says the same; a test keeps them equal.
default_team="9A9AUX9UHT"
# The identifier of the application, read from the project: the one source (it cannot change once a build has been sent, docs/ios.md, section 10.1).
bundle_id="$(awk '/PRODUCT_BUNDLE_IDENTIFIER:/ && $2 !~ /\.tests$/ { print $2; exit }' "$root/ios/project.yml")"
[ -n "$bundle_id" ] || { echo "ios-archive: no PRODUCT_BUNDLE_IDENTIFIER in ios/project.yml" >&2; exit 1; }
out="${LUCIUM_IOS_OUT:-$root/out-ios-archive}"

dry=0 export_only=0 refresh=0 external=0 build=""
team="${LUCIUM_IOS_TEAM:-$default_team}"

die() {
  echo "ios-archive: $*" >&2
  exit 1
}
# Anything that stops the script without a message of its own still says where.
trap 'echo "ios-archive: a command failed unexpectedly (line $LINENO, status $?). Nothing was sent unless the last step above says so." >&2' ERR

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --export-only) export_only=1 ;;
    --refresh-lists) refresh=1 ;;
    --allow-external) external=1 ;;
    --build) [ $# -ge 2 ] || die "--build needs a number"; build="$2"; shift ;;
    --team) [ $# -ge 2 ] || die "--team needs an identifier"; team="$2"; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument \"$1\" (--help says which exist)" ;;
  esac
  shift
done

[[ "$team" =~ ^[A-Z0-9]{10}$ ]] || die "the team \"$team\" is not an Apple team identifier (ten capital letters and digits): give it with --team or LUCIUM_IOS_TEAM"
[ -z "$build" ] || [[ "$build" =~ ^[1-9][0-9]{0,8}$ ]] || die "the build number \"$build\" is not a whole number of one to nine digits without a leading zero"
command -v node >/dev/null || die "node is missing (docs/ios.md, section 6.3: the checks are in JavaScript)"

if [ "$dry" = 0 ]; then
  [ "$(uname)" = Darwin ] || die "this runs on a Mac: an iOS application is archived by Xcode"
  command -v xcodegen >/dev/null || die "xcodegen is missing: brew install xcodegen (a development tool, MIT)"
  xcodebuild -version >/dev/null 2>&1 || die "Xcode is not ready: install it, open it once, and point the command line at it (sudo xcode-select -s /Applications/Xcode.app)"
fi

# Xcode makes the .ipa with /usr/bin/rsync -E (openrsync), which starts the "rsync" found on the PATH. Homebrew's rsync 3.x does not accept it ("--extended-attributes:
# unknown option") and the export stops with "Copy failed" (seen on the first real send, 18 November 2026). So xcodebuild gets the system folders first. The tool
# is looked up BEFORE the PATH changes: the one that runs stays the one the user's PATH names (a stand-in in the tests, the selected Xcode on a Mac).
xcodebuild_bin="$(command -v xcodebuild || true)"
xcodebuild() { PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH" "$xcodebuild_bin" "$@"; }

step() { echo; echo "== $*"; }
# A command that is run, or, in a dry run, only shown. The arguments are printed so that they can be copied.
run() {
  if [ "$dry" = 1 ]; then
    printf 'would run:'
    printf ' %q' "$@"
    echo
  else
    "$@"
  fi
}
# A long command whose output is kept in a log of the output folder as well as shown; its status is the command's.
logged() {
  local name="$1"
  shift
  if [ "$dry" = 1 ]; then
    run "$@"
    return 0
  fi
  echo "   (log: $out/$name-$build.log)"
  "$@" 2>&1 | tee "$out/$name-$build.log"
}

# ---------- 1. what the application must carry ----------
if [ "$refresh" = 1 ]; then
  step "Filter lists: fetch and convert again (a plain GET of the public address of each list, nothing sent)"
  run node "$root/scripts/ios-filter-lists.mjs" || die "the filter lists could not be refreshed. The previous folder is untouched. Run pnpm install if a module is missing, and check the network."
fi

step "Checks: the filter lists and the page guard"
if ! "${cli[@]}" check-sources; then
  cat >&2 <<'EOF'

ios-archive: nothing was built. Prepare the filter lists on this Mac, then run this script again:
    node scripts/ios-filter-lists.mjs          (or: scripts/ios-archive.sh --refresh-lists)
The page guard is committed: if it is missing, run node scripts/ios-guard.mjs.
EOF
  exit 1
fi

# ---------- 2. what is being built ----------
if [ -z "$build" ]; then build="$("${cli[@]}" build-number)"; fi
version="$(awk -F'"' '/MARKETING_VERSION/ { print $2; exit }' "$root/ios/project.yml")"
commit="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
changed="$(git -C "$root" status --porcelain 2>/dev/null | wc -l | tr -d ' ' || true)"
archive="$out/Lucium-$build.xcarchive"
export_dir="$out/export-$build"
plist="$out/ExportOptions-$build.plist"
destination=upload
if [ "$export_only" = 1 ]; then destination=export; fi

step "Build"
echo "   application   $bundle_id, version $version, build $build"
echo "   team          $team"
echo "   source        commit $commit, ${changed:-0} file(s) changed in the working tree"
if [ "${changed:-0}" != 0 ]; then echo "   note          the archive is made from the working tree as it is, not from the commit"; fi
if [ "$destination" = upload ]; then
  if [ "$external" = 1 ]; then echo "   end           SENT to App Store Connect; internal AND external TestFlight"; else echo "   end           SENT to App Store Connect; internal TestFlight only"; fi
else
  echo "   end           exported only: nothing is sent"
fi
if [ "$dry" = 0 ]; then mkdir -p "$out"; fi

# ---------- 3. the project, the archive ----------
step "Xcode project (xcodegen)"
(cd "$root/ios" && run xcodegen generate)

step "Archive (Release, signed automatically with the team $team)"
archive_command=(xcodebuild archive
  -project "$root/ios/Lucium.xcodeproj" -scheme Lucium -configuration Release -destination 'generic/platform=iOS'
  -archivePath "$archive" -allowProvisioningUpdates
  DEVELOPMENT_TEAM="$team" CURRENT_PROJECT_VERSION="$build" CODE_SIGN_STYLE=Automatic)
if ! logged archive "${archive_command[@]}"; then
  cat >&2 <<EOF

ios-archive: the archive failed, so nothing was exported or sent. The log is $out/archive-$build.log. The usual causes:
  - Xcode is not signed in to the Apple account of the team $team (Xcode > Settings > Accounts), or that account cannot make profiles for it;
  - the identifier $bundle_id is not registered for that team (App Store Connect / developer.apple.com, docs/ios.md section 10.2);
  - the Mac is offline (-allowProvisioningUpdates talks to Apple), or the keychain asked for its password and was refused;
  - a compile error: the lines above say which file.
EOF
  exit 1
fi

# ---------- 4. what the archive holds ----------
step "Check the archive"
if [ "$dry" = 1 ]; then
  run "${cli[@]}" check-archive "$archive" --build "$build" --bundle-id "$bundle_id"
elif ! "${cli[@]}" check-archive "$archive" --build "$build" --bundle-id "$bundle_id"; then
  die "the archive $archive was not exported or sent (see the reasons above). Nothing left this Mac."
fi

# ---------- 5. export, and send ----------
step "ExportOptions.plist (method app-store-connect, destination $destination)"
options=(export-options --team "$team" --destination "$destination")
if [ "$external" = 1 ]; then options+=(--allow-external); fi
if [ "$dry" = 1 ]; then
  "${cli[@]}" "${options[@]}"
else
  "${cli[@]}" "${options[@]}" >"$plist"
  echo "   written: $plist"
fi

if [ "$destination" = upload ]; then step "Export and SEND to App Store Connect"; else step "Export (nothing is sent)"; fi
export_command=(xcodebuild -exportArchive -archivePath "$archive" -exportPath "$export_dir" -exportOptionsPlist "$plist" -allowProvisioningUpdates)
if ! logged export "${export_command[@]}"; then
  cat >&2 <<EOF

ios-archive: the export failed. The log is $out/export-$build.log, the archive is kept at $archive. The usual causes:
  - the build number $build was already used for this version: run again with --build <a larger number>;
  - no app record for $bundle_id in App Store Connect, or an agreement to sign (App Store Connect > Business);
  - Xcode has no distribution certificate or profile it may create for the team $team (-allowProvisioningUpdates asks Apple for them);
  - the Mac is offline.
Whether the build reached Apple: look in App Store Connect > Apps > Lucium > TestFlight > Builds, not in this output.
EOF
  exit 1
fi

echo
if [ "$dry" = 1 ]; then
  echo "== Dry run: nothing was built, signed or sent. The checks above ran for real."
elif [ "$destination" = upload ]; then
  echo "== Done: build $build was handed to App Store Connect. It is processed there (a few minutes, sometimes longer) before it shows in TestFlight."
  echo "   Follow it in App Store Connect > Apps > Lucium > TestFlight > Builds (docs/ios.md, section 10.3)."
else
  echo "== Done: the .ipa is in $export_dir. Nothing was sent; send it later from Transporter."
fi

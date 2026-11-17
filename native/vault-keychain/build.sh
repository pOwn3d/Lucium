#!/usr/bin/env bash
# Builds the keychain service of the password vault (main.swift) as out-native/LuciumKeychain.xpc, the XPC service the application carries in
# Contents/XPCServices/ and that src/main/vault-keychain.ts reaches through the addon of native/vault-xpc/. A bundle and not a bare tool: the
# entitlements that open the data protection keychain must be authorized by a provisioning profile, and a profile can only be embedded in an
# app-like bundle, which an XPC service is (Apple, TN3125 and TN3137).
#
#   native/vault-keychain/build.sh                     universal (arm64 + x86_64), signed ad hoc: it runs, but admits no caller (no team to require)
#                                                      and the keychain would refuse it (errSecMissingEntitlement): Lucium then says Touch ID is unavailable
#   native/vault-keychain/build.sh --arch arm64        Apple silicon only
#
# Signed for distribution when LUCIUM_SIGN_IDENTITY is set (the "Developer ID Application: … (TEAMID)" identity package-drm.mjs and
# `pnpm package:signed` use), with:
#   LUCIUM_KEYCHAIN_PROFILE   path of the Developer ID provisioning profile made for the App ID <TEAMID>.app.lucium.browser.keychain
#   LUCIUM_TEAM_ID            optional: the team identifier, read from the identity's "(…)" when not set
# Without the profile the service is signed with the hardened runtime but without the keychain entitlements (restricted entitlements that no
# profile authorizes would make macOS kill it at launch). Nothing of the identity, the team or the profile is written in this repository.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="${LUCIUM_NATIVE_OUT:-$root/out-native}"
app="$out/LuciumKeychain.xpc"
executable="lucium-keychain"
bundle_id="app.lucium.browser.keychain"
access_group_suffix="app.lucium.browser.vault"
minimum="12.0"
arch="universal"

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch="${2:-}"; shift 2 ;;
    *) echo "build.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
case "$arch" in
  universal) targets="arm64 x86_64" ;;
  arm64) targets="arm64" ;;
  *) echo "build.sh: --arch is arm64 or universal" >&2; exit 2 ;;
esac

fail() { echo "build.sh: $*" >&2; exit 1; }
[ "$(uname -s)" = "Darwin" ] || fail "the keychain service is built on macOS only"
command -v swiftc >/dev/null || fail "swiftc not found (Xcode or its command line tools)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

slices=()
for target in $targets; do
  swiftc -O -whole-module-optimization -target "$target-apple-macos$minimum" -o "$work/$executable-$target" "$here/main.swift"
  slices+=("$work/$executable-$target")
done

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$here/Info.plist" "$app/Contents/Info.plist"
if [ "${#slices[@]}" -gt 1 ]; then
  lipo -create -output "$app/Contents/MacOS/$executable" "${slices[@]}"
else
  cp "${slices[0]}" "$app/Contents/MacOS/$executable"
fi
chmod 755 "$app/Contents/MacOS/$executable"

identity="${LUCIUM_SIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  codesign --force --sign - "$app"
  codesign --verify --strict "$app"
  echo "build.sh: $app (signed ad hoc: it admits no caller, and the keychain would refuse it)"
  exit 0
fi

team="${LUCIUM_TEAM_ID:-}"
if [ -z "$team" ]; then
  team="$(printf '%s' "$identity" | sed -n 's/.*(\([A-Z0-9]\{10\}\)).*/\1/p')"
fi
[ -n "$team" ] || fail "no team identifier: set LUCIUM_TEAM_ID or use an identity that ends with (TEAMID)"
# Ten capital letters and digits, whichever way it came: it goes into a pattern and into the entitlements, where anything else would be read as more.
printf '%s' "$team" | grep -Eqx '[A-Z0-9]{10}' || fail "the team identifier is not ten capital letters and digits: check LUCIUM_TEAM_ID"

sign() {
  local timestamp="$1"
  shift
  codesign --force --options runtime "$timestamp" "$@" --sign "$identity" "$app"
}

profile="${LUCIUM_KEYCHAIN_PROFILE:-}"
if [ -z "$profile" ]; then
  echo "build.sh: LUCIUM_KEYCHAIN_PROFILE is not set: signed WITHOUT the keychain entitlements, Touch ID will be unavailable" >&2
  sign --timestamp || { echo "build.sh: no timestamp from Apple, signing without" >&2; sign --timestamp=none; }
  codesign --verify --strict "$app"
  exit 0
fi
[ -f "$profile" ] || fail "LUCIUM_KEYCHAIN_PROFILE does not name a file"

# The profile must be the one of this App ID and must allow the access group: a wrong one would make macOS refuse to start the service.
security cms -D -i "$profile" > "$work/profile.plist" 2>/dev/null || fail "the provisioning profile cannot be decoded"
granted_id="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.application-identifier' "$work/profile.plist" 2>/dev/null || true)"
[ "$granted_id" = "$team.$bundle_id" ] || fail "the profile is for '$granted_id', not for '$team.$bundle_id'"
groups="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:keychain-access-groups' "$work/profile.plist" 2>/dev/null || true)"
printf '%s\n' "$groups" | grep -Eq "^[[:space:]]*($team\\.\\*|$team\\.${access_group_suffix//./\\.})[[:space:]]*$" \
  || fail "the profile does not allow the keychain access group $team.$access_group_suffix"

cp "$profile" "$app/Contents/embedded.provisionprofile"
sed "s/__TEAM_ID__/$team/g" "$here/entitlements.plist.in" > "$work/entitlements.plist"
plutil -lint -s "$work/entitlements.plist"
sign --timestamp --entitlements "$work/entitlements.plist" \
  || { echo "build.sh: no timestamp from Apple, signing without" >&2; sign --timestamp=none --entitlements "$work/entitlements.plist"; }
codesign --verify --strict --verbose=2 "$app"
echo "build.sh: $app (Developer ID, keychain entitlements)"

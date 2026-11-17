#!/usr/bin/env bash
# Builds the translation helper of the local page translation (main.swift, with native/shared/caller.swift: the check that the process that
# starts it is Lucium) as out-native/LuciumTranslate.app, the bundle the application
# carries in Contents/Helpers/ and that src/main/translate/system.ts runs, once for a page (protocol 2: lines of JSON with ids). A bundle and not
# a bare tool: the Translation framework knows a program by its bundle identifier, and the bundle carries LSUIElement (no Dock icon while it
# runs) and the protocol the program speaks (`LuciumTranslateProtocol`, which the main process reads to know how to run it).
#
#   native/system-translate/build.sh                   universal (arm64 + x86_64), signed ad hoc with the hardened runtime
#   native/system-translate/build.sh --arch arm64      Apple silicon only
#
# Signed for distribution when LUCIUM_SIGN_IDENTITY is set (the "Developer ID Application: … (TEAMID)" identity package-drm.mjs and
# `pnpm package:signed` use): hardened runtime, timestamp, and NO entitlement. The helper reaches the system's translation service only (no
# keychain, no network of its own, no camera, no JIT): the hardened runtime without exception is enough, and the application's entitlements
# (build/entitlements.mac.plist) are not given to it. Nothing of the identity is written in this repository.
#
# The minimum system is 12.0, as for the keychain helper (Electron 45 itself needs 13.0): the Translation framework is weakly linked, and the
# program answers "unavailable" before macOS 26 (TranslationSession(installedSource:target:), the session without a window, is macOS 26.0 and later).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="${LUCIUM_NATIVE_OUT:-$root/out-native}"
app="$out/LuciumTranslate.app"
executable="lucium-translate"
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
[ "$(uname -s)" = "Darwin" ] || fail "the helper is built on macOS only"
command -v swiftc >/dev/null || fail "swiftc not found (Xcode or its command line tools)"

# The protocol the bundle names is the one the program speaks: a bundle that names another would be run the wrong way.
named="$(/usr/libexec/PlistBuddy -c 'Print :LuciumTranslateProtocol' "$here/Info.plist" 2>/dev/null || true)"
grep -q "^let protocolVersion = ${named:-none}\$" "$here/main.swift" || fail "Info.plist names the protocol '${named}', main.swift speaks another"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

slices=()
for target in $targets; do
  # Weakly linked: on a macOS without the framework (before 15) the program still starts, and says "unavailable".
  swiftc -O -whole-module-optimization -target "$target-apple-macos$minimum" -Xlinker -weak_framework -Xlinker Translation \
    -o "$work/$executable-$target" "$here/main.swift" "$here/../shared/caller.swift"
  slices+=("$work/$executable-$target")
done

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$here/Info.plist" "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"
if [ "${#slices[@]}" -gt 1 ]; then
  lipo -create -output "$app/Contents/MacOS/$executable" "${slices[@]}"
else
  cp "${slices[0]}" "$app/Contents/MacOS/$executable"
fi
chmod 755 "$app/Contents/MacOS/$executable"

identity="${LUCIUM_SIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  codesign --force --options runtime --sign - "$app"
  codesign --verify --strict "$app"
  echo "build.sh: $app (signed ad hoc)"
  exit 0
fi

sign() {
  codesign --force --options runtime "$1" --sign "$identity" "$app"
}
sign --timestamp || { echo "build.sh: no timestamp from Apple, signing without" >&2; sign --timestamp=none; }
codesign --verify --strict --verbose=2 "$app"
echo "build.sh: $app (Developer ID, hardened runtime, no entitlement)"

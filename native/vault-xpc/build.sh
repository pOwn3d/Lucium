#!/usr/bin/env bash
# Builds the addon of the main process that reaches the keychain service of the password vault (vault_xpc.c, native/vault-keychain/ is the
# service) as out-native/vault-xpc.node, the file the application carries in Contents/Resources/ (outside app.asar) and that
# src/main/vault-keychain.ts loads. A Node-API addon (version 8), built by clang alone, without node-gyp: `-bundle -undefined dynamic_lookup`,
# the napi_* functions are found in the process that loads it (Electron's framework), and Node-API keeps the same binary good for every Electron.
# The headers are the local Node's (<node>/../include/node), only for the declarations: nothing of Node is linked in.
#
#   native/vault-xpc/build.sh                      universal (arm64 + x86_64), signed ad hoc
#   native/vault-xpc/build.sh --arch arm64         Apple silicon only
#
# Signed with LUCIUM_SIGN_IDENTITY when it is set, with the hardened runtime and no entitlement; the signature of the application signs it
# again as one of its pieces (same identity, same team: the hardened runtime of the main process loads it without disable-library-validation).
# Nothing of the identity is written in this repository.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="${LUCIUM_NATIVE_OUT:-$root/out-native}"
addon="$out/vault-xpc.node"
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
[ "$(uname -s)" = "Darwin" ] || fail "the addon is built on macOS only"
command -v clang >/dev/null || fail "clang not found (Xcode or its command line tools)"
command -v node >/dev/null || fail "node not found: its headers declare Node-API"
headers="$(cd "$(dirname "$(node -p process.execPath)")/../include/node" 2>/dev/null && pwd)" || fail "no include/node beside the local Node"
[ -f "$headers/node_api.h" ] || fail "no node_api.h in $headers"

arch_flags=()
for target in $targets; do arch_flags+=(-arch "$target"); done

mkdir -p "$out"
clang -bundle -undefined dynamic_lookup "${arch_flags[@]}" -mmacosx-version-min="$minimum" -O2 -fvisibility=hidden -fstack-protector-strong \
  -Wall -Wextra -Werror -DNAPI_VERSION=8 -I"$headers" \
  -framework Security -framework CoreFoundation \
  -o "$addon" "$here/vault_xpc.c"

identity="${LUCIUM_SIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  codesign --force --options runtime --sign - "$addon"
  codesign --verify --strict "$addon"
  echo "build.sh: $addon (signed ad hoc)"
  exit 0
fi
sign() {
  codesign --force --options runtime "$1" --sign "$identity" "$addon"
}
sign --timestamp || { echo "build.sh: no timestamp from Apple, signing without" >&2; sign --timestamp=none; }
codesign --verify --strict --verbose=2 "$addon"
echo "build.sh: $addon (Developer ID, hardened runtime, no entitlement)"

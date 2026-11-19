#!/usr/bin/env bash
# Checks the iOS application (ios/) without opening a single window:
#   1. the tests of LuciumKit, on the Mac itself (`swift test`, no simulator);
#   2. the project is generated (XcodeGen), built and tested (`xcodebuild test`) on an iOS simulator that is booted by
#      `simctl`. Simulator.app is never started: the simulator runs in the background, nothing appears on screen.
# Optional argument: a folder where a screenshot of the application is written (French, then English).
#
# It is heavy (a build of Swift, a simulator): several minutes and a good part of the CPU. AGENTS.md, section 1: say so before
# running it on a machine somebody is using. Nothing is signed, nothing is sent to Apple.
#
# LUCIUM_IOS_RUNTIME and LUCIUM_IOS_DEVICE choose the simulator (default: iOS 26.5 on an iPhone 17 Pro).
# Each run creates its own simulator ("Lucium-iOS-Check-<epoch>-<pid>-<random>") and deletes it at the end, so runs in parallel do not touch each other;
# at the start, simulators of that prefix older than 2 hours (left by a killed run) are deleted, younger ones are never touched.
# LUCIUM_IOS_KEEP=1 keeps this run's simulator instead of deleting it (it is then reaped by a later run once it is 2 hours old).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
runtime="${LUCIUM_IOS_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}"
device="${LUCIUM_IOS_DEVICE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}"
prefix="Lucium-iOS-Check"
shots="${1:-}"
bundle="app.lucium.browser.ios"

# shellcheck source=scripts/simulator-lib.sh
. "$root/scripts/simulator-lib.sh"
name="$(sim_unique_name "$prefix")"

command -v xcodegen >/dev/null || { echo "xcodegen is missing: brew install xcodegen (a development tool, MIT)" >&2; exit 1; }

echo "== LuciumKit (swift test, on the Mac)"
(cd "$root/ios/LuciumKit" && swift test)

echo "== Xcode project"
(cd "$root/ios" && xcodegen generate)

sim_reap_orphans "$prefix"
udid="$(xcrun simctl create "$name" "$device" "$runtime")"
cleanup() {
  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  if [ "${LUCIUM_IOS_KEEP:-0}" != 1 ]; then xcrun simctl delete "$udid" >/dev/null 2>&1 || echo "could not delete simulator $name ($udid)" >&2; fi
}
trap cleanup EXIT

echo "== Simulator $name $udid (background, no window)"
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null

echo "== xcodebuild test"
# The simulator build is signed ad hoc ("Sign to Run Locally": no certificate, no team, no profile, nothing that leaves this Mac). An application with no
# signature at all has no keychain on the simulator (errSecMissingEntitlement, -34018), and the identity of the synchronisation lives in the keychain
# (docs/synchronisation.md, section 3.3). Nothing is signed for a device and nothing is handed to anyone.
# A folder for the picture of the licences screen, drawn by a test (xcodebuild hands TEST_RUNNER_* variables to the tests).
[ -n "$shots" ] && { mkdir -p "$shots"; export TEST_RUNNER_LUCIUM_SHOTS="$(cd "$shots" && pwd)"; }
(cd "$root/ios" && xcodebuild -project Lucium.xcodeproj -scheme Lucium -destination "id=$udid" -configuration Debug \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- -parallel-testing-enabled NO test)

if [ -n "$shots" ]; then
  echo "== Screenshots in $shots"
  mkdir -p "$shots"
  products="$(cd "$root/ios" && xcodebuild -project Lucium.xcodeproj -scheme Lucium -destination "id=$udid" -configuration Debug -showBuildSettings 2>/dev/null \
    | awk -F' = ' '/ BUILT_PRODUCTS_DIR /{print $2; exit}')"
  xcrun simctl install "$udid" "$products/Lucium.app"
  for language in fr en; do
    xcrun simctl launch "$udid" "$bundle" -AppleLanguages "($language)" -AppleLocale "${language}_$(echo "$language" | tr a-z A-Z)" >/dev/null
    sleep 4
    xcrun simctl io "$udid" screenshot "$shots/lucium-ios-$language.png"
    xcrun simctl terminate "$udid" "$bundle" >/dev/null
  done
fi
echo "== done"

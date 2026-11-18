#!/usr/bin/env bash
# Takes the pictures of the App Store listing (ios/AppStore/README.md): the real screens of the iOS application with demo data, on an iPhone of 6.9 inches
# and an iPad of 13 inches, in English and in French, without opening a single window. Nothing is signed, nothing is sent to Apple.
#
#   nice -n 15 scripts/ios-store-shots.sh [folder]        default folder: out-ios-store/ (Git ignores it)
#
# Output: <folder>/<en-US|fr-FR>/<iphone-6.9|ipad-13>/<NN-name>.png, the sizes App Store Connect accepts, with no alpha channel (scripts/ios-store-shots/finish.mjs).
#
# How: for each device a simulator is created and, for each language, booted in the background (`xcrun simctl boot`: no window, never Simulator.app) in
# that language and given the status bar a store picture shows (9:41, full battery); then LuciumTests/StoreScreenshotTests runs on it in each language and draws the screens one after the other
# in a real window. A picture is taken from here with `xcrun simctl io … screenshot`, when the test says (in the folder TEST_RUNNER_LUCIUM_STORE_SHOTS) that
# the screen is drawn and still: only the simulator draws the status bar, the Dynamic Island and the home indicator. Both simulators are deleted at the end.
#
# It is heavy (a build, two simulators, one after the other): several minutes and a good part of the CPU. AGENTS.md, section 1: say so before running it on a
# machine somebody is using, run one simulator at a time, and run `xcrun simctl shutdown all` if it was interrupted.
#
# LUCIUM_IOS_RUNTIME chooses the runtime (default: iOS 26.5). LUCIUM_STORE_ONLY=iphone-6.9 (or ipad-13) takes one device, LUCIUM_STORE_LOCALES=en-US one language.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/out-ios-store}"
runtime="${LUCIUM_IOS_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}"
only="${LUCIUM_STORE_ONLY:-}"
locales="${LUCIUM_STORE_LOCALES:-en-US fr-FR}"
# id : device type : pixels of a picture (App Store Connect: 6.9" is 1320 x 2868, 13" iPad is 2064 x 2752)
devices=(
  "iphone-6.9:com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max:1320x2868"
  "ipad-13:com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB:2064x2752"
)
# What the test is called, and the five screens it draws (the names it writes are the file names).
expected=(01-browse 02-tabs 03-spaces 04-commands 05-privacy)

command -v xcodegen >/dev/null || { echo "xcodegen is missing: brew install xcodegen (a development tool, MIT)" >&2; exit 1; }

echo "== Xcode project"
(cd "$root/ios" && xcodegen generate)

created=()
watcher=""
cleanup() {
  [ -n "$watcher" ] && kill "$watcher" >/dev/null 2>&1 || true
  for udid in "${created[@]:-}"; do
    [ -n "$udid" ] || continue
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$udid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# Answers a test that says `ready-<name>`: takes the picture, then says `done-<name>`.
watch() {
  local handshake="$1" udid="$2" target="$3"
  while [ ! -e "$handshake/stop" ]; do
    for ready in "$handshake"/ready-*; do
      [ -e "$ready" ] || continue
      local name="${ready##*/ready-}"
      xcrun simctl io "$udid" screenshot --type=png "$target/$name.png" >/dev/null 2>&1 || echo "the picture $name could not be taken" >&2
      rm -f "$ready"
      : > "$handshake/done-$name"
    done
    sleep 0.2
  done
}

built=0
for entry in "${devices[@]}"; do
  IFS=: read -r id device size <<<"$entry"
  [ -z "$only" ] || [ "$only" = "$id" ] || continue

  echo "== Simulator for $id (background, no window)"
  udid="$(xcrun simctl create "Lucium-Store-$id" "$device" "$runtime")"
  created+=("$udid")
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b >/dev/null

  if [ "$built" = 0 ]; then
    echo "== Build (once: the same product runs on both devices)"
    (cd "$root/ios" && xcodebuild -project Lucium.xcodeproj -scheme Lucium -destination "id=$udid" -configuration Debug \
      CODE_SIGNING_ALLOWED=NO build-for-testing)
    built=1
  fi

  for locale in $locales; do
    language="${locale%%-*}"
    region="${locale##*-}"
    target="$out/$locale/$id"
    # The language of the device itself, not only of the application: the status bar of an iPad writes the date, the keyboard follows the region. The system
    # reads it at start, so the device is restarted (it was booted just before).
    xcrun simctl spawn "$udid" defaults write -g AppleLanguages -array "$language"
    xcrun simctl spawn "$udid" defaults write -g AppleLocale -string "${language}_${region}"
    xcrun simctl shutdown "$udid"
    xcrun simctl boot "$udid"
    xcrun simctl bootstatus "$udid" -b >/dev/null
    xcrun simctl status_bar "$udid" override --time "9:41" --batteryState discharging --batteryLevel 100 --wifiBars 3 --cellularBars 4 --dataNetwork wifi
    # A fresh simulator shows the keyboard's first-use tips over the command bar: say they were seen (the keyboard's own preferences, in this simulator only).
    xcrun simctl spawn "$udid" defaults write com.apple.keyboard.preferences DidShowContinuousPathIntroduction -bool true
    xcrun simctl spawn "$udid" defaults write com.apple.keyboard.preferences DidShowGestureKeyboardIntroduction -bool true
    handshake="$(mktemp -d)"
    rm -rf "$target"; mkdir -p "$target"
    echo "== $id, $locale"
    watch "$handshake" "$udid" "$target" &
    watcher=$!
    status=0
    (cd "$root/ios" && TEST_RUNNER_LUCIUM_STORE_SHOTS="$handshake" xcodebuild -project Lucium.xcodeproj -scheme Lucium -destination "id=$udid" \
      -configuration Debug CODE_SIGNING_ALLOWED=NO -parallel-testing-enabled NO -testLanguage "$language" -testRegion "$region" \
      -only-testing:LuciumTests/StoreScreenshotTests test-without-building) || status=$?
    : > "$handshake/stop"
    wait "$watcher" 2>/dev/null || true
    watcher=""
    rm -rf "$handshake"
    [ "$status" = 0 ] || { echo "the run failed for $id, $locale" >&2; exit "$status"; }

    for name in "${expected[@]}"; do
      [ -s "$target/$name.png" ] || { echo "missing picture: $target/$name.png" >&2; exit 1; }
    done
    # The size of the device, and no alpha channel (the simulator writes one, the store takes none): refused or rewritten in place.
    node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$root/scripts/ios-store-shots/finish.mjs" "$size" "$target"/*.png
  done

  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  xcrun simctl delete "$udid" >/dev/null 2>&1 || true
  created=()
done
echo "== Pictures in $out"

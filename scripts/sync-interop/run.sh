#!/usr/bin/env bash
# Runs the Mac <-> iPhone interoperability check without opening a window (scripts/sync-interop/README.md):
#   1. the REAL Mac of the synchronisation (src/main/sync/, TypeScript, under Node via Vitest, no Electron) is started and listens on a real address of this machine;
#   2. an iOS simulator is booted in the background by `simctl` (Simulator.app is never started), like scripts/ios-check.sh;
#   3. the tests of ios/LuciumTests/SyncInteropTests.swift run the REAL Swift of the application on it, against that Mac, and drive it through its control port.
# Both are stopped and the simulator is deleted at the end, whatever happens. The simulator is named "Lucium-Interop-Check-<epoch>-<pid>-<random>", owned by
# this run alone (parallel runs do not touch each other); at the start, ones of that prefix older than 2 hours are deleted, younger ones never.
#
# Usage: scripts/sync-interop/run.sh [--only <Test>] [--report <dir>]
#   --only    one test of SyncInteropTests (testPairingThenSessionsInBothDirections, testPairingRefusedOnThePhoneKeepsNothing,
#             testACategoryTickedAloneOrWithoutStructureTakesNothingAwayFromEitherSide, testMeasuresWith200TodayTabsOnEachDevice,
#             testASessionEvery30SecondsForTheLengthOfTheSoak); default: all of them
#   --report  where the measures are written as JSON (default: a new folder under the system's temporary folder)
# Environment: LUCIUM_INTEROP_SOAK_SECONDS (length of the 30-second loop, default 90; 600 for the ten-minute measure), LUCIUM_INTEROP_TABS (Today tabs per device,
# default 200), LUCIUM_INTEROP_INTERFACE (the network interface the Mac listens on, default the first private IPv4 of an `en*`),
# LUCIUM_IOS_RUNTIME and LUCIUM_IOS_DEVICE (the simulator, as in ios-check.sh).
#
# It builds the application and boots a simulator: several minutes and a good part of the CPU. AGENTS.md section 1: say so before running it on a machine
# somebody is using. Nothing is signed for a device, nothing is sent anywhere: the connection never leaves this machine's local network.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
runtime="${LUCIUM_IOS_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}"
device="${LUCIUM_IOS_DEVICE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}"
prefix="Lucium-Interop-Check"
# shellcheck source=scripts/simulator-lib.sh
. "$root/scripts/simulator-lib.sh"
name="$(sim_unique_name "$prefix")"
only=""
report=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) only="$2"; shift 2 ;;
    --report) report="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v xcodegen >/dev/null || { echo "xcodegen is missing: brew install xcodegen (a development tool, MIT)" >&2; exit 1; }
scratch="$(mktemp -d "${TMPDIR:-/tmp}/lucium-interop.XXXXXX")"
[ -n "$report" ] || report="$scratch/report"
mkdir -p "$report"
report="$(cd "$report" && pwd)"
portfile="$scratch/port"
peerlog="$scratch/mac-peer.log"
peerpid=""
udid=""

cleanup() {
  if [ -s "$portfile" ]; then curl -s -m 5 -X POST "http://127.0.0.1:$(cat "$portfile")/stop" >/dev/null 2>&1 || true; fi
  [ -n "$peerpid" ] && { sleep 1; kill "$peerpid" >/dev/null 2>&1 || true; }
  if [ -n "$udid" ]; then
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$udid" >/dev/null 2>&1 || echo "could not delete simulator $name ($udid)" >&2
  fi
  echo "== stopped; the log of the Mac is $peerlog, the measures are in $report"
}
trap cleanup EXIT

echo "== The Mac (Node, no Electron, no window)"
(cd "$root" && LUCIUM_INTEROP_PORT_FILE="$portfile" exec node_modules/.bin/vitest run --config vitest.sync-interop.config.mts) >"$peerlog" 2>&1 &
peerpid=$!
for _ in $(seq 1 120); do [ -s "$portfile" ] && break; sleep 0.5; done
[ -s "$portfile" ] || { echo "the Mac did not start:" >&2; cat "$peerlog" >&2; exit 1; }
grep LUCIUM_INTEROP_READY "$peerlog" || true

echo "== Xcode project"
(cd "$root/ios" && xcodegen generate)

sim_reap_orphans "$prefix"
udid="$(xcrun simctl create "$name" "$device" "$runtime")"
echo "== Simulator $udid (background, no window)"
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b >/dev/null

echo "== xcodebuild test (SyncInteropTests${only:+/$only})"
export TEST_RUNNER_LUCIUM_INTEROP_PORT="$(cat "$portfile")"
export TEST_RUNNER_LUCIUM_INTEROP_REPORT_DIR="$report"
for variable in LUCIUM_INTEROP_SOAK_SECONDS LUCIUM_INTEROP_TABS; do
  if [ -n "${!variable:-}" ]; then export "TEST_RUNNER_$variable=${!variable}"; fi
done
only_testing="LuciumTests/SyncInteropTests${only:+/$only}"
(cd "$root/ios" && xcodebuild -project Lucium.xcodeproj -scheme Lucium -destination "id=$udid" -configuration Debug \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- -parallel-testing-enabled NO -only-testing:"$only_testing" test)

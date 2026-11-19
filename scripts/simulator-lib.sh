# Shared by scripts/ios-check.sh and scripts/sync-interop/run.sh (sourced, not run).
# Every run owns one simulator named "<prefix>-<epoch>-<pid>-<random>": created by the run, deleted by the same run, never shared, so two runs in parallel
# (several workers on one machine) cannot shut down or delete each other's simulator.

# Deletes the simulators of <prefix> that are older than 2 hours (the epoch is in the name). A younger one may belong to a run in progress: it is left alone.
sim_reap_orphans() {
  local prefix="$1" now line name stamp
  now="$(date +%s)"
  while read -r line; do
    name="${line%% (*}"
    name="${name#"${name%%[![:space:]]*}"}"
    case "$name" in "$prefix"-*) ;; *) continue ;; esac
    stamp="${name#"$prefix"-}"
    stamp="${stamp%%-*}"
    case "$stamp" in '' | *[!0-9]*) continue ;; esac
    if [ $((now - stamp)) -gt 7200 ]; then
      udid_orphan="$(printf '%s' "$line" | grep -Eo '[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}' | head -1)"
      if [ -n "$udid_orphan" ]; then
        echo "== Orphan simulator $name (older than 2 h): deleting"
        xcrun simctl shutdown "$udid_orphan" >/dev/null 2>&1 || true
        xcrun simctl delete "$udid_orphan" >/dev/null 2>&1 || echo "could not delete $name" >&2
      fi
    fi
  done < <(xcrun simctl list devices | grep -F "$prefix-")
}

# Prints the unique name of this run's simulator.
sim_unique_name() { printf '%s-%s-%s-%s' "$1" "$(date +%s)" "$$" "$RANDOM"; }

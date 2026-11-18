#!/usr/bin/env bash
# Helpers of .github/workflows/linux.yml, for the Ubuntu runners of GitHub only (it refuses to run anywhere else: it starts the application, on a
# virtual screen made by Xvfb, never on the screen of a desktop).
#
#   linux-ci.sh sandbox-state                      say what the kernel allows Chromium's sandbox to do (nothing is changed)
#   linux-ci.sh sandbox-profile <binary>           Ubuntu 24.04: let that one binary create user namespaces, by an AppArmor profile (what the .deb ships)
#   linux-ci.sh unrestrict                         Ubuntu 24.04: lift the restriction on user namespaces for the whole machine (a runner is thrown away)
#   linux-ci.sh smoke <label> <start|refused> <command...>
#                                                  start the built application, as a user would, and check what happens (`refused`: the launch
#                                                  is refused, the line says why on the standard error and a box says it on the screen)
#
# The sandbox of Chromium is never switched off: no step of the workflow and no line of this file passes --no-sandbox. `smoke` fails when a process of
# the application carries it, and when a renderer has no seccomp filter (the proof that the sandbox is on, not only that nobody asked it to be off).
set -euo pipefail

if [ "$(uname -s)" != Linux ]; then
  echo "linux-ci.sh: Linux only (it starts the application)" >&2
  exit 2
fi

LOGS="${LUCIUM_CI_LOGS:-out-linux}"
mkdir -p "$LOGS"
RESTRICTION=/proc/sys/kernel/apparmor_restrict_unprivileged_userns

fail() {
  echo "::error::$*"
  return 1
}

sandbox_state() {
  local restricted=absent
  [ -r "$RESTRICTION" ] && restricted="$(cat "$RESTRICTION")"
  echo "kernel.apparmor_restrict_unprivileged_userns: $restricted"
  if unshare -Ur true 2>/dev/null; then
    echo "unprivileged user namespaces, from this shell: usable"
  else
    echo "unprivileged user namespaces, from this shell: refused"
  fi
}

# The profile electron-builder puts in a .deb (templates/linux/apparmor-profile.tpl), for any binary: it lets that binary, and nothing else, create the
# user namespace Chromium's sandbox is made of. Nothing is loaded when the machine does not restrict them. A failure to load is a failure of the run:
# the answer is never to start the application without its sandbox.
sandbox_profile() {
  local binary
  binary="$(realpath "${1:?the binary to give the profile to}")"
  [ -x "$binary" ] || { fail "$binary is not an executable"; return 1; }
  if [ ! -r "$RESTRICTION" ] || [ "$(cat "$RESTRICTION")" != 1 ]; then
    echo "user namespaces are not restricted here: no profile needed for $binary"
    return 0
  fi
  local name file
  name="lucium-ci-$(printf '%s' "$binary" | sha1sum | cut -c1-8)"
  file="$(mktemp)"
  cat >"$file" <<PROFILE
abi <abi/4.0>,
include <tunables/global>

profile $name "$binary" flags=(unconfined) {
  userns,
}
PROFILE
  sudo apparmor_parser --replace "$file"
  rm -f "$file"
  sudo grep -q "^$name " /sys/kernel/security/apparmor/profiles || { fail "the AppArmor profile $name did not load"; return 1; }
  echo "AppArmor profile $name loaded for $binary: it may create user namespaces"
}

unrestrict() {
  if [ -r "$RESTRICTION" ] && [ "$(cat "$RESTRICTION")" = 1 ]; then
    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  else
    echo "user namespaces are not restricted here: nothing to lift"
  fi
}

# The processes of one run of the application: all of them carry the --user-data-dir of the run (the children of Chromium inherit it).
run_pids() { pgrep -f -- "--user-data-dir=$1" || true; }
renderer_pids() {
  local pid
  for pid in $(run_pids "$1"); do
    if tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q -- '--type=renderer'; then echo "$pid"; fi
  done
}

# What a started application must show. Returns 1 with the reason; the caller prints the log.
check_started() {
  local app="$1" data="$2" log="$3" windows=0 renderers="" waited=0
  while [ "$waited" -lt 90 ]; do
    if ! kill -0 "$app" 2>/dev/null; then
      fail "the application ended before it showed a window"
      return 1
    fi
    windows="$(xwininfo -root -tree 2>/dev/null | grep -ci lucium || true)"
    renderers="$(renderer_pids "$data")"
    if [ "$windows" -gt 0 ] && [ -n "$renderers" ]; then break; fi
    sleep 1
    waited=$((waited + 1))
  done
  if [ "$windows" -eq 0 ] || [ -z "$renderers" ]; then
    fail "no window of the application and no renderer after ${waited} s (windows: $windows, renderers: ${renderers:-none})"
    return 1
  fi
  echo "a window of the application and its renderer(s) appeared after ${waited} s"
  # Still there a little later: a start that crashes on its first frame is not a start.
  sleep 5
  kill -0 "$app" 2>/dev/null || { fail "the application ended after it showed its window"; return 1; }
  # The sandbox is on: no switch that turns it off, and the filter of the sandbox on every renderer (Seccomp: 2 is "filter mode").
  local pid
  for pid in $(run_pids "$data"); do
    if tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q -- '--no-sandbox'; then
      fail "process $pid runs with --no-sandbox"
      return 1
    fi
  done
  for pid in $renderers; do
    local seccomp
    seccomp="$(awk '/^Seccomp:/ {print $2}' "/proc/$pid/status")"
    echo "renderer $pid: Seccomp=$seccomp"
    [ "$seccomp" = 2 ] || { fail "renderer $pid has no seccomp filter (Seccomp=$seccomp): its sandbox is not on"; return 1; }
  done
  if grep -Eqi 'No usable sandbox|SUID sandbox helper binary was found, but is not configured correctly|sandbox_linux.*FATAL' "$log"; then
    fail "the log of the application reports a sandbox failure"
    return 1
  fi
}

# What a refused application must show (an AppImage whose AppRun added --no-sandbox: Lucium refuses it, never runs without the sandbox). Two things: the line
# that says why on the standard error, before anything else, and, since a screen exists, a box that says it to a person who has no terminal (drawn by zenity,
# which the workflow installs as an Ubuntu desktop has it: src/main/launch-refusal.ts; Electron opens no box before `ready` on Linux, which is why the person
# used to see nothing). The box waits to be closed and
# nobody here can click it: the check finds it on the virtual screen by its title, « Lucium cannot start » (the runner's locale is English), checks that no page was started, then
# closes the application with a signal. An application that ends by itself instead did not show the box: that is a failure.
check_refused() {
  local app="$1" data="$2" log="$3" waited=0 status=0 pid
  # Counted, not `grep -q` (which stops at the first match and can hand xwininfo a SIGPIPE that `pipefail` reports as a failure).
  until [ "$(xwininfo -root -tree 2>/dev/null | grep -ci "lucium cannot start" || true)" -gt 0 ]; do
    if ! kill -0 "$app" 2>/dev/null; then
      wait "$app" || status=$?
      fail "the application ended by itself after ${waited} s (exit code $status) without showing the box that says why it refuses to start"
      return 1
    fi
    if [ "$waited" -ge 60 ]; then
      fail "no box after ${waited} s: the application is still running and shows nothing that says why it refuses to start"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "the box that says why appeared after ${waited} s"
  grep -q 'refused: this application does not start with --no-sandbox' "$log" || { fail "the log does not say that --no-sandbox is refused"; return 1; }
  grep -q 'sandbox' "$log" && echo "the refusal names the sandbox"
  # Nothing but the box was made: no page, so no renderer, and nothing that Electron starts once it is ready (its GPU process and its network service would run
  # without a sandbox: the launcher gave `--no-sandbox` to the process, which carries it to its children).
  if [ -n "$(renderer_pids "$data")" ]; then
    fail "a renderer is running in a launch that was refused"
    return 1
  fi
  for pid in $(run_pids "$data"); do
    if tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -Eq -- '--type=(gpu-process|utility)'; then
      fail "process $pid (GPU or utility) runs in a launch that was refused, with --no-sandbox"
      return 1
    fi
  done
  # What closing the box would end with, here by the signal.
  kill -TERM "$app" 2>/dev/null || true
  wait "$app" 2>/dev/null || true
}

smoke() {
  local label="${1:?a label}" expect="${2:?start or refused}"
  shift 2
  [ "$expect" = start ] || [ "$expect" = refused ] || { fail "expected 'start' or 'refused', not '$expect'"; return 2; }
  local data log xvfb app status=0
  data="$(mktemp -d)"
  log="$LOGS/$label.log"
  # A virtual screen of its own, so that nothing is drawn anywhere else.
  export DISPLAY=:99
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >"$LOGS/$label-xvfb.log" 2>&1 &
  xvfb=$!
  sleep 2
  echo "== $label: $* (expected: $expect)"
  "$@" "--user-data-dir=$data" --enable-logging=stderr >"$log" 2>&1 &
  app=$!
  if [ "$expect" = start ]; then check_started "$app" "$data" "$log" || status=$?; else check_refused "$app" "$data" "$log" || status=$?; fi
  if [ "$status" -ne 0 ]; then
    echo "---- log of the application ($log), last 60 lines"
    tail -n 60 "$log" || true
    echo "---- windows on the virtual screen"
    xwininfo -root -tree 2>&1 | head -n 40 || true
  fi
  pkill -TERM -f -- "--user-data-dir=$data" 2>/dev/null || true
  sleep 2
  pkill -KILL -f -- "--user-data-dir=$data" 2>/dev/null || true
  kill "$xvfb" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$data"
  [ "$status" -eq 0 ] && echo "== $label: ok"
  return "$status"
}

command="${1:-}"
[ $# -gt 0 ] && shift
case "$command" in
  sandbox-state) sandbox_state ;;
  sandbox-profile) sandbox_profile "$@" ;;
  unrestrict) unrestrict ;;
  smoke) smoke "$@" ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac

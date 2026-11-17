#!/bin/bash
# Keeps the newest copies of the application that scripts/build-drm-release.sh sets aside at each installation, and removes the older ones:
# each copy weighs about 300 MB, and an old build stays runnable with the flaws it had.
#
#   scripts/prune-app-backups.sh <folder> [<count>]
#
# <folder> holds one folder per installation, named by its date (YYYYMMDD-HHMMSS). The <count> newest are kept (3 when it is not given;
# 0 keeps none). Only a real folder with such a name is ever removed: anything else found there (a file, a link, a folder named by hand) is left alone.
# Prints one line per folder removed.
set -eu

FOLDER="${1:-}"
KEEP="${2:-3}"
if [ -z "$FOLDER" ]; then
  echo "prune-app-backups: the folder of the copies is missing" >&2
  exit 2
fi
case "$KEEP" in
  '' | *[!0-9]*)
    echo "prune-app-backups: the count must be a whole number, not \"$KEEP\"" >&2
    exit 2
    ;;
esac
# Nothing set aside yet.
[ -d "$FOLDER" ] || exit 0

# The names sort as the dates do. A glob that matches nothing stays as written, and the tests below then skip it.
NAMES=()
for ENTRY in "$FOLDER"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]; do
  if [ -d "$ENTRY" ] && [ ! -L "$ENTRY" ]; then NAMES+=("${ENTRY##*/}"); fi
done
EXTRA=$((${#NAMES[@]} - KEEP))
INDEX=0
while [ "$INDEX" -lt "$EXTRA" ]; do
  NAME="${NAMES[$INDEX]}"
  rm -rf -- "${FOLDER:?}/${NAME:?}"
  echo "removed $NAME"
  INDEX=$((INDEX + 1))
done

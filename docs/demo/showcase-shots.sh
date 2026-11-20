#!/bin/sh
# Takes the README's picture from start to end: builds a showcase stage with showcase.sh as its
# hook (the Mods dialog open on Discover), takes preview.png with the kit's shoot.sh, and takes
# the stage down, also when something fails.
#
#   sh docs/demo/showcase-shots.sh
#
# preview.png   the Mods dialog on Discover over the whole window (also the herdr.dev card)
#
# The picture waits until nobody has typed for a minute (shoot.sh), so a run takes a few minutes.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
kit=${SHOWCASE_KIT:-$HOME/workspace/herdr/herdr-showcase}

# stage.sh prints the stage's folder. Read from a file: some of the stage's processes keep
# stage.sh's output open, so `w=$(sh stage.sh)` would wait until the stage is gone.
out=$(mktemp "${TMPDIR:-/tmp}/mod-hub-stage.XXXXXX")
w=
trap '[ -n "$w" ] && sh "$kit/stage.sh" --down "$w"; rm -f "$out"' EXIT
SHOWCASE_VPN=0 SHOWCASE_HOOK="$here/showcase.sh" sh "$kit/stage.sh" > "$out"
w=$(head -n 1 "$out")
[ -d "$w" ] || { echo "showcase-shots: no stage" >&2; exit 1; }

sh "$kit/shoot.sh" "$w" "$repo/preview.png"
sh "$here/quantize.sh" "$repo/preview.png"

#!/bin/sh
# The README's picture, on a showcase stage (~/workspace/herdr/herdr-showcase): the Mods dialog
# open on Discover over the default scene. stage.sh runs it after the cast, with the stage folder.
#
#   SHOWCASE_TFVPN=0 SHOWCASE_HOOK=$PWD/docs/demo/showcase.sh sh ~/workspace/herdr/herdr-showcase/stage.sh > /tmp/stage.txt
#   w=$(head -n 1 /tmp/stage.txt)
#
# showcase-shots.sh does all of it, pictures included.
#
# The gallery is the real one on herdr.dev, fetched over the network; its previews download as
# the cards are drawn, so the hook waits for them.
set -eu
w=${1:?usage: showcase.sh <stage folder>}
# shellcheck disable=SC1091
. "$w/env.sh"
# The page the dialog opens on is the one shown last (mod-hub.page in the mod's store); a first
# open shows Discover.
herdr-app do mod.open --name mod-hub >/dev/null

previews="$HERDR_APP_HOME/mod-hub/cache/previews"
i=0
while [ "$i" -lt 60 ]; do
  n=$(ls "$previews" 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -ge 9 ] && break
  sleep 1; i=$((i + 1))
done
printf '%s\n' "showcase: mod-hub open, $n previews cached" >&2
sleep 2

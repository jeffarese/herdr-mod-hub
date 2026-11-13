#!/bin/sh
# Install the Mods screen into the Herdr app, or update it.
#
#   ./install.sh            check mods/mod-hub with Herdr, copy it in, bind cmd-shift-m
#   ./install.sh --remove   take the screen and its key out; your mods stay as they are
#
# Without a clone, the script fetches the mod itself:
#
#   curl -fsSL https://raw.githubusercontent.com/jeffarese/herdr-mod-hub/main/install.sh | sh
#
# The app's home is ~/.config/herdr-app, or $HERDR_APP_HOME. Needs python3 for keys.json.
set -eu
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || pwd)
command -v python3 >/dev/null 2>&1 || { echo "The installer needs python3." >&2; exit 1; }

# Run from a pipe, or from a copy of this file alone: fetch the rest.
if [ ! -f "$here/mods/mod-hub/main.js" ]; then
  tarball=${HERDR_MOD_HUB_TARBALL:-https://github.com/jeffarese/herdr-mod-hub/archive/refs/heads/main.tar.gz}
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$tarball" | tar -xz -C "$tmp" --strip-components 1
  [ -f "$tmp/mods/mod-hub/main.js" ] || { echo "Couldn't fetch the mod from $tarball" >&2; exit 1; }
  here=$tmp
fi

python3 "$here/scripts/install.py" "$@"

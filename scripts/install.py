#!/usr/bin/env python3
"""Install the Mods screen (mods/mod-hub) into Herdr and bind its key, or take it out.

Checks the mod with `herdr-app check`, copies it to ~/.config/herdr-app/mods/mod-hub
(staged, then swapped in), and adds cmd-shift-m (ctrl-shift-m off macOS) to keys.json
unless that key is already yours. Run again to update.

--remove takes out the folder and the key it added. What the screen keeps in
~/.config/herdr-app/mod-hub/ stays: mods you turned off live there until you turn them on.
"""
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parent.parent
APP_HOME = Path(os.environ.get("HERDR_APP_HOME", Path.home() / ".config/herdr-app"))
MOD = "mod-hub"
SKIP = shutil.ignore_patterns("*.d.ts", "jsconfig.json", "*.error", ".*")


def app(*args, timeout=60):
    return subprocess.run(["herdr-app", *args], check=True, timeout=timeout, capture_output=True, text=True).stdout


def normalize(keys):
    parts = keys.lower().split("-")
    key = parts.pop() or "-"
    return "-".join(sorted(p for p in parts if p) + [key])


def bind_key():
    key = key_for_platform()
    path = APP_HOME / "keys.json"
    if not path.exists():
        # Herdr writes the whole set on start; a file with only this key would drop the rest.
        print(f"keys.json isn't there yet, so no key was added. Open Mods with: herdr-app do mod.open --name {MOD}")
        return
    keys = json.loads(path.read_text())
    section = keys.setdefault("global", {})
    taken = next((k for k in section if normalize(k) == normalize(key)), None)
    if taken:
        if section[taken] != f"mod.open:{MOD}":
            print(f"{key} already runs {section[taken]}; open Mods with: herdr-app do mod.open --name {MOD}")
        return
    section[key] = f"mod.open:{MOD}"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(keys, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(path)
    print(f"{key} opens Mods.")


def key_for_platform():
    return "cmd-shift-m" if platform.system() == "Darwin" else "ctrl-shift-m"


def unbind_key():
    path = APP_HOME / "keys.json"
    if not path.exists():
        return
    keys = json.loads(path.read_text())
    section = keys.get("global", {})
    ours = [k for k, v in section.items() if v == f"mod.open:{MOD}"]
    if not ours:
        return
    for k in ours:
        del section[k]
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(keys, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(path)
    print(f"Took out {', '.join(ours)}.")


def close_screen():
    """Closes the Mods screen if it's open: mod.open toggles it. Leaves other dialogs alone."""
    if not shutil.which("herdr-app"):
        return
    try:
        status = json.loads(app("status", timeout=10))
    except (subprocess.SubprocessError, ValueError, OSError):
        return
    if MOD in (status.get("overlays") or []):
        app("do", "mod.open", "--name", MOD, timeout=10)


def remove():
    target = APP_HOME / "mods" / MOD
    if target.exists():
        close_screen()
        shutil.rmtree(target)
        print(f"Removed {target}")
    unbind_key()
    off = APP_HOME / MOD / "off"
    waiting = sorted(p.name for p in off.iterdir() if p.is_dir()) if off.is_dir() else []
    if waiting:
        print(f"Still turned off, in {off}: {', '.join(waiting)}.")
        print("Install Mods again and turn them on from Installed: that also puts back their blocks and keys.")


def install():
    if not shutil.which("herdr-app") or not (APP_HOME / "mods").is_dir():
        sys.exit("Start Herdr once before installing.")
    app("check", str(SOURCE / "mods" / MOD))
    target = APP_HOME / "mods" / MOD
    staged = target.with_name(f".{MOD}.new")
    shutil.rmtree(staged, ignore_errors=True)
    shutil.copytree(SOURCE / "mods" / MOD, staged, ignore=SKIP)
    app("check", str(staged))
    old = target.with_name(f".{MOD}.old")
    shutil.rmtree(old, ignore_errors=True)
    if target.exists():
        target.rename(old)
    staged.rename(target)
    shutil.rmtree(old, ignore_errors=True)
    print(f"Installed {target}")
    bind_key()


if __name__ == "__main__":
    try:
        remove() if sys.argv[1:] == ["--remove"] else install()
    except subprocess.CalledProcessError as error:
        sys.exit(f"Installation stopped: {(error.stderr or error.stdout or str(error)).strip()}")
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        sys.exit(f"Installation stopped: {error}")

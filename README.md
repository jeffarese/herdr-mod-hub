# herdr-mod-hub

[![CI](https://github.com/jeffarese/herdr-mod-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffarese/herdr-mod-hub/actions/workflows/ci.yml)

A mod for the [Herdr](https://herdr.dev) desktop app: one screen for every mod. Browse what
people share in the gallery, read what a mod's code can reach before you install it, and manage
the mods you have: turn them off and on, update them, roll back, remove them with undo.

![A dialog titled Mods over the Herdr window. A sidebar lists Discover, Installed (8), Updates and Built in (21), and at its foot "Gallery: 757 mods, updated 1 min ago". The Discover page shows a search field, a Popular / Recently updated switch, and a grid of cards: Skillshare, Agenttrail, Nvim, Auto Title, Pulse, Insights, Gitview, Git Graph and Atuin Threads, each with its screenshot, author, description, stars, last update and an Install button.](preview.png)

Herdr has no screen for mods. You add one by asking an agent or copying a folder, take it out
by deleting the folder, and to see which mods you have you open `~/.config/herdr-app/mods`.
Removing a mod that a layout or a key still names leaves an empty block or a dead shortcut.

Mods does all of that from one place, and it does it the careful way: before anything is
installed it shows what the code can reach, it takes a mod out of your layouts and keys before
it goes, and every removal can be undone for 30 days.

This is an unofficial mod. It is not affiliated with Herdr.

## Install

Ask your agent, in a terminal inside Herdr:

> Add the Herdr mod at github.com/jeffarese/herdr-mod-hub

Or run the installer:

```sh
curl -fsSL https://raw.githubusercontent.com/jeffarese/herdr-mod-hub/main/install.sh | sh
```

It checks the mod with `herdr-app check`, copies `mods/mod-hub` into
`~/.config/herdr-app/mods`, and binds ⇧⌘M (Ctrl+Shift+M on Linux) unless that key is already
yours. Run it again to update. From a clone, `./install.sh` does the same, and
`./install.sh --remove` takes the screen and its key out.

Adding a key edits `~/.config/herdr-app/keys.json`, which makes the whole file yours: Herdr then
stops adding new default shortcuts to it. Installing a mod that comes with keys does the same.

It needs the Herdr app (tested with 0.1.15), `python3` for the installer, and `curl` and `tar`,
which macOS and Linux have.

## Using it

Open it with ⇧⌘M, or `herdr-app do mod.open --name mod-hub`. Esc steps back: from a picture to
the page, from a page to the list, then closes.

| To | Do |
| --- | --- |
| Find a mod | **Discover**. Type in the search field (⌘F or /); sort by popular or recently updated. |
| See what it is | Click its card: its screenshot (click it for full size), stars, last update, and its recipe's "What you see" and "How it behaves". |
| Install it | **Install** on the card or the page. A review opens first; nothing changes until you confirm. |
| Turn a mod off for now | **Installed**, then its switch. It leaves your layouts and keys; **Undo** or the switch puts it back where it was. |
| See where a mod shows | Click it in **Installed**: the layouts and blocks it's in, its keys, the mods that open it. |
| Remove a mod | Its page, **Remove**. It's kept under **Removed** for 30 days, with **Restore**. |
| Update | **Updates** shows what changed upstream, file by file. **Update**, or **Update all**. |
| Undo an update | The mod's page, **Roll back**. The copy before each update is kept (the last 3), and so is the one a roll back replaces, so a roll back can be undone too. |
| Get updates for a mod you copied in by hand | **Updates** lists the ones a gallery listing has a folder for. **Link** ties them to it. |
| Change one of Herdr's own mods | **Built in**, **Duplicate**. Herdr restores its own on every start, so you change the copy. |

### Before you install

The review lists what the mod's code can do, read from its source:

- **Reaches the network**, with the hosts it names.
- **Runs programs**, by name: `git`, `gh`, `hc`.
- **Reads or writes files** outside Herdr's own data.
- **Deletes files**, and **touches Claude Code settings**, in amber.

Each line opens to the file and line it came from. A mod that does none of this says "Only draws
and runs Herdr commands". It's a reading of the code, not a sandbox: Herdr runs mods as trusted
code, so the review is there to help you decide.

The review also says where each mod will show (a mod that docks on a side goes into the layout
you're using as soon as it's installed), which folder name it gets (a listing whose mod shares a
name with one of yours gets `name-2`, renamed inside too), and which keys it adds. A key you
already use stays yours: the listing's binding for it is left out, and the review says so.
Herdr checks the mod (`herdr-app check`) before it goes live; if the check fails, nothing is
installed. A download whose mod folders or `keys.json` hold symlinks is refused before anything
is read or copied: a link could point at your own files, and a mod has no need of one.

### Updates

Mods installed from Discover remember the listing and the commit they came from. The screen
looks for updates when it opens, at most every 6 hours, and with **Check now**. It downloads a
listing only when its commit moved, and offers an update only when the mod's own files changed,
so a commit that touched the README is not an update. If you edited a mod after installing it,
the update says which files, and your copy is kept for **Roll back**.

## What it touches

Herdr's guide asks a mod to say this before it's added. Mods:

- **Reaches the network:** the gallery index and previews on `assets.herdr.dev`, recipes on
  `raw.githubusercontent.com`, and mods from `codeload.github.com`.
- **Runs programs:** `curl` and `tar` to download, `mv` and `cp` to move mod folders, `rm -rf`
  only inside its own folder, `herdr-app check` and `herdr-app status`, and `open` (Finder) or
  `xdg-open` when you ask to see a folder.
- **Reads and writes files outside its folder:** `mods/` (installing, turning off, removing),
  your own layouts in `layouts/` (taking a mod out and putting it back; Herdr's layouts are
  never edited), `keys.json` (adding a mod's keys without replacing yours, taking a removed
  mod's keys out and back), and `data/<mod>` (kept with a removed mod so Restore brings it back).
- **Keeps its own state** in `~/.config/herdr-app/mod-hub/`: where each mod came from, mods
  turned off (`off/`), removed ones (`removed/`), earlier copies (`backups/`) and the gallery
  cache.

## Known limits

- **Turned-off mods live in `mod-hub/off/`.** Removing this screen leaves them there;
  `./install.sh --remove` lists them. Install Mods again and turn them on: that also puts back
  their blocks and keys, which moving a folder back by hand doesn't.
- **A file it can't read stops a change before it starts.** A layout or `keys.json` that isn't
  valid JSON (say, mid-edit) stops a turn off or remove with nothing changed. If one breaks
  while a mod comes back, the rest goes back and the mod's page offers **Try again**.
- **No `keys.json`, no keys.** Herdr writes the whole set on start, and the escape hatch sets
  it aside; a file holding only a mod's keys would drop every default, so none are added.
- **Herdr's own mods can't be turned off or removed:** Herdr puts them back on every start.
  **Duplicate** makes a copy you can change.
- **Updates need a link.** A mod copied in by hand has no record of where it came from; **Link**
  it to a listing to get its updates.
- **The review reads, it doesn't run.** Code that builds a program's name at run time shows as
  "Runs programs" without the name.
- **This screen can't turn itself off.** Use `./install.sh --remove`.
- **Windows:** untested, and the installer is a shell script.

## Development

```sh
npm test                                   # logic, hub and screen tests, with node --test
herdr-app check mods/mod-hub
./install.sh                               # into your Herdr, then ⇧⌘M
```

- **`mods/mod-hub/main.js`** draws the screen. It only draws and asks; every change on disk goes
  through the hub.
- **`hub.js`** does the work: install, turn off and on, remove and restore, updates, roll back.
  Changes run one at a time, and every edit of a layout or `keys.json` is checked against what
  was read, so an edit made meanwhile isn't overwritten.
- **`catalog.js`** (the gallery index, search, recipes), **`layouts.js`** (taking a mod out of a
  layout and putting it back), **`keys.js`**, **`review.js`**, **`manifest.js`** (file
  fingerprints) and **`inventory.js`** are pure functions that Node tests directly.
- **`tests/view.test.mjs`** runs the real screen against a stand-in for Herdr's modules and a
  temporary Herdr home, with real downloads from local tarballs.
- Herdr stops a script that runs for half a second at a stretch, so anything heavy is done in
  one pass or in pieces.
- **[RECIPE.md](RECIPE.md)** is the brief an agent can rebuild the mod from.

## License

[MIT](LICENSE)

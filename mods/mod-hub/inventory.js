// What's installed: the person's mods, Herdr's own, the ones turned off, and for each one
// where it shows (layouts, keys, other mods) and where it came from.
// Pure functions over what the hub read from disk. No host calls.

import { references, describe } from "./layouts.js";
import { bindingsOf } from "./keys.js";
import { candidatesFor, entryKey } from "./catalog.js";
import { diff } from "./manifest.js";

/** installed.json: Herdr's own mods and layouts ("layout:<name>" keys). */
export function shipped(installed) {
  const mods = new Set();
  const layouts = new Set();
  for (const key of Object.keys(installed ?? {})) {
    if (key.startsWith("layout:")) layouts.add(key.slice(7));
    else mods.add(key);
  }
  return { mods, layouts };
}

/** How a mod shows: a window it opens itself, a panel it docks, or a part a layout places. */
export function kind(manifest) {
  if (manifest?.overlay && typeof manifest.overlay === "object") return "window";
  if (manifest?.place && manifest.place !== "none") return "panel";
  return "part";
}

export const KIND_WORDS = { window: "Opens as a window", panel: "Docks as a panel", part: "A part layouts and other mods use" };

/** "new-menu" → "New menu", for mods whose mod.json has no title. */
export const pretty = (name) => {
  const words = String(name).replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(name);
};

// Herdr's engine compares strings by code unit even in localeCompare, so "changes" would
// sort after "Tabs". Compare folded case instead.
const byTitle = (a, b) => {
  const x = a.title.toLowerCase();
  const y = b.title.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

// How one mod's code names another: `mod: "x"` (placing it), "mod.open:x" (a key or command
// string), run("mod.open", { name: "x" }).
const REFERENCE = /\bmod\s*:\s*["'`]([\w.-]+)["'`]|mod\.open:([\w.-]+)["'`]|["'`]mod\.open["'`]\s*,\s*\{\s*name\s*:\s*["'`]([\w.-]+)["'`]/g;

/**
 * For every mod named in `sources` ({ mod: code }), the other mods whose code opens or places
 * it. One pass over all the code: Herdr stops a script that runs for half a second, and a pass
 * per mod over every other mod's code took longer than that.
 */
export function usedByAll(sources) {
  const users = {};
  for (const [other, text] of Object.entries(sources ?? {})) {
    for (const m of String(text).matchAll(REFERENCE)) {
      const name = m[1] ?? m[2] ?? m[3];
      if (name !== other) (users[name] ??= new Set()).add(other);
    }
  }
  return Object.fromEntries(Object.entries(users).map(([name, set]) => [name, [...set].sort()]));
}

/** Other mods whose code opens or places this one. */
export const usedBy = (name, sources) => usedByAll(sources)[name] ?? [];

/**
 * One row per mod. `disk` is what the hub read:
 *   live, off: folder names; manifests: { name: mod.json }; layouts: { name: tree };
 *   keys; sources: { name: code }; state (the hub's records); entries (gallery);
 *   shippedSet; errors: Herdr's status errors; current: { name: manifest } for live folders.
 */
export function inventory(disk, self) {
  const ship = disk.shippedSet ?? { mods: new Set(), layouts: new Set() };
  const byKey = new Map((disk.entries ?? []).map((e) => [entryKey(e), e]));
  const users = usedByAll(disk.sources);
  const where = {};
  for (const [layout, tree] of Object.entries(disk.layouts ?? {})) {
    for (const ref of references(tree)) (where[ref.mod] ??= []).push({ layout, ref, words: describe(ref), personal: !ship.layouts.has(layout) });
  }
  const all = [];
  const add = (name, enabled) => {
    const manifest = disk.manifests?.[name] ?? {};
    const source = disk.state?.sources?.[name] ?? null;
    const entry = source ? byKey.get(`${source.fullName}#${source.path}`) ?? null : null;
    const update = disk.state?.updates?.[name] ?? null;
    const local = source?.files && disk.current?.[name] ? diff(source.files, disk.current[name]) : null;
    const isShipped = ship.mods.has(name);
    all.push({
      name,
      enabled,
      shipped: isShipped,
      self: name === self,
      title: typeof manifest.title === "string" && manifest.title.trim() ? manifest.title.trim() : pretty(name),
      description: typeof manifest.description === "string" ? manifest.description.trim() : "",
      version: typeof manifest.version === "string" ? manifest.version : null,
      kind: kind(manifest),
      overlay: Boolean(manifest.overlay),
      clonedFrom: typeof manifest.cloned_from?.name === "string" ? manifest.cloned_from.name : null,
      source,
      entry,
      update: update && source && update.commit !== source.commit ? update : null,
      edited: local && local.count ? local : null,
      candidates: !source && !isShipped ? candidatesFor(disk.entries ?? [], name) : [],
      layouts: where[name] ?? [],
      keys: bindingsOf(disk.keys ?? {}, name),
      usedBy: users[name] ?? [],
      errors: (disk.errors ?? []).filter((e) => mentions(e, name)),
      off: enabled ? null : disk.state?.off?.[name] ?? null,
      pending: disk.state?.pending?.[name] ?? null,
    });
  };
  for (const name of disk.live ?? []) add(name, true);
  for (const name of disk.off ?? []) if (!(disk.live ?? []).includes(name)) add(name, false);
  return all.sort(byTitle);
}

function mentions(error, name) {
  const text = typeof error === "string" ? error : JSON.stringify(error);
  return new RegExp(`(^|[^A-Za-z0-9_-])(mods/)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_-]|$)`).test(text);
}

/** The groups the Installed page shows, in order. */
export function groups(mods) {
  const mine = mods.filter((m) => !m.shipped);
  return [
    { id: "gallery", title: "From the gallery", mods: mine.filter((m) => m.enabled && m.source) },
    { id: "local", title: "Yours", mods: mine.filter((m) => m.enabled && !m.source && !m.clonedFrom) },
    { id: "clones", title: "Copies of Herdr's mods", mods: mine.filter((m) => m.enabled && !m.source && m.clonedFrom) },
    { id: "off", title: "Turned off", mods: mine.filter((m) => !m.enabled) },
  ].filter((g) => g.mods.length);
}

/**
 * What a mod falls back to in a layout when it's turned off: the mod it was cloned from,
 * else Herdr's mod named like the block ("files" for a block called files), if either is
 * there. Otherwise nothing, and the block goes.
 */
export function fallbackFor(mod, available) {
  return (node) => {
    if (mod.clonedFrom && available.has(mod.clonedFrom)) return mod.clonedFrom;
    if (node?.id && node.id !== mod.name && available.has(node.id)) return node.id;
    return null;
  };
}

// keys.json and mods: which bindings belong to a mod, taking them out and back,
// and merging a mod's own keys.json without ever replacing a key the person uses.
// Pure functions. No host calls.

const clone = (v) => JSON.parse(JSON.stringify(v));

/** "Shift-Cmd-M" and "cmd-shift-m" are the same key. "cmd--" is cmd and minus. */
export function normalizeKey(keys) {
  return String(keys)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((stroke) => {
      const parts = [];
      let rest = stroke;
      // The key is what follows the last separating "-"; a trailing "-" is the minus key.
      while (rest.includes("-") && rest.length > 1) {
        const i = rest.indexOf("-");
        if (i === rest.length - 1) break;
        parts.push(rest.slice(0, i));
        rest = rest.slice(i + 1);
      }
      const key = rest;
      const mods = parts.filter(Boolean).sort();
      return [...mods, key].join("-");
    })
    .join(" ");
}

/** The command an action runs and its first argument: "mod.open:bar", {command, args}. */
function parse(action) {
  if (typeof action === "string") {
    const i = action.indexOf(":");
    return i < 0 ? { command: action, value: null } : { command: action.slice(0, i), value: action.slice(i + 1) };
  }
  if (action && typeof action === "object" && typeof action.command === "string") {
    const args = action.args && typeof action.args === "object" ? action.args : {};
    return { command: action.command, value: typeof args.name === "string" ? args.name : typeof args.mod === "string" ? args.mod : null };
  }
  return { command: null, value: null };
}

/**
 * Herdr's own command groups (`herdr-app commands`): `tab.new` is Herdr's even when a mod is
 * called `tab`, so a mod with one of these names never owns `<name>.<command>` bindings.
 */
export const BUILT_IN_GROUPS = new Set(["agent", "app", "layout", "mod", "overlay", "pane", "space", "tab", "terminal", "window"]);

/** Does this binding run something of `mod`'s? `mod.open:<mod>` or `<mod>.<command>`. */
export function targets(action, mod) {
  const { command, value } = parse(action);
  if (!command) return false;
  if (command === "mod.open" || command === "mod.clone") return value === mod;
  return !BUILT_IN_GROUPS.has(mod) && command.startsWith(`${mod}.`);
}

/** Every binding of `mod`'s: [{ section, keys, action }]; a `mod:<mod>` section is all its own. */
export function bindingsOf(keys, mod) {
  const out = [];
  for (const [section, map] of Object.entries(keys ?? {})) {
    if (!map || typeof map !== "object") continue;
    for (const [k, action] of Object.entries(map)) {
      if (section === `mod:${mod}` || targets(action, mod)) out.push({ section, keys: k, action });
    }
  }
  return out;
}

/** Takes a mod's bindings out: { keys, removed }. */
export function strip(keys, mod) {
  const next = clone(keys ?? {});
  const removed = bindingsOf(next, mod);
  for (const b of removed) delete next[b.section][b.keys];
  for (const section of new Set(removed.map((b) => b.section))) {
    if (Object.keys(next[section]).length === 0) delete next[section];
  }
  return { keys: next, removed };
}

function boundIn(map, k) {
  const want = normalizeKey(k);
  return Object.keys(map ?? {}).find((existing) => normalizeKey(existing) === want) ?? null;
}

/** Puts bindings back, unless the key was taken meanwhile: { keys, restored, skipped }. */
export function restore(keys, removed) {
  const next = clone(keys ?? {});
  const restored = [];
  const skipped = [];
  for (const b of removed ?? []) {
    const map = (next[b.section] ??= {});
    const taken = boundIn(map, b.keys);
    if (taken && JSON.stringify(map[taken]) !== JSON.stringify(b.action)) skipped.push({ ...b, by: map[taken] });
    else {
      if (!taken) map[b.keys] = b.action;
      restored.push(b);
    }
  }
  return { keys: next, restored, skipped };
}

/**
 * Adds a mod's keys.json to the person's. A key they already bind stays theirs:
 * { keys, added, kept: [{ section, keys, action, by }], same }.
 */
export function merge(mine, theirs) {
  const next = clone(mine ?? {});
  const added = [];
  const kept = [];
  const same = [];
  for (const [section, map] of Object.entries(theirs ?? {})) {
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [k, action] of Object.entries(map)) {
      if (typeof action !== "string" && (typeof action !== "object" || action === null)) continue;
      const own = (next[section] ??= {});
      const taken = boundIn(own, k);
      if (!taken) {
        own[k] = clone(action);
        added.push({ section, keys: k, action });
      } else if (JSON.stringify(own[taken]) === JSON.stringify(action)) same.push({ section, keys: k, action });
      else kept.push({ section, keys: k, action, by: own[taken] });
    }
    if (Object.keys(next[section]).length === 0) delete next[section];
  }
  return { keys: next, added, kept, same };
}

/** A mod's keys.json after its folder took another name. */
export function renameIn(keys, from, to) {
  const out = {};
  for (const [section, map] of Object.entries(keys ?? {})) {
    if (!map || typeof map !== "object") continue;
    const name = section === `mod:${from}` ? `mod:${to}` : section;
    out[name] = {};
    for (const [k, action] of Object.entries(map)) out[name][k] = renameAction(action, from, to);
  }
  return out;
}

function renameAction(action, from, to) {
  if (typeof action === "string") {
    if (action === `mod.open:${from}`) return `mod.open:${to}`;
    if (!BUILT_IN_GROUPS.has(from) && action.startsWith(`${from}.`)) return `${to}.${action.slice(from.length + 1)}`;
    return action;
  }
  if (action && typeof action === "object") {
    const next = clone(action);
    if (!BUILT_IN_GROUPS.has(from) && typeof next.command === "string" && next.command.startsWith(`${from}.`)) next.command = `${to}.${next.command.slice(from.length + 1)}`;
    if (next.command === "mod.open" && next.args?.name === from) next.args.name = to;
    return next;
  }
  return action;
}

/** "cmd-shift-m" -> "⌘⇧M" on macOS, "Ctrl+Shift+M" elsewhere. */
export function prettyKey(keys, mac = true) {
  const MAC = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧", fn: "fn" };
  const OTHER = { cmd: "Super", ctrl: "Ctrl", alt: "Alt", shift: "Shift", fn: "Fn" };
  const NAMED = { enter: "↩", escape: "Esc", backspace: "⌫", tab: "⇥", space: "Space", left: "←", right: "→", up: "↑", down: "↓" };
  return normalizeKey(keys)
    .split(" ")
    .map((stroke) => {
      const parts = stroke.split("-");
      let key = parts.pop();
      if (key === "" && parts.length) key = "-";
      const order = ["ctrl", "alt", "shift", "cmd", "fn"];
      const mods = parts.filter(Boolean).sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const label = NAMED[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
      return mac ? `${mods.map((m) => MAC[m] ?? m).join("")}${label}` : [...mods.map((m) => OTHER[m] ?? m), label].join("+");
    })
    .join(" ");
}

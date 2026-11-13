// Fingerprints of a mod folder's files, to tell whether an update changes anything and
// whether the person edited what was installed. Also folder names and renames.
// Pure functions. No host calls.

/** Files Herdr writes into mod folders, and editor litter: never part of a mod. */
export function ignored(relPath) {
  const parts = relPath.split("/");
  if (parts.some((p) => p.startsWith("."))) return true; // .DS_Store, .previews/, .git/
  if (parts.includes("node_modules")) return true;
  const base = parts[parts.length - 1];
  return base === "jsconfig.json" || base.endsWith(".d.ts") || base.endsWith(".error");
}

/** 64-bit FNV-1a as hex (two 32-bit lanes), over bytes or a string. */
export function fingerprint(data) {
  const bytes = typeof data === "string" ? utf8(data) : data;
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x050c5d1f | 0;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
    h2 = Math.imul(h2 ^ bytes[i], 0x01000193) ^ (h1 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0") + bytes.length.toString(16);
}

function utf8(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** What changed from manifest `a` to `b` ({ relPath: fingerprint }). */
export function diff(a, b) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [path, hash] of Object.entries(b ?? {})) {
    if (!(path in (a ?? {}))) added.push(path);
    else if (a[path] !== hash) changed.push(path);
  }
  for (const path of Object.keys(a ?? {})) if (!(path in (b ?? {}))) removed.push(path);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), count: added.length + removed.length + changed.length };
}

export const same = (a, b) => diff(a, b).count === 0;

/** "main.js, mod.json and 2 more" for a diff. */
export function changedFiles(d, max = 3) {
  const all = [...d.changed, ...d.added, ...d.removed];
  if (all.length <= max) return all.join(", ");
  return `${all.slice(0, max).join(", ")} and ${all.length - max} more`;
}

/** `name`, or `name-2`, `name-3`… whichever isn't taken. */
export function freeName(name, taken) {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name}-${i}`)) return `${name}-${i}`;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "<name>.json" is a file, not one of the mod's commands.
const FILE_ENDINGS = "json|m?js|cjs|ts|md|txt|svg|png|jpe?g|gif|webp|ico|css|html?|toml|ya?ml|sh|py|wav|mp3|ogg|lock|log|csv|tsv|db|sqlite|zip|tgz|gz";

/**
 * A mod's source after its folder took another name: its own asset paths
 * (`mods/<from>/`), overlays it opens of itself (`mod: "<from>"`, `mod.open:<from>`) and
 * its own commands (`"<from>.<command>"`).
 */
export function renameInText(text, from, to) {
  const f = escape(from);
  return String(text)
    .replace(new RegExp(`mods/${f}/`, "g"), `mods/${to}/`)
    .replace(new RegExp(`(\\bmod\\s*:\\s*)(["'\`])${f}\\2`, "g"), `$1$2${to}$2`)
    .replace(new RegExp(`(["'\`])mod\\.open:${f}\\1`, "g"), `$1mod.open:${to}$1`)
    .replace(new RegExp(`(\\bname\\s*:\\s*)(["'\`])${f}\\2`, "g"), `$1$2${to}$2`)
    .replace(new RegExp(`(["'\`])${f}\\.(?!(?:${FILE_ENDINGS})\\1)([a-z][A-Za-z0-9_-]*)\\1`, "g"), `$1${to}.$2$1`)
    .replace(new RegExp(`(["'\`])mod:${f}\\1`, "g"), `$1mod:${to}$1`);
}

/** One file of a mod after its folder took another name; mod.json's "name" follows too. */
export function renameFile(text, rel, from, to) {
  let next = renameInText(text, from, to);
  if (rel === "mod.json") next = next.replace(new RegExp(`("name"\\s*:\\s*")${escape(from)}(")`), `$1${to}$2`);
  return next;
}

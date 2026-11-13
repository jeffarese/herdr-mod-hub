// Everything that touches disk or the network: reading what's installed, installing,
// updating, turning off and on, removing and restoring. The screen (main.js) only calls
// this. Host functions come in as `deps`, so tests run it on a temporary home folder.
//
// Layout of ~/.config/herdr-app/mod-hub/ (all Mods' own):
//   state.json      where each installed mod came from, what's off, what was removed
//   off/<name>/     a mod turned off (Herdr only loads mods/)
//   removed/<id>/   a removed mod and its data, restorable until purged
//   backups/        the copy an update replaced, for Roll back
//   staging/        downloads being looked at; never loaded by Herdr
//   cache/          the gallery index and preview pictures

import { INDEX_URL, parseIndex, tarballUrl, recipeUrl, modsDirIn, keysFileIn, entryKey, MOD_NAME } from "./catalog.js";
import { detach, reattach, renameIn as renameInLayout } from "./layouts.js";
import { strip, restore, merge, renameIn as renameInKeys } from "./keys.js";
import { Review } from "./review.js";
import { ignored, fingerprint, diff, freeName, renameFile } from "./manifest.js";
import { shipped } from "./inventory.js";

export const SELF = "mod-hub";
const KEEP_BACKUPS = 3;
const REMOVED_DAYS = 30;
// Lines of code read between pauses when reviewing a download (about 50 ms in Herdr).
const REVIEW_LINES = 4000;
const TEXT = /\.(m?js|cjs|ts|json|md|txt|svg|css|html|toml|ya?ml)$/i;

const message = (e) => String(e?.message ?? e).trim();

/** state.json with every record present. `pending`: what couldn't go back into a layout or keys.json yet. */
function normalize(s) {
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  return {
    version: 1,
    sources: obj(s.sources),
    off: obj(s.off),
    removed: Array.isArray(s.removed) ? s.removed : [],
    updates: obj(s.updates),
    checkedAt: typeof s.checkedAt === "number" ? s.checkedAt : 0,
    backups: obj(s.backups),
    pending: obj(s.pending),
  };
}

const isEmpty = (rec) => !rec || (!Object.keys(rec.layouts ?? {}).length && !(rec.keys ?? []).length);

/** Two records of changes as one, undone newest first: `b` was made after `a`. */
function joined(a, b) {
  const layouts = {};
  for (const rec of [a, b]) for (const [layout, ops] of Object.entries(rec?.layouts ?? {})) layouts[layout] = [...(layouts[layout] ?? []), ...ops];
  return { layouts, keys: [...(a?.keys ?? []), ...(b?.keys ?? [])] };
}

/** Records what couldn't go back yet (state.pending), or clears it when everything did. */
function keepPending(s, name, left) {
  if (isEmpty(left)) delete s.pending[name];
  else s.pending[name] = { layouts: left.layouts ?? {}, keys: left.keys ?? [] };
}

/** Blocks other mods' records took out of a layout: where they were tells where a new removal sits. */
function knownOps(s, layout, except) {
  const out = [];
  const add = (owner, rec) => {
    if (owner !== except) for (const op of rec?.layouts?.[layout] ?? []) if (op.op === "remove") out.push(op);
  };
  for (const [name, rec] of Object.entries(s.off)) add(name, rec);
  for (const [name, rec] of Object.entries(s.pending)) add(name, rec);
  for (const r of s.removed) add(r.name, r);
  return out;
}

/**
 * Drops records of mods that are gone (deleted by hand); a mod moved back from off/ by hand
 * keeps what it left as pending. Returns the removed mods past 30 days, taken out of `s`.
 */
function forget(s, live, off, now) {
  const here = (name) => live.includes(name) || off.includes(name);
  for (const name of Object.keys(s.sources)) if (!here(name)) { delete s.sources[name]; delete s.updates[name]; }
  for (const name of Object.keys(s.off)) {
    if (off.includes(name)) continue;
    if (live.includes(name)) keepPending(s, name, joined(s.pending[name], s.off[name]));
    delete s.off[name];
  }
  for (const name of Object.keys(s.pending)) if (!here(name)) delete s.pending[name];
  const cutoff = now - REMOVED_DAYS * 86400000;
  const expired = s.removed.filter((r) => r.at < cutoff);
  s.removed = s.removed.filter((r) => r.at >= cutoff);
  return expired;
}

/** The earlier copy Roll back would bring: only one from the same listing as the mod there now. */
export function rollbackFor(state, name) {
  const b = state?.backups?.[name]?.[0];
  const now = state?.sources?.[name];
  if (!b?.source || !now) return null;
  return b.source.fullName === now.fullName && b.source.path === now.path && b.source.mod === now.mod ? b : null;
}

export class Hub {
  /**
   * deps: { home, exec(cmd, args, opts), fs (herdr's fs/promises), fetch, writeText(path, text, expected),
   *         now(), check(folder) -> { ok, error } , urls?: { tarball(entry, commit) } }
   */
  constructor(deps) {
    this.d = deps;
    this.home = deps.home;
    this.root = `${this.home}/mod-hub`;
    this.queue = Promise.resolve();
    this.previewJobs = new Map();
    this.downloads = new Set(); // staging folders in use, which cleanStaging leaves alone
  }

  get modsDir() { return `${this.home}/mods`; }
  get layoutsDir() { return `${this.home}/layouts`; }
  get keysPath() { return `${this.home}/keys.json`; }
  get statePath() { return `${this.root}/state.json`; }
  get offDir() { return `${this.root}/off`; }
  get removedDir() { return `${this.root}/removed`; }
  get backupsDir() { return `${this.root}/backups`; }
  get stagingDir() { return `${this.root}/staging`; }
  get cacheDir() { return `${this.root}/cache`; }
  now() { return this.d.now ? this.d.now() : Date.now(); }

  /**
   * Runs changes one at a time, so two clicks can't interleave their file edits. Nothing runs
   * while state.json can't be read: it's the only record of what was turned off or removed.
   */
  serial(job) {
    const go = async () => {
      await this.settle();
      return job();
    };
    const run = this.queue.then(go, go);
    this.queue = run.catch(() => {});
    return run;
  }

  // Files ---------------------------------------------------------------------------------

  async exists(path) {
    try { return await this.d.fs.exists(path); } catch { return false; }
  }

  /** Parsed JSON, or null when the file is absent or isn't JSON. For files only looked at. */
  async readJson(path) {
    try {
      const text = await this.readText(path);
      return text == null ? null : JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * UTF-8 text, or null when the file isn't there. One that's there but can't be read throws.
   * Herdr's readTextFile reads off the UI thread but stops at 1 MiB; fs.readFile covers the rest.
   */
  async readText(path) {
    if (!(await this.exists(path))) return null;
    if (this.d.readText) {
      try {
        const text = await this.d.readText(path);
        if (text != null) return text;
      } catch {}
    }
    return this.d.fs.readFile(path, "utf8");
  }

  /** Writes `text` only if the file still holds `expected` (null: it doesn't exist yet). */
  async writeChecked(path, text, expected) {
    if (this.d.writeText) await this.d.writeText(path, text, expected);
    else await this.d.fs.writeFile(path, text);
  }

  /**
   * Hands control back to Herdr for a moment. Herdr stops a script that runs for half a second
   * at a stretch, and any file call ends the stretch.
   */
  pause() {
    return this.d.fs.exists(this.home).catch(() => false);
  }

  async writeJson(path, value) {
    await this.d.fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * A file the person and Herdr also edit: written only if it's still what was read. `edit`
   * may run more than once and must not touch disk.
   */
  async editJson(path, edit) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.readText(path);
      let value = {};
      if (before != null) {
        try { value = JSON.parse(before); } catch { throw new Error(`${path.split("/").pop()} isn't valid JSON, so it was left alone`); }
      }
      const result = edit(value, before);
      if (!result || result.value === undefined) return result;
      const text = `${JSON.stringify(result.value, null, 2)}\n`;
      if (text === before) return result;
      try {
        await this.writeChecked(path, text, before);
        return result;
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }
    return null;
  }

  /**
   * keys.json is the person's whole set of keys: Herdr fills it on first start. When it's
   * missing (set aside by the escape hatch, say), a file with only a mod's keys would drop
   * every default, so nothing is written: { absent: true }.
   */
  async editKeys(edit) {
    let absent = false;
    const result = await this.editJson(this.keysPath, (keys, before) => {
      absent = before == null;
      return absent ? null : edit(keys);
    });
    return absent ? { absent: true } : result;
  }

  async folders(dir) {
    try {
      const entries = await this.d.fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }

  /** Every file under a folder, relative ("icons/x.svg"), without the ones Herdr writes. */
  async files(dir, prefix = "") {
    const out = [];
    let entries = [];
    try { entries = await this.d.fs.readdir(`${dir}${prefix ? `/${prefix}` : ""}`, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (ignored(rel)) continue;
      if (e.isDirectory()) out.push(...(await this.files(dir, rel)));
      else out.push(rel);
    }
    return out.sort();
  }

  /** { relPath: fingerprint } of a folder; `transform` sees text files first (renames). */
  async manifest(dir, transform = null) {
    const out = {};
    for (const rel of await this.files(dir)) {
      try {
        if (transform && TEXT.test(rel)) out[rel] = fingerprint(transform(await this.d.fs.readFile(`${dir}/${rel}`, "utf8"), rel));
        else out[rel] = fingerprint(await this.d.fs.readFile(`${dir}/${rel}`));
      } catch {
        out[rel] = "unreadable";
      }
    }
    return out;
  }

  /** The .js sources of a folder (for "used by" and the code review). */
  async sources(dir) {
    const out = [];
    for (const rel of await this.files(dir)) {
      if (!/\.(m?js|cjs)$/.test(rel)) continue;
      const text = await this.readText(`${dir}/${rel}`);
      if (text != null) out.push({ path: rel, text });
    }
    return out;
  }

  /** The .js sources of an installed mod, for "used by": an unreadable file counts as empty. */
  async sourcesQuietly(dir) {
    try {
      return await this.sources(dir);
    } catch {
      return [];
    }
  }

  async run(cmd, args, opts) {
    const r = await this.d.exec(cmd, args, opts);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `${cmd} failed (${r.code})`).trim().split("\n").slice(-3).join("\n"));
    return r;
  }

  /** A path that must stay inside one of Mods' own folders (or mods/), for mv and rm. */
  guard(path, within) {
    const ok = within.some((root) => path.startsWith(`${root}/`) && !path.slice(root.length).split("/").includes(".."));
    if (!ok) throw new Error(`Refused to touch ${path}`);
    return path;
  }

  async move(from, to) {
    const roots = [this.modsDir, this.root, `${this.home}/data`];
    this.guard(from, roots);
    this.guard(to, roots);
    if (await this.exists(to)) throw new Error(`${to.split("/").slice(-2).join("/")} is already there`);
    await this.d.fs.mkdir(to.split("/").slice(0, -1).join("/"), { recursive: true });
    await this.run("mv", [from, to]);
  }

  async remove(path) {
    this.guard(path, [this.root]);
    await this.run("rm", ["-rf", path]);
  }

  // State ---------------------------------------------------------------------------------

  /**
   * state.json as text and value. Absent is a fresh start; there but unreadable stops every
   * change, since it holds the only record of what was turned off or removed.
   */
  async readState() {
    let text;
    try {
      text = await this.readText(this.statePath);
    } catch (e) {
      throw new Error(`mod-hub/state.json can't be read (${message(e)}), so Mods changes nothing until it can`);
    }
    if (text == null) return { text: null, state: normalize({}) };
    try {
      return { text, state: normalize(JSON.parse(text)) };
    } catch {
      throw new Error("mod-hub/state.json isn't valid JSON, so Mods changes nothing until it's fixed");
    }
  }

  async state() {
    return (await this.readState()).state;
  }

  /**
   * Changes state.json: `job(state)` edits it in place (and must not touch disk: it may run
   * again). Written only if the file is still what was read; read again and redone if not.
   */
  async withState(job) {
    for (let attempt = 0; ; attempt++) {
      const { text, state } = await this.readState();
      const result = await job(state);
      const next = `${JSON.stringify(state, null, 2)}\n`;
      if (next === text) return result;
      await this.d.fs.mkdir(this.root, { recursive: true });
      try {
        await this.writeChecked(this.statePath, next, text);
        return result;
      } catch (e) {
        if (attempt >= 2) throw e;
      }
    }
  }

  /** Herdr's own mods and layouts (installed.json). Without it, nothing can be told apart. */
  async shippedSet() {
    const installed = await this.readJson(`${this.home}/installed.json`);
    if (!installed || typeof installed !== "object") {
      throw new Error("Herdr's installed.json can't be read, so Mods can't tell Herdr's own mods and layouts from yours. Start Herdr, then open Mods again");
    }
    return shipped(installed);
  }

  // Reading what's installed ----------------------------------------------------------------

  /**
   * Everything the screen needs about the person's mods, in one read. It changes nothing:
   * records of folders that are gone are left out here and dropped by tidy(), in the queue.
   */
  async scan() {
    const state = await this.state();
    const shippedSet = await this.shippedSet();
    const live = await this.folders(this.modsDir);
    const off = (await this.folders(this.offDir)).filter((n) => !live.includes(n));
    const manifests = {};
    const sources = {};
    const current = {};
    for (const name of live) {
      manifests[name] = (await this.readJson(`${this.modsDir}/${name}/mod.json`)) ?? {};
      sources[name] = (await this.sourcesQuietly(`${this.modsDir}/${name}`)).map((f) => f.text).join("\n");
      if (state.sources[name]) current[name] = await this.manifest(`${this.modsDir}/${name}`);
    }
    for (const name of off) manifests[name] = (await this.readJson(`${this.offDir}/${name}/mod.json`)) ?? {};
    const layouts = {};
    for (const file of await this.layoutFiles()) {
      const tree = await this.readJson(`${this.layoutsDir}/${file}`);
      if (tree) layouts[file.slice(0, -5)] = tree;
    }
    const keys = (await this.readJson(this.keysPath)) ?? {};
    forget(state, live, off, this.now());
    return { state, shippedSet, live, off, manifests, sources, current, layouts, keys };
  }

  /**
   * Brings state.json up to date with the folders before a change reads it: records of mods
   * deleted by hand go, a mod moved back from off/ by hand keeps what it left as pending, and
   * what's been in Removed for 30 days is deleted. Throws if state.json can't be read.
   */
  async settle() {
    await this.readState();
    const live = await this.folders(this.modsDir);
    const off = (await this.folders(this.offDir)).filter((n) => !live.includes(n));
    let expired = [];
    await this.withState((s) => { expired = forget(s, live, off, this.now()); });
    for (const r of expired) await this.dropBundle(r);
  }

  /** settle() on its own, when the screen opens. */
  tidy() {
    return this.serial(async () => {});
  }

  /** Deletes a removed mod's folder and the earlier copies kept with it. */
  async dropBundle(r) {
    await this.remove(`${this.removedDir}/${r.id}`).catch(() => {});
    for (const b of r.backups ?? []) await this.remove(b.dir).catch(() => {});
  }

  async layoutFiles() {
    try {
      return (await this.d.fs.readdir(this.layoutsDir)).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
    } catch {
      return [];
    }
  }

  /** Herdr's own report of broken files and mods (`herdr-app status`). */
  async errors() {
    try {
      const r = await this.d.exec("herdr-app", ["status"], { timeout: 8000 });
      const s = JSON.parse(r.stdout);
      return Array.isArray(s.errors) ? s.errors : [];
    } catch {
      return [];
    }
  }

  // Layouts and keys --------------------------------------------------------------------------

  /**
   * Takes a mod out of every personal layout and keys.json; returns the record to undo it.
   * Every file is read and checked first, so one that isn't valid JSON stops it before
   * anything changes; if a write still fails, the ones already made are undone.
   */
  async detachEverywhere(name, fallback, personal) {
    const state = await this.state();
    const files = [];
    try {
      for (const file of await this.layoutFiles()) {
        if (!personal(file.slice(0, -5))) continue;
        const tree = await this.readJsonStrict(`${this.layoutsDir}/${file}`);
        if (tree && detach(tree, name, fallback).ops.length) files.push(file);
      }
      await this.readJsonStrict(this.keysPath);
    } catch (e) {
      throw new Error(`Nothing changed: ${message(e)}`);
    }
    const record = { layouts: {}, keys: [] };
    try {
      for (const file of files) {
        const layout = file.slice(0, -5);
        try {
          await this.editJson(`${this.layoutsDir}/${file}`, (tree) => {
            delete record.layouts[layout];
            const { tree: next, ops } = detach(tree, name, fallback, knownOps(state, layout, name));
            if (!ops.length) return null;
            record.layouts[layout] = ops;
            return { value: next };
          });
        } catch (e) {
          delete record.layouts[layout]; // its write failed, so the file is as it was
          throw e;
        }
      }
      try {
        await this.editKeys((keys) => {
          const { keys: next, removed } = strip(keys, name);
          record.keys = removed;
          return removed.length ? { value: next } : null;
        });
      } catch (e) {
        record.keys = [];
        throw e;
      }
    } catch (e) {
      const { problems, left } = await this.reattachEverywhere(record);
      if (isEmpty(left)) throw new Error(`Nothing changed: ${message(e)}${problems.length ? `. Putting back what had changed: ${problems.join("; ")}` : ""}`);
      await this.withState((s) => keepPending(s, name, joined(s.pending[name], left))).catch(() => {});
      throw new Error(`Stopped: ${message(e)}. Not all of it could be undone (${problems.join("; ")}); its page has Try again`);
    }
    return record;
  }

  /** JSON a change depends on: null when absent; throws when it's there but can't be used. */
  async readJsonStrict(path) {
    const text = await this.readText(path);
    if (text == null) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${path.slice(this.home.length + 1)} isn't valid JSON`);
    }
  }

  /**
   * Undoes detachEverywhere, one file at a time; never throws. { problems: ["main: the
   * sidebar group is gone"], left: the part of the record that couldn't be tried, to keep }.
   */
  async reattachEverywhere(record) {
    const problems = [];
    const left = { layouts: {}, keys: [] };
    for (const [layout, ops] of Object.entries(record?.layouts ?? {})) {
      const path = `${this.layoutsDir}/${layout}.json`;
      if (!(await this.exists(path))) { problems.push(`${layout}: that layout is gone`); continue; }
      let failed = [];
      try {
        await this.editJson(path, (tree) => {
          const r = reattach(tree, ops);
          failed = r.failed;
          return { value: r.tree };
        });
        for (const f of failed) problems.push(`${layout}: ${f.why}`);
      } catch (e) {
        problems.push(`${layout}: ${message(e)}`);
        left.layouts[layout] = ops;
      }
    }
    if (record?.keys?.length) {
      let skipped = [];
      try {
        const r = await this.editKeys((keys) => {
          const out = restore(keys, record.keys);
          skipped = out.skipped;
          return { value: out.keys };
        });
        if (r?.absent) {
          problems.push("keys.json isn't there, so its keys weren't put back");
          left.keys = record.keys;
        }
        for (const s of skipped) problems.push(`${s.keys} is used by ${typeof s.by === "string" ? s.by : s.by?.command ?? "another key"} now`);
      } catch (e) {
        problems.push(`keys.json: ${message(e)}`);
        left.keys = record.keys;
      }
    }
    return { problems, left };
  }

  /** Tries again to put back what a turn on or restore couldn't. */
  putBack(name) {
    return this.serial(async () => {
      const state = await this.state();
      const { problems, left } = await this.reattachEverywhere(state.pending[name]);
      await this.withState((s) => keepPending(s, name, left));
      return problems;
    });
  }

  // Off and on ------------------------------------------------------------------------------

  turnOff(name, fallback, personal) {
    return this.serial(async () => {
      if (name === SELF) throw new Error("Mods can't turn itself off");
      const from = `${this.modsDir}/${name}`;
      if (!(await this.exists(from))) throw new Error(`${name} isn't in mods/`);
      const record = await this.detachEverywhere(name, fallback, personal);
      try {
        await this.move(from, `${this.offDir}/${name}`);
      } catch (e) {
        await this.putBackOrKeep(name, record);
        throw e;
      }
      await this.withState((s) => {
        s.off[name] = { at: this.now(), ...joined(s.pending[name], record) };
        delete s.pending[name];
      });
      return record;
    });
  }

  turnOn(name) {
    return this.serial(async () => {
      const state = await this.state();
      await this.move(`${this.offDir}/${name}`, `${this.modsDir}/${name}`);
      const { problems, left } = await this.reattachEverywhere(state.off[name]);
      await this.withState((s) => {
        delete s.off[name];
        keepPending(s, name, left);
      });
      return problems;
    });
  }

  /** After a failed move: undoes a detach, keeping in state whatever couldn't go back. */
  async putBackOrKeep(name, record) {
    const { left } = await this.reattachEverywhere(record);
    if (!isEmpty(left)) await this.withState((s) => keepPending(s, name, joined(s.pending[name], left))).catch(() => {});
  }

  // Remove and restore ------------------------------------------------------------------------

  uninstall(mod, fallback, personal) {
    return this.serial(async () => {
      const name = mod.name;
      if (name === SELF) throw new Error("Remove Mods by deleting its folder");
      const state = await this.state();
      const enabled = await this.exists(`${this.modsDir}/${name}`);
      if (!enabled && !(await this.exists(`${this.offDir}/${name}`))) throw new Error(`${name} isn't installed`);
      const id = `${name}-${this.now()}`;
      const bundle = `${this.removedDir}/${id}`;
      const record = enabled ? await this.detachEverywhere(name, fallback, personal) : { layouts: state.off[name]?.layouts ?? {}, keys: state.off[name]?.keys ?? [] };
      try {
        await this.move(enabled ? `${this.modsDir}/${name}` : `${this.offDir}/${name}`, `${bundle}/mod`);
      } catch (e) {
        if (enabled) await this.putBackOrKeep(name, record);
        throw e;
      }
      const data = `${this.home}/data/${name}`;
      let hasData = false;
      if (await this.exists(data)) hasData = await this.move(data, `${bundle}/data`).then(() => true, () => false);
      await this.withState((s) => {
        const all = joined(s.pending[name], enabled ? record : s.off[name] ?? record);
        s.removed.unshift({ id, name, title: mod.title ?? name, at: this.now(), source: s.sources[name] ?? null, data: hasData, backups: s.backups[name] ?? [], layouts: all.layouts, keys: all.keys });
        delete s.sources[name];
        delete s.updates[name];
        delete s.off[name];
        delete s.pending[name];
        delete s.backups[name];
      });
      return id;
    });
  }

  /**
   * Puts a removed mod back where it was. Its data goes back too, unless data/<name> is there
   * already: then the old data stays under Removed rather than being mixed in or lost.
   */
  restoreRemoved(id) {
    return this.serial(async () => {
      const state = await this.state();
      const r = state.removed.find((x) => x.id === id);
      if (!r) throw new Error("It's no longer in Removed");
      if (r.dataOnly) throw new Error(`Only ${r.title}'s old data is kept here`);
      const bundle = `${this.removedDir}/${r.id}`;
      if (await this.exists(`${this.modsDir}/${r.name}`)) throw new Error(`A mod called ${r.name} is installed again`);
      if (await this.exists(`${this.offDir}/${r.name}`)) throw new Error(`A mod called ${r.name} is installed again, turned off`);
      await this.move(`${bundle}/mod`, `${this.modsDir}/${r.name}`);
      let dataLeft = false;
      if (r.data) {
        if (await this.exists(`${this.home}/data/${r.name}`)) dataLeft = true;
        else dataLeft = !(await this.move(`${bundle}/data`, `${this.home}/data/${r.name}`).then(() => true, () => false));
      }
      const { problems, left } = await this.reattachEverywhere(r);
      if (dataLeft) problems.push(`data/${r.name} was there already, so its old data is kept under Removed`);
      else await this.remove(bundle).catch(() => {});
      await this.withState((s) => {
        s.removed = s.removed.filter((x) => x.id !== id);
        if (dataLeft) s.removed.unshift({ id: r.id, name: r.name, title: r.title, at: r.at, dataOnly: true, data: true, layouts: {}, keys: [] });
        if (r.source) s.sources[r.name] = r.source;
        if (r.backups?.length) s.backups[r.name] = [...(s.backups[r.name] ?? []), ...r.backups];
        keepPending(s, r.name, left);
      });
      return problems;
    });
  }

  purgeRemoved(id) {
    return this.serial(async () => {
      if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error("Bad id");
      const r = (await this.state()).removed.find((x) => x.id === id) ?? { id };
      await this.dropBundle(r);
      await this.withState((s) => { s.removed = s.removed.filter((x) => x.id !== id); });
    });
  }

  // The gallery -----------------------------------------------------------------------------

  async cachedIndex() {
    const cached = await this.readJson(`${this.cacheDir}/index.json`);
    if (!cached?.json) return null;
    return { fetchedAt: cached.fetchedAt ?? 0, ...parseIndex(cached.json) };
  }

  async fetchIndex() {
    const res = await this.d.fetch(INDEX_URL);
    if (!res.ok) throw new Error(`herdr.dev answered ${res.status}`);
    const json = await res.json();
    const parsed = parseIndex(json);
    if (!parsed.entries.length) throw new Error("The gallery index was empty");
    await this.d.fs.mkdir(this.cacheDir, { recursive: true });
    const fetchedAt = this.now();
    await this.writeJson(`${this.cacheDir}/index.json`, { fetchedAt, json });
    return { fetchedAt, ...parsed };
  }

  async recipe(entry) {
    const res = await this.d.fetch(recipeUrl(entry));
    if (!res.ok) throw new Error(res.status === 404 ? "This listing has no recipe" : `GitHub answered ${res.status}`);
    return res.text();
  }

  /** A listing's preview picture, downloaded once: its path for image(), or null. */
  preview(entry) {
    if (!entry.previewFile) return Promise.resolve(null);
    const rel = `mod-hub/cache/previews/${entry.previewFile}`;
    const path = `${this.home}/${rel}`;
    if (this.previewJobs.has(path)) return this.previewJobs.get(path);
    const job = (async () => {
      if (await this.exists(path)) return rel;
      await this.d.fs.mkdir(`${this.cacheDir}/previews`, { recursive: true });
      const part = `${path}.part`;
      const r = await this.d.exec("curl", ["-fsSL", "--max-time", "30", "-o", part, entry.previewUrl], { timeout: 35000 });
      if (r.code !== 0) { await this.d.fs.unlink(part).catch(() => {}); return null; }
      await this.run("mv", [part, path]);
      return rel;
    })().catch(() => null);
    this.previewJobs.set(path, job);
    job.then((v) => { if (!v) this.previewJobs.delete(path); });
    return job;
  }

  /**
   * Refuses a download if what Mods reads or copies from it (`rels`, and the folders on the way)
   * holds links or special files: a link could point at the person's files, and copying or
   * renaming through it would write there. Links elsewhere in the repo (CLAUDE.md pointing at
   * AGENTS.md, say) are never read, so they don't matter.
   */
  async refuseLinks(dir, rels) {
    const chain = new Set([dir]);
    const used = [];
    for (const rel of rels) {
      let p = dir;
      for (const part of rel.split("/").filter(Boolean)) chain.add((p = `${p}/${part}`));
      used.push(p);
    }
    const here = async (paths) => (await Promise.all(paths.map(async (p) => ((await this.exists(p)) ? p : null)))).filter(Boolean);
    const links = await here([...chain]);
    const inside = await here(used);
    const found = [
      links.length ? (await this.run("find", [...links, "-maxdepth", "0", "-type", "l"], { timeout: 30000 })).stdout : "",
      inside.length ? (await this.run("find", [...inside, "!", "-type", "f", "!", "-type", "d"], { timeout: 30000 })).stdout : "",
    ].join("\n").trim();
    if (found) throw new Error(`it holds links or special files (${found.split("\n")[0].slice(dir.length + 1)}), which mods don't need`);
  }

  /**
   * Downloads a listing's repo at its commit into staging: { dir (the unpacked repo), done() }.
   * `mods`: the mod folders that will be read, checked for links with the listing's keys.json.
   */
  async download(entry, mods = entry.modNames) {
    const commit = entry.commit;
    const work = `${this.stagingDir}/${entry.owner}-${entry.repo}-${commit.slice(0, 12)}-${this.now().toString(36)}`;
    this.downloads.add(work);
    const done = () => {
      this.downloads.delete(work);
      return this.remove(work).catch(() => {});
    };
    await this.d.fs.mkdir(`${work}/repo`, { recursive: true });
    try {
      const url = this.d.urls?.tarball ? this.d.urls.tarball(entry, commit) : tarballUrl(entry, commit);
      await this.run("curl", ["-fsSL", "--max-time", "120", "-o", `${work}/repo.tgz`, url], { timeout: 125000 });
      await this.run("tar", ["-xzf", `${work}/repo.tgz`, "-C", `${work}/repo`], { timeout: 60000 });
      const top = await this.folders(`${work}/repo`);
      if (top.length !== 1) throw new Error("The download wasn't one repository");
      const dir = `${work}/repo/${top[0]}`;
      await this.refuseLinks(dir, [...mods.filter((n) => MOD_NAME.test(n)).map((n) => `${modsDirIn(entry)}/${n}`), keysFileIn(entry)]);
      return { dir, work, done };
    } catch (e) {
      await done();
      throw new Error(`Couldn't download ${entry.fullName}: ${message(e)}`);
    }
  }

  /** Removes downloads a closed screen left behind. */
  cleanStaging() {
    return this.serial(async () => {
      for (const name of await this.folders(this.stagingDir)) {
        const path = `${this.stagingDir}/${name}`;
        if (!this.downloads.has(path)) await this.remove(path).catch(() => {});
      }
    });
  }

  // Install -----------------------------------------------------------------------------------

  /**
   * Downloads a listing and says what installing it would do, without changing anything:
   * { entry, dl, mods: [{ name, target, action: "new" | "rename" | "reinstall", files, manifest }],
   *   report, keys: { added, kept, same }, missing: [names not in the download] }.
   */
  async plan(entry) {
    const dl = await this.download(entry);
    try {
      const state = await this.state();
      const sh = await this.shippedSet();
      // A name in Removed stays free for its Restore.
      const taken = new Set([...(await this.folders(this.modsDir)), ...(await this.folders(this.offDir)), ...state.removed.map((r) => r.name), ...sh.mods, SELF]);
      const mods = [];
      const missing = [];
      const review = new Review();
      for (const name of entry.modNames) {
        const dir = `${dl.dir}/${modsDirIn(entry)}/${name}`;
        if (!MOD_NAME.test(name) || !(await this.exists(`${dir}/main.js`))) { missing.push(name); continue; }
        // The same listing installed before: install over it rather than beside it.
        const mine = Object.entries(state.sources).find(([, s]) => s.fullName === entry.fullName && s.path === entry.path && s.mod === name);
        let target = mine ? mine[0] : freeName(name, taken);
        const action = mine ? "reinstall" : target === name ? "new" : "rename";
        if (!mine) taken.add(target);
        const files = await this.files(dir);
        for (const f of await this.sources(dir)) {
          const rows = f.text.split("\n");
          for (let i = 0; i < rows.length; i += REVIEW_LINES) {
            review.add(`${name}/${f.path}`, rows.slice(i, i + REVIEW_LINES), i + 1);
            await this.pause();
          }
        }
        mods.push({ name, target, action, dir, files, manifest: (await this.readJson(`${dir}/mod.json`)) ?? {} });
      }
      let keys = { added: [], kept: [], same: [] };
      const theirs = await this.readJson(`${dl.dir}/${keysFileIn(entry)}`);
      if (theirs && typeof theirs === "object") {
        let renamed = theirs;
        for (const m of mods) if (m.target !== m.name) renamed = renameInKeys(renamed, m.name, m.target);
        keys = merge((await this.readJson(this.keysPath)) ?? {}, renamed);
        keys.theirs = renamed;
      }
      return { entry, dl, mods, missing, report: review.report(), keys };
    } catch (e) {
      await dl.done();
      throw e;
    }
  }

  /** Copies a downloaded mod folder into staging under its target name, renamed inside. */
  async prepare(m, into) {
    const ready = `${into}/${m.target}`;
    await this.d.fs.mkdir(into, { recursive: true });
    await this.run("cp", ["-R", m.dir, ready]);
    if (m.target !== m.name) {
      for (const rel of await this.files(ready)) {
        if (!TEXT.test(rel)) continue;
        const text = await this.readText(`${ready}/${rel}`);
        if (text == null) continue;
        const next = renameFile(text, rel, m.name, m.target);
        if (next !== text) await this.d.fs.writeFile(`${ready}/${rel}`, next);
      }
    }
    return ready;
  }

  /** Herdr's own check of a mod folder; throws its message. */
  async check(folder, label) {
    const r = await this.d.check(folder);
    if (!r.ok) throw new Error(`${label} didn't pass Herdr's check: ${r.error}`);
  }

  /**
   * Installs what plan() described. Nothing moves into mods/ until every mod passed Herdr's
   * check, and nothing replaces a folder unless it's this listing's own earlier install.
   */
  install(plan) {
    return this.serial(async () => {
      const into = `${plan.dl.work}/ready`;
      const installed = [];
      try {
        // Decided again now: the review may have been open a while.
        const state = await this.state();
        const places = [];
        for (const m of plan.mods) {
          const on = `${this.modsDir}/${m.target}`;
          const off = `${this.offDir}/${m.target}`;
          const there = (await this.exists(on)) ? on : (await this.exists(off)) ? off : null;
          const src = state.sources[m.target];
          const ours = src && src.fullName === plan.entry.fullName && src.path === plan.entry.path && src.mod === m.name;
          if (there && !(m.action === "reinstall" && ours)) {
            throw new Error(`A mod called ${m.target} appeared since the review opened, so nothing was installed. Open the review again to install beside it`);
          }
          // A reinstall goes where the old copy is: mods/, or off/ if it's turned off (it stays off).
          places.push({ m, target: there ?? on, replace: Boolean(there) });
        }
        const ready = [];
        for (const p of places) {
          const folder = await this.prepare(p.m, into);
          await this.check(folder, p.m.target);
          ready.push({ ...p, folder, files: await this.manifest(folder) });
        }
        for (const { m, target, replace, folder, files } of ready) {
          await this.swapIn(m.target, folder, target, replace, plan.entry.commit);
          installed.push(m.target);
          await this.withState((s) => {
            s.sources[m.target] = { fullName: plan.entry.fullName, path: plan.entry.path, mod: m.name, commit: plan.entry.commit, installedAt: this.now(), files };
            delete s.updates[m.target];
          });
        }
        const keys = await this.addKeys(plan.keys.theirs, plan.keys.kept ?? []);
        return { installed, keys };
      } catch (e) {
        if (installed.length) throw new Error(`Installed ${installed.join(", ")}, then stopped: ${message(e)}`);
        throw e;
      } finally {
        await plan.dl.done();
      }
    });
  }

  /** Merges a listing's keys.json into the person's: { added, kept, absent? }. */
  async addKeys(theirs, kept = []) {
    let keys = { added: [], kept };
    if (!theirs || typeof theirs !== "object") return keys;
    const r = await this.editKeys((mine) => {
      keys = merge(mine, theirs);
      return keys.added.length ? { value: keys.keys } : null;
    });
    return r?.absent ? { added: [], kept: [], absent: true } : keys;
  }

  /**
   * Moves a checked folder to `target`. With `replace`, what's there goes to backups/ first,
   * and comes back if the move fails.
   */
  async swapIn(name, folder, target, replace, nextCommit) {
    const b = replace ? await this.backup(name, nextCommit, target) : null;
    try {
      await this.move(folder, target);
    } catch (e) {
      if (b && (await this.move(b.dir, target).then(() => true, () => false))) {
        await this.withState((s) => { s.backups[name] = (s.backups[name] ?? []).filter((x) => x.dir !== b.dir); }).catch(() => {});
      }
      throw e;
    }
    if (b) await this.trimBackups(name);
  }

  /** A folder name in backups/ that isn't taken. */
  async freeBackup(name) {
    const base = `${this.backupsDir}/${name}-${this.now()}`;
    let dir = base;
    for (let i = 2; await this.exists(dir); i++) dir = `${base}-${i}`;
    return dir;
  }

  /** Moves the current copy of a mod into backups/ and returns its entry. */
  async backup(name, nextCommit, from) {
    const state = await this.state();
    const entry = { dir: await this.freeBackup(name), at: this.now(), commit: state.sources[name]?.commit ?? null, source: state.sources[name] ?? null, replacedBy: nextCommit };
    await this.move(from, entry.dir);
    await this.withState((s) => { s.backups[name] = [entry, ...(s.backups[name] ?? []).filter((b) => b.dir !== entry.dir)]; });
    return entry;
  }

  /** Keeps the newest few earlier copies of a mod, once the new copy is in place. */
  async trimBackups(name) {
    let dropped = [];
    await this.withState((s) => {
      const list = s.backups[name] ?? [];
      dropped = list.slice(KEEP_BACKUPS);
      if (dropped.length) s.backups[name] = list.slice(0, KEEP_BACKUPS);
    });
    for (const old of dropped) await this.remove(old.dir).catch(() => {});
  }

  // Updates ---------------------------------------------------------------------------------

  /**
   * For each mod installed from the gallery whose listing moved to a new commit: downloads it
   * and compares the mod's own files. Only a changed folder is an update; otherwise the
   * record just follows the commit. `progress(name)` is told what's being looked at.
   */
  checkUpdates(entries, progress = () => {}) {
    return this.serial(async () => {
      const state = await this.state();
      const byKey = new Map(entries.map((e) => [entryKey(e), e]));
      const due = new Map(); // listing key -> [mod folder names]
      for (const [name, src] of Object.entries(state.sources)) {
        const e = byKey.get(`${src.fullName}#${src.path}`);
        if (!e) continue;
        if (e.commit === src.commit || state.updates[name]?.commit === e.commit) continue;
        if (!(await this.exists(`${this.modsDir}/${name}`)) && !(await this.exists(`${this.offDir}/${name}`))) continue;
        if (!due.has(e.key)) due.set(e.key, []);
        due.get(e.key).push(name);
      }
      const problems = [];
      const found = {}; // name -> { commit } (same files, new commit) or { update }
      for (const [key, names] of due) {
        const e = byKey.get(key);
        progress(e.fullName);
        let dl;
        try {
          dl = await this.download(e, names.map((n) => state.sources[n].mod));
          for (const name of names) {
            const src = state.sources[name];
            const dir = `${dl.dir}/${modsDirIn(e)}/${src.mod}`;
            if (!(await this.exists(`${dir}/main.js`))) {
              found[name] = { update: { commit: e.commit, gone: true, checkedAt: this.now() } };
              continue;
            }
            const transform = name !== src.mod ? (text, rel) => renameFile(text, rel, src.mod, name) : null;
            const d = diff(src.files, await this.manifest(dir, transform));
            found[name] = d.count === 0 ? { commit: e.commit } : { update: { commit: e.commit, diff: d, checkedAt: this.now() } };
          }
        } catch (err) {
          problems.push(`${e.fullName}: ${message(err)}`);
        } finally {
          await dl?.done();
        }
      }
      await this.withState((s) => {
        for (const [name, f] of Object.entries(found)) {
          if (!s.sources[name]) continue;
          if (f.commit) {
            s.sources[name] = { ...s.sources[name], commit: f.commit };
            delete s.updates[name];
          } else s.updates[name] = f.update;
        }
        s.checkedAt = this.now();
      });
      return problems;
    });
  }

  /** Replaces a mod with its listing's newest files; the old copy goes to backups/. */
  update(name, entry) {
    return this.serial(async () => {
      const state = await this.state();
      const src = state.sources[name];
      if (!src) throw new Error(`${name} isn't linked to the gallery`);
      const enabled = await this.exists(`${this.modsDir}/${name}`);
      const live = enabled ? `${this.modsDir}/${name}` : `${this.offDir}/${name}`;
      if (!enabled && !(await this.exists(live))) throw new Error(`${name} isn't installed`);
      const dl = await this.download(entry, [src.mod]);
      try {
        const dir = `${dl.dir}/${modsDirIn(entry)}/${src.mod}`;
        if (!(await this.exists(`${dir}/main.js`))) throw new Error(`${entry.fullName} no longer has ${src.mod}`);
        const folder = await this.prepare({ name: src.mod, target: name, dir }, `${dl.work}/ready`);
        await this.check(folder, name);
        const files = await this.manifest(folder);
        await this.swapIn(name, folder, live, true, entry.commit);
        await this.withState((s) => {
          s.sources[name] = { ...src, commit: entry.commit, updatedAt: this.now(), files };
          delete s.updates[name];
        });
        // A turned-off mod gets its keys when it's turned on; none are added meanwhile.
        const theirs = enabled ? await this.readJson(`${dl.dir}/${keysFileIn(entry)}`) : null;
        const keys = await this.addKeys(theirs && name !== src.mod ? renameInKeys(theirs, src.mod, name) : theirs);
        return { keys };
      } finally {
        await dl.done();
      }
    });
  }

  /**
   * Puts back the copy the last update replaced. The copy it replaces is kept as the next
   * earlier copy, so a roll back can be rolled back.
   */
  rollback(name) {
    return this.serial(async () => {
      const state = await this.state();
      const b = rollbackFor(state, name);
      if (!b || !(await this.exists(b.dir))) throw new Error("There's no earlier copy to go back to");
      const enabled = await this.exists(`${this.modsDir}/${name}`);
      const live = enabled ? `${this.modsDir}/${name}` : `${this.offDir}/${name}`;
      let aside = null;
      if (await this.exists(live)) {
        aside = { dir: await this.freeBackup(name), at: this.now(), commit: state.sources[name]?.commit ?? null, source: state.sources[name] ?? null, replacedBy: b.commit, undone: true };
        await this.move(live, aside.dir);
      }
      try {
        await this.move(b.dir, live);
      } catch (e) {
        if (aside && !(await this.move(aside.dir, live).then(() => true, () => false))) {
          await this.withState((s) => { s.backups[name] = [aside, ...(s.backups[name] ?? [])]; }).catch(() => {});
        }
        throw e;
      }
      await this.withState((s) => {
        const rest = (s.backups[name] ?? []).filter((x) => x.dir !== b.dir);
        s.backups[name] = aside ? [aside, ...rest] : rest;
        if (!s.backups[name].length) delete s.backups[name];
        s.sources[name] = b.source;
        delete s.updates[name];
      });
    });
  }

  /** Remembers that a folder installed by hand came from a listing, so updates can be found. */
  link(name, entry, folder = name) {
    return this.serial(async () => {
      const files = await this.manifest(`${this.modsDir}/${name}`);
      await this.withState((s) => {
        s.sources[name] = { fullName: entry.fullName, path: entry.path, mod: folder, commit: null, installedAt: this.now(), linked: true, files };
        delete s.updates[name];
      });
    });
  }

  unlink(name) {
    return this.serial(() => this.withState((s) => { delete s.sources[name]; delete s.updates[name]; }));
  }
}

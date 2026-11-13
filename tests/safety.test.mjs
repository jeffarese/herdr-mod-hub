// Ways a change could lose or corrupt the person's files, each found by review and fixed.
// On a temporary Herdr home with real mv, cp, tar and curl; nothing touches ~/.config.
import test from "node:test";
import assert from "node:assert/strict";
import * as nfs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, rollbackFor } from "../mods/mod-hub/hub.js";
import { parseIndex } from "../mods/mod-hub/catalog.js";
import { detach, reattach } from "../mods/mod-hub/layouts.js";
import { strip } from "../mods/mod-hub/keys.js";
import { renameFile } from "../mods/mod-hub/manifest.js";

const fsAdapter = {
  readFile: (p, enc) => (enc ? nfs.readFile(p, "utf8") : nfs.readFile(p).then((b) => new Uint8Array(b))),
  writeFile: (p, c) => nfs.writeFile(p, c),
  readdir: (p, o) => nfs.readdir(p, o),
  exists: async (p) => nfs.access(p).then(() => true, () => false),
  mkdir: (p, o) => nfs.mkdir(p, o),
  unlink: (p) => nfs.unlink(p),
  rmdir: (p) => nfs.rmdir(p),
};
const execReal = async (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", timeout: opts.timeout });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || (r.error ? String(r.error) : "") };
};
const write = async (path, text) => { await nfs.mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true }); await nfs.writeFile(path, text); };
const read = (p) => nfs.readFile(p, "utf8");
const json = async (p) => JSON.parse(await read(p));
const exists = (p) => fsAdapter.exists(p);

async function setup(over = {}) {
  const base = await nfs.mkdtemp(join(tmpdir(), "mod-hub-safety-"));
  const home = `${base}/home`;
  await write(`${home}/installed.json`, JSON.stringify({ files: {}, "layout:main": {} }));
  await write(`${home}/mods/files/main.js`, "export default class {}");
  await write(`${home}/keys.json`, JSON.stringify({ global: { "cmd-g": "app.palette" } }, null, 2));
  const repos = `${base}/repos`;
  let clock = 1_000_000;
  const deps = {
    home, exec: execReal, fs: fsAdapter, now: () => clock++,
    fetch: async () => { throw new Error("no network in tests"); },
    check: async () => ({ ok: true }),
    urls: { tarball: (e, commit) => `file://${repos}/${e.repo}-${commit}.tgz` },
    ...over,
  };
  const hub = new Hub(deps);
  async function publish(repo, commit, files, links = {}) {
    const top = `${base}/src/${repo}-${commit}`;
    for (const [path, text] of Object.entries(files)) await write(`${top}/${path}`, text);
    for (const [path, target] of Object.entries(links)) {
      await nfs.mkdir(`${top}/${path}`.split("/").slice(0, -1).join("/"), { recursive: true });
      await nfs.symlink(target, `${top}/${path}`);
    }
    await nfs.mkdir(repos, { recursive: true });
    const r = spawnSync("tar", ["-czf", `${repos}/${repo}-${commit}.tgz`, "-C", `${base}/src`, `${repo}-${commit}`]);
    assert.equal(r.status, 0);
  }
  return { home, hub, deps, publish, cleanup: () => nfs.rm(base, { recursive: true, force: true }) };
}

const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const listing = (repo, commit, mods, owner = "o") => parseIndex({ mods: [{ fullName: `${owner}/${repo}`, headCommit: commit, path: "", modNames: mods }] }).entries[0];
const blk = (id, mod) => ({ id, type: "block", content: { mod } });
const row = (...children) => ({ id: "root", type: "row", children });
const all = () => true;
const none = () => null;

test("a download holding links is refused before anything is copied or renamed", async () => {
  const h = await setup();
  try {
    await write(`${h.home}/mods/graph/main.js`, 'const icon = "mods/graph/icon.svg";\n');
    await write(`${h.home}/keys.json`, JSON.stringify({ global: { "cmd-g": "mod.open:graph", "cmd-r": "graph.refresh" } }, null, 2));
    const before = [await read(`${h.home}/mods/graph/main.js`), await read(`${h.home}/keys.json`)];
    await h.publish("evil", C1, { "mods/graph/main.js": "export default class {}\n", "mods/graph/mod.json": "{}" }, {
      "mods/graph/k.json": "../../../../../keys.json",
      "mods/graph/m.js": "../../../../../mods/graph/main.js",
    });
    await assert.rejects(h.hub.plan(listing("evil", C1, ["graph"])), /links or special files \(mods\/graph\/k.json\)/);
    assert.deepEqual([await read(`${h.home}/mods/graph/main.js`), await read(`${h.home}/keys.json`)], before);
    assert.equal(await exists(`${h.home}/mods/graph-2`), false);

    // A link to a folder on the way counts; a link the mod never reads doesn't.
    await h.publish("sly", C1, { "README.md": "x" }, { mods: "../../../../.." });
    await assert.rejects(h.hub.plan(listing("sly", C1, ["graph"])), /links or special files/);
    await h.publish("nice", C1, { "AGENTS.md": "guide", "mods/n/main.js": "export default class {}\n", "mods/n/mod.json": "{}" }, { "CLAUDE.md": "AGENTS.md" });
    const plan = await h.hub.plan(listing("nice", C1, ["n"]));
    assert.deepEqual(plan.mods.map((m) => m.target), ["n"]);
    await plan.dl.done();
  } finally { await h.cleanup(); }
});

test("turning off stops before any change when a file it needs isn't valid JSON", async () => {
  const h = await setup();
  try {
    await write(`${h.home}/mods/x/main.js`, "x");
    const layout = JSON.stringify(row({ id: "xb", type: "block", content: { mod: "x", props: { k: 1 } }, size: { px: 300 } }));
    await write(`${h.home}/layouts/a.json`, layout);
    await write(`${h.home}/keys.json`, '{ "global": { "cmd-g": "app.palette", } }');
    await assert.rejects(h.hub.turnOff("x", none, all), /Nothing changed: keys.json isn't valid JSON/);
    assert.equal(await read(`${h.home}/layouts/a.json`), layout);
    assert.ok(await exists(`${h.home}/mods/x/main.js`));
  } finally { await h.cleanup(); }
});

test("turning off undoes the layouts it changed when a later write fails", async () => {
  const h = await setup({
    writeText: async (path, text) => {
      if (path.endsWith("/b.json")) throw new Error("stale snapshot");
      await nfs.writeFile(path, text);
    },
  });
  try {
    await write(`${h.home}/mods/x/main.js`, "x");
    const a = row(blk("xa", "x"), blk("files", "files"));
    await write(`${h.home}/layouts/a.json`, JSON.stringify(a));
    await write(`${h.home}/layouts/b.json`, JSON.stringify(row(blk("xb", "x"))));
    await assert.rejects(h.hub.turnOff("x", none, all), /Nothing changed/);
    assert.deepEqual(await json(`${h.home}/layouts/a.json`), a);
    assert.ok(await exists(`${h.home}/mods/x/main.js`));
  } finally { await h.cleanup(); }
});

test("a failed undo is kept to try again, not reported as nothing changed", async () => {
  let writes = 0;
  const h = await setup({
    writeText: async (path, text) => {
      if (path.endsWith("state.json")) return nfs.writeFile(path, text);
      if (++writes > 1) throw new Error("No space left on device");
      await nfs.writeFile(path, text);
    },
  });
  try {
    await write(`${h.home}/mods/x/main.js`, "x");
    await write(`${h.home}/keys.json`, JSON.stringify({ global: { "cmd-x": "mod.open:x" } }));
    await write(`${h.home}/layouts/a.json`, JSON.stringify(row(blk("xa", "x"), blk("files", "files"))));
    await assert.rejects(h.hub.turnOff("x", none, all), /Stopped: No space left on device\. Not all of it could be undone/);
    assert.ok((await json(`${h.home}/mod-hub/state.json`)).pending.x.layouts.a);
    writes = -100;
    assert.deepEqual(await h.hub.putBack("x"), []);
    assert.deepEqual((await json(`${h.home}/layouts/a.json`)).children.map((c) => c.id), ["xa", "files"]);
  } finally { await h.cleanup(); }
});

test("a mod moved back from off/ by hand keeps what it left, through Try again or another turn off", async () => {
  const h = await setup();
  try {
    await write(`${h.home}/mods/x/main.js`, "x");
    await write(`${h.home}/keys.json`, JSON.stringify({ global: { "cmd-g": "app.palette", "cmd-x": "mod.open:x" } }));
    await write(`${h.home}/layouts/a.json`, JSON.stringify(row(blk("xa", "x"), blk("files", "files"))));
    await h.hub.turnOff("x", none, all);
    await nfs.rename(`${h.home}/mod-hub/off/x`, `${h.home}/mods/x`);
    await h.hub.turnOff("x", none, all);
    await h.hub.turnOn("x");
    assert.deepEqual((await json(`${h.home}/layouts/a.json`)).children.map((c) => c.id), ["xa", "files"]);
    assert.equal((await json(`${h.home}/keys.json`)).global["cmd-x"], "mod.open:x");

    await h.hub.turnOff("x", none, all);
    await nfs.rename(`${h.home}/mod-hub/off/x`, `${h.home}/mods/x`);
    assert.ok((await h.hub.scan()).state.pending.x, "the page offers Try again");
    assert.deepEqual(await h.hub.putBack("x"), []);
    assert.deepEqual((await json(`${h.home}/layouts/a.json`)).children.map((c) => c.id), ["xa", "files"]);
    assert.equal((await json(`${h.home}/keys.json`)).global["cmd-x"], "mod.open:x");
  } finally { await h.cleanup(); }
});

test("turning on with one broken layout puts back the rest and keeps what's left to try again", async () => {
  const h = await setup();
  try {
    await write(`${h.home}/mods/x/main.js`, "x");
    await write(`${h.home}/keys.json`, JSON.stringify({ global: { "cmd-x": "mod.open:x" } }));
    await write(`${h.home}/layouts/a.json`, JSON.stringify(row(blk("xa", "x"))));
    await write(`${h.home}/layouts/b.json`, JSON.stringify(row(blk("xb", "x"))));
    await h.hub.turnOff("x", none, all);
    const fine = await read(`${h.home}/layouts/a.json`);
    await write(`${h.home}/layouts/a.json`, fine.replace(/\]\s*}\s*$/, "],}"));
    const problems = await h.hub.turnOn("x");
    assert.match(problems.join(), /^a: /);
    assert.deepEqual((await json(`${h.home}/layouts/b.json`)).children.map((c) => c.id), ["xb"]);
    assert.equal((await json(`${h.home}/keys.json`)).global["cmd-x"], "mod.open:x");
    await h.hub.tidy();
    const s = await json(`${h.home}/mod-hub/state.json`);
    assert.ok(s.pending.x.layouts.a, "what didn't go back is kept");
    assert.equal(s.off.x, undefined);
    await write(`${h.home}/layouts/a.json`, fine);
    assert.deepEqual(await h.hub.putBack("x"), []);
    assert.deepEqual((await json(`${h.home}/layouts/a.json`)).children.map((c) => c.id), ["xa"]);
    assert.equal((await json(`${h.home}/mod-hub/state.json`)).pending.x, undefined);
  } finally { await h.cleanup(); }
});

test("scan never writes state.json, so it can't undo a change that ran meanwhile", async () => {
  let gate = null;
  let open = null;
  const h = await setup();
  try {
    h.deps.fs = { ...fsAdapter, readdir: async (p, o) => { if (gate && p === `${h.home}/mods`) { const g = gate; gate = null; await g; } return fsAdapter.readdir(p, o); } };
    await write(`${h.home}/mods/b/main.js`, "b");
    await write(`${h.home}/mod-hub/state.json`, JSON.stringify({ sources: { b: { fullName: "o/b", path: "", mod: "b", commit: C1, files: {} } } }));
    gate = new Promise((r) => (open = r));
    const scanning = h.hub.scan();
    await new Promise((r) => setTimeout(r, 20));
    const id = await h.hub.uninstall({ name: "b", title: "B" }, none, all);
    open();
    await scanning;
    const s = await json(`${h.home}/mod-hub/state.json`);
    assert.deepEqual(s.removed.map((r) => r.id), [id]);
    await h.hub.restoreRemoved(id);
    assert.ok(await exists(`${h.home}/mods/b/main.js`));
  } finally { await h.cleanup(); }
});

test("roll back is offered only for the same listing's mod, and keeps the copy it replaces", async () => {
  const h = await setup();
  try {
    const files = (v) => ({ "mods/g/main.js": `export default class {} // ${v}\n`, "mods/g/mod.json": "{}" });
    await h.publish("g", C1, files("v1"));
    await h.publish("g", C2, files("v2"));
    await h.hub.install(await h.hub.plan(listing("g", C1, ["g"])));
    await h.hub.update("g", listing("g", C2, ["g"]));
    await write(`${h.home}/mods/g/edited.js`, "my edit after the update");
    await h.hub.rollback("g");
    assert.match(await read(`${h.home}/mods/g/main.js`), /v1/);
    let s = (await h.hub.scan()).state;
    assert.equal(rollbackFor(s, "g").undone, true);
    await h.hub.rollback("g");
    assert.equal(await read(`${h.home}/mods/g/edited.js`), "my edit after the update", "rolling back the roll back brings the edit back");

    await h.hub.uninstall({ name: "g", title: "G" }, none, all);
    await h.hub.purgeRemoved((await json(`${h.home}/mod-hub/state.json`)).removed[0].id);
    assert.deepEqual(await nfs.readdir(`${h.home}/mod-hub/backups`), [], "earlier copies go with it");
    await write(`${h.home}/mods/g/main.js`, "MY OWN g");
    s = (await h.hub.scan()).state;
    assert.equal(rollbackFor(s, "g"), null);
    await assert.rejects(h.hub.rollback("g"), /no earlier copy/);
    assert.equal(await read(`${h.home}/mods/g/main.js`), "MY OWN g");
  } finally { await h.cleanup(); }
});

test("restore refuses over a turned-off mod of the same name, and never deletes old data", async () => {
  const h = await setup();
  try {
    await write(`${h.home}/mods/x/main.js`, "old x");
    await write(`${h.home}/data/x/notes.json`, "OLD DATA");
    const id = await h.hub.uninstall({ name: "x", title: "X" }, none, all);
    await write(`${h.home}/mods/x/main.js`, "new x");
    await h.hub.turnOff("x", none, all);
    await assert.rejects(h.hub.restoreRemoved(id), /installed again, turned off/);
    assert.equal(await read(`${h.home}/mod-hub/removed/${id}/data/notes.json`), "OLD DATA");

    await h.hub.uninstall({ name: "x", title: "X" }, none, all);
    await write(`${h.home}/data/x/notes.json`, "new data");
    const problems = await h.hub.restoreRemoved(id);
    assert.match(problems.join(), /data\/x was there already/);
    assert.equal(await read(`${h.home}/mods/x/main.js`), "old x");
    assert.equal(await read(`${h.home}/data/x/notes.json`), "new data");
    assert.equal(await read(`${h.home}/mod-hub/removed/${id}/data/notes.json`), "OLD DATA");
    const kept = (await json(`${h.home}/mod-hub/state.json`)).removed.find((r) => r.id === id);
    assert.equal(kept.dataOnly, true);
    await assert.rejects(h.hub.restoreRemoved(id), /old data/);
  } finally { await h.cleanup(); }
});

test("install never replaces a folder that appeared after the review, and leaves Removed names free", async () => {
  const h = await setup();
  try {
    await h.publish("foo", C1, { "mods/foo/main.js": "gallery foo\n", "mods/foo/mod.json": "{}" });
    const plan = await h.hub.plan(listing("foo", C1, ["foo"]));
    assert.deepEqual(plan.mods.map((m) => [m.target, m.action]), [["foo", "new"]]);
    await write(`${h.home}/mods/foo/main.js`, "MY OWN foo");
    await assert.rejects(h.hub.install(plan), /appeared since the review opened/);
    assert.equal(await read(`${h.home}/mods/foo/main.js`), "MY OWN foo");
    assert.equal(await exists(`${h.home}/mod-hub/backups`), false);

    await h.hub.uninstall({ name: "foo", title: "Foo" }, none, all);
    const later = await h.hub.plan(listing("foo", C1, ["foo"]));
    assert.deepEqual(later.mods.map((m) => m.target), ["foo-2"], "foo is kept for its Restore");
    await later.dl.done();
  } finally { await h.cleanup(); }
});

test("an update whose move fails puts the old copy back", async () => {
  const h = await setup();
  try {
    const files = (v) => ({ "mods/g/main.js": `export default class {} // ${v}\n`, "mods/g/mod.json": "{}" });
    await h.publish("g", C1, files("v1"));
    await h.publish("g", C2, files("v2"));
    await h.hub.install(await h.hub.plan(listing("g", C1, ["g"])));
    h.deps.exec = async (cmd, args, opts) => (cmd === "mv" && args[0].includes("/ready/") ? { code: 1, stdout: "", stderr: "disk full" } : execReal(cmd, args, opts));
    await assert.rejects(h.hub.update("g", listing("g", C2, ["g"])), /disk full/);
    assert.match(await read(`${h.home}/mods/g/main.js`), /v1/);
    const s = await json(`${h.home}/mod-hub/state.json`);
    assert.equal(s.backups.g?.length ?? 0, 0);
    assert.equal(s.sources.g.commit, C1);
  } finally { await h.cleanup(); }
});

test("a failed update keeps every earlier copy", async () => {
  const h = await setup();
  try {
    const C = (n) => String(n).repeat(40);
    const files = (v) => ({ "mods/g/main.js": `export default class {} // ${v}\n`, "mods/g/mod.json": "{}" });
    for (const n of [1, 2, 3, 4, 5]) await h.publish("g", C(n), files(`v${n}`));
    await h.hub.install(await h.hub.plan(listing("g", C(1), ["g"])));
    for (const n of [2, 3, 4]) await h.hub.update("g", listing("g", C(n), ["g"]));
    const commits = async () => (await json(`${h.home}/mod-hub/state.json`)).backups.g.map((b) => b.commit[0]);
    assert.deepEqual(await commits(), ["3", "2", "1"]);
    h.deps.exec = async (cmd, args, opts) => (cmd === "mv" && args[0].includes("/ready/") ? { code: 1, stdout: "", stderr: "disk full" } : execReal(cmd, args, opts));
    await assert.rejects(h.hub.update("g", listing("g", C(5), ["g"])), /disk full/);
    assert.deepEqual(await commits(), ["3", "2", "1"]);
    assert.equal((await nfs.readdir(`${h.home}/mod-hub/backups`)).length, 3);
  } finally { await h.cleanup(); }
});

test("a mod named like Herdr's commands doesn't own them; file names survive a rename", () => {
  const keys = { global: { "cmd-t": "tab.new", "cmd-w": "tab.close", "cmd-o": "mod.open:tab" }, terminal: { "cmd-c": "terminal.copy" } };
  assert.deepEqual(strip(keys, "tab").removed.map((b) => b.keys), ["cmd-o"]);
  assert.deepEqual(strip(keys, "terminal").removed, []);
  assert.equal(renameFile('a("config.json"); b("config.refresh"); c("config.md")', "main.js", "config", "config-2"), 'a("config.json"); b("config-2.refresh"); c("config.md")');
});

test("blocks turned on in any order go back where they were; an emptied group shows again", () => {
  const T0 = row(
    { id: "side", type: "column", children: [blk("a", "A"), blk("b", "B"), blk("c", "C")] },
    { id: "dock", type: "stack", active: "q", children: [blk("p", "P"), blk("q", "Q")] },
  );
  let t = T0;
  const offA = detach(t, "A"); t = offA.tree;
  const offB = detach(t, "B", none, offA.ops); t = offB.tree;
  t = reattach(t, offA.ops).tree;
  t = reattach(t, offB.ops).tree;
  assert.deepEqual(t.children[0].children.map((c) => c.id), ["a", "b", "c"]);

  t = T0;
  const offP = detach(t, "P"); t = offP.tree;
  const offQ = detach(t, "Q", none, offP.ops); t = offQ.tree;
  assert.equal(t.children[1].hidden, true);
  t = reattach(t, offP.ops).tree;
  assert.equal(t.children[1].hidden, undefined, "P is on, so its group shows");
  t = reattach(t, offQ.ops).tree;
  assert.deepEqual(t.children[1], T0.children[1]);

  const hiddenByPerson = row({ id: "g", type: "column", hidden: true, children: [blk("p", "P")] });
  const off = detach(hiddenByPerson, "P");
  assert.deepEqual(reattach(off.tree, off.ops).tree, hiddenByPerson, "a group the person hid stays hidden");
  const older = off.ops.map(({ parentHidden, siblings, ...op }) => op);
  assert.deepEqual(reattach(off.tree, older).tree, hiddenByPerson, "so it does with a record from before");
});

test("state.json that can't be read stops every change; a missing installed.json stops the scan", async () => {
  const h = await setup();
  try {
    await write(`${h.home}/mods/x/main.js`, "x");
    await write(`${h.home}/mod-hub/state.json`, '{ "off": { "y": ');
    await assert.rejects(h.hub.turnOff("x", none, all), /state.json isn't valid JSON/);
    await assert.rejects(h.hub.tidy(), /state.json isn't valid JSON/);
    assert.equal(await read(`${h.home}/mod-hub/state.json`), '{ "off": { "y": ');
    assert.ok(await exists(`${h.home}/mods/x/main.js`));

    await nfs.rm(`${h.home}/mod-hub/state.json`);
    await nfs.rm(`${h.home}/installed.json`);
    await assert.rejects(h.hub.scan(), /installed.json can't be read/);
  } finally { await h.cleanup(); }
});

test("without keys.json, installing adds no keys rather than a file with only the mod's", async () => {
  const h = await setup();
  try {
    await nfs.rm(`${h.home}/keys.json`);
    await h.publish("k", C1, { "mods/k/main.js": "export default class {}\n", "mods/k/mod.json": "{}", "keys.json": JSON.stringify({ global: { "cmd-k": "mod.open:k" } }) });
    const r = await h.hub.install(await h.hub.plan(listing("k", C1, ["k"])));
    assert.equal(r.keys.absent, true);
    assert.equal(await exists(`${h.home}/keys.json`), false);
  } finally { await h.cleanup(); }
});

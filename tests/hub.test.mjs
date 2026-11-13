// The disk side, on a temporary Herdr home: real mv, cp, tar and curl (file:// URLs stand
// in for GitHub), Herdr's check faked. Nothing here touches ~/.config/herdr-app.
import test from "node:test";
import assert from "node:assert/strict";
import * as nfs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../mods/mod-hub/hub.js";
import { parseIndex } from "../mods/mod-hub/catalog.js";

const fsAdapter = {
  readFile: (p, enc) => (enc ? nfs.readFile(p, "utf8") : nfs.readFile(p).then((b) => new Uint8Array(b))),
  writeFile: (p, c) => nfs.writeFile(p, c),
  readdir: (p, o) => nfs.readdir(p, o),
  exists: async (p) => nfs.access(p).then(() => true, () => false),
  mkdir: (p, o) => nfs.mkdir(p, o),
  unlink: (p) => nfs.unlink(p),
  rmdir: (p) => nfs.rmdir(p),
};
const exec = async (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", timeout: opts.timeout });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || (r.error ? String(r.error) : "") };
};
const write = async (path, text) => { await nfs.mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true }); await nfs.writeFile(path, text); };
const read = (path) => nfs.readFile(path, "utf8");
const json = async (path) => JSON.parse(await read(path));
const exists = (p) => fsAdapter.exists(p);

/** A temporary Herdr home with one personal layout, keys, a shipped mod and data. */
async function setup() {
  const base = await nfs.mkdtemp(join(tmpdir(), "mod-hub-test-"));
  const home = `${base}/home`;
  await write(`${home}/installed.json`, JSON.stringify({ files: { "main.js": "x" }, "layout:main": { json: "y" } }));
  await write(`${home}/mods/files/main.js`, "export default class {}");
  await write(`${home}/layouts/main.json`, JSON.stringify({ id: "root", type: "row", children: [{ id: "files", type: "block", content: { mod: "files" } }] }));
  await write(`${home}/keys.json`, JSON.stringify({ global: { "cmd-g": "app.palette" } }, null, 2));
  const checked = [];
  let failCheck = null;
  let clock = 1_000_000;
  const repos = `${base}/repos`;
  const hub = new Hub({
    home, exec, fs: fsAdapter, now: () => clock++,
    fetch: async () => { throw new Error("no network in tests"); },
    check: async (folder) => { checked.push(folder); return failCheck && folder.endsWith(failCheck) ? { ok: false, error: "boom" } : { ok: true }; },
    urls: { tarball: (e, commit) => `file://${repos}/${e.repo}-${commit}.tgz` },
  });
  /** Publishes a repo version as a tarball the hub downloads. */
  async function publish(repo, commit, files) {
    const top = `${base}/src/${repo}-${commit}`;
    for (const [path, text] of Object.entries(files)) await write(`${top}/${path}`, text);
    await nfs.mkdir(repos, { recursive: true });
    const r = spawnSync("tar", ["-czf", `${repos}/${repo}-${commit}.tgz`, "-C", `${base}/src`, `${repo}-${commit}`]);
    assert.equal(r.status, 0);
  }
  return { base, home, hub, checked, publish, setFail: (v) => { failCheck = v; }, cleanup: () => nfs.rm(base, { recursive: true, force: true }) };
}

const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const entryAt = (commit, over = {}) => parseIndex({ mods: [{ fullName: "ann/graph", headCommit: commit, path: "", modNames: ["git-graph"], name: "git-graph", ...over }] }).entries[0];
const GRAPH_V1 = {
  "mods/git-graph/main.js": 'import { exec } from "herdr";\nexport default class G { render() { return svg("mods/git-graph/icon.svg"); } }\nexec("git", ["log"]);\n',
  "mods/git-graph/mod.json": '{ "place": "none", "title": "Git Graph", "overlay": { "kind": "dialog" } }',
  "mods/git-graph/icon.svg": "<svg/>",
  "keys.json": JSON.stringify({ global: { "cmd-g": "mod.open:git-graph", "cmd-shift-g": "git-graph.refresh" } }),
  "README.md": "readme",
};

test("install: review first, then the mod lands in mods/, keys merge without replacing, source recorded", async () => {
  const h = await setup();
  try {
    await h.publish("graph", C1, GRAPH_V1);
    const plan = await h.hub.plan(entryAt(C1));
    assert.deepEqual(plan.mods.map((m) => [m.name, m.target, m.action]), [["git-graph", "git-graph", "new"]]);
    assert.deepEqual(plan.report.programs, ["git"]);
    assert.deepEqual(plan.keys.added.map((k) => k.keys), ["cmd-shift-g"]);
    assert.deepEqual(plan.keys.kept.map((k) => k.keys), ["cmd-g"]);
    assert.equal(await exists(`${h.home}/mods/git-graph`), false, "planning changes nothing");
    const result = await h.hub.install(plan);
    assert.deepEqual(result.installed, ["git-graph"]);
    assert.ok(await exists(`${h.home}/mods/git-graph/main.js`));
    assert.ok(h.checked[0].includes("/mod-hub/staging/"), "checked in staging before it went live");
    const keys = await json(`${h.home}/keys.json`);
    assert.equal(keys.global["cmd-g"], "app.palette");
    assert.equal(keys.global["cmd-shift-g"], "git-graph.refresh");
    const state = await json(`${h.home}/mod-hub/state.json`);
    assert.equal(state.sources["git-graph"].commit, C1);
    assert.ok(state.sources["git-graph"].files["main.js"]);
    assert.equal(await exists(`${h.home}/mod-hub/staging`) && (await nfs.readdir(`${h.home}/mod-hub/staging`)).length, 0, "staging is cleaned");
  } finally { await h.cleanup(); }
});

test("install: a taken name gets a free one, renamed inside; a failed check installs nothing", async () => {
  const h = await setup();
  try {
    await write(`${h.home}/mods/git-graph/main.js`, "mine");
    await h.publish("graph", C1, GRAPH_V1);
    const plan = await h.hub.plan(entryAt(C1));
    assert.deepEqual(plan.mods.map((m) => [m.target, m.action]), [["git-graph-2", "rename"]]);
    assert.ok(plan.keys.theirs.global["cmd-shift-g"] === "git-graph-2.refresh");
    await h.hub.install(plan);
    assert.equal(await read(`${h.home}/mods/git-graph/main.js`), "mine", "the person's folder is untouched");
    assert.match(await read(`${h.home}/mods/git-graph-2/main.js`), /mods\/git-graph-2\/icon\.svg/);

    h.setFail("git-graph-3");
    const again = await h.hub.plan(entryAt(C1, { fullName: "bob/graph" }));
    await assert.rejects(h.hub.install(again), /didn't pass Herdr's check: boom/);
    assert.equal(await exists(`${h.home}/mods/git-graph-3`), false);
  } finally { await h.cleanup(); }
});

test("off and on: out of personal layouts and keys, folder parked, then everything back", async () => {
  const h = await setup();
  try {
    await h.publish("graph", C1, GRAPH_V1);
    await h.hub.install(await h.hub.plan(entryAt(C1)));
    const mine = { id: "root", type: "row", toast: "git-graph", children: [{ id: "graph", type: "block", content: { mod: "git-graph" } }, { id: "files", type: "block", content: { mod: "files" } }] };
    await write(`${h.home}/layouts/mine.json`, JSON.stringify(mine, null, 2));
    const personal = (name) => name !== "main";
    await h.hub.turnOff("git-graph", () => null, personal);
    assert.equal(await exists(`${h.home}/mods/git-graph`), false);
    assert.ok(await exists(`${h.home}/mod-hub/off/git-graph/main.js`));
    const off = await json(`${h.home}/layouts/mine.json`);
    assert.deepEqual(off.children.map((c) => c.id), ["files"]);
    assert.equal(off.toast, undefined);
    assert.equal((await json(`${h.home}/keys.json`)).global["cmd-shift-g"], undefined);
    const scan = await h.hub.scan();
    assert.deepEqual(scan.off, ["git-graph"]);

    const problems = await h.hub.turnOn("git-graph");
    assert.deepEqual(problems, []);
    assert.deepEqual(await json(`${h.home}/layouts/mine.json`), mine);
    assert.equal((await json(`${h.home}/keys.json`)).global["cmd-shift-g"], "git-graph.refresh");
    assert.ok(await exists(`${h.home}/mods/git-graph/main.js`));
  } finally { await h.cleanup(); }
});

test("uninstall goes to Removed with its data, and restores", async () => {
  const h = await setup();
  try {
    await h.publish("graph", C1, GRAPH_V1);
    await h.hub.install(await h.hub.plan(entryAt(C1)));
    await write(`${h.home}/data/git-graph/store.json`, "{}");
    const id = await h.hub.uninstall({ name: "git-graph", title: "Git Graph" }, () => null, () => true);
    assert.equal(await exists(`${h.home}/mods/git-graph`), false);
    assert.equal(await exists(`${h.home}/data/git-graph`), false);
    let state = await json(`${h.home}/mod-hub/state.json`);
    assert.equal(state.removed[0].id, id);
    assert.equal(state.sources["git-graph"], undefined);
    await h.hub.restoreRemoved(id);
    assert.ok(await exists(`${h.home}/mods/git-graph/main.js`));
    assert.ok(await exists(`${h.home}/data/git-graph/store.json`));
    state = await json(`${h.home}/mod-hub/state.json`);
    assert.equal(state.removed.length, 0);
    assert.equal(state.sources["git-graph"].commit, C1, "the gallery link comes back too");

    const again = await h.hub.uninstall({ name: "git-graph" }, () => null, () => true);
    await h.hub.purgeRemoved(again);
    assert.equal(await exists(`${h.home}/mod-hub/removed/${again}`), false);
    await assert.rejects(h.hub.uninstall({ name: "mod-hub" }, () => null, () => true), /deleting its folder/);
  } finally { await h.cleanup(); }
});

test("updates: a moved commit with the same files isn't one; changed files are; update and roll back", async () => {
  const h = await setup();
  try {
    await h.publish("graph", C1, GRAPH_V1);
    await h.hub.install(await h.hub.plan(entryAt(C1)));
    await h.publish("graph", C2, { ...GRAPH_V1, "README.md": "only the readme changed" });
    assert.deepEqual(await h.hub.checkUpdates([entryAt(C2)]), []);
    let state = await json(`${h.home}/mod-hub/state.json`);
    assert.equal(state.updates["git-graph"], undefined);
    assert.equal(state.sources["git-graph"].commit, C2, "the record follows the commit");

    await h.publish("graph", C3, { ...GRAPH_V1, "mods/git-graph/main.js": `${GRAPH_V1["mods/git-graph/main.js"]}// v3\n`, "mods/git-graph/new.svg": "<svg/>" });
    await h.hub.checkUpdates([entryAt(C3)]);
    state = await json(`${h.home}/mod-hub/state.json`);
    assert.deepEqual(state.updates["git-graph"].diff.changed, ["main.js"]);
    assert.deepEqual(state.updates["git-graph"].diff.added, ["new.svg"]);

    await h.hub.update("git-graph", entryAt(C3));
    assert.match(await read(`${h.home}/mods/git-graph/main.js`), /v3/);
    state = await json(`${h.home}/mod-hub/state.json`);
    assert.equal(state.sources["git-graph"].commit, C3);
    assert.equal(state.updates["git-graph"], undefined);
    assert.equal(state.backups["git-graph"].length, 1);

    await h.hub.rollback("git-graph");
    assert.doesNotMatch(await read(`${h.home}/mods/git-graph/main.js`), /v3/);
    state = await json(`${h.home}/mod-hub/state.json`);
    assert.equal(state.sources["git-graph"].commit, C2);
  } finally { await h.cleanup(); }
});

test("a renamed install compares updates through the same rename; link finds a hand-copied mod", async () => {
  const h = await setup();
  try {
    await write(`${h.home}/mods/git-graph/main.js`, "mine");
    await h.publish("graph", C1, GRAPH_V1);
    await h.hub.install(await h.hub.plan(entryAt(C1)));
    await h.publish("graph", C2, { ...GRAPH_V1, "README.md": "docs" });
    await h.hub.checkUpdates([entryAt(C2)]);
    const state = await json(`${h.home}/mod-hub/state.json`);
    assert.equal(state.updates["git-graph-2"], undefined, "the renamed copy matches the listing");

    // A copy made by hand, then linked: the first check settles which commit it is.
    const h2 = await setup();
    try {
      for (const [p, t] of Object.entries(GRAPH_V1)) if (p.startsWith("mods/")) await write(`${h2.home}/${p}`, t);
      await h2.publish("graph", C1, GRAPH_V1);
      await h2.hub.link("git-graph", entryAt(C1));
      await h2.hub.checkUpdates([entryAt(C1)]);
      const s2 = await json(`${h2.home}/mod-hub/state.json`);
      assert.equal(s2.sources["git-graph"].commit, C1);
      assert.equal(s2.updates["git-graph"], undefined);
    } finally { await h2.cleanup(); }
  } finally { await h.cleanup(); }
});

test("moves and deletes refuse paths outside Herdr's mods and Mods' own folder", async () => {
  const h = await setup();
  try {
    await assert.rejects(h.hub.remove(`${h.home}/layouts`), /Refused/);
    await assert.rejects(h.hub.remove(`${h.home}/mod-hub/../layouts`), /Refused/);
    await assert.rejects(h.hub.move(`${h.home}/keys.json`, `${h.home}/mod-hub/x`), /Refused/);
  } finally { await h.cleanup(); }
});

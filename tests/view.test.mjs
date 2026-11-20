// The real screen (main.js) on an in-memory element builder and a temporary Herdr home.
// Clicks go through the same handlers the app calls; files change on disk as they would.
// Native layout and drawing are checked in the app itself, not here.
import "./fakes/hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import * as nfs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: ModHub } = await import("../mods/mod-hub/main.js");

const write = async (path, text) => { await nfs.mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true }); await nfs.writeFile(path, text); };
const exists = (p) => nfs.access(p).then(() => true, () => false);
const C1 = "c".repeat(40);

function listing(i, over = {}) {
  return { fullName: `dev${i}/herdr-thing-${i}`, headCommit: C1, path: "", modNames: [`thing-${i}`], name: `thing-${i}`, blurb: `Thing number ${i}`, stars: i, pushedAt: "2026-11-01T00:00:00Z", defaultBranch: "main", hasKeys: false, ...over };
}

async function setup() {
  const base = await nfs.mkdtemp(join(tmpdir(), "mod-hub-view-"));
  const home = `${base}/home`;
  await write(`${home}/installed.json`, JSON.stringify({ files: {}, agents: {}, toast: {}, "layout:main": {} }));
  for (const m of ["files", "agents", "toast"]) await write(`${home}/mods/${m}/main.js`, "export default class {}");
  await write(`${home}/mods/${"mod-hub"}/mod.json`, '{ "title": "Mods", "overlay": {} }');
  await write(`${home}/mods/notes/main.js`, "export default class {}");
  await write(`${home}/mods/notes/mod.json`, '{ "title": "Notes", "place": "none" }');
  await write(`${home}/layouts/main.json`, JSON.stringify({ id: "root", type: "row", children: [{ id: "files", type: "block", content: { mod: "files" } }] }));
  const mine = { id: "root", type: "row", children: [{ id: "notes", type: "block", content: { mod: "notes" } }, { id: "files", type: "block", content: { mod: "files" } }] };
  await write(`${home}/layouts/mine.json`, JSON.stringify(mine, null, 2));
  await write(`${home}/keys.json`, JSON.stringify({ global: { "cmd-g": "app.palette" } }, null, 2));

  // The gallery: 30 listings, one of them git-graph (a real tarball), one with notes.
  const mods = Array.from({ length: 28 }, (_, i) => listing(i + 1));
  mods.push(listing(100, { fullName: "ann/herdr-git-graph", modNames: ["git-graph"], name: "git-graph", blurb: "Commit lanes and branches", stars: 500, hasKeys: true }));
  mods.push(listing(101, { fullName: "bob/herdr-notes", modNames: ["notes"], name: "notes", blurb: "Notes per space", stars: 3 }));
  const src = `${base}/src/herdr-git-graph-${C1}`;
  await write(`${src}/mods/git-graph/main.js`, 'import { exec } from "herdr";\nexec("git", ["log"]);\nexport default class {}\n');
  await write(`${src}/mods/git-graph/mod.json`, '{ "place": "none", "title": "Git Graph", "overlay": { "kind": "dialog" } }');
  await write(`${src}/keys.json`, JSON.stringify({ global: { "cmd-g": "mod.open:git-graph", "cmd-shift-g": "mod.open:git-graph" } }));
  const tgz = `${base}/git-graph.tgz`;
  assert.equal(spawnSync("tar", ["-czf", tgz, "-C", `${base}/src`, `herdr-git-graph-${C1}`]).status, 0);

  const harness = { home, closed: [], commands: [], opened: [], props: { overlay: "o1" }, layout: structuredClone(mine), shared: { layout: "mine" } };
  harness.exec = async (cmd, args = [], opts = {}) => {
    if (cmd === "herdr-app" && args[0] === "check") return { code: 0, stdout: "Check passed", stderr: "" };
    if (cmd === "herdr-app" && args[0] === "status") return { code: 0, stdout: JSON.stringify({ errors: [] }), stderr: "" };
    if (cmd === "open" || cmd === "xdg-open") { harness.opened.push(args); return { code: 0, stdout: "", stderr: "" }; }
    if (cmd === "curl") {
      const url = args[args.length - 1];
      if (url.startsWith("https://codeload.github.com/ann/herdr-git-graph/")) args = [...args.slice(0, -1), `file://${tgz}`];
      else if (url.startsWith("https://")) return { code: 22, stdout: "", stderr: "offline" };
    }
    const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  globalThis.__herdr = harness;
  globalThis.fetch = async (url) => {
    if (url.endsWith("/mods/index.json")) return { ok: true, status: 200, json: async () => ({ generatedAt: "2026-11-13T00:00:00Z", mods }) };
    if (url.includes("raw.githubusercontent.com/ann/herdr-git-graph")) return { ok: true, status: 200, text: async () => "# Git Graph\n\nA graph.\n\n## What you see\n\nCommit lanes.\n\n## How it behaves\n\nDouble-click checks out.\n" };
    return { ok: false, status: 404, text: async () => "" };
  };
  globalThis.localStorage = { getItem: () => null, setItem() {} };

  const tasks = [];
  const failures = [];
  const cx = {
    notify() {},
    spawn(fn) { tasks.push(Promise.resolve().then(() => fn(cx)).catch((e) => failures.push(e))); return { cancel() {}, is_done: () => false }; },
    timer: { after(ms, fn) { if (ms < 1000) setTimeout(() => fn(cx), 1); return { cancel() {} }; }, every() { return { cancel() {} }; } },
    focus_handle: () => ({ focus() {} }),
    stop_propagation() {},
    open_url(url) { harness.opened.push(url); },
  };
  const view = new ModHub();
  view.init({}, cx);
  async function settle() {
    for (let i = 0; i < 100; i++) {
      const n = tasks.length;
      await Promise.all(tasks);
      await new Promise((r) => setTimeout(r, 5));
      if (tasks.length === n) break;
    }
    assert.deepEqual(failures.map(String), []);
  }
  await settle();
  const render = () => view.render(cx);
  const click = async (id, root = render()) => {
    const node = find(root, id);
    assert.ok(node, `no element ${id}`);
    const handler = node.props.on_click ?? node.props.on_mouse_down?.[1];
    assert.ok(handler, `${id} has no click handler`);
    handler({}, cx);
    await settle();
  };
  return { base, home, view, cx, harness, render, click, settle, mine, cleanup: () => nfs.rm(base, { recursive: true, force: true }) };
}

const text = (node) => (typeof node === "string" ? node : node?.nodes ? node.nodes.map(text).join(" ") : "");
function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.props?.id === id) return node;
  for (const child of node.nodes ?? []) {
    const match = find(child, id);
    if (match) return match;
  }
  return null;
}

test("opens on Discover with the gallery as cards, popular first, 24 at a time", async () => {
  const h = await setup();
  try {
    const shown = text(h.render());
    assert.match(shown, /30 mods people share on herdr\.dev/);
    assert.match(shown, /Show more \(6 left\)/);
    assert.ok(shown.indexOf("Git Graph") < shown.indexOf("Thing 28"), "most stars first");
    assert.ok(find(h.render(), "mh-card-ann/herdr-git-graph#"));
    h.view.inputs.discover.type("lanes", h.cx);
    const filtered = text(h.render());
    assert.match(filtered, /1 mod\b/);
    assert.match(filtered, /Git Graph/);
    assert.doesNotMatch(filtered, /Thing 1\b/);
    h.view.inputs.discover.type("zzz", h.cx);
    assert.match(text(h.render()), /Nothing matches “zzz”/);
  } finally { await h.cleanup(); }
});

test("a listing's page shows its recipe for people, and installs after a review", async () => {
  const h = await setup();
  try {
    await h.click("mh-card-ann/herdr-git-graph#");
    assert.match(text(h.render()), /Commit lanes and branches/); // the recipe starts loading here
    await h.settle();
    let page = text(h.render());
    assert.match(page, /WHAT YOU SEE Commit lanes\./);
    assert.match(page, /Double-click checks out/);
    await h.click("mh-entry-install");
    page = text(h.render());
    assert.match(page, /Install Git Graph\?/);
    assert.match(page, /Runs git/);
    assert.match(page, /mods\/git-graph/);
    assert.match(page, /⇧⌘G/, "the key it adds");
    assert.match(page, /stays app\.palette/, "the key it doesn't take");
    assert.equal(await exists(`${h.home}/mods/git-graph`), false, "nothing installed before confirming");
    await h.click("mh-sheet-install");
    assert.ok(await exists(`${h.home}/mods/git-graph/main.js`));
    assert.equal(h.view.sheet, null);
    assert.deepEqual(h.view.detail, { type: "mod", name: "git-graph" });
    page = text(h.render());
    assert.match(page, /Installed Git Graph/);
    assert.match(page, /ann\/herdr-git-graph/);
    assert.match(page, /⇧⌘G/);
    await h.click("mh-snack-action");
    assert.deepEqual(h.harness.commands.at(-1), { name: "mod.open", args: { name: "git-graph" } });
    assert.deepEqual(h.harness.closed, ["o1"]);
  } finally { await h.cleanup(); }
});

test("Installed: turn a mod off and back on from its switch, with Undo", async () => {
  const h = await setup();
  try {
    await h.click("mh-nav-installed");
    let page = text(h.render());
    assert.match(page, /Notes/);
    assert.match(page, /in mine/);
    assert.doesNotMatch(page, /Agents/, "Herdr's own are under Built in");
    await h.click("mh-toggle-notes");
    assert.equal(await exists(`${h.home}/mods/notes`), false);
    const off = JSON.parse(await nfs.readFile(`${h.home}/layouts/mine.json`, "utf8"));
    assert.deepEqual(off.children.map((c) => c.id), ["files"]);
    page = text(h.render());
    assert.match(page, /Turned off Notes; it left mine/);
    assert.match(page, /TURNED OFF/);
    await h.click("mh-snack-action");
    assert.ok(await exists(`${h.home}/mods/notes/main.js`));
    assert.deepEqual(JSON.parse(await nfs.readFile(`${h.home}/layouts/mine.json`, "utf8")), h.mine);
  } finally { await h.cleanup(); }
});

test("a mod's page: where it shows, link to the gallery, remove and restore", async () => {
  const h = await setup();
  try {
    await h.click("mh-nav-installed");
    await h.click("mh-mod-notes");
    let page = text(h.render());
    assert.match(page, /mine .*the notes block/);
    assert.match(page, /bob\/herdr-notes/, "a listing with the same folder name is offered");
    await h.click("mh-cand-btn-0");
    page = text(h.render());
    assert.match(page, /linked to bob\/herdr-notes/);
    await h.click("mh-uninstall");
    assert.equal(await exists(`${h.home}/mods/notes`), false);
    assert.equal(h.view.detail, null);
    page = text(h.render());
    assert.match(page, /Removed Notes/);
    assert.match(page, /REMOVED/);
    const id = h.view.disk.state.removed[0].id;
    await h.click(`mh-restore-${id}`);
    assert.ok(await exists(`${h.home}/mods/notes/main.js`));
    assert.match(text(h.render()), /Notes is back/);
  } finally { await h.cleanup(); }
});

test("Updates and Built in", async () => {
  const h = await setup();
  try {
    await h.click("mh-nav-updates");
    let page = text(h.render());
    assert.match(page, /Nothing to check yet/);
    assert.match(page, /NOT LINKED TO THE GALLERY/);
    assert.match(page, /bob\/herdr-notes/);
    await h.click("mh-nav-builtin");
    page = text(h.render());
    assert.match(page, /Agents|agents/);
    assert.match(page, /files/);
    await h.click("mh-dup-files");
    assert.deepEqual(h.harness.commands.at(-1), { name: "mod.clone", args: { name: "files", as: "files-copy" } });
  } finally { await h.cleanup(); }
});

test("Escape steps back: picture, review, page, then closes", async () => {
  const h = await setup();
  try {
    await h.click("mh-card-ann/herdr-git-graph#");
    const esc = async () => { h.view.key({ key: "escape", keystroke: "escape" }, h.cx); await h.settle(); };
    await h.click("mh-entry-install");
    assert.ok(h.view.sheet);
    await esc();
    assert.equal(h.view.sheet, null);
    assert.equal(await exists(`${h.home}/mod-hub/staging`) && (await nfs.readdir(`${h.home}/mod-hub/staging`)).length, 0, "a cancelled review leaves no download behind");
    assert.ok(h.view.detail);
    await esc();
    assert.equal(h.view.detail, null);
    await esc();
    assert.deepEqual(h.harness.closed, ["o1"]);
  } finally { await h.cleanup(); }
});

test("Installed and mod page: Hide and Show toggle active layout visibility with Undo", async () => {
  const h = await setup();
  try {
    await h.click("mh-nav-installed");
    let page = text(h.render());
    assert.match(page, /Notes/);
    await h.click("mh-vis-notes");
    assert.deepEqual(h.harness.commands.at(-1), { name: "layout.hide", args: { id: "notes" } });
    page = text(h.render());
    assert.match(page, /Hid Notes/);
    assert.match(page, /in mine · hidden/);

    // Undo brings it back.
    await h.click("mh-snack-action");
    assert.deepEqual(h.harness.commands.at(-1), { name: "layout.show", args: { id: "notes" } });
    assert.match(text(h.render()), /Showing Notes/);

    // Mod page Shows-in row also toggles visibility.
    await h.click("mh-mod-notes");
    await h.click("mh-where-vis-0");
    assert.deepEqual(h.harness.commands.at(-1), { name: "layout.hide", args: { id: "notes" } });
    page = text(h.render());
    assert.match(page, /Hidden/);
    await h.click("mh-mod-vis");
    assert.deepEqual(h.harness.commands.at(-1), { name: "layout.show", args: { id: "notes" } });
  } finally { await h.cleanup(); }
});

test("Undo shows again only the blocks its Hide changed, not one that was already hidden", async () => {
  const h = await setup();
  try {
    h.harness.layout.children.push({ id: "notes-2", type: "block", hidden: true, content: { mod: "notes" } });
    await h.click("mh-nav-installed");
    await h.click("mh-vis-notes");
    assert.deepEqual(h.harness.commands.at(-1), { name: "layout.hide", args: { id: "notes" } });
    const before = h.harness.commands.length;
    await h.click("mh-snack-action");
    assert.deepEqual(h.harness.commands.slice(before), [{ name: "layout.show", args: { id: "notes" } }]);
    assert.equal(h.harness.layout.children.find((n) => n.id === "notes-2").hidden, true);
  } finally { await h.cleanup(); }
});

test("a collapsed sidebar opens the full Mod Hub from its icon", async () => {
  const h = await setup();
  try {
    h.harness.props = {};
    h.harness.layout = { type: "row", children: [
      { content: { tab: "active" } }, { id: "sidebar-right", size: { px: 52 }, content: { mod: "mod-hub" } },
    ] };
    h.render().props.on_size_change({ width: 52, height: 100 }, h.cx);
    assert.ok(find(h.render(), "expand"));
    assert.equal(find(h.render(), "mh-main"), null);
    await h.click("open-mod-hub");
    assert.deepEqual(h.harness.commands.at(-1), { name: "mod.open", args: { name: "mod-hub" } });
  } finally {
    await h.cleanup();
  }
});

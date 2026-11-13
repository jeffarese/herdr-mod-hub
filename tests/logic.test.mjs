// The pure modules: gallery index, layouts, keys, code review, fingerprints and names.
import test from "node:test";
import assert from "node:assert/strict";
import { parseIndex, search, sortEntries, displayName, recipeSections, forPeople, safePath, candidatesFor, ago, compact, repoUrl, tarballUrl } from "../mods/mod-hub/catalog.js";
import { references, detach, reattach, renameIn as renameLayout, describe } from "../mods/mod-hub/layouts.js";
import { normalizeKey, targets, bindingsOf, strip, restore, merge, renameIn as renameKeys, prettyKey } from "../mods/mod-hub/keys.js";
import { analyze, summary, quiet } from "../mods/mod-hub/review.js";
import { ignored, fingerprint, diff, freeName, renameInText, changedFiles } from "../mods/mod-hub/manifest.js";
import { shipped, kind, usedBy, inventory, groups, fallbackFor } from "../mods/mod-hub/inventory.js";

const SHA = "a".repeat(40);
const listing = (over = {}) => ({ fullName: "ann/herdr-git-graph", headCommit: SHA, path: "", modNames: ["git-graph"], name: "git-graph", blurb: "A git graph", stars: 5, pushedAt: "2026-11-01T00:00:00Z", previewUrl: `https://assets.herdr.dev/previews/${"b".repeat(64)}.png`, defaultBranch: "main", ...over });

test("the index keeps good listings and drops ones that could escape a folder or a URL", () => {
  const { entries } = parseIndex({ generatedAt: "2026-11-13T00:00:00Z", mods: [
    listing(),
    listing({ fullName: "evil/../x" }),
    listing({ fullName: "bob/repo", path: "../up" }),
    listing({ fullName: "bob/repo2", modNames: ["../etc", "ok"] }),
    listing({ fullName: "bob/repo3", headCommit: "main" }),
    listing({ fullName: "bob/repo4", previewUrl: "https://evil.example/x.png" }),
    listing(), // duplicate key
  ] });
  assert.deepEqual(entries.map((e) => e.key), ["ann/herdr-git-graph#", "bob/repo2#", "bob/repo4#"]);
  assert.deepEqual(entries[1].modNames, ["ok"]);
  assert.equal(entries[2].previewUrl, "");
  assert.equal(entries[0].previewFile, `${"b".repeat(64)}.png`);
  assert.equal(safePath("a/b"), true);
  assert.equal(safePath("/a"), false);
  assert.equal(safePath("a/./b"), false);
});

test("search ranks name matches over blurbs and needs every word", () => {
  const { entries } = parseIndex({ mods: [
    listing({ fullName: "a/one", name: "Notes", blurb: "keep a git log", modNames: ["notes"] }),
    listing({ fullName: "b/two", name: "git-graph", blurb: "commit lanes", modNames: ["git-graph"] }),
    listing({ fullName: "c/three", name: "Tabs", blurb: "tabs", modNames: ["tabs"] }),
  ] });
  assert.deepEqual(search(entries, "git").map((e) => e.fullName), ["b/two", "a/one"]);
  assert.deepEqual(search(entries, "git lanes").map((e) => e.fullName), ["b/two"]);
  assert.equal(search(entries, "  ").length, 3);
  assert.deepEqual(sortEntries([{ stars: 1, pushedAt: 9 }, { stars: 5, pushedAt: 1 }], "popular").map((e) => e.stars), [5, 1]);
  assert.deepEqual(sortEntries([{ stars: 1, pushedAt: 9 }, { stars: 5, pushedAt: 1 }], "updated").map((e) => e.stars), [1, 5]);
  assert.equal(displayName({ name: "herdr-git-graph" }), "Git Graph");
  assert.equal(displayName({ name: "Markdown panel" }), "Markdown panel");
  assert.equal(candidatesFor(entries, "tabs").length, 1);
  const [e] = parseIndex({ mods: [listing({ path: "mods-pack" })] }).entries;
  assert.equal(repoUrl(e), "https://github.com/ann/herdr-git-graph/tree/main/mods-pack");
  assert.equal(tarballUrl(e), `https://codeload.github.com/ann/herdr-git-graph/tar.gz/${SHA}`);
});

test("recipes split into sections, from headings or bold leads, without relative images", () => {
  const md = "# Git Graph\n\nA graph of commits.\n\n![Git Graph](preview.png)\n\n## What you see\n\nLanes.\n\n## How it behaves\n\nClicks.\n\n## Built from\n\nCode.\n";
  const r = recipeSections(md);
  assert.equal(r.intro, "A graph of commits.");
  assert.deepEqual(r.sections.map((s) => s.title), ["What you see", "How it behaves", "Built from"]);
  assert.deepEqual(forPeople(r).map((s) => s.body), ["Lanes.", "Clicks."]);
  const bold = recipeSections("Intro\n\n**What you see:** A list.\nMore.\n\n**How it behaves:**\nIt moves.");
  assert.deepEqual(bold.sections.map((s) => [s.title, s.body]), [["What you see", "A list.\nMore."], ["How it behaves", "It moves."]]);
  assert.equal(ago(Date.now() - 3 * 86400000), "3 days ago");
  assert.equal(compact(1234), "1.2k");
});

const LAYOUT = {
  id: "root", type: "row", toast: "my-toast", terminal_menu: "my-menu",
  children: [
    { id: "sidebar", type: "column", children: [
      { id: "agents", type: "block", content: { mod: "agents-plus" } },
      { id: "solo", type: "column", children: [{ id: "only", type: "block", content: { mod: "git-graph" } }] },
    ] },
    { id: "main", type: "block", content: { tab: "active", pane: { gap: 6, header: { content: { mod: "my-header" }, height: 30 } } } },
    { id: "panel", type: "stack", active: "graph", header: { mod: "git-graph" }, children: [
      { id: "files", type: "block", content: { mod: "files" } },
      { id: "graph", type: "block", content: { mod: "git-graph", props: { x: 1 } } },
    ] },
  ],
  floating: [{ id: "float", content: { mod: "git-graph" }, edge: "left" }],
};

test("references list every place a layout names a mod", () => {
  const refs = references(LAYOUT).map((r) => `${r.mod}@${r.where}:${r.id}`);
  for (const want of ["agents-plus@block:agents", "git-graph@block:only", "my-header@pane-header:main", "git-graph@stack-header:panel", "git-graph@block:graph", "git-graph@floating:float", "my-toast@toast:root", "my-menu@terminal_menu:root"]) {
    assert.ok(refs.includes(want), `${want} in ${refs}`);
  }
  assert.equal(describe({ where: "block", id: "prs" }), "the prs block");
});

test("detach takes a mod out everywhere, and reattach puts back exactly that", () => {
  const { tree, ops } = detach(LAYOUT, "git-graph");
  assert.equal(JSON.stringify(tree).includes("git-graph"), false);
  const panel = tree.children[2];
  assert.equal(panel.active, "files");
  assert.equal(panel.header, "tabs");
  assert.equal(tree.children[0].children[1].hidden, true, "an emptied group hides");
  assert.equal(tree.floating.length, 0);
  const back = reattach(tree, ops);
  assert.deepEqual(back.failed, []);
  assert.deepEqual(back.tree, LAYOUT);
});

test("detach swaps in a fallback where there is one, and root fields go", () => {
  const { tree, ops } = detach(LAYOUT, "agents-plus", () => "agents");
  assert.equal(tree.children[0].children[0].content.mod, "agents");
  assert.deepEqual(reattach(tree, ops).tree, LAYOUT);
  const toast = detach(LAYOUT, "my-toast");
  assert.equal(toast.tree.toast, undefined);
  assert.deepEqual(reattach(toast.tree, toast.ops).tree, LAYOUT);
  const header = detach(LAYOUT, "my-header");
  assert.equal(header.tree.children[1].content.pane.header, undefined);
  assert.equal(header.tree.children[1].content.pane.gap, 6);
  assert.deepEqual(reattach(header.tree, header.ops).tree, LAYOUT);
});

test("reattach leaves alone what the person changed meanwhile, and says what", () => {
  const { tree, ops } = detach(LAYOUT, "git-graph");
  tree.children.splice(2, 1); // the person deleted the panel stack
  tree.toast = "someone-else";
  const back = reattach(tree, ops);
  assert.ok(back.failed.some((f) => /panel/.test(f.why)));
  assert.ok(back.tree.floating.some((f) => f.id === "float"), "the rest still goes back");
  const swapped = detach(LAYOUT, "agents-plus", () => "agents");
  swapped.tree.children[0].children[0].content.mod = "mine";
  assert.match(reattach(swapped.tree, swapped.ops).failed[0].why, /shows something else/);
  const renamed = renameLayout(LAYOUT, "git-graph", "git-graph-2");
  assert.equal(JSON.stringify(renamed).includes('"git-graph"'), false);
});

test("keys: same key in any spelling, strip and restore, merge never replaces", () => {
  assert.equal(normalizeKey("Shift-Cmd-M"), "cmd-shift-m");
  assert.equal(normalizeKey("cmd--"), "cmd--");
  assert.equal(prettyKey("cmd-shift-m"), "⇧⌘M");
  assert.equal(prettyKey("ctrl-shift-m", false), "Ctrl+Shift+M");
  assert.ok(targets("mod.open:bar", "bar"));
  assert.ok(targets("bar.toggle", "bar"));
  assert.ok(!targets("bar.toggle", "ba"));
  assert.ok(targets({ command: "mod.open", args: { name: "bar" } }, "bar"));
  const keys = { global: { "cmd-k": "mod.open:bar", "cmd-t": "tab.new" }, "mod:bar": { "ctrl-s": "bar.save" } };
  assert.equal(bindingsOf(keys, "bar").length, 2);
  const s = strip(keys, "bar");
  assert.deepEqual(s.keys, { global: { "cmd-t": "tab.new" } });
  s.keys.global["cmd-k"] = "mod.open:picker";
  const r = restore(s.keys, s.removed);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.keys.global["cmd-k"], "mod.open:picker");
  assert.equal(r.keys["mod:bar"]["ctrl-s"], "bar.save");
  const m = merge({ global: { "cmd-shift-m": "app.palette" } }, { global: { "Shift-Cmd-M": "mod.open:x", "cmd-g": "x.go" }, "mod:x": { esc: "x.close" } });
  assert.deepEqual(m.added.map((a) => a.keys), ["cmd-g", "esc"]);
  assert.equal(m.kept[0].by, "app.palette");
  assert.equal(m.keys.global["cmd-shift-m"], "app.palette");
  assert.deepEqual(renameKeys({ global: { a: "mod.open:x", b: "x.go", c: "xy.go" }, "mod:x": {} }, "x", "x-2"), { global: { a: "mod.open:x-2", b: "x-2.go", c: "xy.go" }, "mod:x-2": {} });
});

test("the code review finds the network, programs, files and deletes, and skips comments", () => {
  const report = analyze([
    { path: "git-graph/main.js", text: [
      'import { exec, hc } from "herdr";',
      "// fetch(\"https://not-really.example\") in a comment",
      'const r = await exec("git", ["log"]);',
      'await exec("gh", ["pr", "list"]);',
      'await hc(["ls"]);',
      'const res = await fetch("https://api.github.com/repos");',
      'await exec("rm", ["-rf", dir]);',
      'const text = await readTextFile(path);',
      'const settings = home() + "/.claude/settings.json";',
    ].join("\n") },
    { path: "git-graph/icon.svg", text: "<svg>fetch(</svg>" },
  ]);
  assert.deepEqual(report.checks.map((c) => c.id), ["network", "programs", "files", "claude", "delete"]);
  assert.deepEqual(report.programs, ["gh", "git", "hc", "rm"]);
  assert.deepEqual(report.hosts, ["api.github.com"]);
  assert.equal(report.checks[0].hits[0].line, 6);
  assert.match(summary(report)[1], /^Runs gh, git, hc, rm$/);
  assert.equal(quiet(analyze([{ path: "a/main.js", text: 'import { View, div } from "gpui-kit";' }])), true);
  // Methods that share a name with what's checked aren't it.
  assert.equal(quiet(analyze([{ path: "a/main.js", text: 'const m = /x(\\d)/.exec(s);\nthis.fetch(url);\nhub.hc(1);' }])), true);
});

test("fingerprints, diffs, free names and renames inside a mod's source", () => {
  assert.equal(fingerprint("héllo"), fingerprint(new Uint8Array([104, 195, 169, 108, 108, 111])));
  assert.notEqual(fingerprint("a"), fingerprint("b"));
  assert.ok(ignored("jsconfig.json") && ignored("gpui-kit.d.ts") && ignored(".previews/x.png") && ignored("main.js.error"));
  assert.ok(!ignored("icons/x.svg"));
  const d = diff({ a: "1", b: "2", c: "3" }, { a: "1", b: "9", d: "4" });
  assert.deepEqual([d.changed, d.added, d.removed, d.count], [["b"], ["d"], ["c"], 3]);
  assert.equal(changedFiles(d), "b, d, c");
  assert.equal(freeName("x", new Set(["x", "x-2"])), "x-3");
  const src = 'svg("mods/x/icon.svg"); openOverlay({ mod: "x" }); run("mod.open", { name: "x" }); keys["a"] = "x.toggle"; const y = "mods/xy/a.svg"; "mod.open:x"';
  assert.equal(renameInText(src, "x", "x-2"), 'svg("mods/x-2/icon.svg"); openOverlay({ mod: "x-2" }); run("mod.open", { name: "x-2" }); keys["a"] = "x-2.toggle"; const y = "mods/xy/a.svg"; "mod.open:x-2"');
});

test("inventory sorts mods into groups and finds where each one shows", () => {
  const disk = {
    live: ["files", "git-graph", "notes", "agents-plus", "mod-hub"],
    off: ["old"],
    manifests: { "git-graph": { title: "Git Graph", overlay: { kind: "dialog" } }, "agents-plus": { cloned_from: { name: "agents" }, place: "left" }, old: { title: "Old" } },
    layouts: { mine: LAYOUT },
    keys: { global: { "cmd-g": "mod.open:git-graph" } },
    sources: { notes: 'openOverlay({ mod: "git-graph" })' },
    state: { sources: { "git-graph": { fullName: "ann/herdr-git-graph", path: "", commit: "1", files: { "main.js": "a" } } }, updates: { "git-graph": { commit: "2" } }, off: { old: { layouts: {} } } },
    current: { "git-graph": { "main.js": "b" } },
    entries: parseIndex({ mods: [listing({ modNames: ["git-graph", "notes"] })] }).entries,
    shippedSet: shipped({ files: {}, "layout:main": {} }),
    errors: ["mods/git-graph/main.js: boom"],
  };
  const mods = inventory(disk, "mod-hub");
  const g = mods.find((m) => m.name === "git-graph");
  assert.equal(g.kind, "window");
  assert.equal(g.update.commit, "2");
  assert.equal(g.edited.count, 1);
  assert.equal(g.layouts.length, 4);
  assert.equal(g.keys.length, 1);
  assert.deepEqual(g.usedBy, ["notes"]);
  assert.equal(g.errors.length, 1);
  assert.equal(mods.find((m) => m.name === "notes").candidates.length, 1);
  assert.equal(mods.find((m) => m.name === "files").shipped, true);
  assert.equal(kind({ place: "left" }), "panel");
  assert.deepEqual(groups(mods).map((x) => x.id), ["gallery", "local", "clones", "off"]);
  const fb = fallbackFor(mods.find((m) => m.name === "agents-plus"), new Set(["agents", "files"]));
  assert.equal(fb({ id: "x" }), "agents");
  assert.equal(fallbackFor({ name: "my-files" }, new Set(["files"]))({ id: "files" }), "files");
  assert.deepEqual(usedBy("x", { a: 'run("mod.open", { name: "x" })', b: "mod.open:xy'" }), ["a"]);
});

test("reattach drops the block Herdr placed on its own when the folder came back", () => {
  const tree = {
    id: "root",
    type: "row",
    children: [
      { id: "a1b2c3d4e5f6a7b8", type: "block", content: { mod: "side-panel" }, size: { px: 240 } },
      { id: "main", type: "block", content: { mod: "files" } },
    ],
  };
  const { tree: off, ops } = detach(tree, "side-panel");
  assert.deepEqual(off.children.map((c) => c.id), ["main"]);
  // Herdr saw the folder return and placed a fresh block first.
  const placed = { ...off, children: [{ id: "ffffeeeeddddcccc", type: "block", content: { mod: "side-panel" }, size: { px: 240 } }, ...off.children] };
  const { tree: back, failed } = reattach(placed, ops);
  assert.deepEqual(failed, []);
  assert.deepEqual(back, tree);
});

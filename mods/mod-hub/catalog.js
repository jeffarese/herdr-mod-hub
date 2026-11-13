// The gallery: the index herdr.dev/mods is built from (GitHub repos with the `herdr-mod`
// topic), parsed, searched and sorted. Pure functions, no host calls.

export const INDEX_URL = "https://assets.herdr.dev/mods/index.json";
const PREVIEWS = "https://assets.herdr.dev/previews/";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
export const MOD_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const PREVIEW_FILE = /^[0-9a-f]{16,64}\.(png|jpe?g|gif|webp)$/;

/** A repo subfolder that can't climb out of the repo: "", "a", "a/b". */
export function safePath(path) {
  if (path === "") return true;
  if (typeof path !== "string" || path.startsWith("/") || path.endsWith("/")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && /^[A-Za-z0-9_.@ +-]+$/.test(part));
}

/** One listing's key: a repo can list several folders, each its own listing. */
export const entryKey = (e) => `${e.fullName}#${e.path}`;

/**
 * The index as listings. Anything malformed is dropped: names become folder names and
 * URLs, so they're checked here once.
 */
export function parseIndex(json) {
  const raw = Array.isArray(json?.mods) ? json.mods : [];
  const entries = [];
  const seen = new Set();
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.fullName !== "string" || !REPO.test(m.fullName)) continue;
    if (typeof m.headCommit !== "string" || !COMMIT.test(m.headCommit)) continue;
    const path = typeof m.path === "string" ? m.path : "";
    if (!safePath(path)) continue;
    const modNames = Array.isArray(m.modNames) ? m.modNames.filter((n) => typeof n === "string" && MOD_NAME.test(n) && n !== "." && n !== "..") : [];
    if (!modNames.length) continue;
    const [owner, repo] = m.fullName.split("/");
    const previewName = typeof m.previewUrl === "string" && m.previewUrl.startsWith(PREVIEWS) ? m.previewUrl.slice(PREVIEWS.length) : "";
    const entry = {
      fullName: m.fullName,
      owner,
      repo,
      path,
      branch: typeof m.defaultBranch === "string" && /^[A-Za-z0-9_./-]+$/.test(m.defaultBranch) ? m.defaultBranch : "main",
      commit: m.headCommit,
      stars: Number.isFinite(m.stars) ? m.stars : 0,
      pushedAt: Date.parse(m.pushedAt) || 0,
      name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : modNames[0],
      blurb: typeof m.blurb === "string" ? m.blurb.trim() : "",
      modNames,
      hasKeys: m.hasKeys === true,
      previewUrl: PREVIEW_FILE.test(previewName) ? m.previewUrl : "",
      previewFile: PREVIEW_FILE.test(previewName) ? previewName : "",
      recipeBytes: Number.isFinite(m.recipeBytes) ? m.recipeBytes : 0,
    };
    entry.key = entryKey(entry);
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
  }
  return { generatedAt: Date.parse(json?.generatedAt) || 0, entries };
}

/** "git-graph" -> "Git Graph"; names people chose ("Markdown panel") stay as they are. */
export function displayName(e) {
  const name = e.name;
  if (/[A-Z ]/.test(name)) return name;
  const words = name.replace(/^herdr[-_]/i, "").split(/[-_]+/).filter(Boolean);
  if (!words.length) return name;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

const fold = (s) => String(s ?? "").toLowerCase();

/** Ranks a listing for a query: every word must match somewhere; the name counts most. */
function score(e, words) {
  const name = fold(`${e.name} ${e.modNames.join(" ")}`);
  const owner = fold(e.fullName);
  const blurb = fold(e.blurb);
  let total = 0;
  for (const w of words) {
    if (name.startsWith(w) || name.includes(` ${w}`) || name.includes(`-${w}`)) total += 6;
    else if (name.includes(w)) total += 4;
    else if (owner.includes(w)) total += 2;
    else if (blurb.includes(w)) total += 1;
    else return 0;
  }
  return total;
}

/** Listings matching the query, best first; ties keep `entries`' order. */
export function search(entries, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return entries;
  return entries
    .map((e, i) => ({ e, i, s: score(e, words) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.e);
}

export const SORTS = [
  { id: "popular", label: "Popular" },
  { id: "updated", label: "Recently updated" },
];

export function sortEntries(entries, sort) {
  const list = entries.slice();
  if (sort === "updated") list.sort((a, b) => b.pushedAt - a.pushedAt || b.stars - a.stars);
  else list.sort((a, b) => b.stars - a.stars || b.pushedAt - a.pushedAt);
  return list;
}

const sub = (e) => (e.path ? `${e.path}/` : "");
export const repoUrl = (e) => `https://github.com/${e.fullName}${e.path ? `/tree/${e.branch}/${e.path}` : ""}`;
export const tarballUrl = (e, commit = e.commit) => `https://codeload.github.com/${e.fullName}/tar.gz/${commit}`;
export const recipeUrl = (e) => `https://raw.githubusercontent.com/${e.fullName}/${e.commit}/${sub(e)}RECIPE.md`;
/** Where a listing's mod folders and keys.json sit inside its unpacked repo. */
export const modsDirIn = (e) => `${sub(e)}mods`;
export const keysFileIn = (e) => `${sub(e)}keys.json`;

/** Listings that contain a mod folder with this name (an install copied by hand, say). */
export function candidatesFor(entries, folder) {
  return entries.filter((e) => e.modNames.includes(folder));
}

/**
 * A recipe as an intro and its sections. Recipes use "## What you see" headings or
 * "**What you see:**" paragraphs; both are read. Relative images (preview.png) are dropped:
 * they live in the repo, not here.
 */
export function recipeSections(md) {
  const text = String(md ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/!\[[^\]]*\]\((?!https:\/\/)[^)]*\)\s*/g, "");
  const lines = text.split("\n");
  const sections = [];
  let intro = [];
  let current = null;
  for (const line of lines) {
    const heading = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    const bold = /^\*\*([^*]{2,60}?):?\*\*:?\s*(.*)$/.exec(line);
    if (heading || (bold && /^(what|how|built|watch|done)/i.test(bold[1]))) {
      current = { title: (heading ? heading[1] : bold[1]).replace(/:$/, ""), body: [] };
      if (bold && bold[2]) current.body.push(bold[2]);
      sections.push(current);
    } else if (/^#\s/.test(line)) {
      // The recipe's own title: the screen shows its name already.
    } else if (current) {
      current.body.push(line);
    } else {
      intro.push(line);
    }
  }
  const tidy = (rows) => rows.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    intro: tidy(intro),
    sections: sections.map((s) => ({ title: s.title, body: tidy(s.body) })).filter((s) => s.body),
  };
}

/** The sections a person reads before installing: what it looks like and how it behaves. */
export function forPeople(recipe) {
  return recipe.sections.filter((s) => /^(what you see|how it behaves)/i.test(s.title));
}

/** "3 min ago" style. */
export function ago(ms, now = Date.now()) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  if (d < 30) return d === 1 ? "yesterday" : `${d} days ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return mo === 1 ? "a month ago" : `${mo} months ago`;
  return "over a year ago";
}

/** 1234 -> "1.2k". */
export function compact(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}

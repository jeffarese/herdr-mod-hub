// What a mod's code can reach, read from its source before it's installed: the network,
// programs, files outside its folder. Herdr runs mods as trusted code, so the person sees
// this and decides. A reading of the source, not a sandbox: it lists what the code names.
// No host calls.

const CHECKS = [
  {
    id: "network",
    title: "Reaches the network",
    patterns: [/(?:^|[^.\w$])fetch\s*\(/, /\bWebSocket\b/, /from\s+["'](net|websocket)["']/, /(?:^|[^.\w$])exec\s*\(\s*["'`](curl|wget)["'`]/],
  },
  {
    id: "programs",
    title: "Runs programs",
    patterns: [/(?:^|[^.\w$])exec\s*\(/, /(?:^|[^.\w$])hc\s*\(/],
  },
  {
    id: "files",
    title: "Reads or writes files",
    patterns: [/\b(readTextFile|writeTextFile|watchFolder|pickFolder)\s*\(/, /from\s+["']fs\/promises["']/, /\bfs\.(readFile|writeFile|unlink|rmdir|mkdir)\s*\(/],
  },
  {
    id: "claude",
    title: "Touches Claude Code settings",
    patterns: [/\.claude\b/],
  },
  {
    id: "delete",
    title: "Deletes files",
    patterns: [/(?:^|[^.\w$])exec\s*\(\s*["'`]rm["'`]/, /\brm\s+-[a-z]*r[a-z]*f?\b/, /\b(unlink|rmdir)\s*\(/],
  },
];

// Calls of exec itself, not of a method that shares its name (/re/.exec(text)).
const PROGRAM = /(?:^|[^.\w$])exec\s*\(\s*(["'`])([A-Za-z0-9_./-]+)\1/g;
const HOSTS = /https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
// Comments are skipped, roughly: whole-line // and lines inside /* */ blocks.
const commentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

const SCRIPT = /\.(m?js|cjs|ts)$/;

/**
 * Reads code a piece at a time, then reports. Herdr stops a script that runs for half a second,
 * so a big listing is read in pieces with a pause between them (the hub does the pausing).
 */
export class Review {
  constructor() {
    this.checks = CHECKS.map((c) => ({ id: c.id, title: c.title, hits: [] }));
    this.programs = new Set();
    this.hosts = new Set();
    this.lines = 0;
    this.scripts = 0;
  }

  /** Whether a file is code this reads. */
  static reads(path) {
    return SCRIPT.test(path);
  }

  /** Lines of one file, the first of them being line `first` (1-based). */
  add(path, rows, first = 1) {
    if (!SCRIPT.test(path)) return;
    if (first === 1) this.scripts++;
    this.lines += rows.length;
    rows.forEach((row, i) => {
      if (commentLine(row)) return;
      CHECKS.forEach((c, k) => {
        if (c.patterns.some((p) => p.test(row))) this.checks[k].hits.push({ path, line: first + i, text: row.trim().slice(0, 160) });
      });
      for (const m of row.matchAll(PROGRAM)) this.programs.add(m[2].split("/").pop());
      for (const m of row.matchAll(HOSTS)) if (!/^(www\.)?w3\.org$/.test(m[1])) this.hosts.add(m[1]);
    });
  }

  /**
   * { checks: [{ id, title, hits: [{ path, line, text }] }], programs: [...], hosts: [...],
   *   scripts, lines }.
   */
  report() {
    const programs = new Set(this.programs);
    // "hc(...)" is herdr-core: say so by name.
    if (this.checks[1].hits.some((h) => /(?:^|[^.\w$])hc\s*\(/.test(h.text))) programs.add("hc");
    return {
      checks: this.checks.filter((c) => c.hits.length),
      programs: [...programs].sort(),
      hosts: [...this.hosts].sort(),
      scripts: this.scripts,
      lines: this.lines,
    };
  }
}

/** files: [{ path, text }] (a mod folder's .js/.mjs files), read at once. */
export function analyze(files) {
  const review = new Review();
  for (const file of files ?? []) review.add(file.path, String(file.text ?? "").split("\n"));
  return review.report();
}

/** One line for each thing it can do, for a summary: "Runs git, gh". */
export function summary(report) {
  return report.checks.map((c) => {
    if (c.id === "programs" && report.programs.length) return `Runs ${list(report.programs)}`;
    if (c.id === "network" && report.hosts.length) return `Reaches ${list(report.hosts)}`;
    return c.title;
  });
}

function list(items, max = 4) {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/** True when nothing beyond drawing and Herdr's own commands was found. */
export const quiet = (report) => report.checks.length === 0;

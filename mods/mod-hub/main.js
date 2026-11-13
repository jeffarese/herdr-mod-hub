// Mods: one screen for every Herdr mod. Discover what people share on herdr.dev, install
// after reading what the code can reach, see where each installed mod shows, turn mods off
// and on, update them, roll back, remove with undo. Herdr's own mods are listed too.
//
// The screen only draws and asks; hub.js does every change on disk.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, TextView } from "gpui-base";
import { appHome, exec, theme, props, closeOverlay, run, readTextFile, writeTextFile, settings, watchFolder, window as herdrWindow } from "herdr";
import * as fs from "fs/promises";
import { Hub, SELF, rollbackFor } from "./hub.js";
import { search, sortEntries, SORTS, displayName, repoUrl, recipeSections, forPeople, ago, compact, entryKey } from "./catalog.js";
import { inventory, groups, fallbackFor, KIND_WORDS } from "./inventory.js";
import { summary, quiet } from "./review.js";
import { changedFiles } from "./manifest.js";
import { prettyKey } from "./keys.js";
import { describe } from "./layouts.js";
import { I, CLEAR, alpha, icon, spinner, tones, button, iconButton, link, toggle, chip, dot, heading, tile, skeleton, fact, notice } from "./ui.js";

const RAIL = 200;
const PAGE = 24; // cards drawn before "Show more"
const CARD_MIN = 228;
const GAP = 14;
const INDEX_FRESH = 30 * 60 * 1000;
const CHECK_EVERY = 6 * 60 * 60 * 1000;
const PREVIEW_JOBS = 6;
const SNACK_MS = 7000;

const PAGES = [
  { id: "discover", title: "Discover", glyph: "compass" },
  { id: "installed", title: "Installed", glyph: "package" },
  { id: "updates", title: "Updates", glyph: "refresh" },
  { id: "builtin", title: "Built in", glyph: "box" },
];

const PLACEHOLDERS = { discover: "Search the gallery", installed: "Filter your mods", builtin: "Filter Herdr's mods" };

// Per-viewer conveniences only (the page last shown, the sort). Storage may be missing.
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not kept */ } },
};

const SIDES = { left: "on the left", right: "on the right", top: "at the top", bottom: "at the bottom" };
/** Where a mod shows the moment it's installed: Herdr docks one with a `place` in the shown layout. */
const arrival = (manifest) => {
  if (SIDES[manifest?.place]) return `docks ${SIDES[manifest.place]} of your layout right away`;
  if (manifest?.overlay) return "opens as a window when you ask";
  return null;
};

const message = (e) => String(e?.message ?? e).trim();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (commit) => (commit ? commit.slice(0, 7) : "unknown");

export default class ModHub extends View {
  init(_props, cx) {
    const home = appHome();
    this.hub = new Hub({
      home,
      exec,
      fs,
      fetch: (url, opts) => fetch(url, opts),
      writeText: writeTextFile,
      readText: (path) => readTextFile(path),
      check: async (folder) => {
        const r = await exec("herdr-app", ["check", folder], { timeout: 60000 });
        return { ok: r.code === 0, error: (r.stderr || r.stdout || "").trim().split("\n").slice(-4).join("\n") };
      },
    });
    const asked = props()?.page;
    this.page = PAGES.some((p) => p.id === asked) ? asked : store.get("mod-hub.page", "discover");
    this.detail = null; // { type: "entry", key } | { type: "mod", name }
    this.sheet = null; // the install review, or a question
    this.lightbox = null; // a preview shown full size
    this.snack = null; // { id, text, tone, action }
    this.index = null;
    this.indexState = "loading";
    this.indexError = null;
    this.disk = null;
    this.mods = [];
    this.errors = [];
    this.previews = {}; // listing key -> image path | "loading" | "none"
    this.previewQueue = [];
    this.previewsRunning = 0;
    this.recipes = {}; // listing key -> { state, recipe, error }
    this.busy = {}; // mod name or listing key -> true
    this.jobs = 0; // changes running: the folder watcher waits for them
    this.expanded = {};
    this.sort = store.get("mod-hub.sort", "popular");
    this.shown = PAGE;
    this.width = 760;
    this.height = 600;
    this.checking = null;
    this.checkProblems = [];
    this.snacks = 0;
    this.queries = {};
    this.inputs = {};
    for (const id of Object.keys(PLACEHOLDERS)) {
      const input = InputState.new({ placeholder: PLACEHOLDERS[id] });
      input.on("change", (_e, cx) => {
        this.queries[id] = input.value();
        this.shown = PAGE;
        cx.notify();
      });
      input.on("focus", (_e, cx) => { this.searching = true; cx.notify(); });
      input.on("blur", (_e, cx) => { this.searching = false; cx.notify(); });
      this.inputs[id] = input;
    }
    this.handle = cx.focus_handle();
    this.handle.focus();

    cx.spawn(async (cx) => {
      let step = "reading the gallery cache";
      try {
        const cached = await this.hub.cachedIndex().catch(() => null);
        if (cached) {
          this.index = cached;
          this.indexState = "ready";
        }
        step = "reading your mods";
        await this.hub.tidy();
        await this.rescan();
        cx.notify();
        step = "fetching the gallery";
        if (!cached || Date.now() - cached.fetchedAt > INDEX_FRESH) await this.refreshIndex(cx);
        step = "asking Herdr for errors";
        this.errors = await this.hub.errors();
        this.rebuild();
        cx.notify();
        step = "cleaning old downloads";
        await this.hub.cleanStaging();
        step = "looking for updates";
        if (this.dueForCheck()) await this.checkUpdates(cx);
      } catch (e) {
        this.loadError = `Stopped while ${step}: ${message(e)}`;
        if (this.indexState === "loading" && !this.index) this.indexState = "error";
        cx.notify();
      }
    });
    // Mods added or removed some other way (an agent, a terminal) show up here too.
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          await watchFolder(`${home}/mods`);
        } catch {
          return;
        }
        await this.delay(cx, 600);
        if (this.jobs > 0) continue;
        await this.rescan().catch(() => {});
        cx.notify();
      }
    });
  }

  delay(cx, ms) {
    return new Promise((resolve) => cx.timer.after(ms, () => resolve()));
  }

  // Data ------------------------------------------------------------------------------------

  async rescan() {
    this.disk = await this.hub.scan();
    this.rebuild();
  }

  rebuild() {
    if (!this.disk) return;
    this.mods = inventory({ ...this.disk, entries: this.index?.entries ?? [], errors: this.errors }, SELF);
    this.byEntry = new Map();
    for (const m of this.mods) {
      if (!m.source) continue;
      const key = `${m.source.fullName}#${m.source.path}`;
      if (!this.byEntry.has(key)) this.byEntry.set(key, []);
      this.byEntry.get(key).push(m);
    }
  }

  async refreshIndex(cx) {
    if (!this.index) this.indexState = "loading";
    this.indexError = null;
    this.refreshing = true;
    cx.notify();
    try {
      this.index = await this.hub.fetchIndex();
      this.indexState = "ready";
      this.rebuild();
    } catch (e) {
      this.indexError = message(e);
      if (!this.index) this.indexState = "error";
    }
    this.refreshing = false;
    cx.notify();
  }

  dueForCheck() {
    const sources = Object.keys(this.disk?.state?.sources ?? {});
    return Boolean(this.index && sources.length && Date.now() - (this.disk.state.checkedAt ?? 0) > CHECK_EVERY);
  }

  async checkUpdates(cx) {
    if (!this.index || this.checking) return;
    this.checking = "Looking for updates…";
    cx.notify();
    try {
      this.checkProblems = await this.hub.checkUpdates(this.index.entries, (name) => {
        this.checking = `Looking at ${name}…`;
        cx.notify();
      });
    } catch (e) {
      this.checkProblems = [message(e)];
    }
    this.checking = null;
    await this.rescan().catch(() => {});
    cx.notify();
  }

  entry(key) {
    return this.index?.entries.find((e) => e.key === key) ?? null;
  }

  mod(name) {
    return this.mods.find((m) => m.name === name) ?? null;
  }

  /** Every mod that will still be there: what a turned-off one can fall back to. */
  available(except) {
    const names = new Set([...(this.disk?.shippedSet.mods ?? []), ...this.mods.filter((m) => m.enabled).map((m) => m.name)]);
    names.delete(except);
    return names;
  }

  personal() {
    const shipped = this.disk?.shippedSet.layouts ?? new Set();
    return (layout) => !shipped.has(layout);
  }

  // Actions ---------------------------------------------------------------------------------

  /** Runs a change with `id` marked busy; refreshes and reports when it's done. */
  act(id, cx, job, done = null) {
    this.busy[id] = true;
    this.jobs++;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await job();
        await this.rescan();
        this.errors = await this.hub.errors();
        this.rebuild();
        if (done) done(result, cx);
      } catch (e) {
        this.flash(cx, message(e), { tone: "bad" });
        await this.rescan().catch(() => {});
      } finally {
        delete this.busy[id];
        this.jobs--;
        cx.notify();
      }
    });
  }

  flash(cx, text, opts = {}) {
    const id = ++this.snacks;
    this.snack = { id, text, tone: opts.tone ?? "ok", action: opts.action ?? null };
    cx.notify();
    cx.timer.after(opts.ms ?? SNACK_MS, (cx) => {
      if (this.snack?.id === id) {
        this.snack = null;
        cx.notify();
      }
    });
  }

  setOff(m, cx) {
    this.act(m.name, cx, () => this.hub.turnOff(m.name, fallbackFor(m, this.available(m.name)), this.personal()), (record, cx) => {
      const left = Object.entries(record.layouts).map(([l]) => l);
      this.flash(cx, `Turned off ${m.title}${left.length ? `; it left ${left.join(", ")}` : ""}`, {
        action: { label: "Undo", run: (cx) => this.setOn(m, cx) },
      });
    });
  }

  setOn(m, cx) {
    this.act(m.name, cx, () => this.hub.turnOn(m.name), (problems, cx) => {
      if (problems.length) this.flash(cx, `Turned on ${m.title}, but not everything went back: ${problems.join("; ")}`, { tone: "warn", ms: 12000 });
      else this.flash(cx, `Turned on ${m.title}`);
    });
  }

  uninstall(m, cx) {
    this.act(m.name, cx, () => this.hub.uninstall(m, fallbackFor(m, this.available(m.name)), this.personal()), (id, cx) => {
      if (this.detail?.name === m.name) this.detail = null;
      this.flash(cx, `Removed ${m.title}`, { action: { label: "Undo", run: (cx) => this.restore(id, m.title, cx) } });
    });
  }

  restore(id, title, cx) {
    this.act(`removed-${id}`, cx, () => this.hub.restoreRemoved(id), (problems, cx) => {
      if (problems.length) this.flash(cx, `${title} is back, but: ${problems.join("; ")}`, { tone: "warn", ms: 12000 });
      else this.flash(cx, `${title} is back`);
    });
  }

  purge(r, cx) {
    this.act(`removed-${r.id}`, cx, () => this.hub.purgeRemoved(r.id), (_r, cx) => this.flash(cx, `Deleted ${r.title} for good`));
  }

  update(m, cx) {
    const e = m.entry;
    if (!e) return;
    this.act(m.name, cx, () => this.hub.update(m.name, e), (r, cx) => {
      const extra = r.keys.absent ? "; keys.json isn't there, so its new keys weren't added" : r.keys.added.length ? ` and added ${plural(r.keys.added.length, "key")}` : "";
      this.flash(cx, `Updated ${m.title} to ${short(e.commit)}${extra}`, { action: { label: "Roll back", run: (cx) => this.rollback(m, cx) } });
    });
  }

  updateAll(cx) {
    const list = this.mods.filter((m) => m.update && m.entry && !m.update.gone);
    if (!list.length) return;
    this.act("update-all", cx, async () => {
      const failed = [];
      for (const m of list) {
        this.busy[m.name] = true;
        try {
          await this.hub.update(m.name, m.entry);
        } catch (e) {
          failed.push(`${m.title}: ${message(e)}`);
        }
        delete this.busy[m.name];
      }
      return failed;
    }, (failed, cx) => {
      if (failed.length) this.flash(cx, `Some updates didn't go in: ${failed.join("; ")}`, { tone: "bad", ms: 12000 });
      else this.flash(cx, `Updated ${plural(list.length, "mod")}`);
    });
  }

  rollback(m, cx) {
    const b = rollbackFor(this.disk?.state, m.name);
    const what = b?.undone ? "the copy you rolled back from" : "the copy before its update";
    this.act(m.name, cx, () => this.hub.rollback(m.name), (_r, cx) => this.flash(cx, `${m.title} is back to ${what}`, { action: { label: "Undo", run: (cx) => this.rollback(m, cx) } }));
  }

  putBack(m, cx) {
    this.act(m.name, cx, () => this.hub.putBack(m.name), (problems, cx) => {
      if (problems.length) this.flash(cx, `Still couldn't put everything back: ${problems.join("; ")}`, { tone: "warn", ms: 12000 });
      else this.flash(cx, `${m.title} is back in its places`);
    });
  }

  link(m, e, cx) {
    this.act(m.name, cx, async () => {
      await this.hub.link(m.name, e);
      await this.hub.checkUpdates(this.index?.entries ?? []);
    }, (_r, cx) => this.flash(cx, `${m.title} is linked to ${e.fullName}`));
  }

  unlink(m, cx) {
    this.act(m.name, cx, () => this.hub.unlink(m.name), (_r, cx) => this.flash(cx, `${m.title} is no longer linked to the gallery`));
  }

  duplicate(m, cx) {
    const taken = new Set([...this.mods.map((x) => x.name), ...(this.disk?.off ?? [])]);
    let as = `${m.name}-copy`;
    for (let i = 2; taken.has(as); i++) as = `${m.name}-copy-${i}`;
    this.act(m.name, cx, async () => {
      run("mod.clone", { name: m.name, as });
      for (let i = 0; i < 20 && !(await fs.exists(`${appHome()}/mods/${as}`)); i++) await new Promise((r) => cx.timer.after(150, () => r()));
    }, (_r, cx) => {
      this.page = "installed";
      this.detail = { type: "mod", name: as };
      this.flash(cx, `Made ${as}, a copy of ${m.title} you can change`);
    });
  }

  openMod(m) {
    closeOverlay(props().overlay);
    if (m.overlay) run("mod.open", { name: m.name });
    else run("pane.split", { direction: "right", mod: m.name });
  }

  reveal(path) {
    const mac = herdrWindow()?.platform === "macos";
    exec(mac ? "open" : "xdg-open", mac ? ["-R", path] : [path.split("/").slice(0, -1).join("/")]).catch(() => null);
  }

  folderOf(m) {
    return `${appHome()}/${m.enabled ? "mods" : "mod-hub/off"}/${m.name}`;
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(page, cx) {
    this.page = page;
    this.detail = null;
    this.shown = PAGE;
    store.set("mod-hub.page", page);
    this.handle.focus();
    if (page === "updates" && this.dueForCheck()) cx.spawn(async (cx) => this.checkUpdates(cx));
    cx.notify();
  }

  // Install ---------------------------------------------------------------------------------

  startInstall(e, cx) {
    const sheet = { type: "install", entry: e, phase: "loading", plan: null, error: null, picked: new Set(e.modNames) };
    this.sheet = sheet;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const plan = await this.hub.plan(e);
        if (this.sheet !== sheet) return plan.dl.done();
        sheet.plan = plan;
        sheet.picked = new Set(plan.mods.map((m) => m.name));
        sheet.phase = plan.mods.length ? "ready" : "error";
        if (!plan.mods.length) sheet.error = `${e.fullName} doesn't have the mod folders its listing names (${e.modNames.join(", ")}).`;
      } catch (err) {
        sheet.phase = "error";
        sheet.error = message(err);
      }
      cx.notify();
    });
  }

  cancelSheet(cx) {
    const s = this.sheet;
    if (!s || s.phase === "installing") return;
    if (s.plan && s.phase !== "done") s.plan.dl.done();
    this.sheet = null;
    this.handle.focus();
    cx.notify();
  }

  confirmInstall(cx) {
    const s = this.sheet;
    if (!s?.plan || s.phase !== "ready") return;
    const plan = { ...s.plan, mods: s.plan.mods.filter((m) => s.picked.has(m.name)) };
    if (!plan.mods.length) return;
    s.phase = "installing";
    this.jobs++;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await this.hub.install(plan);
        s.phase = "done";
        await this.rescan();
        this.errors = await this.hub.errors();
        this.rebuild();
        this.sheet = null;
        const first = this.mod(result.installed[0]);
        this.page = "installed";
        this.detail = first ? { type: "mod", name: first.name } : null;
        const names = result.installed.map((n) => this.mod(n)?.title ?? n);
        const action = first?.enabled && first.overlay ? { label: "Open", run: () => this.openMod(first) } : null;
        const keys = result.keys.absent ? "; keys.json isn't there, so its keys weren't added" : "";
        this.flash(cx, `Installed ${names.join(", ")}${keys}`, { action, tone: keys ? "warn" : "ok" });
      } catch (err) {
        s.phase = "error";
        s.error = message(err);
        await this.rescan().catch(() => {});
      }
      this.jobs--;
      cx.notify();
    });
  }

  // Previews and recipes ---------------------------------------------------------------------

  previewFor(e, cx) {
    const state = this.previews[e.key];
    if (state === undefined) {
      if (!e.previewFile) {
        this.previews[e.key] = "none";
        return null;
      }
      this.previews[e.key] = "loading";
      this.previewQueue.push(e);
      this.pumpPreviews(cx);
      return null;
    }
    return state === "loading" || state === "none" ? null : state;
  }

  pumpPreviews(cx) {
    while (this.previewsRunning < PREVIEW_JOBS && this.previewQueue.length) {
      const e = this.previewQueue.shift();
      this.previewsRunning++;
      cx.spawn(async (cx) => {
        const path = await this.hub.preview(e).catch(() => null);
        this.previews[e.key] = path ?? "none";
        this.previewsRunning--;
        this.pumpPreviews(cx);
        cx.notify();
      });
    }
  }

  recipeFor(e, cx) {
    const r = this.recipes[e.key];
    if (r) return r;
    const fresh = { state: "loading" };
    this.recipes[e.key] = fresh;
    cx.spawn(async (cx) => {
      try {
        const md = await this.hub.recipe(e);
        Object.assign(fresh, { state: "ready", md, parsed: recipeSections(md) });
      } catch (err) {
        Object.assign(fresh, { state: "error", error: message(err) });
      }
      cx.notify();
    });
    return fresh;
  }

  /** A mod's tile picture: its listing's preview, once downloaded. */
  pictureOf(m, cx) {
    return m.entry ? this.previewFor(m.entry, cx) : null;
  }

  // Keys ------------------------------------------------------------------------------------

  key(e, cx) {
    const k = e.keystroke ?? e.key;
    if (k === "escape") {
      if (this.lightbox) this.lightbox = null;
      else if (this.sheet) return this.cancelSheet(cx);
      else if (this.detail) this.detail = null;
      else return this.close();
      this.handle.focus();
    } else if ((k === "cmd-f" || (k === "/" && !this.searching)) && this.inputs[this.page] && !this.detail) {
      this.inputs[this.page].focus();
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  // Render ----------------------------------------------------------------------------------

  render(cx) {
    const t = theme();
    const key = this.detail ? `${this.detail.type}-${this.detail.key ?? this.detail.name}` : this.page;
    return h_flex()
      .id("mod-hub")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => {
        // Sizes come zoomed (Herdr's zoom setting); lengths set here are zoomed after.
        const zoom = Number(settings()?.zoom) || 1;
        const width = size.width / zoom - RAIL;
        const height = size.height / zoom;
        if (Math.abs(width - this.width) < 1 && Math.abs(height - this.height) < 1) return;
        this.width = width;
        this.height = height;
        cx.notify();
      })
      .size_full()
      .min_h(0)
      .items_start()
      .child(this.rail(t, cx))
      .child(
        div()
          .id("mh-main")
          .relative()
          .flex_1()
          .min_w(0)
          .h_full()
          .child(
            div()
              .id(`mh-body-${key}`)
              .size_full()
              .overflow_y_scroll()
              .child(div().px(28).pt(20).pb(48).child(this.body(t, cx))),
          )
          .child(Scrollbar.vertical(`mh-body-${key}`).absolute().inset_0())
          .when(Boolean(this.sheet), (el) => el.child(this.sheetView(t, cx)))
          .when(Boolean(this.lightbox), (el) => el.child(this.lightboxView(t)))
          .when(Boolean(this.snack), (el) => el.child(this.snackView(t))),
      );
  }

  body(t, cx) {
    if (this.loadError) {
      return v_flex().w_full().gap(16).child(notice(t, tones(t).bad, "alert", "Mods couldn't finish loading", this.loadError)).child(this.page_(t, cx));
    }
    return this.page_(t, cx);
  }

  page_(t, cx) {
    if (this.detail?.type === "entry") {
      const e = this.entry(this.detail.key);
      if (e) return this.entryPage(t, e, cx);
    }
    if (this.detail?.type === "mod") {
      const m = this.mod(this.detail.name);
      if (m) return this.modPage(t, m, cx);
      if (!this.disk) return this.loadingRows(t);
    }
    switch (this.page) {
      case "installed": return this.installedPage(t, cx);
      case "updates": return this.updatesPage(t, cx);
      case "builtin": return this.builtinPage(t, cx);
      default: return this.discoverPage(t, cx);
    }
  }

  // The rail ------------------------------------------------------------------------------

  rail(t, cx) {
    const mine = this.mods.filter((m) => !m.shipped);
    const updates = this.mods.filter((m) => m.update).length;
    const counts = { installed: mine.length || null, updates: updates || null, builtin: this.mods.filter((m) => m.shipped).length || null };
    const index = this.index;
    return v_flex()
      .flex_none()
      .w(RAIL)
      .h_full()
      .p(10)
      .gap(2)
      .border_r(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(9)
          .px(10)
          .pt(6)
          .pb(14)
          .items_center()
          .child(icon("puzzle", 17, t.accent))
          .child(div().text_size(16).font_semibold().text_color(t.foreground).child("Mods")),
      )
      .children(
        PAGES.map((p) => {
          const on = this.page === p.id && !this.detail;
          const within = this.page === p.id;
          const n = counts[p.id];
          return h_flex()
            .id(`mh-nav-${p.id}`)
            .gap(10)
            .px(10)
            .py(7)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .bg(on ? t.raised : CLEAR)
            .hover((s) => s.bg(t.raised))
            .on_click((_e, cx) => this.go(p.id, cx))
            .child(icon(p.glyph, 15, within ? t.accent : t.dim))
            .child(div().flex_1().text_size(13.5).text_color(within ? t.foreground : t.muted).child(p.title))
            .when(p.id === "updates" && Boolean(this.checking), (el) => el.child(spinner(12, t.dim)))
            .when(p.id === "updates" && !this.checking && Boolean(n), (el) =>
              el.child(div().px(6).h(18).rounded(9).bg(t.accent).text_color(t.accent_foreground).text_size(11).font_semibold().flex().items_center().child(String(n))))
            .when(p.id !== "updates" && Boolean(n), (el) => el.child(div().text_size(12).text_color(t.dim).child(String(n))));
        }),
      )
      .child(div().flex_1())
      .child(
        v_flex()
          .gap(6)
          .px(10)
          .pt(10)
          .border_t(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                v_flex()
                  .flex_1()
                  .min_w(0)
                  .gap(1)
                  .child(div().text_size(12).text_color(t.muted).truncate().child(index ? `Gallery: ${compact(index.entries.length)} mods` : this.indexState === "error" ? "Gallery offline" : "Loading the gallery…"))
                  .child(div().text_size(11.5).text_color(this.indexError ? tones(t).warn : t.dim).truncate().child(this.indexError ? "Couldn't refresh" : index ? `Updated ${ago(index.fetchedAt)}` : "")),
              )
              .child(iconButton(t, "mh-refresh-index", "refresh", "Refresh the gallery", (_e, cx) => cx.spawn(async (cx) => this.refreshIndex(cx)), { size: 26, busy: this.refreshing })),
          )
          .child(div().text_size(12).child(link(t, "mh-open-folder", "Open the mods folder", () => this.reveal(`${appHome()}/mods/${SELF}`), t.dim))),
      );
  }

  // Shared page pieces ------------------------------------------------------------------------

  header(t, title, subtitle, right = null) {
    return h_flex()
      .w_full()
      .gap(12)
      .items_start()
      .pb(16)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(4)
          .child(div().text_size(21).font_semibold().text_color(t.foreground).child(title))
          .when(Boolean(subtitle), (el) => el.child(div().text_size(13).text_color(t.dim).child(subtitle))),
      )
      .when(Boolean(right), (el) => el.child(h_flex().flex_none().gap(8).items_center().child(right)))
      .child(iconButton(t, "mh-close", "x", "Close (Esc)", () => this.close(), { size: 28 }));
  }

  back(t, label, cx) {
    return h_flex()
      .id("mh-back")
      .w_full()
      .pb(14)
      .items_center()
      .justify_between()
      .child(
        h_flex()
          .id("mh-back-link")
          .gap(6)
          .items_center()
          .px(6)
          .py(3)
          .ml(-6)
          .rounded(6)
          .cursor_pointer()
          .text_size(13)
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            this.detail = null;
            this.handle.focus();
            cx.notify();
          })
          .child(icon("arrow-left", 14))
          .child(label),
      )
      .child(iconButton(t, "mh-close", "x", "Close (Esc)", () => this.close(), { size: 28 }));
  }

  searchField(t, id, extra = null) {
    const input = this.inputs[id];
    const q = this.queries[id] ?? "";
    return h_flex()
      .w_full()
      .gap(10)
      .items_center()
      .pb(18)
      .child(
        h_flex()
          .id(`mh-search-${id}`)
          .flex_1()
          .min_w(0)
          .h(34)
          .px(10)
          .gap(8)
          .items_center()
          .rounded(8)
          .border_1()
          .border_color(this.searching ? t.accent : t.input ?? t.border)
          .bg(t.surface)
          .on_click(() => input.focus())
          .child(icon("search", 15, t.dim))
          .child(div().flex_1().min_w(0).text_size(13.5).child(Input.new(input).h(30).text_color(t.foreground)))
          .when(Boolean(q), (el) =>
            el.child(iconButton(t, `mh-clear-${id}`, "x", "Clear", (_e, cx) => {
              input.set_value("");
              this.queries[id] = "";
              cx.notify();
            }, { size: 22 }))),
      )
      .when(Boolean(extra), (el) => el.child(extra));
  }

  segmented(t, id, options, value, onPick) {
    return h_flex()
      .flex_none()
      .h(34)
      .p(3)
      .gap(2)
      .rounded(8)
      .bg(t.raised)
      .children(
        options.map((o) =>
          div()
            .id(`${id}-${o.id}`)
            .px(10)
            .h_full()
            .flex()
            .items_center()
            .rounded(6)
            .text_size(12.5)
            .cursor_pointer()
            .bg(o.id === value ? t.background : CLEAR)
            .when(o.id === value, (el) => el.shadow_sm())
            .text_color(o.id === value ? t.foreground : t.muted)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => onPick(o.id, cx))
            .child(o.label),
        ),
      );
  }

  empty(t, glyph, title, body, action = null) {
    return v_flex()
      .w_full()
      .py(56)
      .gap(10)
      .items_center()
      .child(div().w(52).h(52).rounded(26).bg(t.raised).flex().items_center().justify_center().child(icon(glyph, 24, t.dim)))
      .child(div().text_size(15).font_medium().text_color(t.foreground).child(title))
      .when(Boolean(body), (el) => el.child(div().max_w(420).text_center().text_size(13).line_height("19px").text_color(t.dim).child(body)))
      .when(Boolean(action), (el) => el.child(div().pt(6).child(action)));
  }

  loadingRows(t) {
    return v_flex().gap(10).pt(8).children([0, 1, 2, 3].map(() => h_flex().gap(12).items_center().child(skeleton(t, 36, 36, 9)).child(v_flex().gap(6).flex_1().child(skeleton(t, 180, 12)).child(skeleton(t, 280, 10)))));
  }

  get contentWidth() {
    return Math.max(280, this.width - 56 - 6);
  }

  // Discover ------------------------------------------------------------------------------

  discoverPage(t, cx) {
    const all = this.index?.entries ?? [];
    const q = this.queries.discover ?? "";
    const list = q.trim() ? search(sortEntries(all, this.sort), q) : sortEntries(all, this.sort);
    const sub = this.index ? `${all.length} mods people share on herdr.dev. Read what each one does before you install it.` : "Mods people share on herdr.dev.";
    const sort = this.segmented(t, "mh-sort", SORTS, this.sort, (id, cx) => {
      this.sort = id;
      this.shown = PAGE;
      store.set("mod-hub.sort", id);
      cx.notify();
    });
    let content;
    if (!this.index && this.indexState === "loading") content = this.skeletonGrid(t);
    else if (!this.index) {
      content = this.empty(t, "globe", "Couldn't reach the gallery", this.indexError ?? "herdr.dev didn't answer.", button(t, "mh-retry", "Try again", (_e, cx) => cx.spawn(async (cx) => this.refreshIndex(cx)), { glyph: "refresh" }));
    } else if (!list.length) {
      content = this.empty(t, "search", `Nothing matches “${q.trim()}”`, "Try fewer words, a program name (git, docker) or what it shows (tabs, agents, PRs).");
    } else {
      const shown = list.slice(0, this.shown);
      content = v_flex()
        .w_full()
        .gap(GAP)
        .child(this.grid(t, shown, cx))
        .when(list.length > shown.length, (el) =>
          el.child(
            h_flex().w_full().pt(8).justify_center().child(
              button(t, "mh-more", `Show more (${list.length - shown.length} left)`, (_e, cx) => {
                this.shown += PAGE * 2;
                cx.notify();
              }, { kind: "subtle" }),
            ),
          ));
    }
    return v_flex()
      .w_full()
      .child(this.header(t, "Discover", sub))
      .child(this.searchField(t, "discover", sort))
      .when(Boolean(q.trim()) && list.length > 0, (el) => el.child(div().pb(12).text_size(12.5).text_color(t.dim).child(plural(list.length, "mod"))))
      .child(content);
  }

  columns() {
    const w = this.contentWidth;
    const cols = Math.max(1, Math.floor((w + GAP) / (CARD_MIN + GAP)));
    return { cols, width: Math.floor((w - GAP * (cols - 1)) / cols) };
  }

  grid(t, entries, cx) {
    const { cols, width } = this.columns();
    const rows = [];
    for (let i = 0; i < entries.length; i += cols) rows.push(entries.slice(i, i + cols));
    return v_flex()
      .w_full()
      .gap(GAP)
      .children(rows.map((row, r) =>
        h_flex()
          .id(`mh-row-${r}`)
          .w_full()
          .gap(GAP)
          .items_start()
          .children(row.map((e) => this.card(t, e, width, cx)))
          .children(Array.from({ length: cols - row.length }, () => div().flex_1().min_w(0)))));
  }

  skeletonGrid(t) {
    const { cols, width } = this.columns();
    const card = () => v_flex().w(width).gap(10).child(skeleton(t, width, Math.round(width * 0.56), 10)).child(skeleton(t, Math.round(width * 0.6), 13)).child(skeleton(t, Math.round(width * 0.9), 10)).child(skeleton(t, Math.round(width * 0.75), 10));
    return v_flex().gap(GAP).children([0, 1].map(() => h_flex().gap(GAP).children(Array.from({ length: cols }, card))));
  }

  /** What's installed from a listing, and whether any of it has an update. */
  installedFrom(e) {
    return this.byEntry?.get(e.key) ?? [];
  }

  card(t, e, width, cx) {
    const ph = Math.round(width * 0.56);
    const picture = this.previewFor(e, cx);
    const installed = this.installedFrom(e);
    const hasUpdate = installed.some((m) => m.update);
    const ok = tones(t).ok;
    return v_flex()
      .id(`mh-card-${e.key}`)
      .flex_1()
      .min_w(0)
      .rounded(11)
      .overflow_hidden()
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .cursor_pointer()
      .hover((s) => s.border_color(t.input ?? t.muted).bg(t.raised))
      .on_click((_e, cx) => {
        this.detail = { type: "entry", key: e.key };
        cx.notify();
      })
      .child(
        div()
          .w_full()
          .h(ph)
          .flex_none()
          .overflow_hidden()
          .bg(t.canvas ?? t.background)
          .border_b(1)
          .border_color(t.border)
          .flex()
          .items_center()
          .justify_center()
          .child(picture ? image(picture).w_full().h(ph) : this.previewFallback(t, e, width, ph)),
      )
      .child(
        v_flex()
          .p(12)
          .gap(5)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(displayName(e)))
              .when(installed.length > 0 && !hasUpdate, (el) => el.child(div().id(`mh-ok-${e.key}`).flex_none().tooltip("Installed").child(icon("check-circle", 15, ok))))
              .when(hasUpdate, (el) => el.child(dot(t.accent, 8))),
          )
          .child(div().truncate().text_size(12).text_color(t.dim).child(`by ${e.owner}${e.modNames.length > 1 ? ` · ${e.modNames.length} mods` : ""}`))
          .child(div().h(54).overflow_hidden().text_size(12.5).line_height("18px").text_color(t.muted).child(e.blurb || "No description."))
          .child(
            h_flex()
              .pt(4)
              .gap(10)
              .items_center()
              .text_size(12)
              .text_color(t.dim)
              .child(h_flex().gap(4).items_center().child(icon("star", 13, t.dim)).child(compact(e.stars)))
              .child(div().flex_1().min_w(0).truncate().child(ago(e.pushedAt)))
              .child(
                installed.length
                  ? hasUpdate
                    ? button(t, `mh-card-update-${e.key}`, "Update", (_e, cx) => this.update(installed.find((m) => m.update), cx), { small: true, busy: installed.some((m) => this.busy[m.name]) })
                    : chip(t, "Installed", { color: ok, bg: alpha(ok, "1f"), glyph: "check" })
                  : button(t, `mh-card-install-${e.key}`, "Install", (_e, cx) => this.startInstall(e, cx), { small: true, glyph: "download" }),
              ),
          ),
      );
  }

  previewFallback(t, e, w, h) {
    const loading = this.previews[e.key] === "loading";
    if (loading) return div().w_full().h(h).bg(t.raised).loop("opacity", { from: 0.4, to: 0.9, period: 1300 });
    return v_flex().items_center().gap(8).child(tile(t, e.modNames[0], Math.min(56, Math.round(h * 0.42)))).child(div().text_size(11.5).text_color(t.dim).child("No preview"));
  }

  entryPage(t, e, cx) {
    const w = this.contentWidth;
    const wide = w >= 720;
    const pw = wide ? Math.min(Math.round(w * 0.56), 560) : w;
    const ph = Math.round(pw * 0.56);
    const picture = this.previewFor(e, cx);
    const recipe = this.recipeFor(e, cx);
    const installed = this.installedFrom(e);
    const hasUpdate = installed.find((m) => m.update);
    const busy = installed.some((m) => this.busy[m.name]);
    const ok = tones(t).ok;
    const actions = h_flex()
      .gap(8)
      .items_center()
      .flex_wrap()
      .child(
        hasUpdate
          ? button(t, "mh-entry-update", "Update", (_e, cx) => this.update(hasUpdate, cx), { kind: "primary", glyph: "download", busy })
          : installed.length
            ? h_flex().gap(8).items_center()
              .child(chip(t, installed.length > 1 ? `Installed (${installed.length})` : "Installed", { color: ok, bg: alpha(ok, "1f"), glyph: "check" }))
              .when(installed.some((m) => m.enabled && m.overlay), (el) => el.child(button(t, "mh-entry-open", "Open", () => this.openMod(installed.find((m) => m.enabled && m.overlay)), { glyph: "play" })))
              .child(button(t, "mh-entry-manage", "Manage", (_e, cx) => {
                this.page = "installed";
                this.detail = { type: "mod", name: installed[0].name };
                cx.notify();
              }, { kind: "subtle" }))
            : button(t, "mh-entry-install", "Install", (_e, cx) => this.startInstall(e, cx), { kind: "primary", glyph: "download" }),
      )
      .child(button(t, "mh-entry-github", "GitHub", (_e, cx) => cx.open_url(repoUrl(e)), { kind: "subtle", glyph: "external" }));
    const facts = v_flex()
      .flex_1()
      .min_w(0)
      .gap(10)
      .child(div().text_size(24).font_semibold().text_color(t.foreground).child(displayName(e)))
      .child(
        h_flex()
          .gap(12)
          .items_center()
          .flex_wrap()
          .text_size(12.5)
          .text_color(t.dim)
          .child(link(t, "mh-entry-owner", `by ${e.owner}`, (_e, cx) => cx.open_url(`https://github.com/${e.owner}`), t.muted))
          .child(h_flex().gap(4).items_center().child(icon("star-fill", 12, tones(t).warn)).child(plural(e.stars, "star").replace(/^\d+/, compact(e.stars))))
          .child(h_flex().gap(4).items_center().child(icon("clock", 12, t.dim)).child(`Updated ${ago(e.pushedAt)}`)),
      )
      .child(div().text_size(13.5).line_height("21px").text_color(t.muted).child(e.blurb || "No description."))
      .child(div().pt(4).child(actions));
    const hero = (wide ? h_flex().gap(24).items_start() : v_flex().gap(18))
      .w_full()
      .child(
        div()
          .id("mh-entry-preview")
          .w(pw)
          .h(ph)
          .flex_none()
          .rounded(12)
          .overflow_hidden()
          .border_1()
          .border_color(t.border)
          .bg(t.canvas ?? t.background)
          .flex()
          .items_center()
          .justify_center()
          .when(Boolean(picture), (el) => el.cursor_pointer().on_click((_e, cx) => {
            this.lightbox = picture;
            cx.notify();
          }).tooltip("See it full size"))
          .child(picture ? image(picture).w(pw).h(ph) : this.previewFallback(t, e, pw, ph)),
      )
      .child(facts);

    const people = recipe.state === "ready" ? forPeople(recipe.parsed) : [];
    const sections = v_flex().w_full().gap(22).pt(28);
    if (recipe.state === "loading") sections.child(v_flex().gap(8).child(skeleton(t, 140, 14)).child(skeleton(t, "full", 11)).child(skeleton(t, "full", 11)).child(skeleton(t, 260, 11)));
    else if (recipe.state === "error") sections.child(div().text_size(12.5).text_color(t.dim).child(`The recipe couldn't be read: ${recipe.error}`));
    else {
      for (const [i, s] of people.entries()) sections.child(v_flex().gap(8).child(heading(t, s.title)).child(this.markdown(t, `mh-recipe-${i}`, s.body)));
      const all = this.expanded[`recipe-${e.key}`];
      sections.child(
        v_flex()
          .gap(10)
          .child(
            h_flex()
              .id("mh-full-recipe")
              .gap(6)
              .items_center()
              .cursor_pointer()
              .text_size(12.5)
              .text_color(t.muted)
              .hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => {
                this.expanded[`recipe-${e.key}`] = !all;
                cx.notify();
              })
              .child(icon(all ? "chevron-down" : "chevron-right", 13))
              .child(people.length ? "The whole recipe: how it's built, what to watch out for" : "Its recipe"),
          )
          .when(Boolean(all), (el) => el.child(div().p(16).rounded(10).bg(t.surface).border_1().border_color(t.border).child(this.markdown(t, "mh-recipe-all", recipe.md)))),
      );
    }
    const inside = v_flex()
      .gap(8)
      .child(heading(t, e.modNames.length > 1 ? `${e.modNames.length} mods in this listing` : "In this listing"))
      .child(
        h_flex().gap(6).flex_wrap().children(
          e.modNames.map((n) => {
            const mine = installed.find((m) => m.source?.mod === n);
            return chip(t, mine && mine.name !== n ? `${n} → ${mine.name}` : n, { glyph: mine ? "check" : "puzzle", color: mine ? ok : t.muted, bg: mine ? alpha(ok, "1f") : t.raised });
          }),
        ),
      )
      .when(e.hasKeys, (el) => el.child(div().pt(2).text_size(12.5).text_color(t.dim).child("Comes with keyboard shortcuts. Installing adds the ones you don't already use.")));
    return v_flex().w_full().child(this.back(t, "Discover", cx)).child(hero).child(div().pt(26).child(inside)).child(sections);
  }

  markdown(t, id, md) {
    return div()
      .w_full()
      .text_size(13)
      .line_height("20px")
      .text_color(t.muted)
      .child(TextView.markdown(id, md).selectable(true).on_link_click((url, cx) => cx.open_url(url)));
  }

  // Installed -----------------------------------------------------------------------------

  installedPage(t, cx) {
    if (!this.disk) return v_flex().w_full().child(this.header(t, "Installed", null)).child(this.loadingRows(t));
    const q = (this.queries.installed ?? "").trim().toLowerCase();
    const match = (m) => !q || `${m.title} ${m.name} ${m.source?.fullName ?? ""} ${m.description}`.toLowerCase().includes(q);
    const mine = this.mods.filter((m) => !m.shipped);
    const off = mine.filter((m) => !m.enabled).length;
    const list = groups(mine.filter(match));
    const removed = (this.disk.state.removed ?? []).filter((r) => !q || `${r.title} ${r.name}`.toLowerCase().includes(q));
    const sub = mine.length ? `${plural(mine.length, "mod")} you added${off ? `, ${off} turned off` : ""}. Herdr's own are under Built in.` : null;
    const page = v_flex().w_full().child(this.header(t, "Installed", sub));
    if (!mine.length && !removed.length) {
      return page.child(this.empty(t, "package", "No mods of your own yet", "Mods add panels, menus and windows to Herdr. People share hundreds of them.", button(t, "mh-browse", "Browse the gallery", (_e, cx) => this.go("discover", cx), { kind: "primary", glyph: "compass" })));
    }
    page.child(this.searchField(t, "installed"));
    if (!list.length && !removed.length) return page.child(this.empty(t, "search", `None of your mods match “${q}”`, null));
    for (const g of list) {
      page.child(v_flex().w_full().pb(18).child(heading(t, g.title, g.mods.length)).children(g.mods.map((m) => this.modRow(t, m, cx))));
    }
    if (removed.length) {
      page.child(
        v_flex()
          .w_full()
          .pb(18)
          .child(heading(t, "Removed", "kept for 30 days"))
          .children(removed.map((r) => this.removedRow(t, r, cx))),
      );
    }
    return page;
  }

  where(m) {
    const layouts = [...new Set(m.layouts.filter((l) => l.personal).map((l) => l.layout))];
    const key = m.keys.find((k) => k.section === "global");
    if (!m.enabled) return "off";
    if (layouts.length) return `in ${layouts.join(", ")}`;
    if (key) return `opens with ${prettyKey(key.keys, herdrWindow()?.platform === "macos")}`;
    if (m.usedBy.length) return `used by ${m.usedBy.join(", ")}`;
    return KIND_WORDS[m.kind].toLowerCase();
  }

  modRow(t, m, cx) {
    const from = m.source ? m.source.fullName : m.clonedFrom ? `copy of ${m.clonedFrom}` : null;
    const sub = [m.name !== m.title ? m.name : null, from, this.where(m)].filter(Boolean).join(" · ");
    const busy = Boolean(this.busy[m.name]);
    const bad = tones(t).bad;
    return h_flex()
      .id(`mh-mod-${m.name}`)
      .w_full()
      .gap(12)
      .px(10)
      .py(8)
      .ml(-10)
      .items_center()
      .rounded(9)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.detail = { type: "mod", name: m.name };
        cx.notify();
      })
      .child(div().when(!m.enabled, (el) => el.opacity(0.5)).child(tile(t, m.name, 36, this.pictureOf(m, cx))))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .child(div().min_w(0).truncate().text_size(13.5).font_medium().text_color(m.enabled ? t.foreground : t.muted).child(m.title))
              .when(Boolean(m.version), (el) => el.child(chip(t, `v${m.version.replace(/^v/, "")}`)))
              .when(m.self, (el) => el.child(chip(t, "This screen", { color: t.accent, bg: alpha(t.accent, "1f") }))),
          )
          .child(div().truncate().text_size(12).text_color(t.dim).child(sub)),
      )
      .child(
        h_flex()
          .flex_none()
          .gap(8)
          .items_center()
          .when(m.errors.length > 0, (el) => el.child(chip(t, "Error", { color: bad, bg: alpha(bad, "1f"), glyph: "alert" })))
          .when(Boolean(m.update), (el) => el.child(chip(t, "Update", { color: t.accent, bg: alpha(t.accent, "1f"), glyph: "download" })))
          .when(Boolean(m.edited), (el) => el.child(chip(t, "Edited", { glyph: "code" })))
          .when(!m.self, (el) => el.child(toggle(t, `mh-toggle-${m.name}`, m.enabled, (_e, cx) => (m.enabled ? this.setOff(m, cx) : this.setOn(m, cx)), { busy, tip: m.enabled ? "Turn off" : "Turn on" }))),
      );
  }

  removedRow(t, r, cx) {
    const busy = Boolean(this.busy[`removed-${r.id}`]);
    return h_flex()
      .id(`mh-removed-${r.id}`)
      .w_full()
      .gap(12)
      .py(8)
      .items_center()
      .child(div().opacity(0.45).child(tile(t, r.name, 36)))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().truncate().text_size(13.5).text_color(t.muted).child(r.dataOnly ? `${r.title}: its old data` : r.title))
          .child(div().truncate().text_size(12).text_color(t.dim).child(r.dataOnly
            ? `Kept when it came back, because data/${r.name} was there already · mod-hub/removed/${r.id}/data`
            : [`Removed ${ago(r.at)}`, r.name !== r.title ? r.name : null, r.source?.fullName].filter(Boolean).join(" · "))),
      )
      .when(!r.dataOnly, (el) => el.child(button(t, `mh-restore-${r.id}`, "Restore", (_e, cx) => this.restore(r.id, r.title, cx), { small: true, glyph: "undo", busy })))
      .child(button(t, `mh-purge-${r.id}`, "Delete", (_e, cx) => this.purge(r, cx), { small: true, kind: "ghost", disabled: busy }));
  }

  // One mod ---------------------------------------------------------------------------------

  modPage(t, m, cx) {
    const mac = herdrWindow()?.platform === "macos";
    const busy = Boolean(this.busy[m.name]);
    const bad = tones(t).bad;
    const warn = tones(t).warn;
    const earlier = rollbackFor(this.disk?.state, m.name);
    const from = m.shipped ? "Built in" : m.source ? m.source.fullName : m.clonedFrom ? `Copy of ${m.clonedFrom}` : "Added by hand";
    const top = h_flex()
      .w_full()
      .gap(16)
      .items_center()
      .child(div().when(!m.enabled, (el) => el.opacity(0.5)).child(tile(t, m.name, 56, this.pictureOf(m, cx))))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(4)
          .child(h_flex().gap(8).items_center().child(div().min_w(0).truncate().text_size(22).font_semibold().text_color(t.foreground).child(m.title)).when(Boolean(m.version), (el) => el.child(chip(t, `v${m.version.replace(/^v/, "")}`))))
          .child(div().truncate().text_size(12.5).text_color(t.dim).child([m.name, from, m.enabled ? null : "turned off"].filter(Boolean).join(" · "))),
      )
      .child(
        h_flex()
          .flex_none()
          .gap(10)
          .items_center()
          .when(m.enabled && (m.overlay || m.kind === "panel") && !m.self, (el) => el.child(button(t, "mh-mod-open", m.overlay ? "Open" : "Open beside", () => this.openMod(m), { glyph: "play" })))
          .when(m.shipped, (el) => el.child(button(t, "mh-mod-duplicate", "Duplicate to change it", (_e, cx) => this.duplicate(m, cx), { glyph: "copy", busy })))
          .when(!m.shipped && !m.self, (el) =>
            el.child(
              h_flex()
                .gap(8)
                .items_center()
                .child(div().text_size(12.5).text_color(t.muted).child(m.enabled ? "On" : "Off"))
                .child(toggle(t, "mh-mod-toggle", m.enabled, (_e, cx) => (m.enabled ? this.setOff(m, cx) : this.setOn(m, cx)), { busy })),
            )),
      );

    const alerts = v_flex().w_full().gap(10).pt(18);
    for (const err of m.errors) alerts.child(notice(t, bad, "alert", "Herdr reports a problem with this mod", typeof err === "string" ? err : JSON.stringify(err)));
    if (m.update && !m.update.gone) {
      const d = m.update.diff;
      alerts.child(
        notice(t, t.accent, "download", `Update available: ${short(m.source?.commit)} → ${short(m.update.commit)}`,
          `${d ? `Changed: ${changedFiles(d)}.` : ""}${m.edited ? ` You changed ${changedFiles(m.edited)} since installing; updating replaces that, and keeps your copy for Roll back.` : ""}`.trim(),
          button(t, "mh-mod-update", "Update", (_e, cx) => this.update(m, cx), { kind: "primary", busy })),
      );
    } else if (m.update?.gone) {
      alerts.child(notice(t, warn, "alert", `${m.source.fullName} no longer has ${m.source.mod}`, "The listing moved or dropped this mod. Your copy keeps working; it just won't get updates."));
    } else if (m.edited) {
      alerts.child(notice(t, warn, "code", `You changed ${plural(m.edited.count, "file")} since installing`, `${changedFiles(m.edited)}. An update would replace these, keeping your copy for Roll back.`));
    }
    if (m.pending) {
      const where = [...Object.keys(m.pending.layouts ?? {}), ...(m.pending.keys?.length ? ["keys.json"] : [])];
      alerts.child(notice(t, warn, "alert", `Not everything of ${m.title}'s went back`, `Mods couldn't change ${where.join(", ")} when it came back. Fix the file if Herdr reports it, then try again.`,
        button(t, "mh-mod-putback", "Try again", (_e, cx) => this.putBack(m, cx), { busy })));
    }
    if (m.self) alerts.child(notice(t, t.accent, "puzzle", "This is the screen you're looking at", "It can't turn itself off. Delete its folder to remove it."));
    if (m.shipped) alerts.child(notice(t, t.dim, "box", "Herdr ships this mod", "Herdr puts it back as it was on every start, so it can't be turned off or removed. Duplicate it to make a copy that's yours to change."));

    const shows = m.layouts.length
      ? v_flex().gap(5).children(m.layouts.map((l, i) => h_flex().id(`mh-where-${i}`).gap(7).items_center().child(icon("layers", 13, t.dim)).child(div().text_color(t.foreground).child(l.layout)).child(div().text_color(t.dim).child(describe(l.ref))).when(!l.personal, (el) => el.child(chip(t, "Herdr's layout")))))
      : div().text_color(t.muted).child(`Not in any layout. ${KIND_WORDS[m.kind]}.`);
    const keys = m.keys.length
      ? v_flex().gap(5).children(m.keys.map((k, i) => h_flex().id(`mh-key-${i}`).gap(8).items_center().child(div().px(6).h(20).rounded(5).bg(t.raised).border_1().border_color(t.border).flex().items_center().text_size(12).font_family(settings()?.font ?? "JetBrains Mono").child(prettyKey(k.keys, mac))).child(div().text_color(t.dim).truncate().child(typeof k.action === "string" ? k.action : k.action?.command ?? ""))))
      : div().text_color(t.muted).child("No keyboard shortcuts.");
    const sourceFact = m.source
      ? v_flex()
        .gap(6)
        .child(
          h_flex().gap(10).items_center().flex_wrap()
            .child(link(t, "mh-src-repo", m.source.fullName, (_e, cx) => cx.open_url(m.entry ? repoUrl(m.entry) : `https://github.com/${m.source.fullName}`)))
            .child(div().text_color(t.dim).child(m.source.commit ? `at ${short(m.source.commit)}` : "version not known yet")),
        )
        .child(div().text_size(12).text_color(t.dim).child(`${m.source.linked ? "Linked" : "Installed"} ${ago(m.source.updatedAt ?? m.source.installedAt)}`))
        .child(
          h_flex().gap(8).pt(2)
            .when(Boolean(m.entry), (el) => el.child(button(t, "mh-src-listing", "See the listing", (_e, cx) => {
              this.page = "discover";
              this.detail = { type: "entry", key: m.entry.key };
              cx.notify();
            }, { small: true, kind: "subtle" })))
            .child(button(t, "mh-src-unlink", "Unlink", (_e, cx) => this.unlink(m, cx), { small: true, kind: "ghost", disabled: busy })),
        )
      : m.candidates.length
        ? v_flex()
          .gap(6)
          .child(div().text_color(t.muted).child("Not linked to the gallery, so updates can't be found. A listing has a mod with this folder name:"))
          .children(m.candidates.slice(0, 4).map((e, i) =>
            h_flex().id(`mh-cand-${i}`).gap(10).items_center()
              .child(link(t, `mh-cand-link-${i}`, e.fullName, (_e, cx) => cx.open_url(repoUrl(e))))
              .child(div().text_color(t.dim).text_size(12).child(plural(e.stars, "star").replace(/^\d+/, compact(e.stars))))
              .child(button(t, `mh-cand-btn-${i}`, "Link", (_e, cx) => this.link(m, e, cx), { small: true, kind: "subtle", glyph: "link", busy }))))
        : div().text_color(t.muted).child(m.shipped ? "Ships with Herdr and updates with it." : m.clonedFrom ? `Duplicated from Herdr's ${m.clonedFrom}. It's yours: Herdr never updates it.` : "Not from the gallery: copied in by hand, or made here.");
    const folder = this.folderOf(m);
    const rows = v_flex()
      .w_full()
      .pt(18)
      .when(Boolean(m.description), (el) => el.child(fact(t, "About", div().text_color(t.muted).line_height("19px").child(m.description))))
      .child(fact(t, "Shows in", shows))
      .child(fact(t, "Keys", keys))
      .when(m.usedBy.length > 0, (el) => el.child(fact(t, "Used by", div().text_color(t.foreground).child(m.usedBy.join(", ")))))
      .child(fact(t, "Source", sourceFact))
      .child(fact(t, "Folder", h_flex().gap(10).items_center().child(div().min_w(0).truncate().text_color(t.muted).font_family(settings()?.font ?? "JetBrains Mono").text_size(12).child(folder.replace(appHome(), "~/.config/herdr-app"))).child(button(t, "mh-reveal", mac ? "Show in Finder" : "Open folder", () => this.reveal(folder), { small: true, kind: "subtle", glyph: "folder" }))))
      .when(Boolean(earlier), (el) => el.child(fact(t, "Earlier copy", h_flex().gap(10).items_center().child(div().text_color(t.muted).child(`${earlier.undone ? "The copy you rolled back from" : "The copy before its last update"} (${short(earlier.commit)}, ${ago(earlier.at)})`)).child(button(t, "mh-rollback", "Roll back", (_e, cx) => this.rollback(m, cx), { small: true, kind: "subtle", glyph: "undo", busy })))));
    const danger = !m.shipped && !m.self
      ? h_flex()
        .w_full()
        .pt(22)
        .gap(12)
        .items_center()
        .child(v_flex().flex_1().gap(2).child(div().text_size(13).text_color(t.foreground).child("Remove this mod")).child(div().text_size(12.5).text_color(t.dim).child("It leaves your layouts and keys first. You can restore it for 30 days.")))
        .child(button(t, "mh-uninstall", "Remove", (_e, cx) => this.uninstall(m, cx), { kind: "danger", glyph: "trash", disabled: busy }))
      : null;
    return v_flex()
      .w_full()
      .child(this.back(t, m.shipped ? "Built in" : "Installed", cx))
      .child(top)
      .child(alerts)
      .child(rows)
      .when(Boolean(danger), (el) => el.child(danger));
  }

  // Updates ---------------------------------------------------------------------------------

  updatesPage(t, cx) {
    const linked = this.mods.filter((m) => m.source && !m.shipped);
    const pending = linked.filter((m) => m.update);
    const unlinked = this.mods.filter((m) => !m.source && !m.shipped && !m.self && m.candidates.length);
    const checkedAt = this.disk?.state?.checkedAt ?? 0;
    const sub = this.checking ?? (checkedAt ? `Checked ${ago(checkedAt)}` : "Not checked yet");
    const right = h_flex()
      .gap(8)
      .when(pending.filter((m) => !m.update.gone).length > 1, (el) => el.child(button(t, "mh-update-all", `Update all (${pending.filter((m) => !m.update.gone).length})`, (_e, cx) => this.updateAll(cx), { kind: "primary", busy: Boolean(this.busy["update-all"]) })))
      .child(button(t, "mh-check", "Check now", (_e, cx) => cx.spawn(async (cx) => this.checkUpdates(cx)), { glyph: "refresh", busy: Boolean(this.checking), disabled: !this.index }));
    const page = v_flex().w_full().child(this.header(t, "Updates", sub, right));
    for (const p of this.checkProblems) page.child(div().pb(8).child(notice(t, tones(t).warn, "alert", "Couldn't check one listing", p)));
    if (pending.length) {
      page.child(heading(t, "Ready to update", pending.length));
      for (const m of pending) page.child(this.updateRow(t, m, cx));
    } else {
      page.child(this.empty(t, "check-circle", linked.length ? "Everything is up to date" : "Nothing to check yet", linked.length
        ? `${plural(linked.length, "mod")} from the gallery ${linked.length === 1 ? "is" : "are"} checked when this screen opens, at most every 6 hours.`
        : "Mods you install from Discover are checked for updates here."));
    }
    if (unlinked.length) {
      page.child(div().pt(18).child(heading(t, "Not linked to the gallery", unlinked.length)));
      page.child(div().pb(10).text_size(12.5).text_color(t.dim).child("These were copied in by hand, so nothing says where they came from. A listing has a mod folder with the same name: link it to get its updates."));
      for (const m of unlinked) {
        const e = m.candidates[0];
        page.child(
          h_flex()
            .id(`mh-unlinked-${m.name}`)
            .w_full()
            .gap(12)
            .py(8)
            .items_center()
            .child(tile(t, m.name, 32, this.pictureOf(m, cx)))
            .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(13.5).text_color(t.foreground).child(m.title)).child(div().truncate().text_size(12).text_color(t.dim).child(m.candidates.length > 1 ? `${e.fullName} and ${m.candidates.length - 1} more` : e.fullName)))
            .child(button(t, `mh-link-${m.name}`, m.candidates.length > 1 ? "Choose…" : "Link", (_e, cx) => {
              if (m.candidates.length > 1) {
                this.page = "installed";
                this.detail = { type: "mod", name: m.name };
                cx.notify();
              } else this.link(m, e, cx);
            }, { small: true, kind: "subtle", glyph: "link", busy: Boolean(this.busy[m.name]) })),
        );
      }
    }
    return page;
  }

  updateRow(t, m, cx) {
    const d = m.update.diff;
    const busy = Boolean(this.busy[m.name]);
    return h_flex()
      .id(`mh-update-${m.name}`)
      .w_full()
      .gap(12)
      .px(10)
      .py(10)
      .ml(-10)
      .items_center()
      .rounded(9)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.page = "installed";
        this.detail = { type: "mod", name: m.name };
        cx.notify();
      })
      .child(tile(t, m.name, 36, this.pictureOf(m, cx)))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(h_flex().gap(8).items_center().child(div().truncate().text_size(13.5).font_medium().text_color(t.foreground).child(m.title)).child(div().text_size(12).text_color(t.dim).font_family(settings()?.font ?? "JetBrains Mono").child(`${short(m.source.commit)} → ${short(m.update.commit)}`)))
          .child(div().truncate().text_size(12).text_color(t.dim).child(m.update.gone ? "No longer in its listing" : d ? `Changed: ${changedFiles(d)}` : m.source.fullName))
          .when(Boolean(m.edited), (el) => el.child(div().text_size(12).text_color(tones(t).warn).child(`You changed ${changedFiles(m.edited)}; your copy is kept for Roll back`))),
      )
      .when(!m.update.gone, (el) => el.child(button(t, `mh-update-btn-${m.name}`, "Update", (_e, cx) => this.update(m, cx), { kind: "primary", small: true, busy })));
  }

  // Built in ----------------------------------------------------------------------------------

  builtinPage(t, cx) {
    const q = (this.queries.builtin ?? "").trim().toLowerCase();
    const list = this.mods.filter((m) => m.shipped && (!q || `${m.title} ${m.name}`.toLowerCase().includes(q)));
    const page = v_flex().w_full().child(this.header(t, "Built in", "Herdr ships these and restores them on every start. Duplicate one to make a copy you can change."));
    if (!this.disk) return page.child(this.loadingRows(t));
    page.child(this.searchField(t, "builtin"));
    for (const m of list) {
      const layouts = [...new Set(m.layouts.map((l) => l.layout))];
      page.child(
        h_flex()
          .id(`mh-builtin-${m.name}`)
          .w_full()
          .gap(12)
          .px(10)
          .py(8)
          .ml(-10)
          .items_center()
          .rounded(9)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            this.detail = { type: "mod", name: m.name };
            cx.notify();
          })
          .child(tile(t, m.name, 32))
          .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(13.5).text_color(t.foreground).child(m.title)).child(div().truncate().text_size(12).text_color(t.dim).child([m.name !== m.title ? m.name : null, layouts.length ? `in ${layouts.join(", ")}` : KIND_WORDS[m.kind].toLowerCase()].filter(Boolean).join(" · "))))
          .child(button(t, `mh-dup-${m.name}`, "Duplicate", (_e, cx) => this.duplicate(m, cx), { small: true, kind: "subtle", glyph: "copy", busy: Boolean(this.busy[m.name]) })),
      );
    }
    if (!list.length) page.child(this.empty(t, "search", `No built-in mod matches “${q}”`, null));
    return page;
  }

  // Over the page -----------------------------------------------------------------------------

  sheetView(t, cx) {
    const s = this.sheet;
    const width = Math.min(600, this.width - 48);
    const card = v_flex()
      .id("mh-sheet")
      .w(width)
      .max_h(Math.max(240, this.height - 60))
      .rounded(14)
      .bg(t.popover ?? t.background)
      .border_1()
      .border_color(t.border)
      .shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(this.installSheet(t, s, width, cx));
    return div()
      .id("mh-sheet-backdrop")
      .absolute()
      .inset_0()
      .bg("#00000073")
      .flex()
      .items_center()
      .justify_center()
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.cancelSheet(cx);
      })
      .child(card);
  }

  installSheet(t, s, width, cx) {
    const e = s.entry;
    const plan = s.plan;
    const head = v_flex()
      .gap(4)
      .px(22)
      .pt(20)
      .pb(14)
      .border_b(1)
      .border_color(t.border)
      .child(h_flex().gap(10).items_center().child(icon("shield", 18, t.accent)).child(div().text_size(17).font_semibold().text_color(t.foreground).child(`Install ${displayName(e)}?`)))
      .child(div().text_size(12.5).text_color(t.dim).child(`From ${e.fullName} at ${short(e.commit)}. Read what it can do first: mods run as trusted code.`));
    const body = v_flex().id("mh-sheet-body").flex_1().min_h(0).overflow_y_scroll().px(22).py(16).gap(18);
    if (s.phase === "loading") {
      body.child(h_flex().gap(10).items_center().py(18).child(spinner(16, t.accent)).child(div().text_size(13).text_color(t.muted).child("Downloading it and reading its code…")));
    } else if (s.phase === "error") {
      body.child(notice(t, tones(t).bad, "alert", "It can't be installed", s.error));
    } else if (plan) {
      body.child(this.reviewMods(t, s, cx));
      body.child(this.reviewCode(t, plan.report, cx));
      if (plan.keys.added.length || plan.keys.kept.length) body.child(this.reviewKeys(t, plan.keys));
      if (plan.missing.length) body.child(notice(t, tones(t).warn, "alert", "Listed but not in the repository", plan.missing.join(", ")));
    }
    const installing = s.phase === "installing";
    const foot = h_flex()
      .gap(10)
      .px(22)
      .py(14)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .child(div().flex_1().text_size(12).text_color(t.dim).child(installing ? "Checking it with Herdr, then putting it in place…" : s.phase === "ready" ? "Herdr checks it before it goes live; nothing changes until then." : ""))
      .child(button(t, "mh-sheet-cancel", s.phase === "error" ? "Close" : "Cancel", (_e, cx) => this.cancelSheet(cx), { kind: "subtle", disabled: installing }))
      .when(s.phase === "ready" || installing, (el) => el.child(button(t, "mh-sheet-install", installing ? "Installing" : s.picked.size > 1 ? `Install ${s.picked.size} mods` : "Install", (_e, cx) => this.confirmInstall(cx), { kind: "primary", glyph: "download", busy: installing, disabled: !s.picked.size })));
    return v_flex().w(width).max_h(Math.max(240, this.height - 60)).child(head).child(body).child(foot);
  }

  reviewMods(t, s, cx) {
    const plan = s.plan;
    const many = plan.mods.length > 1;
    return v_flex()
      .gap(6)
      .child(heading(t, many ? `Adds ${plan.mods.length} mods` : "Adds"))
      .children(plan.mods.map((m) => {
        const on = s.picked.has(m.name);
        const note = m.action === "rename" ? `as ${m.target}: you already have a ${m.name}` : m.action === "reinstall" ? "replaces your copy (kept for Roll back)" : null;
        const shows = arrival(m.manifest);
        return h_flex()
          .id(`mh-pick-${m.name}`)
          .gap(10)
          .items_center()
          .py(3)
          .when(many, (el) => el.cursor_pointer().on_click((_e, cx) => {
            if (on) s.picked.delete(m.name);
            else s.picked.add(m.name);
            cx.notify();
          }))
          .when(many, (el) => el.child(div().w(16).h(16).rounded(4).border_1().border_color(on ? t.accent : t.input ?? t.border).bg(on ? t.accent : CLEAR).flex().items_center().justify_center().when(on, (b) => b.child(icon("check", 12, t.accent_foreground)))))
          .child(icon("folder", 14, t.dim))
          .child(div().text_size(13).text_color(on ? t.foreground : t.dim).font_family(settings()?.font ?? "JetBrains Mono").child(`mods/${m.target}`))
          .child(div().text_size(12).text_color(t.dim).child(plural(m.files.length, "file")))
          .when(Boolean(note), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(tones(t).warn).child(note)))
          .when(Boolean(shows) && on, (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(shows)));
      }));
  }

  reviewCode(t, report, cx) {
    const box = v_flex().gap(8).child(heading(t, "What its code can do", plural(report.lines, "line")));
    if (quiet(report)) {
      return box.child(notice(t, tones(t).ok, "shield", "Only draws and runs Herdr commands", "No network, no programs, no files outside Herdr's own data."));
    }
    const glyphs = { network: "globe", programs: "terminal", files: "file", claude: "alert", delete: "trash" };
    const lines = summary(report);
    report.checks.forEach((c, i) => {
      const open = this.expanded[`hits-${c.id}`];
      const tone = c.id === "delete" || c.id === "claude" ? tones(t).warn : t.foreground;
      box.child(
        v_flex()
          .gap(6)
          .child(
            h_flex()
              .id(`mh-check-${c.id}`)
              .gap(10)
              .items_center()
              .cursor_pointer()
              .on_click((_e, cx) => {
                this.expanded[`hits-${c.id}`] = !open;
                cx.notify();
              })
              .child(div().w(26).h(26).rounded(7).bg(t.raised).flex().items_center().justify_center().child(icon(glyphs[c.id] ?? "code", 14, tone)))
              .child(div().flex_1().min_w(0).text_size(13).text_color(tone).child(lines[i]))
              .child(div().text_size(12).text_color(t.dim).child(plural(c.hits.length, "place")))
              .child(icon(open ? "chevron-down" : "chevron-right", 13, t.dim)),
          )
          .when(Boolean(open), (el) =>
            el.child(
              v_flex()
                .ml(36)
                .p(8)
                .gap(3)
                .rounded(7)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .font_family(settings()?.font ?? "JetBrains Mono")
                .text_size(11.5)
                .children(c.hits.slice(0, 8).map((h) => h_flex().gap(8).child(div().flex_none().text_color(t.dim).child(`${h.path}:${h.line}`)).child(div().min_w(0).truncate().text_color(t.muted).child(h.text))))
                .when(c.hits.length > 8, (b) => b.child(div().text_color(t.dim).child(`and ${c.hits.length - 8} more`))),
            )),
      );
    });
    return box;
  }

  reviewKeys(t, keys) {
    const mac = herdrWindow()?.platform === "macos";
    const label = (k) => prettyKey(k.keys, mac);
    const what = (a) => (typeof a === "string" ? a : a?.command ?? "");
    return v_flex()
      .gap(6)
      .child(heading(t, "Keys"))
      .children(keys.added.map((k) => h_flex().gap(8).items_center().text_size(12.5).child(icon("key", 13, tones(t).ok)).child(div().text_color(t.foreground).child(label(k))).child(div().text_color(t.dim).truncate().child(`→ ${what(k.action)}`))))
      .children(keys.kept.map((k) => h_flex().gap(8).items_center().text_size(12.5).child(icon("key", 13, t.dim)).child(div().text_color(t.muted).child(label(k))).child(div().text_color(t.dim).truncate().child(`stays ${what(k.by)} (it wanted ${what(k.action)})`))));
  }

  lightboxView(t) {
    const w = this.width - 48;
    const h = this.height - 48;
    return div()
      .id("mh-lightbox")
      .absolute()
      .inset_0()
      .bg("#000000d9")
      .flex()
      .items_center()
      .justify_center()
      .cursor_pointer()
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.lightbox = null;
        cx.notify();
      })
      .child(image(this.lightbox).w(w).h(h));
  }

  snackView(t) {
    const s = this.snack;
    const tone = tones(t)[s.tone] ?? tones(t).ok;
    return h_flex()
      .absolute()
      .bottom(18)
      .left(0)
      .right(0)
      .justify_center()
      .child(
        h_flex()
          .id("mh-snack")
          .max_w(Math.min(620, this.width - 40))
          .gap(12)
          .pl(14)
          .pr(8)
          .py(8)
          .items_center()
          .rounded(10)
          .bg(t.popover ?? t.raised)
          .border_1()
          .border_color(t.border)
          .shadow_lg()
          .child(icon(s.tone === "ok" ? "check-circle" : "alert", 16, tone))
          .child(div().min_w(0).text_size(13).text_color(t.foreground).child(s.text))
          .when(Boolean(s.action), (el) => el.child(button(t, "mh-snack-action", s.action.label, (_e, cx) => {
            const act = s.action;
            this.snack = null;
            act.run(cx);
            cx.notify();
          }, { small: true, kind: "subtle" })))
          .child(iconButton(t, "mh-snack-close", "x", "Dismiss", (_e, cx) => {
            this.snack = null;
            cx.notify();
          }, { size: 24 })),
      );
  }
}

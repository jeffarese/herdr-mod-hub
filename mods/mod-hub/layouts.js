// Where a mod shows in a layout, and how to take it out and put it back exactly.
// Pure functions over layout JSON (layouts/<name>.json). No host calls.
//
// Herdr has no "off" switch for a mod: a layout that names a missing mod shows an error.
// So turning one off first takes it out of the person's own layouts, recording each
// change, and turning it on undoes exactly those changes. Herdr's shipped layouts are
// never edited (they're replaced on every start and can't name the person's mods).

const clone = (v) => JSON.parse(JSON.stringify(v));

/** The mod a block or floating entry shows, if any. */
const blockMod = (node) => (node && typeof node.content?.mod === "string" ? node.content.mod : null);
/** The mod a tab block puts on each pane as its header, if any. */
const paneHeaderMod = (node) => {
  const c = node?.content?.pane?.header?.content;
  return c && typeof c.mod === "string" ? c.mod : null;
};
/** A stack's header: "tabs" (built in), a mod name, or { mod } / { content: { mod } }. */
const stackHeaderMod = (node) => {
  const h = node?.header;
  if (typeof h === "string") return h === "tabs" ? null : h;
  if (h && typeof h === "object") return typeof h.mod === "string" ? h.mod : typeof h.content?.mod === "string" ? h.content.mod : null;
  return null;
};

const ROOT_FIELDS = ["terminal_menu", "toast"];

/** Walks every node: visit(node, parent, list, index, path). Children first in reverse, so
 *  a visitor may remove the node it's given without disturbing the walk. */
function walk(node, visit, parent = null, list = null, index = -1, path = []) {
  if (!node || typeof node !== "object") return;
  for (const key of ["floating", "children"]) {
    const items = Array.isArray(node[key]) ? node[key] : [];
    for (let i = items.length - 1; i >= 0; i--) walk(items[i], visit, node, key, i, [...path, key, i]);
  }
  visit(node, parent, list, index, path);
}

/** Every place a layout names a mod: [{ mod, where, id }]. */
export function references(tree) {
  const out = [];
  if (!tree || typeof tree !== "object") return out;
  walk(tree, (node, parent, list) => {
    const m = blockMod(node);
    if (m) out.push({ mod: m, where: list === "floating" ? "floating" : "block", id: node.id ?? null });
    const h = paneHeaderMod(node);
    if (h) out.push({ mod: h, where: "pane-header", id: node.id ?? null });
    const s = stackHeaderMod(node);
    if (s) out.push({ mod: s, where: "stack-header", id: node.id ?? null });
  });
  for (const field of ROOT_FIELDS) if (typeof tree[field] === "string") out.push({ mod: tree[field], where: field, id: tree.id ?? null });
  return out.reverse();
}

/** Mods a layout names, as a set. */
export const modsIn = (tree) => new Set(references(tree).map((r) => r.mod));

/** Words for where a mod is in a layout: "the prs block", "pane headers". */
export function describe(ref) {
  const id = readable(ref.id);
  switch (ref.where) {
    case "pane-header": return "pane headers";
    case "stack-header": return id ? `the ${id} tabs` : "a set of tabs";
    case "terminal_menu": return "the terminal menu";
    case "toast": return "notifications";
    case "floating": return id ? `a floating ${id}` : "a floating block";
    default: return id ? `the ${id} block` : "a block";
  }
}

/** A block id worth showing: "sidebar" is, a generated "ba6dd1ff3b58…" isn't. */
function readable(id) {
  if (typeof id !== "string" || !id) return null;
  if (/^[0-9a-f-]{12,}$/i.test(id) || /\d{5,}/.test(id)) return null;
  return id;
}

function find(tree, ref) {
  if (ref.id != null) {
    let found = null;
    walk(tree, (node) => { if (!found && node.id === ref.id) found = node; });
    if (found) return found;
  }
  if (!ref.path) return null;
  let node = tree;
  for (const step of ref.path) {
    node = node?.[step];
    if (node === undefined) return null;
  }
  return node && typeof node === "object" ? node : null;
}

/**
 * The order a group's blocks had, counting ones other mods took out earlier (`known`: their
 * "remove" ops), so blocks put back in any order land where they were.
 */
function siblingsOf(items, parent, list, known) {
  const out = items.map((c) => c?.id ?? null);
  if (parent.id == null) return out;
  for (const op of known) {
    const id = op?.node?.id;
    if (op?.op !== "remove" || op.list !== list || op.parent !== parent.id || id == null || out.includes(id)) continue;
    const at = placeIn(out, op);
    if (at != null) out.splice(at, 0, id);
  }
  return out;
}

/** Where a removed block goes back among `ids`: after the nearest earlier sibling still there, else before the nearest later one. */
function placeIn(ids, op) {
  const s = Array.isArray(op.siblings) ? op.siblings : null;
  const me = s ? s.indexOf(op.node?.id) : -1;
  if (me < 0 || op.node?.id == null) return null;
  for (let i = me - 1; i >= 0; i--) {
    const j = s[i] == null ? -1 : ids.indexOf(s[i]);
    if (j >= 0) return j + 1;
  }
  for (let i = me + 1; i < s.length; i++) {
    const j = s[i] == null ? -1 : ids.indexOf(s[i]);
    if (j >= 0) return j;
  }
  return null;
}

/**
 * Takes `mod` out of a layout. `fallback(node)` may name a mod to show in its place (the
 * one it was cloned from, say), else the block goes. `known`: "remove" ops other mods'
 * records hold for this layout. Returns the new tree and the ops that undo it, in the order
 * they were applied.
 */
export function detach(tree, mod, fallback = () => null, known = []) {
  const next = clone(tree);
  const ops = [];
  walk(next, (node, parent, list, index, path) => {
    if (blockMod(node) === mod) {
      const to = fallback(node);
      if (to && to !== mod) {
        node.content.mod = to;
        ops.push({ op: "swap", id: node.id ?? null, path, from: mod, to });
      } else if (parent && list) {
        const siblings = siblingsOf(parent[list], parent, list, known);
        parent[list].splice(index, 1);
        const op = { op: "remove", parent: parent.id ?? null, parentPath: path.slice(0, -2), list, index, siblings, parentHidden: parent.hidden ?? null, node: clone(node) };
        if (parent.type === "stack" && parent.active === node.id) {
          op.active = node.id;
          const first = parent.children.find((c) => c && c.id != null);
          if (first) parent.active = first.id;
          else delete parent.active;
          op.activeAfter = parent.active ?? null;
        }
        ops.push(op);
        if (list === "children" && parent[list].length === 0 && parent !== next && parent.hidden !== true) {
          ops.push({ op: "hide", id: parent.id ?? null, path: path.slice(0, -2), was: parent.hidden ?? null });
          parent.hidden = true;
        }
      }
    }
    if (paneHeaderMod(node) === mod) {
      const to = fallback({ ...node, id: "pane" });
      if (to && to !== mod) {
        node.content.pane.header.content.mod = to;
        ops.push({ op: "pane-header-swap", id: node.id ?? null, path, from: mod, to });
      } else {
        ops.push({ op: "pane-header", id: node.id ?? null, path, header: clone(node.content.pane.header) });
        delete node.content.pane.header;
      }
    }
    if (stackHeaderMod(node) === mod) {
      ops.push({ op: "stack-header", id: node.id ?? null, path, header: clone(node.header) });
      node.header = "tabs";
    }
  });
  for (const field of ROOT_FIELDS) {
    if (next[field] !== mod) continue;
    const to = fallback({ id: field });
    if (to && to !== mod) {
      next[field] = to;
      ops.push({ op: "field-swap", field, from: mod, to });
    } else {
      ops.push({ op: "field", field, value: mod });
      delete next[field];
    }
  }
  return { tree: next, ops };
}

/**
 * Undoes `detach`'s ops. A place the person changed since is left alone and reported:
 * { tree, failed: [{ op, why }] }.
 */
export function reattach(tree, ops) {
  const next = clone(tree);
  const failed = [];
  const fail = (op, why) => failed.push({ op, why });
  // Herdr places a mod whose mod.json names a `place` as soon as its folder appears, so the
  // folder coming back may already have put a new block somewhere. Its old place wins.
  const back = new Map();
  for (const op of ops) {
    const [mod, id] = op.op === "remove" ? [blockMod(op.node), op.node.id] : op.op === "swap" ? [op.from, op.id] : [null];
    if (mod) back.set(mod, (back.get(mod) ?? new Set()).add(id));
  }
  if (back.size) {
    walk(next, (node, parent, list, index) => {
      const mod = blockMod(node);
      if (parent && mod && back.has(mod) && !back.get(mod).has(node.id)) parent[list].splice(index, 1);
    });
  }
  for (const op of ops.slice().reverse()) {
    switch (op.op) {
      case "swap": {
        const node = find(next, op);
        if (blockMod(node) === op.to) node.content.mod = op.from;
        else if (blockMod(node) !== op.from) fail(op, node ? `the ${op.id ?? "block"} block shows something else now` : `the ${op.id ?? "block"} block is gone`);
        break;
      }
      case "remove": {
        if (op.node.id != null && find(next, { id: op.node.id })) break; // put back by hand already
        const parent = op.parent != null || op.parentPath ? find(next, { id: op.parent, path: op.parentPath }) : null;
        if (!parent) { fail(op, `${op.parent ? `the ${op.parent} group` : "its place"} is gone`); break; }
        const list = Array.isArray(parent[op.list]) ? parent[op.list] : (parent[op.list] = []);
        const wasEmpty = list.length === 0;
        list.splice(placeIn(list.map((c) => c?.id ?? null), op) ?? Math.min(op.index, list.length), 0, clone(op.node));
        if (op.active != null && (parent.active ?? null) === (op.activeAfter ?? null)) parent.active = op.active;
        // A group hidden because another mod's removal emptied it shows again once it has a block.
        // Records from before `parentHidden` existed can't tell, so they leave the group as it is.
        if (op.list === "children" && wasEmpty && parent.hidden === true && "parentHidden" in op && op.parentHidden !== true) {
          if (op.parentHidden == null) delete parent.hidden;
          else parent.hidden = op.parentHidden;
        }
        break;
      }
      case "hide": {
        const node = find(next, op);
        if (node && node.hidden === true) {
          if (op.was == null) delete node.hidden;
          else node.hidden = op.was;
        }
        break;
      }
      case "pane-header-swap": {
        const node = find(next, op);
        if (paneHeaderMod(node) === op.to) node.content.pane.header.content.mod = op.from;
        else if (paneHeaderMod(node) !== op.from) fail(op, "pane headers were changed");
        break;
      }
      case "pane-header": {
        const node = find(next, op);
        const pane = node?.content?.pane;
        if (!pane) fail(op, `the ${op.id ?? "tab"} block is gone`);
        else if (!pane.header) pane.header = clone(op.header);
        else if (paneHeaderMod(node) !== stackHeaderModOf(op.header)) fail(op, "pane headers were changed");
        break;
      }
      case "stack-header": {
        const node = find(next, op);
        if (!node) fail(op, `the ${op.id ?? "stack"} group is gone`);
        else if (node.header === "tabs" || node.header == null) node.header = clone(op.header);
        else if (JSON.stringify(node.header) !== JSON.stringify(op.header)) fail(op, `the ${op.id ?? "stack"} tabs were changed`);
        break;
      }
      case "field-swap": {
        if (next[op.field] === op.to) next[op.field] = op.from;
        else if (next[op.field] !== op.from) fail(op, `${op.field.replace("_", " ")} was changed`);
        break;
      }
      case "field": {
        if (next[op.field] === undefined) next[op.field] = op.value;
        else if (next[op.field] !== op.value) fail(op, `${op.field.replace("_", " ")} was changed`);
        break;
      }
      default:
        fail(op, "unknown change");
    }
  }
  return { tree: next, failed };
}

const stackHeaderModOf = (header) => (header && typeof header === "object" ? header.content?.mod ?? header.mod ?? null : null);

/** Renames a mod everywhere a layout names it (after an install took a free name). */
export function renameIn(tree, from, to) {
  const next = clone(tree);
  walk(next, (node) => {
    if (blockMod(node) === from) node.content.mod = to;
    if (paneHeaderMod(node) === from) node.content.pane.header.content.mod = to;
    if (stackHeaderMod(node) === from) {
      if (typeof node.header === "string") node.header = to;
      else if (typeof node.header.mod === "string") node.header.mod = to;
      else node.header.content.mod = to;
    }
  });
  for (const field of ROOT_FIELDS) if (next[field] === from) next[field] = to;
  return next;
}

const holdsTabs = (n) => Boolean(n?.content?.tab) || (n?.children ?? []).some(holdsTabs);
const stackActiveId = (stack) => stack?.active ?? (stack?.children ?? []).find((c) => c && !c.hidden && c.id != null)?.id;

function isPathHidden(path) {
  for (let i = 0; i < path.length; i++) {
    if (path[i]?.hidden === true) return true;
    if (i >= 1 && path[i - 1]?.type === "stack" && stackActiveId(path[i - 1]) !== path[i]?.id) return true;
  }
  return false;
}

function hideSteps(path) {
  let targetIdx = path.length - 1;
  for (let k = targetIdx - 1; k >= 1; k--) {
    const parent = path[k];
    if (holdsTabs(parent)) break;
    if (parent.type === "stack" || (parent.children ?? []).length === 1) {
      if (parent.id) targetIdx = k;
    } else {
      break;
    }
  }
  const steps = [];
  if (path[targetIdx]?.id) steps.push(["layout.hide", { id: path[targetIdx].id }]);
  const newlyHidden = new Set([path[targetIdx]]);
  for (let i = targetIdx - 1; i >= 1; i--) {
    const anc = path[i];
    if (holdsTabs(anc)) break;
    const children = anc.children ?? [];
    const anyVisible = anc.type === "stack"
      ? false
      : children.some((c) => c && !c.hidden && !newlyHidden.has(c));
    if (!anyVisible) {
      if (anc.id) steps.push(["layout.hide", { id: anc.id }]);
      newlyHidden.add(anc);
    } else {
      break;
    }
  }
  return steps;
}

function showSteps(path) {
  const steps = [];
  for (let i = 1; i < path.length; i++) {
    if (path[i]?.hidden === true && path[i]?.id) steps.push(["layout.show", { id: path[i].id }]);
    if (path[i - 1]?.type === "stack" && path[i - 1]?.id && path[i]?.id) {
      const active = stackActiveId(path[i - 1]);
      if (active !== path[i].id) steps.push(["layout.select", { stack: path[i - 1].id, child: path[i].id }]);
    }
  }
  if (!steps.length && path.at(-1)?.id) steps.push(["layout.show", { id: path.at(-1).id }]);
  return steps;
}

/**
 * Every toggleable block showing `mod` in the active layout tree (children only, not floating):
 * [{ id, hidden, show, hide }].
 */
export function blocksOf(tree, mod) {
  if (!tree || typeof tree !== "object" || mod === "workspace-chrome" || mod === "tabs") return [];
  const out = [];
  const visit = (node, path = []) => {
    if (!node || typeof node !== "object") return;
    const here = [...path, node];
    if (node.type === "block" && blockMod(node) === mod && typeof node.id === "string") {
      out.push({ id: node.id, hidden: isPathHidden(here), show: showSteps(here), hide: hideSteps(here) });
    }
    for (const child of node.children ?? []) visit(child, here);
  };
  visit(tree);
  return out;
}

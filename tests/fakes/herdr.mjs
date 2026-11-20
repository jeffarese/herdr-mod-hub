// The `herdr` module, backed by whatever the test put in globalThis.__herdr.
const h = () => globalThis.__herdr;
const findNode = (node, id) => {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
};
export const appHome = () => h().home;
export const exec = (...a) => h().exec(...a);
export const theme = () => new Proxy({}, { get: (_t, k) => (typeof k === "string" ? `#${(k.length * 1234567).toString(16).padStart(6, "0").slice(0, 6)}` : undefined) });
export const props = () => h().props ?? { overlay: "o1" };
export const closeOverlay = (id) => h().closed.push(id);
export const run = (name, args) => {
  h().commands.push({ name, args });
  const tree = h().layout;
  if (tree && typeof tree === "object") {
    if (name === "layout.hide") { const n = findNode(tree, args?.id); if (n) n.hidden = true; }
    else if (name === "layout.show") { const n = findNode(tree, args?.id); if (n) delete n.hidden; }
    else if (name === "layout.select") { const n = findNode(tree, args?.stack); if (n) n.active = args?.child; }
  }
};
export const layout = () => h().layout ?? null;
export const panes = () => [];
export const placement = () => null;
export const setShared = (k, v) => { h().shared[k] = v; };
export const shared = (k) => h().shared?.[k] ?? null;
export const readTextFile = async (path) => { try { return await (await import("node:fs/promises")).readFile(path, "utf8"); } catch { return null; } };
export const writeTextFile = async (path, text) => { await (await import("node:fs/promises")).writeFile(path, text); return null; };
export const settings = () => ({ font: "JetBrains Mono" });
export const watchFolder = () => Promise.reject(new Error("not in tests"));
export const window = () => ({ platform: "macos" });

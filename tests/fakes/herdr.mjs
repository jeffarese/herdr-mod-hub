// The `herdr` module, backed by whatever the test put in globalThis.__herdr.
const h = () => globalThis.__herdr;
export const appHome = () => h().home;
export const exec = (...a) => h().exec(...a);
export const theme = () => new Proxy({}, { get: (_t, k) => (typeof k === "string" ? `#${(k.length * 1234567).toString(16).padStart(6, "0").slice(0, 6)}` : undefined) });
export const props = () => h().props ?? { overlay: "o1" };
export const closeOverlay = (id) => h().closed.push(id);
export const run = (name, args) => h().commands.push({ name, args });
export const readTextFile = async (path) => { try { return await (await import("node:fs/promises")).readFile(path, "utf8"); } catch { return null; } };
export const writeTextFile = async (path, text) => { await (await import("node:fs/promises")).writeFile(path, text); return null; };
export const settings = () => ({ font: "JetBrains Mono" });
export const watchFolder = () => Promise.reject(new Error("not in tests"));
export const window = () => ({ platform: "macos" });

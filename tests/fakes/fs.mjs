// Herdr's fs/promises: Node's, plus exists().
import * as nfs from "node:fs/promises";
export const readFile = (p, enc) => (enc ? nfs.readFile(p, "utf8") : nfs.readFile(p).then((b) => new Uint8Array(b)));
export const writeFile = (p, c) => nfs.writeFile(p, c);
export const readdir = (p, o) => nfs.readdir(p, o);
export const exists = (p) => nfs.access(p).then(() => true, () => false);
export const mkdir = (p, o) => nfs.mkdir(p, o);
export const unlink = (p) => nfs.unlink(p);
export const rmdir = (p) => nfs.rmdir(p);

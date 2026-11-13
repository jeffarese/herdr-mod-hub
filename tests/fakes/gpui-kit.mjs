import { el } from "./element.mjs";
export class View {}
export const div = () => el("div");
export const svg = (path) => el("svg", path);
export const image = (path) => el("image", path);

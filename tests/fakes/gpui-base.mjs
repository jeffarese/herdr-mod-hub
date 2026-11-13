import { el } from "./element.mjs";
export const v_flex = () => el("v_flex");
export const h_flex = () => el("h_flex");
export const InputState = {
  new: (opts = {}) => {
    const handlers = {};
    let value = opts.value ?? "";
    return {
      placeholder: opts.placeholder,
      on: (event, fn) => { (handlers[event] ??= []).push(fn); return true; },
      value: () => value,
      set_value: (v) => { value = v; },
      focus() {},
      type(v, cx) { value = v; for (const fn of handlers.change ?? []) fn({}, cx); },
    };
  },
};
export const Input = { new: (state) => el("input", state.placeholder) };
export const Scrollbar = { vertical: () => el("scrollbar") };
export const TextView = { markdown: (id, md) => { const e = el("markdown"); e.child(md); return e; } };

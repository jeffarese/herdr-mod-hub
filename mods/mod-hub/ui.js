// Small pieces the screen is built from, styled like Herdr's own Settings so the two feel
// like one app. Every color comes from theme(), so light and dark themes both work.

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export const I = (name) => `mods/mod-hub/icons/${name}.svg`;
export const CLEAR = "#00000000";

/** A theme color with an alpha ("#rrggbb" + "26"); colors that carry one already stay. */
export const alpha = (color, aa) => (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${aa}` : color);

export const icon = (name, size = 14, color = null) => {
  const el = svg(I(name)).size(size).flex_none();
  return color ? el.text_color(color) : el;
};

export const spinner = (size = 14, color = null) => {
  const el = svg(I("spinner")).size(size).flex_none().spin(800);
  return color ? el.text_color(color) : el;
};

/** Green, amber and red that read as such in every theme. */
export const tones = (t) => ({
  ok: t.ansi2 ?? t.done,
  warn: t.ansi3 ?? t.working,
  bad: t.blocked ?? t.ansi1,
  info: t.accent,
});

/**
 * A button. kind: "default" | "primary" | "danger" | "ghost" | "subtle". A busy one shows a
 * spinner and ignores clicks; a disabled one is dimmed.
 */
export function button(t, id, label, onClick, opts = {}) {
  const { kind = "default", glyph = null, busy = false, disabled = false, small = false, tip = null } = opts;
  const looks = {
    default: { bg: t.raised, fg: t.foreground, border: t.border, hover: t.hover },
    primary: { bg: t.solid ?? t.accent, fg: t.solid_foreground ?? t.accent_foreground, border: t.solid ?? t.accent, hover: t.solid ?? t.accent },
    danger: { bg: CLEAR, fg: tones(t).bad, border: tones(t).bad, hover: t.hover },
    ghost: { bg: CLEAR, fg: t.muted, border: CLEAR, hover: t.hover },
    subtle: { bg: CLEAR, fg: t.foreground, border: t.border, hover: t.hover },
  };
  const l = looks[kind] ?? looks.default;
  const inert = busy || disabled;
  let el = h_flex()
    .id(id)
    .flex_none()
    .gap(6)
    .items_center()
    .justify_center()
    .px(small ? 9 : 12)
    .h(small ? 26 : 30)
    .rounded(7)
    .border_1()
    .border_color(l.border)
    .bg(l.bg)
    .text_size(small ? 12.5 : 13)
    .text_color(l.fg)
    .when(kind === "primary", (e) => e.font_medium())
    .when(inert, (e) => e.opacity(disabled ? 0.45 : 0.85))
    .when(!inert, (e) => e.cursor_pointer().hover((s) => (kind === "primary" ? s.opacity(0.88) : s.bg(l.hover))))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      if (!inert) onClick(e, cx);
    })
    .when(busy, (e) => e.child(spinner(small ? 12 : 13, l.fg)))
    .when(!busy && Boolean(glyph), (e) => e.child(icon(glyph, small ? 13 : 14, l.fg)))
    .when(Boolean(label), (e) => e.child(label));
  if (tip) el = el.tooltip(tip);
  return el;
}

/** A square icon-only button. */
export function iconButton(t, id, glyph, tip, onClick, opts = {}) {
  const { size = 28, color = t.muted, busy = false } = opts;
  return div()
    .id(id)
    .flex_none()
    .w(size)
    .h(size)
    .flex()
    .items_center()
    .justify_center()
    .rounded(7)
    .text_color(color)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      if (!busy) onClick(e, cx);
    })
    .child(busy ? spinner(Math.round(size * 0.5)) : icon(glyph, Math.round(size * 0.52)));
}

/** A link-styled piece of text. */
export function link(t, id, label, onClick, color = t.accent) {
  return div()
    .id(id)
    .flex_none()
    .text_color(color)
    .cursor_pointer()
    .hover((s) => s.underline())
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      onClick(e, cx);
    })
    .child(label);
}

/** On/off switch, as Settings draws it. */
export function toggle(t, id, on, onClick, opts = {}) {
  const { busy = false, disabled = false, tip = null } = opts;
  let el = div()
    .id(id)
    .flex_none()
    .w(36)
    .h(20)
    .rounded(10)
    .p(2)
    .bg(on ? t.accent : t.hover)
    .flex()
    .items_center()
    .when(on, (e) => e.justify_end())
    .when(disabled, (e) => e.opacity(0.4))
    .when(!disabled && !busy, (e) => e.cursor_pointer())
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      if (!busy && !disabled) onClick(e, cx);
    })
    .child(
      busy
        ? div().w(16).h(16).flex().items_center().justify_center().child(spinner(12, on ? t.accent_foreground : t.muted))
        : div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted),
    );
  if (tip) el = el.tooltip(tip);
  return el;
}

/** A small rounded label. */
export function chip(t, text, opts = {}) {
  const { color = t.muted, bg = t.raised, glyph = null, border = null } = opts;
  return h_flex()
    .flex_none()
    .gap(4)
    .items_center()
    .px(7)
    .h(20)
    .rounded(10)
    .bg(bg)
    .when(Boolean(border), (e) => e.border_1().border_color(border))
    .text_size(11.5)
    .text_color(color)
    .when(Boolean(glyph), (e) => e.child(icon(glyph, 11, color)))
    .child(text);
}

/** A dot, for "needs attention" marks. */
export const dot = (color, size = 7) => div().flex_none().w(size).h(size).rounded(size / 2).bg(color);

/** Section label, upper case, as Settings writes them. */
export function heading(t, text, extra = null) {
  return h_flex()
    .w_full()
    .items_center()
    .gap(8)
    .pt(6)
    .pb(8)
    .child(div().text_size(11.5).font_semibold().text_color(t.dim).child(text.toUpperCase()))
    .when(extra != null, (e) => e.child(div().text_size(11.5).text_color(t.dim).child(String(extra))));
}

const HUES = [4, 5, 6, 2, 3, 1, 12, 13, 14];
/** A stable color for a name, from the theme's terminal palette. */
export function hue(t, name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return t[`ansi${HUES[h % HUES.length]}`] ?? t.accent;
}

/** A mod's tile: its gallery preview when there is one, else its initial on its color. */
export function tile(t, name, size = 36, picture = null) {
  const box = div().flex_none().w(size).h(size).rounded(Math.round(size * 0.24)).overflow_hidden();
  if (picture) return box.bg(t.canvas ?? t.surface).border_1().border_color(t.border).child(image(picture).w(size).h(size));
  const color = hue(t, name);
  const letter = (String(name).replace(/^herdr[-_]/i, "").match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  return box
    .bg(alpha(color, "26"))
    .border_1()
    .border_color(alpha(color, "55"))
    .flex()
    .items_center()
    .justify_center()
    .text_size(Math.round(size * 0.44))
    .font_semibold()
    .text_color(color)
    .child(letter);
}

/** A grey block that pulses while something loads. */
export function skeleton(t, w, h, radius = 6) {
  const el = div().flex_none().h(h).rounded(radius).bg(t.raised).loop("opacity", { from: 0.45, to: 1, period: 1300 });
  return w === "full" ? el.w_full() : el.w(w);
}

/** One fact about a mod: a label on the left, what it is on the right. */
export function fact(t, label, value) {
  return h_flex()
    .w_full()
    .gap(16)
    .py(11)
    .items_start()
    .border_b(1)
    .border_color(t.border)
    .child(div().w(120).flex_none().pt(1).text_size(12.5).text_color(t.dim).child(label))
    .child(v_flex().flex_1().min_w(0).gap(5).text_size(13).text_color(t.foreground).child(value));
}

/** A tinted notice: an update waiting, an error, a warning. */
export function notice(t, tone, glyph, title, body, actions = null) {
  return h_flex()
    .w_full()
    .gap(12)
    .p(12)
    .items_start()
    .rounded(9)
    .bg(alpha(tone, "14"))
    .border_1()
    .border_color(alpha(tone, "44"))
    .child(div().pt(1).child(icon(glyph, 16, tone)))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(3)
        .child(div().text_size(13).font_medium().text_color(t.foreground).child(title))
        .when(Boolean(body), (e) => e.child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(body))),
    )
    .when(Boolean(actions), (e) => e.child(h_flex().flex_none().gap(6).items_center().child(actions)));
}

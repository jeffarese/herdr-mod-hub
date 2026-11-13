// Maps the host's modules to the fakes for files under mods/.
import { registerHooks } from "node:module";
const FAKES = { "gpui-kit": "gpui-kit.mjs", "gpui-base": "gpui-base.mjs", herdr: "herdr.mjs" };
registerHooks({
  resolve(specifier, context, next) {
    if (FAKES[specifier]) return { url: new URL(FAKES[specifier], import.meta.url).href, shortCircuit: true };
    if (specifier === "fs/promises" && context.parentURL?.includes("/mods/")) return { url: new URL("fs.mjs", import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  },
});

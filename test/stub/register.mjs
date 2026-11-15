// Loads the fakes in place of the app's modules, for `node --import ./test/stub/register.mjs`.
//
// The point: a test imports the mod's real source (`import Rail from "../mods/rail/main.js"`)
// and the imports inside it resolve to test/stub/, so nothing is copied, stripped or
// re-evaluated. A name imported from the wrong module still passes here (both fakes are one
// file), which is what test/imports.test.mjs guards.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);

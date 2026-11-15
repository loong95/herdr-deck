// The fake "gpui-kit": primitives, the ones a mod gets from the kit and not from the base.
//
// This file and base.mjs are deliberately separate, so an import from the wrong module fails
// here the way it would in the app ("Could not find export 'Input' in module 'gpui-kit'").
export { div, svg, image, list, uniform_list, byId, textOf, calls, elements } from "./element.mjs";
import { element } from "./element.mjs";

export class View {}
export const Background = { color: (c) => element("bg")._a.color ?? c };
export const PathBuilder = { new: () => element("path") };

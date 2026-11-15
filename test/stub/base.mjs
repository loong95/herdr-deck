// The fake "gpui-base": layout, text and the inputs.
//
// Only the names our mods use are here; a name this file lacks is a name no mod of ours may
// import, which is the point (see kit.mjs). Add to the list when a mod starts using one.
export { byId, textOf, calls, elements, v_flex, h_flex } from "./element.mjs";
import { element, calls as callsRef } from "./element.mjs";

export const TextView = { markdown: (id, text) => { const e = element("md"); e._a.id = id; e._a.text = text; return e; } };
export const Scrollbar = { vertical: () => element("sb"), horizontal: () => element("sb") };

const scrollHandle = () => ({ scroll_to_item: (i, s) => callsRef.push(["scroll_to_item", i, s]), scroll_to_bottom: () => callsRef.push(["bottom"]) });
export const ScrollHandle = { new: scrollHandle };
export const VirtualListScrollHandle = ScrollHandle;
export const v_virtual_list = (id, count, sizes, key, render) => {
  const e = element("vlist");
  e._args = { id, count, sizes, key, render };
  return e;
};
export const h_virtual_list = v_virtual_list;

const state = () => {
  let value = "";
  const handlers = {};
  return {
    value: () => value,
    set_value: (v) => { value = v; },
    replace: (v) => { value += v; },
    on: (event, fn) => { handlers[event] = fn; return true; },
    focus() {},
    _h: handlers,
  };
};
export const InputState = { new: state };
export const TextareaState = { new: state };
export const Textarea = { new: () => element("textarea") };
export const Input = { new: () => element("input") };

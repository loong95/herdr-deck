// The element tree a mod builds, shared by the two fake kits.
//
// Every builder is a Proxy, so any chain of styling calls works without being listed here; what
// matters is kept: children (child/children), ids (_a.id), handlers (_h) and text, so a test can
// walk the tree (byId, textOf) and fire a click. `when(cond, fn)` runs fn, as the real kit does
// — a branch that would throw is a broken render, not a quirk of the stub.
const made = [];
export const calls = [];

export const element = (tag) => {
  const node = { tag, kids: [], _h: {}, _a: {} };
  const p = new Proxy(node, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key === "symbol") return undefined;
      return (...args) => {
        if (key === "child") { t.kids.push(args[0]); return p; }
        if (key === "children") { const c = args[0] ?? []; if (Array.isArray(c)) t.kids.push(...c); return p; }
        if (key === "when") { if (args[0]) { const out = args[1]?.(p); if (out && out !== p && typeof out === "object") return out; } return p; }
        if (typeof key === "string" && (key.startsWith("on_") || key === "hover")) {
          t._h[key === "on_mouse_down" ? `on_mouse_down_${args[0]}` : key] = args[args.length - 1];
          return p;
        }
        if (key === "track_scroll") { t.track = args[0]; return p; }
        t._a[key] = args.length <= 1 ? args[0] : args;
        return p;
      };
    },
    set(t, key, value) { t._a[key] = value; return true; },
  });
  made.push(p);
  return p;
};

const build = (tag) => () => element(tag);
export const div = build("div");
export const v_flex = build("v");
export const h_flex = build("h");
export const svg = (path) => { const e = element("svg"); e._a.path = path; return e; };
export const image = (path) => { const e = element("image"); e._a.path = path; return e; };
export const list = () => element("list");
export const uniform_list = () => element("ulist");



// Every element built in this run (a leak check, and handy in a test).
export const elements = () => made;

// The first element (depth first) whose id is `id`.
export function byId(el, id) {
  if (!el || typeof el !== "object") return null;
  if (el._a?.id === id) return el;
  for (const kid of el.kids ?? []) {
    const found = byId(kid, id);
    if (found) return found;
  }
  return null;
}

// All the text in a tree, for an assertion about what is on screen.
export function textOf(el) {
  if (el == null) return "";
  if (typeof el === "string" || typeof el === "number") return String(el);
  const own = typeof el._a?.text === "string" ? el._a.text : "";
  return [own, ...(el.kids ?? []).map(textOf)].filter(Boolean).join(" ");
}

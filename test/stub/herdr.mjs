// The "herdr" module for a mod under test.
//
// Two ways to drive it, both alive at once:
//   - the new one: `fake` holds the world (spaces, panes, the layout document, what exec
//     answers) and `log` holds what the mod asked for.
//   - the one the first tests were written against: a `globalThis.__x` wins when a test set it,
//     which is why those tests only had to stop building their own module loader.
// A test that sets globalThis.__x is asking for that field; everything else comes from `fake`.
import * as realFs from "node:fs";

export const fake = {
  props: {}, spaces: undefined, panes: [], agents: [], focused: null, shared: {}, home: "/home/test",
  appHome: "/home/test/.config/herdr-app", layout: null, exec: null, readText: null, writeText: null,
  onRun: null, settings: { zoom: 1 }, window: { platform: "macos", titlebar: "none", maximum: false },
};

export const log = { exec: [], run: [], overlays: [], closed: [], notify: [], shared: [], writes: [], order: [] };

// What a space looks like when a test does not say (the panel reads it on every tick).
const DEFAULT_SPACES = [{ id: "s1", name: "api", folder: "/home/dev", machine: "wsl", active: true, tabs: [{ id: "tb1" }, { id: "tb2" }] }];

const pick = (name, fallback) => (name in globalThis ? globalThis[name] : fallback);
const list = (name, own) => (name in globalThis ? globalThis[name] : own);

export const spaces = () => pick("__spaces", fake.spaces) ?? DEFAULT_SPACES;
export const panes = () => pick("__panes", fake.panes) ?? [];
export const agents = () => pick("__agents", fake.agents) ?? [];
export const terminals = () => pick("__terminals", fake.terminals) ?? [];
export const focused = () => pick("__focused", fake.focused) ?? null;
export const layout = () => pick("__tree", fake.layout);
export const props = () => pick("__props", fake.props) ?? {};
export const home = () => pick("__home", fake.home);
export const appHome = () => pick("__appHome", fake.appHome);
export const settings = () => pick("__settings", fake.settings) ?? { zoom: 1 };
export const window = () => pick("__window", fake.window);
export const layouts = () => ["main", "deck"];

export const shared = (key) => (pick("__shared", fake.shared) ?? {})[key];
export const setShared = (key, value) => {
  const store = pick("__shared", fake.shared);
  store[key] = value;
  log.shared.push([key, value]);
  return null;
};

// The app's exec: recorded, then answered by the test (globalThis.__reply / fake.exec).
export const exec = async (cmd, args = [], opts) => {
  const at = list("__calls", log.exec);
  if (Array.isArray(at) && at !== log.exec) at.push({ cmd, args, opts });
  else log.exec.push({ cmd, args, opts });
  // __reply is what most tests set; __exec is the name pi-sessions' test used.
  const reply = globalThis.__exec ?? globalThis.__reply ?? fake.exec;
  if (!reply) return { code: 127, stdout: "", stderr: "no exec in this test" };
  return reply(cmd, args, opts);
};
export const hc = (args) => exec("hc", args);

export const run = (name, args) => {
  const at = list("__runs", log.run);
  at.push([name, args]);
  pick("__apply", fake.onRun)?.(name, args);
  return null;
};

export const openOverlay = (spec) => {
  pick("__overlays", log.overlays).push(spec);
  return "o1";
};
export const closeOverlay = (id) => { pick("__closed", log.closed).push(id); return null; };
export const notify = (n) => { log.notify.push(n); return null; };
export const playSound = () => null;
export const pickFolder = async () => null;
export const setAgentOrder = (order) => { log.order.push(order); return null; };
// A test can drive the app's commands: globalThis.__nextCommand (a promise per call), so
// __send("...") reaches every copy of a mod, as a broadcast does.
export const nextCommand = () => (globalThis.__nextCommand ? globalThis.__nextCommand() : new Promise(() => {}));
export const watchFolder = () => new Promise(() => {});
export const readTextFile = async (path, options) => {
  const read = pick("__readTextFile", fake.readText);
  return read ? read(path, options) : null;
};
export const writeTextFile = async (path, text, expected) => {
  log.writes.push([path, text, expected]);
  return fake.writeText ? fake.writeText(path, text, expected) : null;
};
export const commands = () => [];
// The app's key bindings, for the menu mods that read them.
export const keys = () => ({ global: {}, terminal: {} });

// Colours: any key answers a CSS-ish string, so a test never has to name them all.
export const theme = () => new Proxy({}, { get: (_t, key) => (typeof key === "string" ? `#${key}` : undefined) });

// localStorage: gitlab-mr and mr-review remember a choice, and the tests write into __ls.
globalThis.__ls ??= {};
globalThis.localStorage = {
  getItem: (k) => (globalThis.__ls ?? {})[k] ?? null,
  setItem: (k, v) => { (globalThis.__ls ??= {})[k] = String(v); },
  removeItem: (k) => { delete (globalThis.__ls ?? {})[k]; },
};

// A test that wants the real thing (a temp folder of session files) still gets it.
export const real = realFs;

// fs/promises for a mod under test: the test's own object when it set one (globalThis.__fs),
// else the real thing. The names are the ones our mods import; add one here when a mod
// starts using it, so the fake never answers with a different shape than the app's.
import * as real from "node:fs/promises";

const swap = (name) => (...args) => (globalThis.__fs?.[name] ?? real[name])(...args);

export const readdir = swap("readdir");
export const readFile = swap("readFile");
export const writeFile = swap("writeFile");
export const mkdir = swap("mkdir");
export const stat = swap("stat");
export const rm = swap("rm");
export const realpath = swap("realpath");

export default { ...real, readdir, readFile, writeFile, mkdir, stat, rm, realpath };

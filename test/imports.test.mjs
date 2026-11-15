// Every mod loads. Cheap, but it catches what the app would only tell you at start: a typo in
// an import, a name that does not exist, a module that throws while it is being read.
//
// The fakes are split by module (kit.mjs / base.mjs), so a name imported from the wrong one
// fails here exactly as it does in Herdr: "Could not find export 'Input' in module 'gpui-kit'".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const MODS = fileURLToPath(new URL("../mods/", import.meta.url));

test("every mod folder's main.js loads, and exports a view", async () => {
  const folders = readdirSync(MODS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.ok(folders.length >= 6, "the mods are where they are expected");
  for (const name of folders) {
    const file = join(MODS, name, "main.js");
    assert.ok(existsSync(file), `${name}: no main.js`);
    const mod = await import(new URL(`../mods/${name}/main.js`, import.meta.url).href);
    assert.equal(typeof mod.default, "function", `${name}: no default export to instantiate`);
    assert.equal(mod.default.prototype instanceof (await import("./stub/kit.mjs")).View, true, `${name}: the default export is not a View`);
  }
});

test("every mod has a manifest with a place", () => {
  for (const name of readdirSync(MODS)) {
    const manifest = join(MODS, name, "mod.json");
    if (!existsSync(manifest)) continue;
    const json = JSON.parse(readFileSync(manifest, "utf8"));
    assert.equal(typeof json.place, "string", `${name}: mod.json has no place`);
  }
});

// The layout, the mods and the installer agree with each other.
//
// This is the guard for the kind of change that leaves everything green and the window empty:
// a block naming a mod folder that was renamed (dock -> rail), a mod the installer forgot, a
// rail row pointing at a stack child that is no longer there, a test nobody runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const layout = JSON.parse(read("layouts", "deck.json"));
const modFolders = readdirSync(join(ROOT, "mods"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

const walk = (node, out = []) => {
  out.push(node);
  for (const kid of node.children ?? []) walk(kid, out);
  return out;
};
const nodes = walk(layout);
const blocks = nodes.filter((n) => n.type === "block");
const byId = (id) => nodes.find((n) => n.id === id);

// Herdr's own mods, which this layout arranges but does not carry (it replaces them at start).
const SHIPPED = new Set(["workspace-chrome", "spaces", "agents", "tabs", "files", "changes", "pane", "workspace-status"]);

// A mod that draws in a block of this layout, or one that is opened some other way.
const IN_THE_LAYOUT = new Set(blocks.filter((b) => b.content?.mod).map((b) => b.content.mod));
const ELSEWHERE = new Map([
  ["menu-pi", "the terminal right-click menu (layout.terminal_menu)"],
  ["pi-gui", "opened by mod.open:pi-gui, split beside a terminal"],
  ["mr-review", "opened in a tab by gitlab-mr (tab.new {mod: \"mr-review\"})"],
]);

test("every block that names a mod names a folder that exists", () => {
  for (const block of blocks) {
    const mod = block.content?.mod;
    if (!mod || SHIPPED.has(mod)) continue;
    assert.ok(existsSync(join(ROOT, "mods", mod, "main.js")), `block "${block.id}" wants mod "${mod}", which is not in mods/`);
  }
});

test("the only block without a mod is the tab's panes", () => {
  const bare = blocks.filter((b) => !b.content?.mod);
  assert.deepEqual(bare.map((b) => [b.id, b.content?.tab]), [["main", "active"]]);
});

test("every mod is either in the layout or named as opened elsewhere", () => {
  for (const name of modFolders) {
    assert.ok(IN_THE_LAYOUT.has(name) || ELSEWHERE.has(name), `mods/${name} is in no block of deck.json — say how it is opened, or drop it`);
  }
  assert.equal(layout.terminal_menu, "menu-pi");
});

test("the installer installs every mod", () => {
  const script = read("install.ps1");
  const installed = new Set([...script.matchAll(/"mods\/([a-z0-9-]+)"/g)].map((m) => m[1]));
  for (const name of modFolders) assert.ok(installed.has(name), `install.ps1 does not install mods/${name}`);
  assert.ok(installed.has("menu-pi"));
});

test("no mod folder shadows one of Herdr's own", () => {
  // Herdr replaces its shipped mods at start, so a local "agents" is silently not ours: the
  // block draws Herdr's own panel, and nothing says so. Ship a name of our own.
  for (const name of modFolders) {
    assert.ok(!SHIPPED.has(name), `mods/${name} has the name of a shipped mod — Herdr's own would be drawn instead`);
  }
});

test("the rail's rows point at children that are in the layout, with icons that exist", () => {
  const rail = read("mods", "rail", "main.js");
  const entries = rail.slice(rail.indexOf("const ENTRIES"), rail.indexOf("const STACK"));
  // One row per {...} in ENTRIES; a row names a stack (a column beside the rail) or a screen.
  const rows = [...entries.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).map((body) => ({
    child: /child:\s*"([^"]+)"/.exec(body)?.[1],
    icon: /icon:\s*"([^"]+)"/.exec(body)?.[1],
    stack: /stack:\s*"([^"]+)"/.exec(body)?.[1],
    screen: /screen:\s*"([^"]+)"/.exec(body)?.[1],
  })).filter((row) => row.child);
  assert.ok(rows.length >= 4, "the rail has rows");

  for (const row of rows) {
    const stackId = row.screen ?? row.stack ?? /const STACK = "([^"]+)"/.exec(rail)[1];
    const stack = byId(stackId);
    assert.ok(stack && stack.type === "stack", `no stack "${stackId}" in deck.json`);
    const children = (stack.children ?? []).map((c) => c.id);
    assert.ok(children.includes(row.child), `the rail's "${row.child}" is not a child of "${stackId}" (${children.join(", ")})`);
    if (row.icon) assert.ok(existsSync(join(ROOT, ...row.icon.split("/"))), `the rail's icon ${row.icon} is missing`);
  }

  // Every child of the sidepanel is a row: an orphan would never be shown. The screens stack
  // keeps one child (the tab's own panes) that is reached by closing the board, not by a row.
  const sidepanel = byId("sidepanel");
  for (const id of (sidepanel.children ?? []).map((c) => c.id)) {
    assert.ok(rows.some((row) => row.child === id && (row.stack ?? "sidepanel") === "sidepanel"), `"${id}" is in the sidepanel but has no rail row`);
  }
});

test("npm test runs every test file", () => {
  const script = JSON.parse(read("package.json")).scripts.test;
  const files = readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.mjs"));
  assert.ok(files.length >= 4, files.join(", "));
  // Either the whole folder is asked for, or each file is named — nothing may fall between.
  if (script.includes("test/*.test.mjs")) return;
  for (const f of files) assert.ok(script.includes(f), `package.json's test script skips test/${f}`);
});

test("the tests run against the fakes, never the app", () => {
  const script = JSON.parse(read("package.json")).scripts.test;
  assert.match(script, /--import \.\/test\/stub\/register\.mjs/, "the register hook is what puts the fakes in place");
});

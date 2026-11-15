// The markdown splitter pi-gui draws its own code boxes and tables from. Pure: no gpui, no
// app, so this runs under bare node (it does not need the register hook).
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitBlocks, tableStarts, tableCells, columnWidths, hasBlocks } from "../mods/pi-gui/blocks.js";

const FENCE = "\u0060\u0060\u0060";

test("text around a fence comes out in order", () => {
  const blocks = splitBlocks(["before", FENCE + "js", "let a = 1;", FENCE, "after"].join("\n"));
  assert.deepEqual(blocks.map((b) => b.k), ["md", "code", "md"]);
  assert.equal(blocks[1].lang, "js");
  assert.deepEqual(blocks[1].lines, ["let a = 1;"]);
  assert.equal(blocks[0].text, "before");
  assert.equal(blocks[2].text, "after");
});

test("a fence's info string gives up only its first word", () => {
  assert.equal(splitBlocks(FENCE + "ts title=a.ts").find((b) => b.k === "code").lang, "ts");
});

test("a tilde fence works, and an unclosed fence runs to the end", () => {
  const blocks = splitBlocks(["~~~", "x", "y"].join("\n"));
  assert.deepEqual(blocks, [{ k: "code", lang: "", text: "x\ny", lines: ["x", "y"] }]);
});

test("a longer closing fence closes, a different character does not", () => {
  const blocks = splitBlocks([FENCE, "a", FENCE + FENCE, "after"].join("\n"));
  assert.equal(blocks.length, 2, "the quadruple fence closed it");
  assert.equal(blocks[1].text, "after");
  const tildes = splitBlocks([FENCE, "a", "~~~", "b"].join("\n"));
  assert.equal(tildes.length, 1, "a tilde line does not close a backtick fence");
});

test("an empty fence is an empty box, not a box with one empty line", () => {
  const blocks = splitBlocks([FENCE, FENCE].join("\n"));
  assert.deepEqual(blocks[0].lines, []);
  assert.equal(blocks[0].text, "");
});

test("a markdown block of blank lines only is left out", () => {
  assert.deepEqual(splitBlocks("\n\n  \n"), []);
  assert.deepEqual(splitBlocks(""), []);
});

test("a table is a table only with its separator row", () => {
  assert.equal(tableStarts(["| a | b |", "| --- | --- |"], 0), true);
  assert.equal(tableStarts(["| a | b |", "not a separator"], 0), false);
  const blocks = splitBlocks(["| a | b |", "| --- | ---: |", "| 1 | 2 |", "| 3 | 4 |", "tail"].join("\n"));
  assert.deepEqual(blocks.map((b) => b.k), ["table", "md"]);
  assert.deepEqual(blocks[0].head, ["a", "b"]);
  assert.deepEqual(blocks[0].align, ["left", "right"]);
  assert.deepEqual(blocks[0].rows, [["1", "2"], ["3", "4"]]);
});

test("alignment is read from the separator", () => {
  const table = splitBlocks(["|a|b|c|", "|:--|:--:|--:|", "|x|y|z|"].join("\n"))[0];
  assert.equal(table.k, "table");
  assert.deepEqual(table.align, ["left", "center", "right"]);
  assert.equal(splitBlocks(["|a|b|", "|x|y|"].join("\n"))[0].k, "md", "without a separator it is prose");
});

test("a pipe inside code or escaped stays in its cell", () => {
  assert.deepEqual(tableCells("| a \\| b | `x | y` |"), ["a | b", "`x | y`"]);
  assert.deepEqual(tableCells("a|b"), ["a", "b"]);
  assert.deepEqual(tableCells("| a | b |"), ["a", "b"]);
});

test("a column is as wide as its longest cell, within the cap", () => {
  const widths = columnWidths([["a", "x".repeat(200)], ["bb", "y"]], 2);
  assert.ok(widths[0] >= 64, "a narrow column keeps a minimum");
  assert.equal(widths[1], 260, "a long column stops at the cap");
});

test("only fences and tables are worth drawing by hand", () => {
  assert.equal(hasBlocks("plain **markdown** only"), false);
  assert.equal(hasBlocks("a\n| a | b |\n| --- | --- |\n| 1 | 2 |"), true);
  assert.equal(hasBlocks(FENCE + "\nx\n" + FENCE), true);
});

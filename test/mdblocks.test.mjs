// What pi-gui draws for a text with a fence or a table in it: a code box with the indentation
// kept, and a table with one fixed width per column. The elements come from the fakes, so the
// tree can be walked here the way the app would walk it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownView, codeMarkdown, codeCopyText } from "../mods/pi-gui/mdblocks.js";
import { byId, textOf } from "./stub/element.mjs";
import { theme } from "./stub/herdr.mjs";

const t = theme();
const FENCE = "\u0060\u0060\u0060";

test("plain prose is still one TextView, unchanged", () => {
  const el = markdownView("r1", "just **words**", t, { mono: "Menlo", size: 13 });
  assert.equal(el.tag, "md");
  assert.equal(el._a.text, "just **words**");
});

test("a fence becomes a code box with the source in it", () => {
  const el = markdownView("r2", ["before", FENCE + "js", "let a = 1;", FENCE].join("\n"), t, { mono: "Menlo", size: 13 });
  const box = byId(el, "md-r2-k1");
  assert.ok(box, "the code box is there, by the id a click would look for");
  assert.equal(box._a.font_family, "Menlo");
  // The box hands TextView escaped markdown, so the punctuation is drawn and not read as markup.
  assert.equal(box.kids[0]._a.text, codeMarkdown("let a = 1;"));
});

test("the indentation of a code line survives as no-break spaces", () => {
  // A plain leading space is what markdown drops; the box hands TextView no-break ones.
  assert.equal(codeMarkdown("  x"), "\u00a0\u00a0x");
  assert.equal(codeMarkdown(""), "\u00a0");
  assert.equal(codeMarkdown("a\tb"), "a    b");
  // Punctuation is escaped so it is drawn, not read as markup.
  assert.match(codeMarkdown("**bold**"), /\\\*\\\*bold/);
  assert.equal(codeCopyText("a\r\nb"), "a\nb");
});

test("a table gets a column per cell, and every row a cell in each", () => {
  const text = ["| a | b |", "| --- | --: |", "| 1 | 2 |", "| longer | 4 |"].join("\n");
  const el = markdownView("r3", text, t, { mono: "Menlo", size: 13 });
  const table = byId(el, "md-r3-t0");
  assert.ok(table, "the table is there");
  // head + two rows, each with one cell per column
  const rows = table.kids.filter((k) => k.tag === "h");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kids.length, 2);
  assert.match(textOf(rows[0]), /a b/);
  assert.match(textOf(rows[2]), /longer 4/);
});

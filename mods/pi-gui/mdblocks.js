// Markdown with our own code boxes and tables.
//
// Herdr's TextView.markdown takes no style: a fence is drawn square with no background, and a
// table in a flexible cell keeps its one-line width and spills out. So the text is split
// (blocks.js) and fences and tables are drawn here; the prose between them stays TextView.
//
// Adapted from Flockbook's herdr-app mod (github.com/minchenlee/flockbook, MIT,
// Copyright (c) 2026 Minchen Lee).
import { div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { splitBlocks, columnWidths, hasBlocks } from "./blocks.js";

const NBSP = "\u00a0";

// The block as written, for a copy button somewhere else.
export function codeCopyText(text) {
  return String(text ?? "").split("\n").map((line) => line.replace(/\r$/, "")).join("\n");
}

// The block as one markdown paragraph: punctuation escaped (drawn as text, not markup), leading
// spaces as no-break spaces (markdown drops them), tabs as 4, an empty line as one no-break
// space (else the paragraph ends), lines joined by hard breaks. That is how a code box keeps its
// indentation inside a TextView.
export function codeMarkdown(text) {
  return codeCopyText(text).split("\n").map((line) => {
    const escaped = line.replace(/\t/g, "    ").replace(/[!-/:-@[-\`{-~]/g, "\\$&");
    return escaped.replace(/^ +/, (spaces) => NBSP.repeat(spaces.length)) || NBSP;
  }).join("\\\n");
}

function codeBox(key, block, t, mono, size) {
  return v_flex().id(key).w_full().my(4).px(10).py(8).rounded(8).bg(t.input).border_1().border_color(t.border)
    .font_family(mono).text_size(size - 1 > 0 ? size - 1 : size).text_color(t.foreground)
    .child(TextView.markdown(key + "-t", codeMarkdown(block.text)).selectable(true));
}

// A fixed width per cell: a TextView in a flexible cell keeps its full one-line width and spills
// out of the table, so the widths come from the content (blocks.js columnWidths).
function table(id, block, t, size) {
  const count = Math.max(block.head.length, ...block.rows.map((row) => row.length));
  const widths = columnWidths([block.head, ...block.rows], count);
  const cell = (key, text, column, head) => div().w(widths[column]).flex_none().overflow_hidden().px(10).py(5)
    .when(block.align[column] === "right", (el) => el.text_right())
    .when(block.align[column] === "center", (el) => el.text_center())
    .when(head, (el) => el.font_semibold().text_color(t.foreground))
    .child(TextView.markdown(key, String(text ?? "")).selectable(true));
  const row = (cells, index, head) => h_flex().w_full().items_start()
    .when(head, (el) => el.bg(t.raised).rounded_t(7))
    .when(!head, (el) => el.border_t_1().border_color(t.border))
    .children(Array.from({ length: count }, (_v, column) => cell(`${id}-c${index}-${column}`, cells[column], column, head)));
  return v_flex().id(id).w_full().my(4).rounded(8).border_1().border_color(t.border)
    .text_size(size - 1 > 0 ? size - 1 : size).text_color(t.muted).overflow_hidden()
    .child(row(block.head, "h", true))
    .children(block.rows.map((cells, index) => row(cells, index, false)));
}

// The whole text as one element: prose through TextView, fences and tables drawn here.
// `id` keeps the TextView ids unique per row; a text without a fence or a table comes back as
// the one TextView it used to be, so nothing changes for the common answer.
export function markdownView(id, text, t, { mono = "monospace", size = 13 } = {}) {
  if (!hasBlocks(text)) return TextView.markdown("m" + id, text).text_size(size);
  const prose = (key, md) => TextView.markdown(key, md).text_size(size).selectable(true);
  return v_flex().w_full().children(splitBlocks(text).map((block, index) =>
    block.k === "code" ? codeBox(`md-${id}-k${index}`, block, t, mono, size)
      : block.k === "table" ? table(`md-${id}-t${index}`, block, t, size)
        : prose(`md-${id}-${index}`, block.text)));
}

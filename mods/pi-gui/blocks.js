// Markdown split into the blocks this panel draws itself: code fences and tables.
//
// Adapted from Flockbook's herdr-app mod (github.com/minchenlee/flockbook, MIT,
// Copyright (c) 2026 Minchen Lee) — the same problem: Herdr's TextView.markdown
// takes no style, so a code fence comes out square with no background, and a table
// in a flexible cell keeps its one-line width and spills out of the row.
// Pure on purpose (no gpui, no herdr), so test/blocks.test.mjs runs it under bare node.

// A fence, as in CommonMark: ``` or ~~~ (3 or more), then an info string. The language is
// the info's first word ("\`\`\`js title=a.js" is js). A backtick fence's info has no backtick.
const OPEN = /^\s*(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const TILDE_OPEN = /^\s*(~{3,})\s*(\S*).*$/;
// A closing fence: the same character, at least as many, nothing after it but spaces.
const closes = (line, fence) => {
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(m) && m[1][0] === fence[0] && m[1].length >= fence.length;
};

// A table's separator row: "| --- | :--: |".
export const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
// A table starts at a pipe line with a separator row under it.
export const tableStarts = (lines, i) => /^\s*\|/.test(lines[i]) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]);

const alignOf = (cell) => {
  const c = cell.trim();
  return c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left";
};

// "| a | b |" -> ["a", "b"]. An escaped pipe and pipes inside `code` stay in the cell.
export function tableCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

// [{k:"md", text}, {k:"code", lang, text, lines}, {k:"table", head, align, rows}] in order. A code
// block's `lines` are its source lines (none for an empty box; `text` cannot tell that from one
// empty line). An unclosed fence runs to the end. A markdown block of blank lines only is left out.
export function splitBlocks(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let md = [];
  const flush = () => { if (md.length && md.join("\n").trim()) out.push({ k: "md", text: md.join("\n") }); md = []; };
  for (let i = 0; i < lines.length; i++) {
    const fence = OPEN.exec(lines[i]) ?? TILDE_OPEN.exec(lines[i]);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !closes(lines[i], fence[1])) body.push(lines[i++]);
      out.push({ k: "code", lang: fence[2] || "", text: body.join("\n"), lines: body });
      continue;
    }
    if (tableStarts(lines, i)) {
      flush();
      const head = tableCells(lines[i]);
      const align = tableCells(lines[i + 1]).map(alignOf);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(tableCells(lines[i++]));
      i--;
      out.push({ k: "table", head, align, rows });
      continue;
    }
    md.push(lines[i]);
  }
  flush();
  return out;
}

// True when the text has anything this panel draws better than TextView: a fence or a table.
export function hasBlocks(text) {
  const blocks = splitBlocks(text);
  return blocks.some((b) => b.k !== "md");
}

// A column's width from what is in it: long cells get more room, within a cap. Two characters of
// padding and a minimum keep a narrow column readable.
export function columnWidths(rows, count, { px = 7.2, min = 64, max = 260 } = {}) {
  const widths = Array.from({ length: count }, () => min);
  for (const row of rows) {
    for (let c = 0; c < count; c++) {
      const text = String(row[c] ?? "");
      widths[c] = Math.max(widths[c], Math.min(max, Math.ceil(text.length * px) + 24));
    }
  }
  return widths;
}

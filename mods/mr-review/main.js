// One merge request, reviewed here instead of in the browser: the changed files on the
// left, their diff on the right, merge and close along the top. It is opened as a tab of
// its own, so the diff gets the full width of the window. Everything comes from the API:
// the repo does not have to be on this machine, and nothing is written into a local .git.

import { View, div, list } from "gpui-kit";
import { h_flex, v_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, nextCommand, openOverlay, props, setShared, shared, settings, theme } from "herdr";

const TIMEOUT = 45000;
// glab on this Windows box takes 13–17 s for one API round trip, the same call on WSL
// takes under 2 s, so the machine the space lives on is passed in and used for all of it.
const ACTION_TIMEOUT = 90000;
// How often to ask again while a review is open: enough to notice someone else merging
// it, cheap next to reading a diff.
const REFRESH = 60000;
// A confirmation is only worth acting on for this long. The dialog says "that one is
// done" and nothing else, so anything older than this was left over from another ask.
const CLAIM = 120000;
const MAXFILES = 1000; // the cap the built-in Changes panel uses
const MAXROWS = 1500;
const MAXLINE = 4000;

// The payload key the confirmation hands back through, and the view choices: kept in
// shared state rather than localStorage because localStorage belongs to one copy, and a
// second review tab should open the way the first one was left.
const PENDING = "mr-review.pending";
// What a merge or a close leaves for the list to read: `path!iid` -> when it happened.
const DONE = "mr-review.done";
const DONE_KEEP = 15 * 60e3;
const VIEW = "mr-review.view";
const DEFAULTS = { files: "flat", diff: "unified", desc: false, wrap: "wrap" };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// How long the ✓ stays on the header's number after a copy: long enough to be seen, short
// enough that the header goes back to being a header.
const FLASH = 1200;

// The list reads this: an MR that was merged or closed here is off it before glab is asked
// again, because a row that is already decided should not sit there for another poll.
export function markDone(path, iid, now = Date.now()) {
  const old = shared(DONE) ?? {};
  const next = { [`${path}!${iid}`]: now };
  for (const [k, at] of Object.entries(old)) {
    if (now - Number(at) < DONE_KEEP) next[k] = at;
  }
  setShared(DONE, next);
  return next;
}

// GitLab's own verdict on whether the MR can go in, said shortly. Every value the API
// documents is here: `need_rebase` and `commits_status` are what this instance hands out for
// "合并被阻止：快进合并不成立" and a missing commit, and a verdict that is not in this table
// reads as the raw value with no colour rather than as nothing at all.
const STATUS = {
  mergeable: ["可合并", "done"],
  approvals_satisfied: ["已批准", "done"],
  conflict: ["有冲突", "blocked"],
  need_rebase: ["需先 rebase", "blocked"],
  commits_status: ["提交不齐", "blocked"],
  detached: ["落后于目标分支", "blocked"],
  ci_must_pass: ["流水线在跑", "working"],
  ci_still_running: ["流水线在跑", "working"],
  ci_stopped: ["流水线停了", "blocked"],
  approvals_blocked: ["待批准", "working"],
  not_approved: ["待批准", "working"],
  blocked_status: ["被别的 MR 挡住", "blocked"],
  discussions_not_resolved: ["讨论未解决", "blocked"],
  requested_changes: ["要求修改", "blocked"],
  status_checks_must_pass: ["外部检查未过", "blocked"],
  locked_paths: ["文件被锁", "blocked"],
  security_policy_violations: ["安全策略不允许", "blocked"],
  title_regex: ["标题不合规", "blocked"],
  jira_association_missing: ["缺 Jira 关联", "blocked"],
  merge_time: ["不在允许合并的时段", "blocked"],
  branch_missing: ["源分支不见了", "blocked"],
  approvals_syncing: ["批准同步中", "dim"],
  draft_status: ["草稿", "dim"],
  unchecked: ["检查中", "dim"],
  checking: ["检查中", "dim"],
  not_open: ["已不在评审中", "dim"],
};

// How many comments are drawn, newest kept: an MR argued over for a year has hundreds, and
// a review tab that pages through them all on a 60 s poll is a lot of round trips for rows
// nobody scrolls to.
const MAXTALK = 300;

// What the newest pipeline of this MR is doing. `detailed_merge_status` only says that CI
// stands between the MR and the merge; this is the run itself, with the id that leads to it.
const CI = {
  success: ["流水线通过", "done"],
  failed: ["流水线失败", "blocked"],
  canceled: ["流水线已取消", "blocked"],
  skipped: ["流水线已跳过", "dim"],
  manual: ["流水线待手动", "working"],
  running: ["流水线在跑", "working"],
  pending: ["流水线排队", "working"],
  preparing: ["流水线准备中", "working"],
  waiting_for_resource: ["流水线等资源", "working"],
  created: ["流水线排队", "dim"],
  scheduled: ["流水线已排期", "dim"],
};

// The MR's pipelines, newest first as GitLab lists them: the first one is the run the
// verdict is about, and a review does not have room for the history of it.
export function pipelineOf(pipes) {
  const p = (Array.isArray(pipes) ? pipes : []).find(Boolean);
  if (!p) return null;
  const [label, tone] = CI[p.status] ?? ["流水线 " + String(p.status ?? ""), "dim"];
  return {
    id: p.id ?? 0,
    status: String(p.status ?? ""),
    label,
    tone,
    sha: String(p.sha ?? "").slice(0, 8),
    url: String(p.web_url ?? ""),
    at: Date.parse(p.updated_at ?? p.created_at) || 0,
  };
}

// One row per note, in the order the MR was talked about. A discussion's notes are read in
// sequence, so a reply sits under the comment it answers; `resolved` and the file a thread
// hangs on belong to the discussion, and are said again on each of its notes because that is
// where they are read. System notes are kept — "changed the description" is often the answer
// to why the diff moved — but flagged, to be drawn as the small print they are.
export function talkRows(discussions) {
  const out = [];
  for (const d of Array.isArray(discussions) ? discussions : []) {
    for (const n of Array.isArray(d?.notes) ? d.notes : []) {
      const at = n.position ?? {};
      const path = String(at.new_path ?? at.old_path ?? "");
      const line = at.new_line ?? at.old_line ?? null;
      const body = String(n.body ?? "");
      out.push({
        id: "n" + String(n.id ?? out.length),
        who: n.author?.name || n.author?.username || "?",
        at: Date.parse(n.created_at) || 0,
        system: Boolean(n.system),
        resolved: n.resolvable ? Boolean(n.resolved) : null,
        where: path ? (line ? path + ":" + line : path) : "",
        plain: mdInline(body.split("\n")[0] ?? ""),
        body: mdLines(body),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export const enc = (path) => String(path).split("/").map(encodeURIComponent).join("%2F");

// glab wraps failures in a padded box and prefixes `glab: `, and an API error arrives
// as a bare `{"message":"404 Project Not Found"}glab: HTTP 404 (HTTP 404)`. What is
// left after dropping the frame, the prefix and the repeated code is the reason.
export function say(e) {
  const text = String(typeof e === "string" ? e : e?.message ?? e);
  const api = text.match(/^\s*\{"message":"(.+?)"\}/);
  if (api) return api[1];
  const noise = /^(ERROR|Try .* for usage\.?)$/i;
  const clean = (l) => l.trim().replace(/^glab:\s*/, "").replace(/\s*\(HTTP \d+\)$/, "");
  return text.split("\n").map(clean).find((l) => l && !noise.test(l)) || "glab 没有回应";
}

// The reference an agent can be handed, the way GitLab writes one across projects:
// `acme/team/db!3`. A bare iid is not a reference — every project has its own !3 — and a URL is
// not what an agent wants to parse out of a sentence.
export function refOf(path, iid, mark = "!") {
  const project = String(path ?? "");
  return project ? `${project}${mark}${iid}` : `${mark}${iid}`;
}

const ago = (ms) => {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 2592000) return `${Math.round(s / 86400)} 天前`;
  return new Date(ms).toISOString().slice(0, 10);
};

// The built-in Changes panel tints a changed line with 0x18 of the green or red. That is
// barely a hint on a dark background, so the same colors carry more of themselves there.
const lum = (c) => {
  const h = String(c).replace("#", "");
  const s = h.length === 3 ? h.replace(/./g, (d) => d + d) : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) || 0);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const tint = (t) => (lum(t.background) < lum(t.foreground) ? "3a" : "18");

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

// Side by side: a run of removed lines is read against the added run after it, so each
// pair shares a row and whichever side ran out stays blank. Line numbers only advance
// where a line really is.
export function splitRows(lines) {
  let old = 0, next = 0;
  const out = [];
  const cell = (kind, number, text) => ({ kind, number, text });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; out.push({ kind: "@", text: line }); continue; }
    const kind = line[0];
    if (kind === " ") {
      const text = untab(line.slice(1)) || " ";
      out.push({ kind: "=", left: cell(" ", old++, text), right: cell(" ", next++, text) });
      continue;
    }
    if (kind !== "-" && kind !== "+") { out.push({ kind: "", text: line }); continue; }
    const dels = [], adds = [];
    while (i < lines.length && lines[i][0] === "-") dels.push(lines[i++]);
    while (i < lines.length && lines[i][0] === "+") adds.push(lines[i++]);
    i--;
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      out.push({
        kind: "x",
        left: dels[j] === undefined ? null : cell("-", old++, untab(dels[j].slice(1)) || " "),
        right: adds[j] === undefined ? null : cell("+", next++, untab(adds[j].slice(1)) || " "),
      });
    }
  }
  return out;
}

// The files as a tree. A folder that holds nothing but one other folder is folded into
// its child's name: src/main/java is three rows of nothing to read otherwise.
export function treeRows(files, folded) {
  const node = (name) => ({ name, dirs: new Map(), files: [] });
  const root = node("");
  for (const f of files) {
    const parts = String(f.path).split("/");
    let at = root;
    for (const part of parts.slice(0, -1)) {
      if (!at.dirs.has(part)) at.dirs.set(part, node(part));
      at = at.dirs.get(part);
    }
    at.files.push({ ...f, name: parts[parts.length - 1] });
  }
  const out = [];
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const emit = (at, depth, prefix) => {
    for (const first of [...at.dirs.values()].sort(byName)) {
      let chain = first.name, leaf = first;
      while (!leaf.files.length && leaf.dirs.size === 1) {
        leaf = [...leaf.dirs.values()][0];
        chain = `${chain}/${leaf.name}`;
      }
      const path = prefix ? `${prefix}/${chain}` : chain;
      const open = !folded.has(path);
      out.push({ type: "dir", name: chain, path, depth, open });
      if (open) emit(leaf, depth + 1, path);
    }
    for (const f of [...at.files].sort(byName)) out.push({ type: "file", name: f.name, path: f.path, depth, file: f });
  };
  emit(root, 0, "");
  return out;
}

// One line of markdown with the markup taken off, keeping what it said.
export function mdInline(s) {
  // A code span keeps its text exactly, so it is set aside before anything is stripped —
  // set aside rather than split out, because emphasis runs across one: **不进 `a` / `b`**
  // is bold around two code spans, and cutting the line at them left the stars behind.
  const spans = [];
  const masked = String(s).replace(/`([^`]*)`/g, (_a, one) => {
    spans.push(one);
    return `\u0000${spans.length - 1}\u0000`;
  });
  const strip = masked
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (_a, one, two) => (one ? `${one} ${two}` : two))
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^\w*])\*([^*]+)\*(?=[^\w*]|$)/g, "$1$2")
    .replace(/(^|[^\w])__([^_]+)__(?=[^\w]|$)/g, "$1$2")
    // A single `_` only counts at the edge of a word: user_session_id is one name, and pairing
    // its underscores off turned every snake_case identifier into a new word.
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1$2");
  return strip.replace(/\u0000(\d+)\u0000/g, (_a, i) => spans[Number(i)]).replace(/\s+$/, "");
}

// A table row as its cells, pipes off. A pipe written \\| is part of the text — the JSON in
// one of these cells has them — and not a column break.
export function cellsOf(line) {
  const body = String(line).trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let at = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") { at += "|"; i++; continue; }
    if (body[i] === "|") { cells.push(at); at = ""; continue; }
    at += body[i];
  }
  cells.push(at);
  return cells.map((c) => mdInline(c.trim()));
}

// The row of dashes under a table's header: the one thing that makes it a table.
const isAlignRow = (line) => /^\s*\|([\s:|-]+)\|\s*$/.test(line);
const isTableRow = (line) => /^\s*\|/.test(line);

// GitLab hands the description back as markdown and there is no text engine here, so
// this reads the line starts a review actually needs and drops the markup inside a line.
export function mdLines(text) {
  const inline = mdInline;
  const out = [];
  const src = String(text).replace(/\r\n/g, "\n").split("\n");
  let code = false;
  for (let n = 0; n < src.length; n++) {
    const raw = src[n];
    if (/^\s*(```|~~~)/.test(raw)) { code = !code; continue; }
    const line = raw.replace(/\s+$/, "");
    if (code) { out.push({ kind: "code", text: untab(line.replace(/^\s{0,4}/, "")) }); continue; }
    if (!line.trim()) { out.push({ kind: "gap", text: "" }); continue; }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) { out.push({ kind: "head", level: head[1].length, text: inline(head[2]) }); continue; }
    const check = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (check) { out.push({ kind: "check", done: check[1] !== " ", text: inline(check[2]), depth: Math.floor((line.length - line.trimStart().length) / 2) }); continue; }
    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) { out.push({ kind: "li", text: inline(`${bullet[2]} ${bullet[3]}`), depth: Math.floor(bullet[1].length / 2) }); continue; }
    if (/^\s*>/.test(line)) { out.push({ kind: "quote", text: inline(line.replace(/^\s*>\s?/, "")) }); continue; }
    // A rule is a line, and a table is a table: its pipes are plumbing, not text, so the
    // rows become cells here and the alignment row goes away. Collected as one row, because
    // a header is only a header next to its columns.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ kind: "rule" }); continue; }
    if (isTableRow(line)) {
      const next = (src[n + 1] ?? "").replace(/\s+$/, "");
      if (isAlignRow(next)) {
        const head = cellsOf(line);
        const rows = [];
        for (n++; n + 1 < src.length;) {
          const row = src[n + 1].replace(/\s+$/, "");
          if (!isTableRow(row)) break;
          n++;
          if (!isAlignRow(row)) rows.push(cellsOf(row));
        }
        out.push({ kind: "table", head, rows });
        continue;
      }
      // A stray line that only starts with a pipe (a shell pipe, say) is still just text.
      out.push({ kind: "p", text: inline(line) });
      continue;
    }
    // A line set in under a bullet, a checkbox or a quote is that item's next line, not a
    // paragraph of its own: markdown's soft wrap, written out by hand.
    const cont = /^\s{2,}(\S.*)$/.exec(line);
    const prev = out[out.length - 1];
    if (cont && prev && (prev.kind === "li" || prev.kind === "check" || prev.kind === "quote")) {
      prev.text = `${prev.text}\n${inline(cont[1])}`;
      continue;
    }
    out.push({ kind: "p", text: inline(line) });
  }
  while (out.length && out[out.length - 1].kind === "gap") out.pop();
  return out;
}

// A row whose text carries more than one source line (a wrapped bullet) keeps those
// breaks: one child per line, instead of one long line with the wrap lost.
const textLines = (s) => String(s).split("\n").map((line) => div().child(line));

const countKind = (diff, sign) => diff.split("\n").filter((l) => l.startsWith(sign)).length;

// What the API gives per file, in the shape the panel draws. A file whose diff GitLab
// folded away has to be asked for out of the whole patch instead.
export function fileOf(d, i) {
  const diff = String(d.diff ?? "");
  const folded = Boolean(d.collapsed || d.too_large);
  const status = d.deleted_file ? "D" : d.new_file ? "A" : d.renamed_file ? "R"
    : !diff && !folded ? "B" : "M";
  return {
    n: i,
    path: String(d.new_path || d.old_path || ""),
    status,
    add: countKind(diff, "+"),
    del: countKind(diff, "-"),
    diff,
    folded,
  };
}

// git quotes a path it will not print raw as the UTF-8 bytes of the name, in octal.
export function unquote(raw) {
  const t = String(raw).trim().replace(/^"|"$/g, "");
  if (!t.includes("\\")) return t;
  const bytes = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "\\") { bytes.push(t.charCodeAt(i)); continue; }
    const oct = /^[0-7]{3}/.exec(t.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; continue; }
    const named = { n: 10, r: 13, t: 9, '"': 34, "\\": 92 }[t[i + 1]];
    bytes.push(named === undefined ? t.charCodeAt(i + 1) : named);
    i += 1;
  }
  let text = "", i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    const more = b < 0x80 ? 0 : b < 0xe0 ? 1 : b < 0xf0 ? 2 : 3;
    let cp = b & (0xff >> (more + 1));
    for (let k = 0; k < more && i < bytes.length; k++) cp = (cp << 6) | (bytes[i++] & 63);
    text += String.fromCodePoint(cp);
  }
  return text;
}

// `+++ b/<path>` names the file the hunks below it belong to; for a deleted file that
// side is /dev/null, so the name has to come from `---` instead.
function patchPath(lines) {
  const one = (prefix) => {
    const line = lines.find((l) => l.startsWith(prefix));
    if (!line) return "";
    const p = unquote(line.slice(prefix.length)).replace(/^[ab]\//, "");
    return p === "/dev/null" ? "" : p;
  };
  return one("+++ ") || one("--- ");
}

// The whole patch, cut into per-file bodies keyed the way the file list is keyed.
export function chunks(text) {
  const out = new Map();
  for (const part of String(text).split(/^diff --git /m).slice(1)) {
    const lines = part.split("\n");
    const hunk = lines.findIndex((l) => l.startsWith("@@"));
    const path = patchPath(lines);
    if (path && hunk >= 0) out.set(path, lines.slice(hunk).join("\n"));
  }
  return out;
}

export default class MrReview extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.iid = p.iid ? String(p.iid) : "";
    this.path = String(p.path ?? "");
    this.on = typeof p.on === "string" ? p.on : null; // whose glab to ask
    this.meta = null;
    this.files = [];
    this.desc = [];
    this.ci = null; // the newest pipeline, once glab has said what it is doing
    this.talk = []; // the notes, oldest first
    this.talkCut = 0; // how many older ones were left out
    this.talkOpen = false; // the discussion column, in this tab only
    this.open = null;
    this.lines = [];
    this.rows = [];
    this.split = [];
    this.widths = { one: 300, half: 300 };
    this.folded = new Set(); // which tree folders are shut, in this tab only
    this.error = "";
    this.hint = "";
    this.note = "";
    this.noteBad = false;
    this.copied = ""; // the reference whose ✓ is on screen, "" when the mark has aged out
    this.loading = false;
    this.busy = false;
    this.limited = false;
    this.again = false; // a load that was asked for while one was already out
    this.raw = null; // the whole patch, fetched only when a diff really arrives folded
    cx.timer.every(REFRESH, (cx) => this.load(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c !== "confirm" && c !== "mr-review.confirm") continue;
        const ask = shared(PENDING);
        if (!ask?.kind || !ask.iid || !ask.path || Date.now() - Number(ask.at) > CLAIM) continue;
        setShared(PENDING, null); // claim it: a second copy waking up must not act twice
        this.act(ask, cx);
      }
    });
    this.load(cx);
  }

  view(key) {
    const v = shared(VIEW);
    const want = v && typeof v === "object" ? v[key] : undefined;
    return want === undefined ? DEFAULTS[key] : want;
  }

  setView(key, value) {
    const next = { files: this.view("files"), diff: this.view("diff"), desc: Boolean(this.view("desc")), wrap: this.view("wrap"), [key]: value };
    setShared(VIEW, next);
  }

  // `after` runs once this load's answer is in — or at once, when there was nothing to ask:
  // act() uses it to judge the merge by the MR as glab reports it afterwards.
  load(cx, after) {
    if (!this.iid || !this.path) { after?.(); return; }
    // Asked again while glab is still thinking about the last time — the ↻ is a click away
    // and a poll can take 15 s — remembered and gone round once more when this one lands,
    // instead of a click that appears to do nothing.
    if (this.loading || this.busy) { if (!this.busy) this.again = true; after?.(); return; }
    this.loading = true;
    // A refresh is meant to show what GitLab has now, and the whole patch is one of the
    // things it may have to show: kept across loads, a folded file would keep the diff it
    // had when the tab was opened.
    this.raw = null;
    const project = `${enc(this.path)}/merge_requests/${this.iid}`;
    cx.spawn(async (cx) => {
      try {
        // The meta and the diff are the review: without them there is nothing to show, so
        // they are the two that can fail the load. The pipeline and the discussion are the
        // extras — a GitLab with CI turned off, or a token that cannot read the notes, must
        // not cost the reader the diff — so each answers `undefined` instead, which the
        // fields below read as "no news" and keep what they had.
        const soft = (p) => p.catch(() => undefined);
        const [meta, diffs, pipelines, discussions] = await Promise.all([
          this.call(["api", `projects/${project}`]),
          this.call(["api", "--paginate", `projects/${project}/diffs?per_page=100`]),
          soft(this.call(["api", `projects/${project}/pipelines?per_page=5`])),
          soft(this.call(["api", "--paginate", `projects/${project}/discussions?per_page=100`])),
        ]);
        this.meta = meta;
        if (pipelines !== undefined) this.ci = pipelineOf(pipelines);
        if (discussions !== undefined) {
          const talk = talkRows(discussions);
          this.talkCut = Math.max(0, talk.length - MAXTALK);
          this.talk = talk.slice(-MAXTALK);
        }
        this.desc = mdLines(String(meta?.description ?? ""));
        this.files = (Array.isArray(diffs) ? diffs : []).slice(0, MAXFILES).map(fileOf);
        this.limited = (Array.isArray(diffs) ? diffs : []).length > MAXFILES;
        this.error = "";
        if (this.open && !this.files.some((f) => f.path === this.open)) { this.open = null; this.lines = []; this.relayout(); }
        // The first file's diff shows until you pick another, same as Changes.
        if (!this.open && this.files.length) this.open = this.files[0].path;
        if (this.open) await this.show(this.open);
      } catch (e) {
        this.error = say(e);
      } finally {
        this.loading = false;
        after?.();
        cx.notify();
        if (this.again) { this.again = false; this.load(cx); }
      }
    });
    cx.notify();
  }

  async call(args) {
    const r = await exec("glab", args, { on: this.on, timeout: TIMEOUT });
    if (r.code !== 0) throw say(r.stderr || r.stdout);
    return JSON.parse(r.stdout || "null");
  }

  async patch() {
    if (this.raw) return this.raw;
    const r = await exec("glab", ["mr", "diff", this.iid, "-R", this.path, "--raw", "--color=never"], { on: this.on, timeout: TIMEOUT });
    if (r.code !== 0) throw say(r.stderr || r.stdout);
    this.raw = chunks(r.stdout);
    return this.raw;
  }

  async show(path) {
    const f = this.files.find((x) => x.path === path);
    if (!f) return;
    this.hint = "";
    if (f.diff) this.setLines(f.diff, "");
    else if (!f.folded) this.setLines("", "二进制文件 · 没有文本差异");
    else this.setLines((await this.patch()).get(path) ?? "", "", "整份补丁里也没有这个文件的差异");
  }

  setLines(diff, empty, missing) {
    const all = String(diff).replace(/\n$/, "").split("\n");
    const first = diff ? all.findIndex((l) => l.startsWith("@@")) : -1;
    this.lines = first < 0 ? [] : all.slice(first, MAXROWS).map((l) => (l.length > MAXLINE ? `${l.slice(0, MAXLINE)}… (这行太长，截掉了)` : l));
    const none = missing || empty || "没有可显示的差异";
    if (!this.lines.length) { this.rows = [{ kind: "", text: none }]; this.split = [{ kind: "", text: none }]; }
    this.relayout();
  }

  // Both views are built from the same lines, so switching one costs nothing and never
  // goes back to GitLab for it.
  relayout() {
    if (!this.lines.length) { this.widths = { one: 300, half: 300 }; return; }
    this.rows = diffRows(this.lines);
    this.split = splitRows(this.lines);
    const longest = (rows, get) => Math.max(0, ...rows.map(get));
    this.widths = {
      one: Math.max(300, longest(this.rows, (r) => (r.text.length + 1) * 7 + 50)),
      half: Math.max(240, longest(this.split, (r) => (Math.max(r.left?.text.length ?? 0, r.right?.text.length ?? 0) + 1) * 7 + 50)),
    };
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path;
    this.lines = [];
    this.rows = [];
    this.split = [];
    this.hint = "";
    if (this.open) cx.spawn(async (cx) => {
      try { await this.show(this.open); } catch (e) { this.hint = say(e); }
      cx.notify();
    });
    cx.notify();
  }

  toggleDir(path) {
    if (this.folded.has(path)) this.folded.delete(path);
    else this.folded.add(path);
  }

  // The built-in dialog runs a command when it is told yes, and that command carries
  // nothing, so which MR to act on is left in shared state for this copy to pick up.
  ask(kind) {
    if (this.busy || this.loading || !this.meta) return;
    const m = this.meta;
    setShared(PENDING, { kind, iid: this.iid, path: this.path, on: this.on, at: Date.now() });
    openOverlay({
      mod: "confirm",
      kind: "dialog",
      // The built-in dialog gives its detail a flex area, so a height picked too large
      // leaves a hole in the middle and one picked too small cuts the warning off.
      width: 0.45,
      height: 260,
      props: {
        title: kind === "merge" ? `合并 !${this.iid}？` : `关闭 MR !${this.iid}？`,
        detail: [
          this.path,
          String(m.title ?? ""),
          `${m.source_branch} → ${m.target_branch}`,
          "",
          kind === "merge"
            ? "流水线还在跑时 GitLab 会把它设成流水线通过后自动合并，而不是立刻合上。"
            : "只是关掉这个 MR，分支还在；要恢复用 glab mr reopen。",
        ].join("\n"),
        command: { name: "mr-review.confirm" },
      },
    });
  }

  // Told to the list now rather than at its next poll — but only once the MR as glab reports
  // it says it really left the open list: `merge -y` on an MR whose pipeline is still running
  // only sets it to merge when that pipeline passes, and a row dropped there would be back
  // at the next poll.
  markDone(job, merge) {
    if (merge && this.meta?.state === "opened") return null;
    return markDone(job.path, job.iid);
  }

  act(job, cx) {
    const merge = job.kind === "merge";
    // -y only skips glab's own "submit?" prompt, which the dialog above has just answered.
    const args = ["mr", merge ? "merge" : "close", String(job.iid), "-R", String(job.path), ...(merge ? ["-y"] : [])];
    this.busy = true;
    this.note = "";
    let done = false;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("glab", args, { on: job.on ?? null, timeout: ACTION_TIMEOUT });
        if (r.code !== 0) throw say(r.stderr || r.stdout);
        this.note = merge ? "已提交合并。" : "已关闭 MR。";
        this.noteBad = false;
        this.raw = null;
        done = true;
      } catch (e) {
        this.note = `${merge ? "合并" : "关闭"}没做成：${say(e)}`;
        this.noteBad = true;
      } finally {
        this.busy = false;
        // Only a command glab accepted can have moved the MR: a failure keeps the row.
        this.load(cx, () => { if (done) this.markDone(job, merge); });
        cx.notify();
      }
    });
    cx.notify();
  }

  web() {
    if (this.meta?.web_url) exec("glab", ["mr", "view", this.iid, "-R", this.path, "--web"]).catch(() => {});
  }

  button(t, id, label, kind, on, why) {
    return div().id(id).h(28).px(12).flex().items_center().rounded(7).text_size(12)
      .bg(on ? (kind === "merge" ? t.solid : t.raised) : t.raised)
      .text_color(kind === "close" ? t.blocked : on ? (kind === "merge" ? t.solid_foreground : t.foreground) : t.dim)
      .when(on, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(() => this.ask(kind)))
      // A button that does nothing has to say why, or it reads as a broken panel rather than
      // as GitLab's answer.
      .when(!on && Boolean(why), (e) => e.tooltip(why))
      .child(label);
  }

  // The clipboard is the whole feature, so the ✓ is the whole receipt: nothing else on screen
  // moves when a click lands. It is put away on a timer rather than left behind to claim a copy
  // happened at some point, and a later copy takes the mark over.
  copy(cx, text) {
    if (!text || typeof cx?.write_to_clipboard !== "function") return;
    cx.write_to_clipboard(text);
    this.copied = text;
    cx.notify();
    cx.timer?.after(FLASH, (cx) => {
      if (this.copied !== text) return;
      this.copied = "";
      cx.notify();
    });
  }

  // The number in the header is the thing an agent is handed — `acme/team/db!12` names the MR
  // on its own, where a bare `!12` names one of every project's — so the number is the button
  // that copies it. Fixed width, so the title beside it does not move when the ✓ lands.
  num(t) {
    const ref = refOf(this.path, this.iid);
    const done = this.copied === ref;
    return div().id("copy-ref").flex_none().w(40).h(20).text_center().rounded(5).bg(t.raised)
      .text_size(11).text_color(done ? t.done : t.muted).truncate()
      // Opened with no props — under `herdr-app check` — there is no MR to name, so the number
      // is decoration and offers nothing it cannot do.
      .when(Boolean(this.iid), (e) => e.cursor_pointer()
        .tooltip(done ? "已复制，粘贴给 agent" : `复制 ${ref}`)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.copy(cx, ref)))
      .child(done ? "✓" : `!${this.iid}`);
  }

  quiet(t, id, label, tip, press) {
    return div().id(id).h(28).px(9).flex().items_center().rounded(7).bg(t.raised).text_color(t.muted).text_size(12)
      .cursor_pointer().tooltip(tip).hover((s) => s.bg(t.hover)).on_click(press).child(label);
  }

  // The two-way switches that sit over the lists they change.
  seg(t, id, pairs, now, pick) {
    return h_flex().flex_none().p(2).gap(2).rounded(6).bg(t.raised)
      .children(pairs.map(([value, label]) => div().id(`${id}-${value}`).h(19).px(7).rounded(4).items_center().text_center()
        .text_size(11).text_color(now === value ? t.solid_foreground : t.muted)
        .when(now === value, (e) => e.bg(t.solid))
        .cursor_pointer().on_click(() => { pick(value); })
        .child(label)));
  }

  // What the chips and the two buttons may do. Closing is allowed whatever GitLab
  // thinks about merging, and only while the MR is still open.
  verdict(m = this.meta ?? {}) {
    const dms = String(m.detailed_merge_status ?? "");
    const [status, tone] = STATUS[dms] ?? [dms, "dim"];
    const live = m.state === "opened" && !this.busy && !this.loading && Boolean(this.files.length);
    // Red is GitLab saying no, and a draft is a no it only says quietly. Everything else —
    // "检查中" included — is left to glab, whose refusal carries its own reason, rather than
    // this panel guessing at a state it does not know.
    const canMerge = live && tone !== "blocked" && dms !== "draft_status";
    return { status, tone, live, canMerge };
  }

  head(t) {
    const m = this.meta ?? {};
    const { status, tone, live, canMerge } = this.verdict(m);
    const shown = Boolean(this.view("desc"));
    const said = this.talk.filter((n) => !n.system).length;
    return v_flex().flex_none().p(10).gap(7).children([
      h_flex().gap(8).items_center().children([
        this.num(t),
        div().flex_1().min_w(0).truncate().font_semibold().child(String(m.title ?? (this.loading ? "加载中…" : "没有标题"))),
        div().text_size(11).text_color(t[tone] ?? t.dim).child(status),
        ...(this.ci ? [this.ciChip(t)] : []),
        this.quiet(t, "refresh", this.loading ? "⋯" : "↻", "重新问一次 GitLab", (_, cx) => this.load(cx)),
        this.quiet(t, "web", "在浏览器打开", "glab mr view --web", () => this.web()),
        this.button(t, "close-mr", "关闭 MR", "close", live),
        this.button(t, "merge-mr", "合并", "merge", canMerge,
          canMerge || !live ? null : `GitLab 不让合并：${status || "检查没过"}（逐项检查在浏览器里能看到）`),
      ]),
      h_flex().gap(10).items_center().text_size(11).text_color(t.dim).children([
        div().flex_1().min_w(0).truncate().child(`${m.author?.name || m.author?.username || "?"} · ${String(m.source_branch ?? "")} → ${String(m.target_branch ?? "")}`),
        div().flex_none().child(ago(Date.parse(m.updated_at) || 0)),
        div().flex_none().truncate().child(this.path),
        said || this.talkOpen
          ? div().id("show-talk").h(20).px(7).rounded(5).items_center().bg(this.talkOpen ? t.selected : t.raised)
            .text_color(this.talkOpen ? t.foreground : t.muted).cursor_pointer()
            .tooltip(this.talkOpen ? "收起讨论" : "展开讨论")
            .on_click((_e, cx) => {
              this.talkOpen = !this.talkOpen;
              // The description has the window to itself when it is open, so asking for the
              // discussion is also asking to stop reading it — otherwise the click opens a
              // column nobody can see.
              if (this.talkOpen && Boolean(this.view("desc"))) this.setView("desc", false);
              cx.notify();
            })
            .child(`讨论 ${said}`)
          : div().flex_none(),
        this.desc.length
          ? div().id("show-desc").h(20).px(7).rounded(5).items_center().bg(t.raised).text_color(t.muted).cursor_pointer()
            .tooltip(shown ? "收起说明" : "展开说明")
            .on_click((_e, cx) => { this.setView("desc", !shown); cx.notify(); })
            .child(`${shown ? "收起" : "展开"}说明`)
          : div().flex_none(),
      ]),
    ]);
  }

  // Beside GitLab's verdict rather than inside it: the verdict only says that CI is one of
  // the reasons the MR cannot go in, this says which run it is and how it ended — and it is
  // the way into the job log the verdict never names.
  ciChip(t) {
    const ci = this.ci;
    return div().id("mr-ci").flex_none().text_size(11).text_color(t[ci.tone] ?? t.dim)
      .when(Boolean(ci.url), (e) => e.cursor_pointer().hover((s) => s.opacity(0.8))
        .tooltip(`流水线 #${ci.id}${ci.sha ? ` · ${ci.sha}` : ""}${ci.at ? ` · ${ago(ci.at)}` : ""} · 在浏览器打开`)
        .on_click((_e, cx) => cx?.open_url?.(ci.url)))
      .child(ci.label);
  }

  // The discussion, beside the diff rather than in place of it: a comment about a file is
  // read with that file on screen, and the diff is what it is about. A fixed width, so
  // switching it on does not leave the diff a different shape every time a note arrives.
  talkPane(t) {
    const id = `mr-talk-${this.iid}`;
    const said = this.talk.filter((n) => !n.system).length;
    return v_flex().id(id).flex_none().w(360).h_full().min_w(0).min_h(0)
      .border_l(1).border_color(t.border)
      .child(h_flex().h(28).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child(`讨论 ${said} 条`))
        .child(div().flex_1())
        .child(this.quiet(t, "talk-close", "收起", "把讨论收起来，让差异占满", (_e, cx) => { this.talkOpen = false; cx.notify(); })))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id(`${id}-list`).absolute().inset_0().overflow_y_scroll().p(8).gap(6)
          .when(this.talkCut > 0, (e) => e.child(div().w_full().flex_none().text_size(10.5).text_color(t.dim)
            .child(`前面还有 ${this.talkCut} 条没有列出来`)))
          .when(this.talk.length === 0, (e) => e.child(div().w_full().flex_none().text_size(11).text_color(t.dim).child("还没有人评论")))
          .children(this.talk.map((n) => this.talkRow(t, n))))
        .child(Scrollbar.vertical(`${id}-list`).absolute().inset_0()));
  }

  // A comment is a card: who said it, when, which line it hangs on, then the words in the
  // same markdown the description is read in. A system note is one dim line instead, because
  // "changed the description" is context for the diff, not something somebody said to you.
  talkRow(t, n) {
    if (n.system) {
      return h_flex().id(`talk-${n.id}`).w_full().flex_none().gap(6).items_center().px(2).py(1)
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(n.who))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(n.plain || "—"))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(n.at)));
    }
    return v_flex().id(`talk-${n.id}`).w_full().flex_none().rounded(6).border_1().border_color(t.border).p(7).gap(3)
      .children([
        h_flex().w_full().min_w(0).gap(6).items_center().children([
          div().flex_none().text_size(11.5).font_semibold().child(n.who),
          ...(n.resolved === null ? [] : [div().flex_none().rounded(4).px(4).py(1).text_size(10)
            .bg(t.raised).text_color(n.resolved ? t.done : t.working).child(n.resolved ? "已解决" : "未解决")]),
          div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(n.where),
          div().flex_none().text_size(10).text_color(t.dim).child(ago(n.at)),
        ]),
        v_flex().w_full().flex_none().gap(2).children(this.mdBlocks(t, n.body, `t-${n.id}`)),
      ]);
  }

  descPane(t) {
    const id = "mr-desc";
    // The same shape as the file list: a box of its own with the list absolutely inside it.
    // A long description inside a row-sized column instead paints over the header and the
    // lists, because the row never clips it. It fills what the window has: open, the
    // description is what is being read, and the diff is a collapse away.
    return div().id("mr-desc-box").flex_1().w_full().min_h(0).relative().border_b(1).border_color(t.border)
      .child(v_flex().id(id).absolute().inset_0().overflow_y_scroll().px(12).py(8).gap(2)
        .children(this.mdBlocks(t)))
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  // A run of lines of one kind is one thing on screen: a fenced block is a block with a
  // line per row, a quote keeps a single bar down its side, and a paragraph stays together.
  // Drawing them line by line gave every code line a rounded box of its own, which read as
  // a stack of chips rather than as code, and left the quote's bar broken between lines.
  mdBlocks(t, rows = this.desc, pre = "d") {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const run = [row];
      while (["code", "quote", "p"].includes(row.kind) && rows[i + 1]?.kind === row.kind) run.push(rows[++i]);
      const id = `${pre}-${i}`;
      if (row.kind === "code") {
        out.push(v_flex().id(id).w_full().flex_none().px(8).py(6).rounded(5).bg(t.raised).gap(1)
          .font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.muted)
          .children(run.map((l) => div().child(l.text || " "))));
      } else if (row.kind === "quote") {
        out.push(v_flex().id(id).w_full().flex_none().pl(8).py(1)
          .border_l(2).border_color(t.border).text_color(t.muted)
          .children(run.map((l) => div().child(l.text))));
      } else if (row.kind === "p") {
        out.push(v_flex().id(id).w_full().flex_none().children(run.map((l) => div().child(l.text))));
      } else if (row.kind === "rule") {
        out.push(div().id(id).w_full().flex_none().h(1).my(3).bg(t.border));
      } else if (row.kind === "table") {
        out.push(this.tableBox(t, row, i, pre));
      } else {
        out.push(this.mdRow(t, row, i, pre));
      }
    }
    return out;
  }

  // A table as a grid: a header row over a rule, then a row per line, the cells sharing
  // the width. Its pipes used to be drawn as monospace text, which read as one long code
  // line that wrapped wherever it liked.
  tableBox(t, l, i, pre = "d") {
    const all = [l.head, ...l.rows];
    const cols = Math.max(...all.map((r) => r.length));
    // A column is as wide as what is in it, capped: a table of a name and a sentence reads
    // as 1:4 rather than 1:1, and one enormous cell cannot take the whole row.
    const grow = Array.from({ length: cols }, (_, k) =>
      Math.min(40, Math.max(4, ...all.map((r) => String(r[k] ?? "").length))));
    const cell = (text, k, head) => div().min_w(0).px(6).py(3)
      .flex_basis(0).flex_grow(grow[k]).flex_shrink(1)
      .text_color(head ? t.foreground : t.muted)
      .when(head, (e) => e.font_semibold())
      .child(String(text ?? ""));
    const line = (cells, head) => h_flex().w_full().items_start()
      .when(head, (e) => e.bg(t.raised))
      .children(Array.from({ length: cols }, (_, k) => cell(cells[k], k, head)));
    return v_flex().id(`${pre}-${i}`).w_full().flex_none().rounded(5).overflow_hidden()
      .children([line(l.head, true), div().w_full().flex_none().h(1).bg(t.border), ...l.rows.map((r) => line(r, false))]);
  }

  mdRow(t, l, i, pre = "d") {
    const pad = 12 * (l.depth ?? 0);
    if (l.kind === "gap") return div().id(`${pre}-${i}`).h(6).flex_none();
    // A heading is a size as well as a weight: h1 and h2 have to read as breaks in a long
    // description, h3 and deeper as a label on what follows.
    if (l.kind === "head") {
      const size = l.level === 1 ? 15 : l.level === 2 ? 13.5 : 12.5;
      return div().id(`${pre}-${i}`).w_full().flex_none().text_size(size).font_semibold().child(l.text);
    }
    if (l.kind === "check") {
      return h_flex().id(`${pre}-${i}`).w_full().flex_none().gap(8).ml(pad).items_start()
        .child(div().w(14).flex_none().text_color(l.done ? t.done : t.dim).child(l.done ? "☑" : "☐"))
        .child(v_flex().flex_1().min_w(0).text_color(l.done ? t.muted : t.foreground)
          .children(textLines(l.text)));
    }
    if (l.kind === "li") return h_flex().id(`${pre}-${i}`).w_full().flex_none().gap(8).ml(pad).items_start()
      .child(div().w(8).flex_none().text_color(t.dim).child("·"))
      .child(v_flex().flex_1().min_w(0).children(textLines(l.text)));
    return div().id(`${pre}-${i}`).w_full().flex_none().ml(pad).child(l.text);
  }

  // One row of the 单栏 view. Cut, it is a single 20px line that ends in an ellipsis at the
  // window's edge; wrapped, it is as tall as its text needs and nothing is out of reach —
  // which is the only way to read a long Chinese sentence or a long URL in a diff.
  diffRow({ kind, number, text }, t, wrap = false) {
    const a = tint(t);
    if (kind === "@") return div().w_full().px(12).flex_none().bg(t.raised).text_color(t.dim)
      .when(wrap, (e) => e.py(2)).when(!wrap, (e) => e.h(20).truncate()).child(text);
    return h_flex().w_full().flex_none().gap(10)
      .when(wrap, (e) => e.min_h(20).py(1).items_start()).when(!wrap, (e) => e.h(20))
      .when(kind === "+", (e) => e.bg(t.ansi2 + a)).when(kind === "-", (e) => e.bg(t.ansi1 + a))
      .child(div().w(34).flex_none().whitespace_nowrap().text_right().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).when(!wrap, (e) => e.truncate()).child(text));
  }

  // One row of the side-by-side view: whatever is on each side, and a marked-out hole
  // where a side ran out of lines. Both sides are flex_1 with no flex_none on top: the
  // second one wins and the wide side then squeezes the other out of the window.
  splitSide(t, cell, tone, edge, wrap) {
    const body = cell
      ? h_flex().flex_1().min_w(0).gap(10).when(tone, (e) => e.bg(tone))
        .when(wrap, (e) => e.min_h(20).py(1).items_start()).when(!wrap, (e) => e.h(20)).children([
        div().w(34).flex_none().whitespace_nowrap().text_right().text_color(cell.kind === "-" ? t.ansi1 : cell.kind === "+" ? t.ansi2 : t.dim).child(String(cell.number)),
        div().flex_1().min_w(0).when(!wrap, (e) => e.truncate()).child(cell.text),
      ])
      : div().flex_1().min_w(0).bg(t.raised + "10").when(wrap, (e) => e.min_h(20)).when(!wrap, (e) => e.h(20));
    return edge
      ? h_flex().flex_1().min_w(0).border_r(1).border_color(t.border).child(body)
      : h_flex().flex_1().min_w(0).child(body);
  }

  splitRow(row, t, wrap = false) {
    if (row.kind === "@") return div().w_full().flex_none().px(12).bg(t.raised).text_color(t.dim)
      .when(wrap, (e) => e.py(2)).when(!wrap, (e) => e.h(20).truncate()).child(row.text);
    if (row.kind !== "x" && row.kind !== "=") return div().w_full().flex_none().px(12).text_color(t.dim)
      .when(wrap, (e) => e.py(2)).when(!wrap, (e) => e.h(20).truncate()).child(row.text);
    const a = tint(t);
    // Wrapped, one side is often taller than the other; stretching both to the row's height
    // keeps the removed and added runs level, and fills a hole's band all the way down.
    return h_flex().w_full().flex_none().when(wrap, (e) => e.items_stretch())
      .child(this.splitSide(t, row.left, row.left?.kind === "-" ? t.ansi1 + a : null, true, wrap))
      .child(this.splitSide(t, row.right, row.right?.kind === "+" ? t.ansi2 + a : null, false, wrap));
  }

  fileRow(t, id, f, depth, name) {
    const tone = f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "B" ? t.ansi1 : f.status === "R" ? t.blocked : t.muted;
    return h_flex().id(`${id}-${f.n}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
      .child(div().w(14).flex_none().ml(depth * 12).text_size(11).text_color(tone).child(f.status))
      .child(div().flex_1().min_w(0).truncate().child(name ?? f.path))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  dirRow(t, id, d) {
    return h_flex().id(`${id}-d-${d.path.replace(/[^\w]/g, "-")}`).h(24).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.toggleDir(d.path); cx.notify(); })
      .child(div().w(12).flex_none().ml(d.depth * 12).text_size(10).text_color(t.dim).child(d.open ? "▾" : "▸"))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(d.name));
  }

  filesPane(t) {
    const id = `mr-files-${this.iid}`;
    const tree = this.view("files") === "tree";
    const rows = tree ? treeRows(this.files, this.folded) : this.files.map((f) => ({ type: "file", file: f, depth: 0 }));
    return v_flex().id(id).flex_none().w(320).h_full().min_w(0).min_h(0).border_r(1).border_color(t.border)
      // h_full: a row sizes its children's cross axis from them, not from itself, so a
      // column that wants the whole height has to say so (the headers showed, the lists
      // under them had nothing to fill).
      .child(h_flex().h(28).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child(`${this.files.length} 个文件`))
        .child(div().flex_1())
        .child(this.seg(t, "files", [["flat", "列表"], ["tree", "树"]], this.view("files"), (v) => this.setView("files", v))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id(`${id}-list`).absolute().inset_0().overflow_y_scroll().p(4)
          .children(rows.map((r) => (r.type === "dir" ? this.dirRow(t, id, r) : this.fileRow(t, id, r.file, r.depth, tree ? r.name : undefined)))))
        .child(Scrollbar.vertical(`${id}-list`).absolute().inset_0()))
      .when(this.limited, (e) => e.child(div().px(10).py(4).text_size(11).text_color(t.dim).child(`只显示前 ${MAXFILES} 个文件`)));
  }

  diffPane(t) {
    const id = `mr-diff-${this.iid}`;
    const f = this.files.find((x) => x.path === this.open);
    const split = this.view("diff") === "split";
    const wrap = this.view("wrap") !== "cut";
    const rows = split ? this.split : this.rows;
    // A long line has three fates, and the reader picks: wrapped over as many rows as it
    // needs — the default, because a line cut at the window's edge stays unread — scrolled
    // sideways in 单栏, or out of reach in 并排, where sharing the window between the two
    // sides is the point. Only the sideways view has to guess how wide its content is, so
    // an estimate is never what a reader is stuck with.
    const width = split || wrap ? 0 : this.widths.one;
    const row = (r) => (split ? this.splitRow(r, t, wrap) : this.diffRow(r, t, wrap));
    return v_flex().id(id).flex_1().h_full().min_w(0).min_h(0)
      .child(h_flex().h(28).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(f ? f.path : "选一个文件看它的差异"))
        .when(Boolean(f?.folded), (e) => e.child(div().text_size(11).text_color(t.dim).child("GitLab 折起了这段，已按整份补丁取回")))
        .when(!wrap && split && this.widths.half * 2 > 960, (e) => e.child(div().text_size(11).text_color(t.dim).child("长行截断，切回单栏可横向滚")))
        .child(this.seg(t, "wrap", [["wrap", "换行"], ["cut", "截断"]], wrap ? "wrap" : "cut", (v) => this.setView("wrap", v)))
        .child(this.seg(t, "diff", [["unified", "单栏"], ["split", "并排"]], this.view("diff"), (v) => this.setView("diff", v))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        // Wrapped rows are measured as they are drawn — list() asks nothing about their
        // height — where the cut ones are all 20px and v_virtual_list places them by that.
        .child(wrap
          ? list(id, rows.length, (i) => String(i), (i) => row(rows[i])).absolute().inset_0()
          : div().id(`${id}-x`).size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(width).h_full().child(v_virtual_list(id, rows.length, 20, (i) => String(i),
              (range) => rows.slice(range.start, range.end).map(row)).size_full())))
        .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0()))
      .when(Boolean(this.hint), (e) => e.child(div().px(10).py(4).text_size(11).text_color(t.blocked).child(this.hint)));
  }

  render() {
    const t = theme();
    const box = v_flex().id("mr-review").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    if (!this.iid || !this.path) {
      return box.child(div().flex_1().items_center().justify_center().text_color(t.dim).child("从 MR 列表点一行打开一个评审"));
    }
    // Open, the description has the window to itself: reading it is what the reader is doing,
    // and the files and the diff come back the moment it is collapsed.
    const reading = Boolean(this.view("desc")) && Boolean(this.desc.length);
    return box
      .child(this.head(t))
      .when(reading, (e) => e.child(this.descPane(t)))
      .when(Boolean(this.error), (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.blocked).child(this.error)))
      .when(!this.error && !reading, (e) => e.child(h_flex().flex_1().min_h(0).children(
        [this.filesPane(t), this.diffPane(t), ...(this.talkOpen ? [this.talkPane(t)] : [])])))
      .when(Boolean(this.note), (e) => e.child(h_flex().flex_none().px(10).py(6).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_size(11).text_color(this.noteBad ? t.blocked : t.done).child(this.note))
        .when(this.busy, (b) => b.child(div().text_size(11).text_color(t.dim).frames(SPINNER, 90)))
        .when(!this.busy, (b) => b.child(this.quiet(t, "recheck", "再查一次", "重新拉取这个 MR", (_e, cx) => { this.note = ""; this.load(cx); })))));
  }
}

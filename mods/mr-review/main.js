// One merge request, reviewed here instead of in the browser: the changed files on the
// left, their diff on the right, merge and close along the top. It is opened as a tab of
// its own, so the diff gets the full width of the window. Everything comes from the API:
// the repo does not have to be on this machine, and nothing is written into a local .git.

import { View, div } from "gpui-kit";
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
const DESC = 200; // how much of the description fits before it has to be scrolled

// The payload key the confirmation hands back through, and the view choices: kept in
// shared state rather than localStorage because localStorage belongs to one copy, and a
// second review tab should open the way the first one was left.
const PENDING = "mr-review.pending";
const VIEW = "mr-review.view";
const DEFAULTS = { files: "flat", diff: "unified", desc: false };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// GitLab's own verdict on whether the MR can go in, said shortly.
const STATUS = {
  mergeable: ["可合并", "done"],
  approvals_satisfied: ["已批准", "done"],
  conflict: ["有冲突", "blocked"],
  detached: ["落后于目标分支", "blocked"],
  ci_must_pass: ["流水线在跑", "working"],
  ci_stopped: ["流水线停了", "blocked"],
  approvals_blocked: ["待批准", "working"],
  draft_status: ["草稿", "dim"],
  unchecked: ["检查中", "dim"],
  checking: ["检查中", "dim"],
  not_open: ["已不在评审中", "dim"],
};

// Things GitLab will not merge no matter what it says it is thinking about.
const BLOCKED = ["conflict", "draft_status", "ci_stopped", "not_open"];

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

// GitLab hands the description back as markdown and there is no text engine here, so
// this reads the line starts a review actually needs and drops the markup inside a line.
export function mdLines(text) {
  const inline = (s) => s
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (_a, one, two) => (one ? `${one} ${two}` : two))
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+$/, "");
  const out = [];
  let code = false;
  for (const raw of String(text).replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) { code = !code; continue; }
    const line = raw.replace(/\s+$/, "");
    if (code) { out.push({ kind: "code", text: untab(line.replace(/^\s{0,4}/, "")) }); continue; }
    if (!line.trim()) { out.push({ kind: "gap", text: "" }); continue; }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) { out.push({ kind: "head", text: inline(head[2]) }); continue; }
    const check = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (check) { out.push({ kind: "check", done: check[1] !== " ", text: inline(check[2]), depth: Math.floor((line.length - line.trimStart().length) / 2) }); continue; }
    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) { out.push({ kind: "li", text: inline(`${bullet[2]} ${bullet[3]}`), depth: Math.floor(bullet[1].length / 2) }); continue; }
    if (/^\s*>/.test(line)) { out.push({ kind: "quote", text: inline(line.replace(/^\s*>\s?/, "")) }); continue; }
    if (/^\s*\|/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line)) { out.push({ kind: "code", text: inline(line) }); continue; }
    out.push({ kind: "p", text: inline(line) });
  }
  while (out.length && out[out.length - 1].kind === "gap") out.pop();
  return out;
}

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
    this.loading = false;
    this.busy = false;
    this.limited = false;
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
    const next = { files: this.view("files"), diff: this.view("diff"), desc: Boolean(this.view("desc")), [key]: value };
    setShared(VIEW, next);
  }

  load(cx) {
    if (!this.iid || !this.path || this.loading || this.busy) return;
    this.loading = true;
    const project = `${enc(this.path)}/merge_requests/${this.iid}`;
    cx.spawn(async (cx) => {
      try {
        const [meta, diffs] = await Promise.all([
          this.call(["api", `projects/${project}`]),
          this.call(["api", "--paginate", `projects/${project}/diffs?per_page=100`]),
        ]);
        this.meta = meta;
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
        cx.notify();
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

  act(job, cx) {
    const merge = job.kind === "merge";
    // -y only skips glab's own "submit?" prompt, which the dialog above has just answered.
    const args = ["mr", merge ? "merge" : "close", String(job.iid), "-R", String(job.path), ...(merge ? ["-y"] : [])];
    this.busy = true;
    this.note = "";
    cx.spawn(async (cx) => {
      try {
        const r = await exec("glab", args, { on: job.on ?? null, timeout: ACTION_TIMEOUT });
        if (r.code !== 0) throw say(r.stderr || r.stdout);
        this.note = merge ? "已提交合并。" : "已关闭 MR。";
        this.noteBad = false;
        this.raw = null;
      } catch (e) {
        this.note = `${merge ? "合并" : "关闭"}没做成：${say(e)}`;
        this.noteBad = true;
      } finally {
        this.busy = false;
        this.load(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  web() {
    if (this.meta?.web_url) exec("glab", ["mr", "view", this.iid, "-R", this.path, "--web"]).catch(() => {});
  }

  button(t, id, label, kind, on) {
    return div().id(id).h(28).px(12).flex().items_center().rounded(7).text_size(12)
      .bg(on ? (kind === "merge" ? t.solid : t.raised) : t.raised)
      .text_color(kind === "close" ? t.blocked : on ? (kind === "merge" ? t.solid_foreground : t.foreground) : t.dim)
      .when(on, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(() => this.ask(kind)))
      .child(label);
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
    const [status, tone] = STATUS[m.detailed_merge_status] ?? ["", "dim"];
    const live = m.state === "opened" && !this.busy && !this.loading && Boolean(this.files.length);
    return { status, tone, live, canMerge: live && !BLOCKED.includes(m.detailed_merge_status) };
  }

  head(t) {
    const m = this.meta ?? {};
    const { status, tone, live, canMerge } = this.verdict(m);
    const shown = Boolean(this.view("desc"));
    return v_flex().flex_none().p(10).gap(7).children([
      h_flex().gap(8).items_center().children([
        div().px(5).py(1).rounded(5).bg(t.raised).text_size(11).text_color(t.muted).child(`!${this.iid}`),
        div().flex_1().min_w(0).truncate().font_semibold().child(String(m.title ?? (this.loading ? "加载中…" : "没有标题"))),
        div().text_size(11).text_color(t[tone] ?? t.dim).child(status),
        this.quiet(t, "refresh", this.loading ? "⋯" : "↻", "重新问一次 GitLab", (_, cx) => this.load(cx)),
        this.quiet(t, "web", "在浏览器打开", "glab mr view --web", () => this.web()),
        this.button(t, "close-mr", "关闭 MR", "close", live),
        this.button(t, "merge-mr", "合并", "merge", canMerge),
      ]),
      h_flex().gap(10).items_center().text_size(11).text_color(t.dim).children([
        div().flex_1().min_w(0).truncate().child(`${m.author?.name || m.author?.username || "?"} · ${String(m.source_branch ?? "")} → ${String(m.target_branch ?? "")}`),
        div().flex_none().child(ago(Date.parse(m.updated_at) || 0)),
        div().flex_none().truncate().child(this.path),
        this.desc.length
          ? div().id("show-desc").h(20).px(7).rounded(5).items_center().bg(t.raised).text_color(t.muted).cursor_pointer()
            .tooltip(shown ? "收起说明" : "展开说明")
            .on_click((_e, cx) => { this.setView("desc", !shown); cx.notify(); })
            .child(`${shown ? "收起" : "展开"}说明`)
          : div().flex_none(),
      ]),
    ]);
  }

  descPane(t) {
    const id = "mr-desc";
    // The same shape as the file list: a box of its own with the list absolutely inside
    // it. A long description inside a row-sized column instead paints over the header
    // and the lists, because the row never clips it.
    return div().id("mr-desc-box").flex_none().w_full().h(DESC + 12).relative().border_b(1).border_color(t.border)
      .child(v_flex().id(id).absolute().inset_0().overflow_y_scroll().px(12).py(8).gap(2)
        .children(this.desc.map((l, i) => this.mdRow(t, l, i))))
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  mdRow(t, l, i) {
    const pad = 12 * (l.depth ?? 0);
    if (l.kind === "gap") return div().id(`d-${i}`).h(6).flex_none();
    if (l.kind === "head") return div().id(`d-${i}`).w_full().flex_none().text_size(13).font_semibold().child(l.text);
    if (l.kind === "code") {
      return div().id(`d-${i}`).w_full().flex_none().ml(pad).px(8).py(2).rounded(5).bg(t.raised)
        .font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.muted).child(l.text || " ");
    }
    if (l.kind === "quote") return div().id(`d-${i}`).w_full().flex_none().ml(pad).pl(8).border_l(2).border_color(t.border).text_color(t.muted).child(l.text);
    if (l.kind === "check") {
      return h_flex().id(`d-${i}`).w_full().flex_none().gap(8).ml(pad).items_start()
        .child(div().w(14).flex_none().text_color(l.done ? t.done : t.dim).child(l.done ? "☑" : "☐"))
        .child(div().flex_1().min_w(0).text_color(l.done ? t.muted : t.foreground).child(l.text));
    }
    if (l.kind === "li") return h_flex().id(`d-${i}`).w_full().flex_none().gap(8).ml(pad).items_start()
      .child(div().w(8).flex_none().text_color(t.dim).child("·")).child(div().flex_1().min_w(0).child(l.text));
    return div().id(`d-${i}`).w_full().flex_none().ml(pad).child(l.text);
  }

  diffRow({ kind, number, text }, t) {
    const a = tint(t);
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + a)).when(kind === "-", (e) => e.bg(t.ansi1 + a))
      .child(div().w(30).flex_none().text_right().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // One row of the side-by-side view: whatever is on each side, and a marked-out hole
  // where a side ran out of lines. Both sides are flex_1 with no flex_none on top: the
  // second one wins and the wide side then squeezes the other out of the window.
  splitSide(t, cell, tone, edge) {
    const body = cell
      ? h_flex().flex_1().min_w(0).h(20).gap(10).when(tone, (e) => e.bg(tone)).children([
        div().w(30).flex_none().text_right().text_color(cell.kind === "-" ? t.ansi1 : cell.kind === "+" ? t.ansi2 : t.dim).child(String(cell.number)),
        div().flex_1().min_w(0).truncate().child(cell.text),
      ])
      : div().flex_1().min_w(0).h(20).bg(t.raised + "10");
    return edge
      ? h_flex().flex_1().min_w(0).border_r(1).border_color(t.border).child(body)
      : h_flex().flex_1().min_w(0).child(body);
  }

  splitRow(row, t) {
    if (row.kind === "@") return div().w_full().h(20).flex_none().px(12).truncate().bg(t.raised).text_color(t.dim).child(row.text);
    if (row.kind !== "x" && row.kind !== "=") return div().w_full().h(20).flex_none().px(12).truncate().text_color(t.dim).child(row.text);
    const a = tint(t);
    return h_flex().w_full().h(20).flex_none()
      .child(this.splitSide(t, row.left, row.left?.kind === "-" ? t.ansi1 + a : null, true))
      .child(this.splitSide(t, row.right, row.right?.kind === "+" ? t.ansi2 + a : null, false));
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
    const rows = split ? this.split : this.rows;
    // Sharing the window between the two sides is the point of the split view, so it
    // takes no more width than there is: long lines are cut, and 单栏 is the view that
    // scrolls sideways to show a whole one.
    const width = split ? 0 : this.widths.one;
    return v_flex().id(id).flex_1().h_full().min_w(0).min_h(0)
      .child(h_flex().h(28).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(f ? f.path : "选一个文件看它的差异"))
        .when(Boolean(f?.folded), (e) => e.child(div().text_size(11).text_color(t.dim).child("GitLab 折起了这段，已按整份补丁取回")))
        .when(split && this.widths.half * 2 > 960, (e) => e.child(div().text_size(11).text_color(t.dim).child("长行截断，切回单栏可横向滚")))
        .child(this.seg(t, "diff", [["unified", "单栏"], ["split", "并排"]], this.view("diff"), (v) => this.setView("diff", v))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id(`${id}-x`).size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(width).h_full().child(v_virtual_list(id, rows.length, 20, (i) => String(i),
            (range) => rows.slice(range.start, range.end).map((row) => (split ? this.splitRow(row, t) : this.diffRow(row, t)))).size_full())))
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
    return box
      .child(this.head(t))
      .when(Boolean(this.view("desc")) && Boolean(this.desc.length), (e) => e.child(this.descPane(t)))
      .when(Boolean(this.error), (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.blocked).child(this.error)))
      .when(!this.error, (e) => e.child(h_flex().flex_1().min_h(0).children([this.filesPane(t), this.diffPane(t)])))
      .when(Boolean(this.note), (e) => e.child(h_flex().flex_none().px(10).py(6).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_size(11).text_color(this.noteBad ? t.blocked : t.done).child(this.note))
        .when(this.busy, (b) => b.child(div().text_size(11).text_color(t.dim).frames(SPINNER, 90)))
        .when(!this.busy, (b) => b.child(this.quiet(t, "recheck", "再查一次", "重新拉取这个 MR", (_e, cx) => { this.note = ""; this.load(cx); })))));
  }
}

// One issue, read here instead of in the browser: the description on the left, the discussion
// on the right, close and reopen along the top. It is opened as a tab of its own, so a long
// thread gets the width of the window. Everything comes from the API: the repo does not have to
// be on this machine, and nothing is written into a local .git.
//
// The markdown reader below is mr-review's, kept here in the same shape rather than imported: a
// mod is installed as a folder of its own, so one mod does not reach into another's files.

import { View, div } from "gpui-kit";
import { h_flex, v_flex, Scrollbar } from "gpui-base";
import { exec, nextCommand, openOverlay, props, setShared, shared, settings, theme } from "herdr";

const TIMEOUT = 45000;
// glab on this Windows box takes 13–17 s for one API round trip, and closing an issue can be
// slower than asking about it, so the action gets its own budget.
const ACTION_TIMEOUT = 90000;
// How often to ask again while an issue is open: enough to notice somebody else closing it or
// answering in the thread, cheap next to reading it.
const REFRESH = 60000;
// A confirmation is only worth acting on for this long. The dialog says "that one is done" and
// nothing else, so anything older than this was left over from another ask.
const CLAIM = 120000;
// How many comments are drawn, newest kept: an issue argued over for years has hundreds, and a
// tab that pages through them all on a 60 s poll is a lot of round trips for rows nobody
// scrolls to.
const MAXNOTES = 300;

// The payload key the confirmation hands back through, and the view choice: kept in shared
// state rather than localStorage because localStorage belongs to one copy, and a second issue
// tab should open the way the first one was left.
const PENDING = "issue-review.pending";
// What a close leaves for the list to read: `path#iid` -> when it happened. The same age limit
// as on the reading side, so an entry a list never got to prune cannot hide a row for good.
const DONE = "issue-review.done";
const DONE_KEEP = 15 * 60e3;
const VIEW = "issue-review.view";
const DEFAULTS = { talk: true };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// The list reads this: an issue closed here is off it before glab is asked again, because a row
// that is already decided should not sit there for another poll.
export function markDone(path, iid, now = Date.now()) {
  const old = shared(DONE) ?? {};
  const next = { [`${path}#${iid}`]: now };
  for (const [k, at] of Object.entries(old)) {
    if (now - Number(at) < DONE_KEEP) next[k] = at;
  }
  setShared(DONE, next);
  return next;
}

// ...and reopened, the other way round: the row is a live issue again, and a list that keeps a
// "done" mark on it would hide it until the mark aged out.
export function markOpen(path, iid) {
  const old = shared(DONE) ?? {};
  const key = `${path}#${iid}`;
  if (!(key in old)) return old;
  const next = { ...old };
  delete next[key];
  setShared(DONE, next);
  return next;
}

// The project path as GitLab's API wants it in a URL: every slash of it escaped.
export const enc = (path) => String(path).split("/").map(encodeURIComponent).join("%2F");

// glab wraps failures in a padded box and prefixes `glab: `, and an API error arrives as a
// bare `{"message":"404 Project Not Found"}glab: HTTP 404 (HTTP 404)`. What is left after
// dropping the frame, the prefix and the repeated code is the reason.
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

// One line of markdown with the markup taken off, keeping what it said.
export function mdInline(s) {
  // A code span keeps its text exactly, so it is set aside before anything is stripped — set
  // aside rather than split out, because emphasis runs across one: **不进 `a` / `b`** is bold
  // around two code spans, and cutting the line at them left the stars behind.
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

// A table row as its cells, pipes off. A pipe written \\| is part of the text and not a column
// break.
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

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// GitLab hands the description back as markdown and there is no text engine here, so this reads
// the line starts an issue actually needs and drops the markup inside a line.
export function mdLines(text) {
  const inline = mdInline;
  const out = [];
  const src = String(text).replace(/\r\n/g, "\n").split("\n");
  let code = false;
  for (let n = 0; n < src.length; n++) {
    const raw = src[n];
    if (/^\s*(`|`~)/.test(raw)) { code = !code; continue; }
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
    // A rule is a line, and a table is a table: its pipes are plumbing, not text, so the rows
    // become cells here and the alignment row goes away.
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

// A row whose text carries more than one source line (a wrapped bullet) keeps those breaks: one
// child per line, instead of one long line with the wrap lost.
const textLines = (s) => String(s).split("\n").map((line) => div().child(line));

// The discussion, in the order it happened. A system note is kept — "changed the description" is
// often the answer to why the page moved — and flagged, to be drawn as the small print it is.
export function noteRows(notes) {
  const out = [];
  for (const n of Array.isArray(notes) ? notes : []) {
    const body = String(n.body ?? "");
    out.push({
      id: "n" + String(n.id ?? out.length),
      who: n.author?.name || n.author?.username || "?",
      at: Date.parse(n.created_at) || 0,
      system: Boolean(n.system),
      plain: mdInline(body.split("\n")[0] ?? ""),
      body: mdLines(body),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

// The labels as they are drawn: GitLab's own colour on each, when the payload carries one. A
// list endpoint hands back names only, so a payload with no colour is drawn in the theme's grey
// rather than in a colour nobody chose.
export function labelsOf(meta) {
  const list = Array.isArray(meta?.labels) ? meta.labels : [];
  return list.map((l) => (typeof l === "string"
    ? { name: String(l), color: "", text: "" }
    : { name: String(l?.name ?? ""), color: String(l?.color ?? ""), text: String(l?.text_color ?? "") }))
    .filter((l) => l.name);
}

export default class IssueReview extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.iid = p.iid ? String(p.iid) : "";
    this.path = String(p.path ?? "");
    this.on = typeof p.on === "string" ? p.on : null; // whose glab to ask
    this.meta = null;
    this.desc = []; // the description, as rows
    this.notes = []; // the comments, oldest first
    this.notesCut = 0; // how many older ones were left out
    this.error = "";
    this.note = ""; // what the last close or reopen said
    this.noteBad = false;
    this.loading = false;
    this.busy = false;
    this.again = false; // a load that was asked for while one was already out
    cx.timer.every(REFRESH, (cx) => this.load(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // The dialog's command, and nothing else: a mod that answered to a bare "confirm" would
        // take the MR review's answer for its own.
        if (c !== "issue-review.confirm") continue;
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
    setShared(VIEW, { ...(shared(VIEW) ?? {}), [key]: value });
  }

  // after runs once this load's answer is in — or at once, when there was nothing to ask: act()
  // uses it to judge the close by the issue as glab reports it afterwards.
  load(cx, after) {
    if (!this.iid || !this.path) { after?.(); return; }
    // Asked again while glab is still thinking about the last time — the ↻ is a click away and a
    // poll can take 15 s — remembered and gone round once more when this one lands, instead of a
    // click that appears to do nothing.
    if (this.loading || this.busy) { if (!this.busy) this.again = true; after?.(); return; }
    this.loading = true;
    // Every GitLab endpoint a project's own things hang on starts here: the path is the id.
    const project = `projects/${enc(this.path)}/issues/${this.iid}`;
    cx.spawn(async (cx) => {
      try {
        // The issue itself is the page: without it there is nothing to read, so it is the one
        // that can fail the load. The notes are the extra — a token that cannot read them must
        // not cost the reader the description — so they answer undefined instead, which the
        // field below reads as "no news" and keeps what it had.
        const meta = await this.call(["api", `${project}?with_labels_details=true`]);
        let notes;
        try {
          notes = await this.call(["api", "--paginate", `${project}/notes?per_page=100&sort=asc`]);
        } catch { notes = undefined; }
        this.meta = meta;
        if (notes !== undefined) {
          const all = noteRows(notes);
          this.notesCut = Math.max(0, all.length - MAXNOTES);
          this.notes = all.slice(-MAXNOTES);
        }
        this.desc = mdLines(String(meta?.description ?? ""));
        this.error = "";
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

  // The built-in dialog runs a command when it is told yes, and that command carries nothing, so
  // which issue to act on is left in shared state for this copy to pick up.
  ask(kind) {
    if (this.busy || this.loading || !this.meta) return;
    setShared(PENDING, { kind, iid: this.iid, path: this.path, on: this.on, at: Date.now() });
    openOverlay({
      mod: "confirm",
      kind: "dialog",
      // The built-in dialog gives its detail a flex area, so a height picked too large leaves a
      // hole in the middle and one picked too small cuts the warning off.
      width: 0.45,
      height: 240,
      props: {
        title: kind === "close" ? `关闭 #${this.iid}？` : `重新打开 #${this.iid}？`,
        detail: [
          this.path,
          String(this.meta.title ?? ""),
          "",
          kind === "close"
            ? "关掉之后它从列表里消失，描述、标签和讨论都还在；要恢复就在这个标签页上点“重新打开”。"
            : "重新打开之后它回到列表里，下一次问 GitLab 时就在。",
        ].join("\n"),
        command: { name: "issue-review.confirm" },
      },
    });
  }

  // Told to the list now rather than at its next poll — but only once the issue as glab reports
  // it really says so: a close glab accepted can still be a state GitLab had already.
  act(job, cx) {
    const close = job.kind === "close";
    const args = ["issue", close ? "close" : "reopen", String(job.iid), "-R", String(job.path)];
    this.busy = true;
    this.note = "";
    let done = false;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("glab", args, { on: job.on ?? null, timeout: ACTION_TIMEOUT });
        if (r.code !== 0) throw say(r.stderr || r.stdout);
        this.note = close ? "已关闭这个 issue。" : "已重新打开这个 issue。";
        this.noteBad = false;
        done = true;
      } catch (e) {
        this.note = `${close ? "关闭" : "重新打开"}没做成：${say(e)}`;
        this.noteBad = true;
      } finally {
        this.busy = false;
        // Only a command glab accepted can have moved the issue: a failure leaves the list alone.
        this.load(cx, () => {
          if (!done) return;
          if (close) markDone(job.path, job.iid);
          else markOpen(job.path, job.iid);
        });
        cx.notify();
      }
    });
    cx.notify();
  }

  web() {
    if (!this.path) return;
    exec("glab", ["issue", "view", this.iid, "-R", this.path, "--web"], { on: this.on, timeout: TIMEOUT }).catch(() => {});
  }

  quiet(t, id, label, tip, press) {
    return div().id(id).h(28).px(9).flex().items_center().rounded(7).bg(t.raised).text_color(t.muted).text_size(12)
      .cursor_pointer().tooltip(tip).hover((s) => s.bg(t.hover)).on_click(press).child(label);
  }

  button(t, id, label, kind, on, why) {
    return div().id(id).h(28).px(12).flex().items_center().rounded(7).text_size(12)
      .bg(t.raised)
      .text_color(kind === "close" ? (on ? t.blocked : t.dim) : (on ? t.foreground : t.dim))
      .when(on, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(() => this.ask(kind)))
      // A button that does nothing has to say why, or it reads as a broken panel rather than as
      // GitLab's answer.
      .when(!on && Boolean(why), (e) => e.tooltip(why))
      .child(label);
  }

  // What the buttons may do, and what the state on screen is called. Closing needs an open
  // issue; reopening needs a closed one; neither happens while glab is thinking.
  verdict(m = this.meta ?? {}) {
    const state = String(m.state ?? "");
    const [label, tone] = state === "closed" ? ["已关闭", "dim"] : state === "opened" ? ["打开", "done"] : [state, "dim"];
    const idle = !this.busy && !this.loading && Boolean(state);
    return { state, label, tone, idle, canClose: idle && state === "opened", canOpen: idle && state === "closed" };
  }

  chips(t) {
    const labels = labelsOf(this.meta);
    const shown = labels.slice(0, 4);
    const more = labels.length - shown.length;
    return shown.map((l) => div().id(`label-${l.name}`).flex_none().max_w(140).truncate().rounded(4).px(5).py(1)
      .text_size(10.5)
      .bg(l.color || t.raised).text_color(l.text || t.muted)
      .child(l.name))
      .concat(more > 0 ? [div().flex_none().text_size(10).text_color(t.dim).child(`+${more}`)] : []);
  }

  head(t) {
    const m = this.meta ?? {};
    const { state, label, tone, canClose, canOpen } = this.verdict(m);
    const said = this.notes.filter((n) => !n.system).length;
    const who = (Array.isArray(m.assignees) ? m.assignees : []).map((a) => a?.name || a?.username).filter(Boolean).join(", ");
    const author = m.author?.name || m.author?.username || "?";
    const due = Date.parse(m.due_date) || 0;
    const overdue = due > 0 && due < Date.now() && this.verdict(m).state === "opened";
    return v_flex().flex_none().p(10).gap(7).children([
      h_flex().gap(8).items_center().children([
        div().px(5).py(1).rounded(5).bg(t.raised).text_size(11).text_color(t.muted).child(`#${this.iid}`),
        div().flex_1().min_w(0).truncate().font_semibold().child(String(m.title ?? (this.loading ? "加载中…" : "没有标题"))),
        div().text_size(11).text_color(t[tone] ?? t.dim).child(label),
        this.quiet(t, "refresh", this.loading ? "⋯" : "↻", "重新问一次 GitLab", (_e, cx) => this.load(cx)),
        this.quiet(t, "web", "在浏览器打开", "glab issue view --web", () => this.web()),
        this.button(t, "close-issue", "关闭", "close", canClose,
          state === "closed" ? "这个 issue 已经关着了" : null),
        this.button(t, "open-issue", "重新打开", "open", canOpen,
          state === "opened" ? "这个 issue 还开着" : null),
        said || this.view("talk")
          ? div().id("show-talk").h(28).px(9).flex().items_center().rounded(7)
            .bg(this.view("talk") ? t.selected : t.raised)
            .text_color(this.view("talk") ? t.foreground : t.muted).cursor_pointer()
            .tooltip(this.view("talk") ? "收起讨论" : "展开讨论")
            .on_click((_e, cx) => { this.setView("talk", !this.view("talk")); cx.notify(); })
            .child(`讨论 ${said}`)
          : div().flex_none(),
      ]),
      h_flex().gap(8).items_center().text_size(11).text_color(t.dim).children([
        div().flex_none().max_w(300).truncate()
          .child(who ? `${author} · 指派给 ${who}` : author),
        div().flex_none().child(`更新 ${ago(Date.parse(m.updated_at) || 0)}`),
        ...(m.milestone?.title ? [div().flex_none().max_w(160).truncate().text_color(t.muted).tooltip("里程碑").child(`◆ ${m.milestone.title}`)] : []),
        ...(due > 0 ? [div().flex_none().text_color(overdue ? t.blocked : t.dim).tooltip("截止日期").child(`截止 ${String(m.due_date).slice(0, 10)}`)] : []),
        ...this.chips(t),
        div().flex_1().min_w(0).truncate().text_right().child(this.path),
      ]),
    ]);
  }

  // A run of lines of one kind is one thing on screen: a fenced block is a block with a line
  // per row, a quote keeps a single bar down its side, and a paragraph stays together.
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

  // A table as a grid: a header row over a rule, then a row per line, the cells sharing the
  // width. Its pipes drawn as monospace text read as one long code line that wrapped anywhere.
  tableBox(t, l, i, pre = "d") {
    const all = [l.head, ...l.rows];
    const cols = Math.max(...all.map((r) => r.length));
    // A column is as wide as what is in it, capped: a table of a name and a sentence reads as
    // 1:4 rather than 1:1, and one enormous cell cannot take the whole row.
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
    if (l.kind === "li") {
      return h_flex().id(`${pre}-${i}`).w_full().flex_none().gap(8).ml(pad).items_start()
        .child(div().w(8).flex_none().text_color(t.dim).child("·"))
        .child(v_flex().flex_1().min_w(0).children(textLines(l.text)));
    }
    return div().id(`${pre}-${i}`).w_full().flex_none().ml(pad).child(l.text);
  }

  descPane(t) {
    const id = "ir-desc";
    // A box of its own with the list absolutely inside it: a long description inside a row-sized
    // column paints over the header instead, because the row never clips it.
    // h_full: a row sizes its children's cross axis from *them*, not from itself, and this box's
    // only children are absolutely positioned — so without it the box is as tall as nothing, and
    // the description is drawn as a 2 px strip down the middle of the tab. (mr-review's two row
    // children say the same thing; its description pane gets its height from being alone in a
    // column, which is not the shape here.)
    return div().id("ir-desc-box").flex_1().h_full().min_w(0).min_h(0).relative()
      .child(v_flex().id(id).absolute().inset_0().overflow_y_scroll().px(12).py(10).gap(2)
        .when(this.desc.length === 0, (e) => e.child(div().text_size(11.5).text_color(t.dim).child("这个 issue 没有描述。")))
        .children(this.mdBlocks(t)))
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  // The discussion, beside the description rather than under it: both are read at once — the
  // comment answers the words above it — and each scrolls on its own.
  talkPane(t) {
    const id = "ir-talk";
    const said = this.notes.filter((n) => !n.system).length;
    return v_flex().id(id).flex_none().w(360).h_full().min_w(0).min_h(0)
      .border_l(1).border_color(t.border)
      .child(h_flex().h(28).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child(`讨论 ${said} 条`))
        .child(div().flex_1())
        .child(this.quiet(t, "talk-close", "收起", "把讨论收起来，让描述占满", (_e, cx) => { this.setView("talk", false); cx.notify(); })))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id(`${id}-list`).absolute().inset_0().overflow_y_scroll().p(8).gap(6)
          .when(this.notesCut > 0, (e) => e.child(div().w_full().flex_none().text_size(10.5).text_color(t.dim)
            .child(`前面还有 ${this.notesCut} 条没有列出来`)))
          .when(this.notes.length === 0, (e) => e.child(div().w_full().flex_none().text_size(11).text_color(t.dim).child("还没有人评论")))
          .children(this.notes.map((n) => this.noteRow(t, n))))
        .child(Scrollbar.vertical(`${id}-list`).absolute().inset_0()));
  }

  // A comment is a card: who said it, when, then the words in the same markdown the description
  // is read in. A system note is one dim line instead, because "changed the description" is
  // context for the thread, not something somebody said to you.
  noteRow(t, n) {
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
          div().flex_1().min_w(0),
          div().flex_none().text_size(10).text_color(t.dim).child(ago(n.at)),
        ]),
        v_flex().w_full().flex_none().gap(2).children(this.mdBlocks(t, n.body, `t-${n.id}`)),
      ]);
  }

  render() {
    const t = theme();
    const box = v_flex().id("issue-review").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    if (!this.iid || !this.path) {
      return box.child(div().flex_1().items_center().justify_center().text_color(t.dim).child("从 issue 列表点一行打开一个 issue"));
    }
    return box
      .child(this.head(t))
      .when(Boolean(this.error), (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.blocked).child(this.error)))
      .when(!this.error, (e) => e.child(h_flex().flex_1().min_h(0).children(
        [this.descPane(t), ...(this.view("talk") ? [this.talkPane(t)] : [])])))
      .when(Boolean(this.note), (e) => e.child(h_flex().flex_none().px(10).py(6).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_size(11).text_color(this.noteBad ? t.blocked : t.done).child(this.note))
        .when(this.busy, (b) => b.child(div().text_size(11).text_color(t.dim).frames(SPINNER, 90)))
        .when(!this.busy, (b) => b.child(this.quiet(t, "recheck", "再查一次", "重新拉取这个 issue", (_e, cx) => { this.note = ""; this.load(cx); })))));
  }
}

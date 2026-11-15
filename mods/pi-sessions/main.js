// A panel for the dock: the Pi sessions of the folder this space works in, newest first;
// a row opens that session in a tab of its own. A project collects hundreds of them, so
// the list is cheap on purpose: one readdir for every row, and a session file is read
// only once its row is on screen. A page is the most that is ever read.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, home, layout, panes, props, run, spaces, theme } from "herdr";
import { join } from "path";
import { readdir, readFile } from "fs/promises";

// Rows on screen at a time, and so the most sessions read: "older" asks for the next page.
const PAGE = 40;
// Files read between redraws, so a page fills in as it lands instead of in one long blank.
const BATCH = 6;
// How often the folder is listed again, for a session someone just started.
const POLL = 15000;
const TICK = 5000;
const TIMEOUT = 20000;

// Where Pi keeps a folder's sessions: D:\Projects\app -> --D--Projects-app--. Its own
// encoding drops the leading separator first, then replaces the rest.
export function slugOf(folder) {
  const path = String(folder || "").replace(/^[\\/]+/, "");
  return "--" + path.replace(/[:\/\\]/g, "-") + "--";
}

// 2026-11-15T05-54-54-453Z_01a1ddc5-....jsonl: when it started, and the id Pi answers to.
const FILE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:_([^/\\]*))?\.jsonl$/;

export function ofFile(name) {
  const m = FILE.exec(name);
  return {
    name,
    id: m && m[6] ? m[6] : "",
    at: m ? Date.parse(m[1] + "T" + m[2] + ":" + m[3] + ":" + m[4] + "." + m[5] + "Z") || 0 : 0,
  };
}

function say(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// A message's text: a plain string, or the text blocks of an array. Tool calls, images and
// thinking are not what a row is for.
function textOf(content) {
  if (typeof content === "string") return content;
  return (content || [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

export function oneLine(value, max = 140) {
  const t = say(value);
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

const STAMP = /"timestamp":"([^"]+)"/;

// What a row says, from the one file holding it. Only the lines that carry something are
// parsed: a long session is mostly messages, and its name is the last thing appended.
// "partial" is the ends of a file too long to carry over a connection: enough for the
// name, the first message and the last word, but not to count every turn in between.
export function digest(text, partial) {
  const out = { name: "", preview: "", at: 0, turns: 0, model: "", partial: Boolean(partial) };
  const lines = String(text || "").split("\n");
  let stamped = false;
  let named = false;
  let modelled = false;
  for (let i = lines.length - 1; i >= 0 && !(stamped && named && modelled); i--) {
    const line = lines[i];
    if (!line || line.length < 12) continue;
    if (!stamped) {
      const m = STAMP.exec(line);
      if (m) {
        out.at = Date.parse(m[1]) || 0;
        stamped = Boolean(out.at);
      }
    }
    if (!named && line.indexOf('"session_info"') > 0) {
      try {
        const entry = JSON.parse(line);
        if (entry && entry.type === "session_info" && entry.name) {
          out.name = say(entry.name);
          named = true;
        }
      } catch (e) {
        // a half-written line: the next one up may still have it
      }
    }
    if (!modelled && line.indexOf('"type":"model_change"') > 0) {
      try {
        const entry = JSON.parse(line);
        if (entry && entry.modelId) {
          out.model = entry.provider ? entry.provider + "/" + entry.modelId : String(entry.modelId);
          modelled = true;
        }
      } catch (e) {}
    }
    if (!modelled && line.indexOf('"role":"assistant"') > 0) {
      try {
        const message = JSON.parse(line).message;
        if (message && message.model) {
          out.model = message.provider ? message.provider + "/" + message.model : String(message.model);
          modelled = true;
        }
      } catch (e) {}
    }
  }
  for (const line of lines) {
    if (!line || line.indexOf('"role":"user"') < 0) continue;
    if (!out.partial) out.turns += 1;
    if (!out.preview) {
      try {
        const entry = JSON.parse(line);
        if (entry && entry.type === "message") out.preview = oneLine(textOf(entry.message && entry.message.content));
      } catch (e) {}
    }
  }
  return out;
}

export function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "now";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  if (s < 2592000) return Math.round(s / 86400) + "d";
  return new Date(ms).toISOString().slice(0, 10);
}

// The last stretch of a model id: "anthropic/claude-sonnet-4-5" says its maker already.
export function shortModel(model) {
  const words = String(model || "").split("/");
  return words[words.length - 1] || "";
}

// A child of a folder, on the machine the folder is on. Only this computer's folders come
// with backslashes; a machine's are its own, and its home is not this one's.
function under(dir, name) {
  return dir.indexOf("/") === 0 ? dir.replace(/\/+$/, "") + "/" + name : join(dir, name);
}

// The folder is not there: Pi has never run in it. Anything else is worth saying out loud.
function missing(e) {
  return /ENOENT|no such file|not a directory|cannot access/i.test(say((e && e.message) || e));
}

// Which node in the layout document has this id.
function find(node, id) {
  if (node && node.id === id) return node;
  for (const child of (node && node.children) || []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

export default class PiSessions extends View {
  init(_props, cx) {
    this.folder = null; // the project the list below belongs to
    this.on = null; // the machine it lives on, null for this computer
    this.dir = null; // its folder in Pi's sessions, null when Pi never ran there
    this.dirOf = null; // the folder "dir" was resolved for, so it is not asked again
    this.rootFor = "unset"; // the machine "root" was read for
    this.root = null; // where Pi keeps sessions on that machine
    this.rows = null; // null: nothing listed yet, so the first frame says so
    this.loadedFor = null; // the project "rows" was listed for
    this.meta = {}; // file name -> digest, filled only for rows that were on screen
    this.failed = {}; // file names that would not read, so they are not asked twice
    this.limit = PAGE; // rows shown; the rest are neither drawn nor read
    this.reading = false; // a batch is being read right now
    this.loading = false; // a listing is out
    this.again = false; // another listing was asked for while one was out
    this.error = "";
    this.at = 0; // when the folder was last listed
    this.wasShown = true; // whether the layout had this panel up at the last look
    this.seen = ""; // what the screen last showed, so a steady list stays quiet
    cx.timer.every(TICK, (cx) => this.tick(cx));
    this.tick(cx);
  }

  // Whether this copy is the panel the layout is showing. Without the ids the layout hands
  // it — read on its own, or under "herdr-app check" — there is nothing to ask, so it
  // counts as shown and the list is the point.
  onScreen() {
    const p = props() || {};
    if (!p.stack || !p.node) return true;
    const s = find(layout(), p.stack);
    return Boolean(s) && !s.hidden && s.active === p.node;
  }

  // The space the window is on decides what "this project" means.
  space() {
    const all = spaces();
    return all.find((s) => s.active) || all[0] || null;
  }

  // Where the project actually is. "space().folder" is only where new terminals start, so
  // it is the last choice: a space whose shells have cd'd elsewhere holds other sessions.
  target() {
    const space = this.space();
    if (!space) return { folder: null, on: null };
    const tabs = new Set((space.tabs || []).map((c) => c.id));
    const ps = panes().filter((p) => tabs.has(p.tab));
    const here = ps.find((p) => p.focused && p.cwd) || ps.find((p) => p.cwd);
    const folder = (here && here.cwd) || space.folder;
    return { folder: folder || null, on: space.machine || null };
  }

  tick(cx) {
    const open = this.onScreen();
    const back = open && !this.wasShown;
    this.wasShown = open;
    // Put away, it asks nothing at all: no listing, no reads. It starts again when shown.
    if (!open) return;
    // `stale()` covers another folder as well as the same one seen from another machine.
    if (back || this.stale() || this.rows === null || Date.now() - this.at >= POLL) this.reload(cx);
  }

  // What the rows on screen belong to: this project on this machine.
  key() {
    const { folder, on } = this.target();
    return (folder || "") + "|" + (on || "");
  }

  // The rows are this project's only if they were listed for it. The window can move to
  // another space at any moment, and until a listing for that one lands the old rows are
  // yesterday's news under today's name.
  stale() {
    return this.rows !== null && this.loadedFor !== this.key();
  }

  // Where Pi keeps sessions on the machine this project lives on. A machine's home is its
  // own: this computer's is only right here.
  async rootPath() {
    if (this.rootFor === this.on) return this.root;
    if (!this.on) {
      this.root = join(home(), ".pi", "agent", "sessions");
    } else {
      const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on, timeout: TIMEOUT });
      const base = String(r.stdout || "").trim();
      if (r.code !== 0 || !base) throw new Error(say(r.stderr || r.stdout) || "cannot read $HOME on " + this.on);
      this.root = base.replace(/\/+$/, "") + "/.pi/agent/sessions";
    }
    this.rootFor = this.on;
    return this.root;
  }

  // A folder's entries, here or on the machine the project is on. Another computer has no
  // readdir from inside this one, so its folders are listed by running ls there.
  async names(dir) {
    if (!this.on) return readdir(dir);
    const r = await exec("ls", ["-1", dir], { on: this.on, timeout: TIMEOUT });
    if (r.code !== 0) throw new Error(say(r.stderr || r.stdout) || "cannot list " + dir);
    return String(r.stdout || "").split("\n").map((n) => n.trim()).filter(Boolean);
  }

  // One session file: all of it here, or the two ends of it from the machine it is on. A
  // session there runs to megabytes, and the whole of one is not worth the wire: the first
  // message is at the top and the name at the bottom. One call, so a page is not eighty.
  async read(row) {
    const path = under(this.dir, row.name);
    if (!this.on) return { text: String(await readFile(path, "utf8")), partial: false };
    const r = await exec("sh", ["-c", 'head -c 65536 "$1"; printf "\n@@CUT@@\n"; tail -c 65536 "$1"', "sh", path], {
      on: this.on,
      timeout: TIMEOUT,
    });
    if (r.code !== 0) throw new Error(say(r.stderr || r.stdout) || "cannot read " + path);
    return { text: String(r.stdout || ""), partial: true };
  }

  // Pi's sessions folder for a project. The exact name is the rule; the case-insensitive
  // match is for a path Pi recorded with another letter case than the shell reports.
  async dirFor(folder) {
    if (!folder) return null;
    if (this.dirOf === folder) return this.dir;
    const root = await this.rootPath();
    let dirs = [];
    try {
      dirs = await this.names(root);
    } catch (e) {
      // Pi has never run here at all is an answer; anything else is worth saying out loud.
      if (!missing(e)) throw e;
      dirs = [];
    }
    const want = slugOf(folder);
    const hit = dirs.includes(want) ? want : dirs.find((d) => d.toLowerCase() === want.toLowerCase()) || null;
    this.dirOf = folder;
    this.dir = hit ? under(root, hit) : null;
    return this.dir;
  }

  // Everything a redraw would put on screen, in one string: a steady list stays quiet.
  seenNow() {
    const names = (this.rows || []).map((r) => r.name).join(",");
    return [this.folder, this.on, this.error, this.limit, names].join("|");
  }

  reload(cx) {
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    this.at = Date.now();
    const place = this.target();
    const asked = place.folder + "|" + (place.on || ""); // an answer about another project is not an answer
    if (place.folder !== this.folder || place.on !== this.on) {
      // Another project: another list, from the top, with none of the old project's digests.
      this.folder = place.folder;
      this.on = place.on;
      this.dirOf = null;
      this.dir = null;
      this.limit = PAGE;
      this.meta = {};
      this.failed = {};
    }
    cx.spawn(async (cx) => {
      let rows = null;
      let error = "";
      try {
        const dir = await this.dirFor(this.folder);
        if (!dir) {
          rows = []; // Pi has never run in this folder
        } else {
          const names = await this.names(dir);
          rows = names
            .filter((name) => FILE.test(name))
            .map(ofFile)
            .sort((a, b) => b.name.localeCompare(a.name)); // the file name starts with its time
        }
      } catch (e) {
        // A failed listing keeps the rows it had, unless it is about another project than
        // the one they were read for: those are yesterday's, and none is better than them.
        rows = this.loadedFor === asked ? this.rows || [] : [];
        error = say((e && e.message) || e);
      }
      if (asked !== this.folder + "|" + (this.on || "")) {
        // The window moved while this was out: it says nothing about where it is now.
        this.loading = false;
        this.again = false;
        return;
      }
      this.loadedFor = asked; // these rows are that project's
      this.loading = false;
      const listed = rows !== null && (this.rows || []).length !== rows.length;
      if (rows !== null) this.rows = rows;
      this.error = error;
      const seen = this.seenNow();
      if (listed || seen !== this.seen) {
        this.seen = seen;
        cx.notify();
      }
      this.fill(cx);
      if (this.again) {
        this.again = false;
        this.reload(cx);
      }
    });
  }

  // Reads the shown rows only, a few files at a time: a page of long sessions is seconds
  // of work, so each batch lands on screen as it comes instead of after the last one.
  fill(cx) {
    // Put away, nothing is read: the page fills in when it is on screen again.
    if (this.reading || !this.dir || !this.onScreen()) return;
    const todo = () =>
      (this.rows || []).slice(0, this.limit).filter((r) => !this.meta[r.name] && !this.failed[r.name]);
    if (!todo().length) return;
    this.reading = true;
    const project = this.folder + "|" + (this.on || "");
    cx.spawn(async (cx) => {
      while (true) {
        if (project !== this.folder + "|" + (this.on || "")) break; // not this list any more
        if (!this.onScreen()) break; // put away mid-page: the rest waits
        const next = todo().slice(0, BATCH);
        if (!next.length) break;
        for (const row of next) {
          try {
            const got = await this.read(row);
            this.meta[row.name] = digest(got.text, got.partial);
          } catch {
            this.failed[row.name] = true;
          }
        }
        cx.notify();
      }
      this.reading = false;
      if (project !== this.folder + "|" + (this.on || "")) this.fill(cx); // the new list's own turn
    });
  }

  more(cx) {
    this.limit = Math.min(this.limit + PAGE, (this.rows || []).length);
    this.seen = this.seenNow();
    this.fill(cx);
    cx.notify();
  }

  // A session tab of its own: it needs the width of the main area and stays put while the
  // list keeps looking for new sessions. "--session" takes the file, so a project that has
  // been moved still opens the session it was.
  open(row) {
    if (!this.dir) return;
    run("tab.new", {
      name: oneLine(this.title(row), 60),
      folder: this.folder,
      argv: ["pi", "--session", under(this.dir, row.name)],
    });
  }

  title(row) {
    const m = this.meta[row.name];
    const id = row.id ? row.id.slice(0, 8) : "";
    if (!m) return id || "…";
    return m.name || m.preview || id || "(empty session)";
  }

  item(t, row, i) {
    const m = this.meta[row.name];
    const turns = m && m.turns > 0 ? m.turns + (m.turns === 1 ? " msg" : " msgs") : "";
    const facts = [ago((m && m.at) || row.at), turns].filter(Boolean).join(" · ");
    return v_flex().id("s-" + i).gap(2).px(7).py(5).rounded(6)
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.open(row))
      .children([
        div().truncate().text_color(m ? t.foreground : t.muted).child(this.title(row)),
        h_flex().gap(6).text_size(10.5).text_color(t.dim).children([
          div().flex_none().child(facts),
          div().flex_1().truncate().child(shortModel(m && m.model)),
          this.failed[row.name] ? div().flex_none().text_color(t.blocked).child("unreadable") : div().flex_none(),
        ]),
      ]);
  }

  // A fixed box, not one sized by its glyph: the ↻ would otherwise drift off the row.
  iconBtn(t, id, tip, inner, press) {
    return h_flex().id(id).flex_none().w(24).h(22).rounded(5).items_center().justify_center()
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip(tip).on_click(press).child(inner);
  }

  where() {
    if (this.stale()) return "looking…"; // the old project's count is not this one's
    if (this.error) return this.error;
    if (this.rows === null) return this.folder || "";
    const total = this.rows.length;
    if (!total) return this.dir ? "No sessions in this folder" : "No Pi sessions here yet";
    const many = total === 1 ? " session" : " sessions";
    return this.limit < total ? total + many + " · showing " + this.limit : total + many;
  }

  head(t) {
    return v_flex().flex_none().p(8).gap(6).children([
      h_flex().gap(2).items_center().children([
        div().flex_1().font_semibold().child("Pi sessions"),
        // Its own slot, filled or not: the button must not slide while a page fills in.
        this.reading
          ? h_flex().flex_none().w(18).h(22).items_center().justify_center()
            .child(div().text_size(11).text_color(t.dim).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))
          : div().flex_none().w(18),
        this.iconBtn(t, "refresh", "List this folder again", div().text_size(13).child("↻"), (_e, cx) => {
          this.at = 0;
          this.reload(cx);
        }),
      ]),
      div().text_size(10.5).text_color(t.dim).truncate().child(this.where()),
      // The folder the window is on now, not the one the list was read from.
      this.target().folder
        ? div().text_size(10).text_color(t.dim).truncate().child(this.target().folder)
        : div().flex_none(),
    ]);
  }

  body(t) {
    // Another project's rows are not shown while this one's answer is on its way.
    if (this.rows === null || this.stale()) {
      return v_flex().flex_1().items_center().justify_center()
        .child(div().text_size(11.5).text_color(t.dim).child(this.loading ? "looking…" : "…"));
    }
    const shown = this.rows.slice(0, this.limit);
    const older = this.rows.length - shown.length;
    return v_flex().flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(8).gap(2)
      .when(Boolean(this.error), (el) => el.child(
        div().px(7).py(5).text_size(11).text_color(t.blocked).child(this.error)))
      .when(this.rows.length === 0 && !this.error, (el) => el.child(
        div().px(7).py(5).text_size(11).text_color(t.dim)
          .child(this.dir ? "This folder's session list is empty." : "Start Pi in this folder and it shows up here.")))
      .children(shown.map((row, i) => this.item(t, row, i)))
      .when(older > 0, (el) => el.child(
        h_flex().id("older").flex_none().h(26).px(7).items_center().justify_center().rounded(6)
          .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.more(cx))
          .child(older + " older")));
  }

  render() {
    const t = theme();
    return v_flex().size_full().bg(t.chrome).text_size(12.5)
      .children([this.head(t), div().flex_none().h(1).bg(t.border), this.body(t)]);
  }
}

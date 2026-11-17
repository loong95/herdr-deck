// A panel for the dock: GitLab issues, switched between the current space's project and
// every open issue the token can see, grouped by project, the space's own one first.
//
// A row opens that issue in a tab of its own (issue-review): its description and its discussion
// need the width of the main area, and the tab stays put while this list keeps refreshing. The
// issue's own page in the browser is a button on that tab, not what a click here costs.
//
// The project is read from the folder's git remote, `origin` first: an issue belongs to the
// project and not to a branch. (gitlab-mr asks the current branch's upstream instead — an MR
// of ours is the branch's, and a checkout can have several remotes.)

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, layout, panes, props, run, setShared, shared, spaces, theme } from "herdr";

const PER_PAGE = "100";
const TIMEOUT = 45000;
// The round trip to glab, and how often the cheap look happens instead: a hidden copy's
// timers keep running, and that look is the only way to find out the dock brought us back.
const POLL = 45000;
const TICK = 5000;
// How long a request has to take before it is worth saying "working on it" about. Every
// redraw of a mod redraws the whole window, so a poll that answers in a blink must not spend
// two of them to mention itself.
const SLOW = 350;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// What the dock keeps this icon told with.
const BADGE = "gitlab-issues.badge";
// Where the chosen scope is remembered. Storage belongs to the whole application, not to one
// panel, so the key says which panel it is — gitlab-mr's own is the bare "mode".
const MODE = "gitlab-issues.mode";
// What an issue tab has just closed, written by issue-review: a row it names leaves the list at
// once. The same age limit as on the writing side, so an entry a tab never got to prune cannot
// hide a row for good.
const DONE = "issue-review.done";
const DONE_KEEP = 15 * 60e3;

// Which node in the layout document has this id.
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

// `group/sub/repo#3` -> `group/sub/repo`, the path GitLab calls the project by.
export function projectOf(x) {
  const full = x?.references?.full ?? "";
  const at = full.lastIndexOf("#");
  return at > 0 ? full.slice(0, at) : "";
}

// `https://host/group/repo/-/issues/12` -> `group/repo`: the project for a payload whose
// `references` did not come along.
export function projectOfUrl(url) {
  const hit = String(url ?? "").match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+?)\/-\//i);
  return hit ? hit[1] : "";
}

// `git@host:group/repo.git`, `https://host/group/repo.git`, `ssh://git@host:22/group/repo`.
export function pathOfRemote(url) {
  const t = String(url ?? "").trim().replace(/\.git\/?$/, "");
  const scp = t.match(/^[^@/\s]+@[^:\s]+:(.+)$/);
  if (scp) return scp[1];
  const uri = t.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/(.+)$/i);
  return uri ? uri[1] : null;
}

// The host a remote URL names, lower case: "" for a path on this machine.
function hostOf(url) {
  const t = String(url ?? "").trim();
  const scp = t.match(/^[^@/\s]+@([^:\s/]+):/);
  if (scp) return scp[1].toLowerCase();
  const uri = t.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i);
  return uri ? uri[1].toLowerCase() : "";
}

// Hosts that run no GitLab: a remote there has no issues to ask about. Anything else is taken
// to be one, because a company's own instance has no name to list here.
const ELSEWHERE = ["github.com", "gitee.com", "gitcode.com", "bitbucket.org", "codeberg.org", "git.sr.ht", "sourceforge.net", "dev.azure.com", "gitea.com"];

function elsewhere(host) {
  return !host || ELSEWHERE.some((h) => host === h || host.endsWith("." + h));
}

export function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 2592000) return `${Math.round(s / 86400)}d`;
  return new Date(ms).toISOString().slice(0, 10);
}

// glab wraps failures in a padded box and prefixes `glab: `, and an API error arrives as a
// bare `{"message":"404 Project Not Found"}glab: HTTP 404 (HTTP 404)`. What is left after
// dropping the frame, the prefix and the repeated code is the reason.
export function say(e) {
  const text = String(typeof e === "string" ? e : e?.message ?? e);
  const api = text.match(/^\s*\{"message":"(.+?)"\}/);
  if (api) return api[1];
  const noise = /^(ERROR|Try .* for usage\.?)$/i;
  const clean = (l) => l.trim().replace(/^glab:\s*/, "").replace(/\s*\(HTTP \d+\)$/, "");
  return text.split("\n").map(clean).find((l) => l && !noise.test(l)) ?? "glab did not answer";
}

// A title, cut to what a tab can wear: the project it was cut from is at the end of the name and
// must survive, so the title gives way first.
export function short(title, max = 44) {
  const one = String(title ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

// One issue, in the shape the panel draws. Labels are names here: the list endpoints hand back
// strings, and a payload that carries the whole label object says the same thing in `name`.
export function rowOf(x, i) {
  return {
    n: i,
    iid: x.iid,
    path: projectOf(x) || projectOfUrl(x.web_url),
    title: String(x.title ?? ""),
    author: x.author?.name || x.author?.username || "?",
    who: (Array.isArray(x.assignees) ? x.assignees : [])
      .map((a) => a?.name || a?.username).filter(Boolean).join(", "),
    labels: (Array.isArray(x.labels) ? x.labels : [])
      .map((l) => (typeof l === "string" ? l : l?.name ?? "")).filter(Boolean),
    url: String(x.web_url ?? ""),
    at: Date.parse(x.updated_at) || 0,
  };
}

export default class GitlabIssues extends View {
  init(_props, cx) {
    this.mode = localStorage.getItem(MODE) === "project" ? "project" : "all";
    this.rows = null; // null: nothing has answered yet, so the first frame says so
    this.error = "";
    this.loading = false;
    // What this folder's remote is, as the last load found it (see repoOf).
    this.repo = { state: "unknown", remote: "", url: "", host: "", project: "", why: "" };
    this.project = ""; // its GitLab path, "" unless the remote is one
    this.at = ""; // the folder `repo` was read from, for when it says nothing
    this.next = 0; // when the next round trip to glab is due
    this.wasShown = true; // whether the layout had this panel up at the last look
    this.again = false; // a request that arrived while one was already out
    this.slow = false; // the spinner has been on screen, so it has to be taken off
    this.sig = ""; // what the list looks like, in one string
    this.loadedFor = ""; // what the rows on screen belong to: this project, or every one
    this.seen = ""; // what the screen last showed
    this.told = ""; // the badge last published, so a steady list stays quiet
    cx.timer.every(TICK, (cx) => this.tick(cx));
    this.load(cx);
  }

  // Whether this copy is the panel the layout is showing. Without the ids the layout hands it
  // — read on its own, or under `herdr-app check` — there is nothing to ask, so it counts as
  // shown and the list is the point.
  onScreen() {
    const { stack, node } = props() ?? {};
    if (!stack || !node) return true;
    const s = find(layout(), stack);
    return Boolean(s) && !s.hidden && s.active === node;
  }

  tick(cx) {
    const open = this.onScreen();
    // A list from another project is worth asking about at once, not at the next poll.
    if (open && (Date.now() >= this.next || !this.wasShown || this.stale())) this.load(cx);
    this.wasShown = open;
    this.tell();
  }

  // What a list belongs to. The account's list is every project's, but not every machine's:
  // glab is installed, logged in and versioned per machine, so the answer only holds for the
  // machine it was asked on.
  key(folder, on) {
    return this.mode === "project"
      ? `project|${on ?? ""}|${folder ?? ""}`
      : `all|${on ?? ""}`;
  }

  // The rows on screen are this project's only if they were asked for it: the window can move
  // to another space at any moment, and until an answer for that one lands the old list is
  // yesterday's news under today's name.
  stale() {
    if (this.rows === null) return false;
    const { folder, on } = this.target();
    return this.loadedFor !== this.key(folder, on);
  }

  // The rows on screen: what glab said, minus what an issue tab has already closed. Writing
  // shared state re-renders every mod, so the row goes as the tab's own frame lands — waiting for
  // the poll would leave a closed issue on a list of open ones for another 45 s.
  shown() {
    const rows = this.rows ?? [];
    const done = shared(DONE);
    if (!done || typeof done !== "object") return rows;
    const now = Date.now();
    const gone = Object.entries(done)
      .filter(([, at]) => now - Number(at) < DONE_KEEP)
      .map(([k]) => k);
    if (!gone.length) return rows;
    const drop = new Set(gone);
    return rows.filter((m) => !drop.has(`${m.path}#${m.iid}`));
  }

  // Only what the dock needs, and only when it changed: writing shared state re-renders every
  // mod, so a fresh object on every poll would be a drumbeat nobody asked for.
  tell() {
    const rows = this.rows === null ? null : this.shown();
    const badge = { n: rows?.length ?? 0, err: Boolean(this.error), ready: rows !== null };
    const said = JSON.stringify(badge);
    if (said === this.told) return;
    this.told = said;
    setShared(BADGE, badge);
  }

  // The space the window is on decides what "current project" means.
  space() {
    return spaces().find((s) => s.active) ?? spaces()[0] ?? null;
  }

  // Where the repo actually is. `space().folder` is only where new terminals start, so it is
  // the last choice: a space whose shells have cd'd elsewhere reads the wrong repo.
  target() {
    const space = this.space();
    if (!space) return { folder: null, on: null };
    const tabs = new Set((space.tabs ?? []).map((c) => c.id));
    const ps = panes().filter((p) => tabs.has(p.tab));
    const folder = ps.find((p) => p.focused && p.cwd)?.cwd ?? ps.find((p) => p.cwd)?.cwd ?? space.folder;
    return { folder: folder || null, on: space.machine ?? null };
  }

  // What this folder is for GitLab's purposes: its remote, and the project path if that remote
  // is a GitLab. `origin` wins when it is there — issues are the project's, so every branch of
  // the checkout belongs to the same list. Without an origin, the branch's upstream remote is
  // the next best answer, and the first remote the last one. Re-read on every load, so a
  // checkout that gains or loses a remote answers for what it has now.
  async repoOf(folder, on) {
    const info = { state: "unknown", remote: "", url: "", host: "", project: "", why: "" };
    if (!folder) {
      info.state = "no-repo";
      info.why = "this space has no folder";
    } else {
      try {
        const listed = await exec("git", ["remote"], { cwd: folder, on, timeout: TIMEOUT });
        const remotes = String(listed.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
        if (listed.code !== 0) {
          const said = `${listed.stderr ?? ""}${listed.stdout ?? ""}`;
          info.state = /not a git repository|not a repository|not a work tree/i.test(said) ? "no-repo" : "unknown";
          info.why = info.state === "no-repo" ? `no git repository at ${folder}` : "cannot read this folder's remotes";
        } else if (!remotes.length) {
          info.state = "no-remote";
          info.why = `no git remote in ${folder}`;
        } else {
          // An origin is the project; a branch's upstream only when there is none.
          let remote = remotes.includes("origin") ? "origin" : "";
          if (!remote) {
            const up = await exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: folder, on, timeout: TIMEOUT });
            const named = String(up.stdout ?? "").trim().split("/")[0];
            remote = remotes.includes(named) ? named : remotes[0];
          }
          info.remote = remote;
          const url = await exec("git", ["remote", "get-url", remote], { cwd: folder, on, timeout: TIMEOUT });
          if (url.code !== 0 || !String(url.stdout ?? "").trim()) {
            info.state = "no-remote";
            info.why = `${remote} has no address`;
          } else {
            info.url = String(url.stdout).trim();
            info.host = hostOf(info.url);
            info.project = pathOfRemote(info.url) ?? "";
            if (elsewhere(info.host)) {
              info.state = "elsewhere";
              info.why = info.host ? `${info.host} is not GitLab` : "this remote is not on GitLab";
            } else if (!info.project) {
              info.state = "elsewhere";
              info.why = `no project path in ${info.url}`;
            } else {
              info.state = "gitlab";
            }
          }
        }
      } catch {
        info.state = "unknown";
        info.why = "cannot read this folder's remotes";
      }
    }
    this.at = folder ?? "";
    this.repo = info;
    this.project = info.state === "gitlab" ? info.project : "";
    return info;
  }

  // What the list looks like: which issues, what they are labelled, and what each one is
  // called. Enough to notice news, and cheap enough to compare every poll.
  put(rows) {
    const sig = rows.map((m) => `${m.path}#${m.iid}:${m.labels.join(",")}:${m.title}:${m.at}`).join(";");
    // Nothing on screen yet is news even when it is empty: the first frame says "looking".
    if (sig === this.sig && this.rows !== null) return false;
    this.sig = sig;
    this.rows = rows;
    return true;
  }

  // Everything the panel puts on screen. `at` is the issue's own `updated_at`, so real edits
  // reach the signature; the ages that move by the clock ride along on the redraws the rest of
  // the window asks for anyway.
  view() {
    // `loadedFor` is in here so the frame after a machine or project switch is redrawn even
    // when the new answer is the same list: the "looking" in between has to come off.
    return `${this.mode}|${this.loadedFor}|${this.error}|${this.repo.state}|${this.repo.why}|${this.project}|${this.sig}`;
  }

  load(cx) {
    if (this.loading) {
      // Asked again while glab is still thinking: remember it and go round once more when this
      // one lands, instead of dropping the request.
      this.again = true;
      return;
    }
    this.loading = true;
    this.next = Date.now() + POLL;
    const asked = this.mode; // an answer from another scope is not an answer
    cx.timer.after(SLOW, (cx) => {
      if (!this.loading) return;
      this.slow = true;
      cx.notify();
    });
    cx.spawn(async (cx) => {
      const { folder, on } = this.target();
      const project = this.mode === "project";
      const askedKey = this.key(folder, on);
      try {
        // Resolved before the list: a label that still names the last good repo while the
        // shell has cd'd out of it is worse than no label.
        const info = await this.repoOf(folder, on);
        // Only a remote on a GitLab has issues to ask about. A GitHub or Gitee one, no remote
        // at all, or a folder without git: no request, and the header says why.
        if (project && info.state !== "gitlab") {
          this.put([]);
          this.error = "";
        } else {
          const args = project
            ? ["issue", "list", "-F", "json", "-P", PER_PAGE]
            : ["api", `issues?scope=all&state=opened&per_page=${PER_PAGE}`];
          // Both scopes ask the space's own machine: one round trip here takes 13–17 s and
          // misses the budget, on WSL the same call answers in under 2 s.
          const opts = project ? { cwd: folder, on, timeout: TIMEOUT } : { on, timeout: TIMEOUT };
          const r = await exec("glab", args, opts);
          if (r.code !== 0) throw say(r.stderr || r.stdout);
          this.put(JSON.parse(r.stdout || "[]").map(rowOf));
          this.error = "";
        }
      } catch (e) {
        this.error = say(e);
        // A failed poll keeps the list it had, so a dropped connection does not blank the
        // panel — but only when that list was asked for this very project and machine.
        // Another one's rows under this error would read as this project's issues.
        if (this.loadedFor === askedKey) {
          this.rows = this.rows ?? [];
        } else {
          this.rows = [];
          this.sig = "";
        }
      }
      this.loading = false;
      const spinner = this.slow;
      this.slow = false;
      const now = this.target();
      if (asked === this.mode && askedKey === this.key(now.folder, now.on)) {
        this.loadedFor = askedKey;
        this.tell();
      } else {
        // Never one scope's or one project's list under another's name: that is a claim about
        // a screen nobody has looked at yet.
        this.rows = null;
        this.error = "";
        this.sig = "";
        this.tell();
      }
      const seen = this.view();
      if (seen !== this.seen || spinner) {
        this.seen = seen;
        cx.notify(); // the spinner was on screen and has to be taken off
      }
      if (this.again) { this.again = false; this.load(cx); }
    });
  }

  // Where a click's own cx is handed to the task it starts, never kept.
  setMode(cx, mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    localStorage.setItem(MODE, mode);
    this.rows = null;
    this.error = "";
    this.load(cx);
  }

  groups() {
    const by = new Map();
    for (const m of this.shown()) {
      const key = m.path || "?";
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(m);
    }
    const here = this.mode === "all" ? this.project : "";
    const last = (list) => list.reduce((max, m) => Math.max(max, m.at), 0);
    return [...by.entries()]
      .map(([path, list]) => [path, list.sort((a, b) => b.at - a.at), last(list)])
      .sort((a, b) => Number(b[0] === here) - Number(a[0] === here) || b[2] - a[2])
      .map(([path, list]) => [path, list]);
  }

  // What the panel is looking at, said shortly: the line under the switch.
  where() {
    if (this.stale()) return "looking…";
    if (this.mode === "project") return this.repo.why || this.project || `no GitLab repo at ${this.at || "here"}`;
    const rows = this.shown();
    return `${rows.length} open across ${new Set(rows.map((m) => m.path)).size} projects`;
  }

  pill(t, mode, label) {
    const on = this.mode === mode;
    return div().id(`mode-${mode}`).flex_1().h(21).rounded(5).items_center().text_center()
      .text_size(11.5).text_color(on ? t.solid_foreground : t.muted)
      .when(on, (el) => el.bg(t.solid))
      .on_click((_, cx) => this.setMode(cx, mode))
      .child(label);
  }

  // Where an MR row says its verdict, an issue row says what kind of issue it is: two labels
  // and a count, each cut at a width that leaves the title room in a 336 px panel.
  tags(t, m) {
    const shown = m.labels.slice(0, 2);
    const more = m.labels.length - shown.length;
    return shown.map((l) => div().flex_none().max_w(72).truncate().rounded(4).px(4).py(1)
      .bg(t.raised).text_size(10).text_color(t.muted).child(l))
      .concat(more > 0 ? [div().flex_none().text_size(10).text_color(t.dim).child(`+${more}`)] : []);
  }

  // The tab this issue already has, if the space is showing one: `#iid title · project`. The
  // project tail is not decoration — an iid is not an identity, because every project has a #2,
  // and picking another project's issue off a list of both is the mistake this panel exists to
  // avoid. (panes() knows which tab holds a mod, but not the props it was opened with, so a name
  // really is all there is to go on.) The iid sits at the head and the project at the tail, so the
  // title — which can change under the tab — is in between and may be cut short.
  tabFor(m) {
    const head = `#${m.iid} `;
    const mark = ` · ${m.path}`;
    return (this.space()?.tabs ?? []).find((t) => {
      const name = String(t.name ?? "");
      return name.startsWith(head) && name.endsWith(mark);
    }) ?? null;
  }

  // A tab of its own: the description and the discussion need the width of the main area, which
  // this panel cannot give them (it stops at 560px), and the tab stays put while the list keeps
  // refreshing. The machine travels with it: glab here is far quicker on the space's own machine.
  // Clicking the same issue twice shows the tab it already has, instead of a second copy of the
  // same thread under the same name and a third poll of glab for the same issue.
  open(m) {
    if (!m.path) return;
    const there = this.tabFor(m);
    if (there) { run("tab.select", { id: there.id }); return; }
    run("tab.new", {
      name: `#${m.iid} ${short(m.title)} · ${m.path}`,
      mod: "issue-review",
      props: { iid: String(m.iid), path: m.path, on: this.space()?.machine ?? null },
    });
  }

  // The row is two lines of one wide column, with the iid on their left and the labels on the
  // first line's right. Everything on the right rides the same edge, so the labels and the
  // times line up down the list, and only the two titles give way when the panel is narrow —
  // hence the `min_w(0)`s: without them a long title keeps its width, and the labels beside it
  // are pushed past the edge of the panel instead of the title shortening.
  item(t, m) {
    return h_flex().id(`i-${m.n}`).w_full().gap(7).items_start().px(7).py(5).rounded(6)
      .hover((s) => s.bg(t.hover))
      .tooltip(`${m.path ? m.path + " " : ""}#${m.iid} · open the issue`)
      .on_click(() => this.open(m))
      .children([
        div().flex_none().text_size(10.5).text_color(t.dim).child(`#${m.iid}`),
        v_flex().flex_1().min_w(0).min_h(0).gap(2).children([
          h_flex().w_full().min_w(0).gap(6).items_center().children([
            div().flex_1().min_w(0).truncate().child(m.title || "(no title)"),
            ...this.tags(t, m),
          ]),
          h_flex().w_full().min_w(0).gap(6).text_size(10.5).text_color(t.dim).items_center().children([
            div().flex_1().min_w(0).truncate().child(m.who ? `${m.author} → ${m.who}` : m.author),
            // "10h" and "2026-10-16" end on this line's right edge either way, so the ages read
            // as a column instead of stepping in and out with the author's name.
            div().flex_none().text_right().child(ago(m.at)),
          ]),
        ]),
      ]);
  }

  // A fixed box, not one sized by its glyph: the ↻ and a 12px arrow would otherwise sit at
  // different heights and get different hover backgrounds.
  iconBtn(t, id, tip, inner, press) {
    return h_flex().id(id).flex_none().w(24).h(22).rounded(5).items_center().justify_center()
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip(tip).on_click(press).child(inner);
  }

  head(t) {
    return v_flex().flex_none().p(8).gap(7).children([
      h_flex().gap(2).items_center().children([
        div().flex_1().font_semibold().child("Issues"),
        // Its own slot, filled or not: the button must not slide when a slow request shows up
        // beside it.
        this.slow
          ? h_flex().flex_none().w(18).h(22).items_center().justify_center()
            .child(div().text_size(11).text_color(t.dim).frames(SPINNER, 90))
          : div().flex_none().w(18),
        this.iconBtn(t, "refresh", "Ask glab again", div().text_size(13).child("↻"), (_, cx) => this.load(cx)),
      ]),
      h_flex().p(2).gap(2).rounded(7).bg(t.raised).children([
        this.pill(t, "project", "Current project"),
        this.pill(t, "all", "All projects"),
      ]),
      div().text_size(10.5).text_color(t.dim).truncate().child(this.where()),
    ]);
  }

  body(t) {
    // Another project's rows are not shown while this one's answer is on its way.
    if (this.rows === null || this.stale()) {
      return v_flex().flex_1().items_center().justify_center()
        .child(div().text_size(11.5).text_color(t.dim).child(this.loading ? "asking glab…" : "…"));
    }
    const groups = this.groups();
    const heads = this.mode === "all";
    return v_flex().flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(8).gap(2)
      .when(Boolean(this.error), (el) => el.child(
        div().px(7).py(5).text_size(11).text_color(t.blocked).child(this.error)))
      .when(groups.length === 0 && !this.error, (el) => el.child(
        div().px(7).py(5).text_size(11).text_color(t.dim)
          .child(this.mode === "project" && this.repo.state !== "gitlab"
            ? this.repo.why || "This folder is not a GitLab repo."
            : "No open issues.")))
      .children(groups.flatMap(([path, list]) =>
        (heads ? [div().px(7).pt(7).pb(2).text_size(10.5).text_color(t.muted).truncate().child(path)] : [])
          .concat(list.map((m) => this.item(t, m)))));
  }

  render() {
    const t = theme();
    return v_flex().size_full().bg(t.chrome).text_size(12.5).children([
      this.head(t),
      div().flex_none().h(1).bg(t.border),
      this.body(t),
    ]);
  }
}

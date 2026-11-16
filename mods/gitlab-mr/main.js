// A panel for the dock: GitLab merge requests, switched between the current space's
// project and every open MR the token can see, grouped by project, the space's own one
// first. A row opens that MR in a review tab. CI status is not shown: this GitLab leaves
// `pipeline` out of both list endpoints, so the verdict is `detailed_merge_status`.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, layout, panes, props, run, setShared, shared, spaces, theme } from "herdr";

const PER_PAGE = "100";
const TIMEOUT = 45000;
// The round trip to glab, and how often the cheap look happens instead: a hidden copy's
// timers keep running, and that look is the only way to find out the dock brought us
// back. Reading `shared` costs nothing; asking glab does, so it stays on POLL.
const POLL = 45000;
const TICK = 5000;
// How long a request has to take before it is worth saying "working on it" about.
// Every redraw of a mod redraws the whole window, so a poll that answers in a blink
// must not spend two of them to mention itself.
const SLOW = 350;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// What the dock keeps its icon told with.
const BADGE = "gitlab-mr.badge";
// What a review tab has just merged or closed, written by mr-review: a row it names leaves
// the list at once. The same age limit as on the writing side, so an entry a review tab
// never got to prune cannot hide a row for good.
const DONE = "mr-review.done";
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

// GitLab's own verdict on whether the MR can go in, said shortly.
const STATUS = {
  mergeable: ["mergeable", "done"],
  approvals_satisfied: ["approved", "done"],
  conflict: ["conflict", "blocked"],
  detached: ["behind", "blocked"],
  ci_must_pass: ["ci running", "working"],
  ci_stopped: ["ci stopped", "blocked"],
  approvals_blocked: ["needs approval", "working"],
  draft_status: ["draft", "dim"],
  unchecked: ["checking", "dim"],
  checking: ["checking", "dim"],
  not_open: ["not open", "dim"],
};

// `group/sub/repo!3` -> `group/sub/repo`, what glab wants after -R.
export function projectOf(m) {
  const full = m.references?.full ?? "";
  const at = full.lastIndexOf("!");
  return at > 0 ? full.slice(0, at) : "";
}

// `git@host:group/repo.git`, `https://host/group/repo.git`, `ssh://git@host:22/group/repo`.
export function pathOfRemote(url) {
  const t = String(url ?? "").trim().replace(/\.git\/?$/, "");
  const scp = t.match(/^[^@/\s]+@[^:\s]+:(.+)$/);
  if (scp) return scp[1];
  const uri = t.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/(.+)$/i);
  return uri ? uri[1] : null;
}

// The host an upstream URL names, lower case: "" for a path on this machine.
function hostOf(url) {
  const t = String(url ?? "").trim();
  const scp = t.match(/^[^@/\s]+@([^:\s/]+):/);
  if (scp) return scp[1].toLowerCase();
  const uri = t.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i);
  return uri ? uri[1].toLowerCase() : "";
}

// Hosts that run no GitLab: an upstream there has no merge requests to ask about. Anything
// else is taken to be one, because a company's own instance has no name to list here.
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

// glab wraps failures in a padded box and prefixes `glab: `, and an API error arrives
// as a bare `{"message":"404 Project Not Found"}glab: HTTP 404 (HTTP 404)`. What is
// left after dropping the frame, the prefix and the repeated code is the reason.
export function say(e) {
  const text = String(typeof e === "string" ? e : e?.message ?? e);
  const api = text.match(/^\s*\{"message":"(.+?)"\}/);
  if (api) return api[1];
  const noise = /^(ERROR|Try .* for usage\.?)$/i;
  const clean = (l) => l.trim().replace(/^glab:\s*/, "").replace(/\s*\(HTTP \d+\)$/, "");
  return text.split("\n").map(clean).find((l) => l && !noise.test(l)) ?? "glab did not answer";
}

function row(m, i) {
  const [status, tone] = STATUS[m.detailed_merge_status] ?? ["", "dim"];
  return {
    n: i,
    iid: m.iid,
    path: projectOf(m),
    title: String(m.title ?? ""),
    author: m.author?.name || m.author?.username || "?",
    target: String(m.target_branch ?? ""),
    draft: Boolean(m.draft || m.work_in_progress),
    status,
    tone,
    at: Date.parse(m.updated_at) || 0,
  };
}

export default class GitlabMr extends View {
  init(_props, cx) {
    this.mode = localStorage.getItem("mode") === "project" ? "project" : "all";
    this.rows = null; // null: nothing has answered yet, so the first frame says so
    this.error = "";
    this.loading = false;
    // What this folder's upstream is, as the last load found it (see repoOf).
    this.repo = { state: "unknown", remote: "", url: "", host: "", project: "", why: "" };
    this.project = ""; // its GitLab path, "" unless the upstream is one
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
    this.load(cx, true);
  }

  // Whether this copy is the panel the layout is showing. Without the ids the layout
  // hands it — read on its own, or under `herdr-app check` — there is nothing to ask,
  // so it counts as shown and the list is the point.
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
    // The row a review tab merged or closed is off the list on its own re-render; the dock's
    // count follows it on this tick rather than waiting out the poll.
    this.tell();
  }

  // What a list belongs to. The account's list is every project's, but not every machine's:
  // glab is installed, logged in and versioned per machine, so the answer only holds for
  // the machine it was asked on.
  key(folder, on) {
    return this.mode === "project" ? `project|${on ?? ""}|${folder ?? ""}` : `all|${on ?? ""}`;
  }

  // The rows on screen are this project's only if they were asked for it: the window can
  // move to another space at any moment, and until an answer for that one lands the old
  // list is yesterday's news under today's name.
  stale() {
    if (this.rows === null) return false;
    const { folder, on } = this.target();
    return this.loadedFor !== this.key(folder, on);
  }

  // The rows on screen: what glab said, minus what a review tab has already merged or
  // closed. Writing shared state re-renders every mod, so the row goes as the review tab's
  // own frame lands — waiting for the poll would leave a decided MR on the list for 45 s.
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
    return rows.filter((m) => !drop.has(`${m.path}!${m.iid}`));
  }

  // Only what the dock needs, and only when it changed: writing shared state re-renders
  // every mod, so a fresh object on every poll would be a drumbeat nobody asked for.
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

  // Where the repo actually is. `space().folder` is only where new terminals start, so
  // it is the last choice: a space whose shells have cd'd elsewhere reads the wrong repo.
  target() {
    const space = this.space();
    if (!space) return { folder: null, on: null };
    const tabs = new Set((space.tabs ?? []).map((c) => c.id));
    const ps = panes().filter((p) => tabs.has(p.tab));
    const folder = ps.find((p) => p.focused && p.cwd)?.cwd ?? ps.find((p) => p.cwd)?.cwd ?? space.folder;
    return { folder: folder || null, on: space.machine ?? null };
  }

  // What this folder is for GitLab's purposes: the remote the current branch goes to, and
  // the project path if that remote is a GitLab. The upstream is asked by branch, not taken
  // to be `origin`: a checkout can have several remotes and the one that matters is the one
  // this branch is tracked on. No branch tracked upstream means no MRs of ours to list.
  // Re-read on every load, so a checkout onto another branch answers for that branch.
  async repoOf(folder, on) {
    const info = { state: "unknown", remote: "", url: "", host: "", project: "", why: "" };
    if (!folder) {
      info.state = "no-repo";
      info.why = "this space has no folder";
    } else {
      try {
        const up = await exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: folder, on, timeout: TIMEOUT });
        if (up.code !== 0) {
          const said = `${up.stderr ?? ""}${up.stdout ?? ""}`;
          info.state = /not a git repository|not a repository|not a work tree/i.test(said) ? "no-repo" : "no-upstream";
          info.why = info.state === "no-repo" ? `no git repository at ${folder}` : `no upstream branch in ${folder}`;
        } else {
          info.remote = String(up.stdout ?? "").trim().split("/")[0] || "origin";
          const url = await exec("git", ["remote", "get-url", info.remote], { cwd: folder, on, timeout: TIMEOUT });
          if (url.code !== 0 || !String(url.stdout ?? "").trim()) {
            info.state = "no-upstream";
            info.why = `${info.remote} has no address`;
          } else {
            info.url = String(url.stdout).trim();
            info.host = hostOf(info.url);
            info.project = pathOfRemote(info.url) ?? "";
            if (elsewhere(info.host)) {
              info.state = "elsewhere";
              info.why = info.host ? `${info.host} is not GitLab` : "this upstream is not on GitLab";
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
        info.why = "cannot read this folder's upstream";
      }
    }
    this.at = folder ?? "";
    this.repo = info;
    this.project = info.state === "gitlab" ? info.project : "";
    return info;
  }

  // What the list looks like: which MRs, what GitLab makes of each, and when it last
  // moved. Enough to notice news, and cheap enough to compare every poll.
  put(rows) {
    const sig = rows.map((m) => `${m.path}!${m.iid}:${m.status}${m.draft ? " draft" : ""}:${m.at}`).join(";");
    // Nothing on screen yet is news even when it is empty: the first frame says "looking".
    if (sig === this.sig && this.rows !== null) return false;
    this.sig = sig;
    this.rows = rows;
    return true;
  }

  // Everything the panel puts on screen. `at` is the MR's own `updated_at`, so real
  // edits reach the signature; the labels that age by the clock ride along on the
  // redraws the rest of the window asks for anyway.
  view() {
    // `loadedFor` is in here so the frame after a machine or project switch is redrawn even
    // when the new answer is the same list: the "looking" in between has to come off.
    return `${this.mode}|${this.loadedFor}|${this.error}|${this.repo.state}|${this.repo.why}|${this.project}|${this.sig}`;
  }

  load(cx) {
    if (this.loading) {
      // Asked again while glab is still thinking: remember it and go round once more
      // when this one lands, instead of dropping the request.
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
        // Resolved before the list: a label that still names the last good repo while
        // the shell has cd'd out of it is worse than no label.
        const info = await this.repoOf(folder, on);
        // Only a branch tracked on a GitLab upstream has merge requests to ask about. A
        // GitHub or Gitee remote, no upstream at all, or a folder without git: no request.
        if (project && info.state !== "gitlab") {
          this.put([]); // nothing to ask glab about; the header says why
          this.error = "";
        } else {
          const args = project
            ? ["mr", "list", "-F", "json", "-P", PER_PAGE]
            : ["api", `merge_requests?scope=all&state=opened&per_page=${PER_PAGE}`];
          // Both scopes ask the space's own machine: one round trip here takes 13–17 s
          // and misses the budget, on WSL the same call answers in under 2 s.
          const opts = project ? { cwd: folder, on, timeout: TIMEOUT } : { on, timeout: TIMEOUT };
          const r = await exec("glab", args, opts);
          if (r.code !== 0) throw say(r.stderr || r.stdout);
          this.put(JSON.parse(r.stdout || "[]").map(row));
          this.error = "";
        }
      } catch (e) {
        this.error = say(e);
        // A failed poll keeps the list it had, so a dropped connection does not blank the
        // panel — but only when that list was asked for this very project and machine.
        // Another one's rows under this error would read as this project's merge requests.
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
        // Never one scope's or one project's list under another's name: that is a claim
        // about a screen nobody has looked at yet.
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
    localStorage.setItem("mode", mode);
    this.rows = null;
    this.error = "";
    this.repoKey = "";
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

  chip(t, m) {
    const label = m.draft ? "draft" : m.status;
    if (!label) return div().flex_none();
    return div().flex_none().text_size(10.5).text_color(t[m.tone] ?? t.dim).child(label);
  }

  // A review tab of its own: a diff needs the width of the main area, which this panel
  // cannot give it (it stops at 560px), and it stays put while the list keeps refreshing.
  // The machine travels with it: glab here is far quicker on the space's own machine.
  open(m) {
    if (!m.path) return;
    run("tab.new", {
      name: `!${m.iid} ${m.title}`.slice(0, 60),
      mod: "mr-review",
      props: { iid: String(m.iid), path: m.path, on: this.space()?.machine ?? null },
    });
  }

  // The row is two lines of one wide column, with the iid on their left and the status on
  // the first line's right. Everything on the right rides the same edge, so the verdicts
  // and the times line up down the list, and only the two titles give way when the panel
  // is narrow — hence the `min_w(0)`s: without them a long title keeps its width, and the
  // status beside it is pushed past the edge of the panel instead of the title shortening.
  item(t, m) {
    return h_flex().id(`m-${m.n}`).w_full().gap(7).items_start().px(7).py(5).rounded(6)
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.open(m))
      .children([
        div().flex_none().text_size(10.5).text_color(t.dim).child(`!${m.iid}`),
        v_flex().flex_1().min_w(0).min_h(0).gap(2).children([
          h_flex().w_full().min_w(0).gap(6).items_center().children([
            div().flex_1().min_w(0).truncate().text_color(m.draft ? t.dim : t.foreground)
              .child(m.title || "(no title)"),
            this.chip(t, m),
          ]),
          h_flex().w_full().min_w(0).gap(6).text_size(10.5).text_color(t.dim).items_center().children([
            div().flex_1().min_w(0).truncate().child(`${m.author} → ${m.target}`),
            // "10h" and "2026-10-16" end on this line's right edge either way, so the ages
            // read as a column instead of stepping in and out with the author's name.
            div().flex_none().text_right().child(ago(m.at)),
          ]),
        ]),
      ]);
  }

  // A fixed box, not one sized by its glyph: the ↻ and a 12px arrow would otherwise sit
  // at different heights and get different hover backgrounds.
  iconBtn(t, id, tip, inner, press) {
    return h_flex().id(id).flex_none().w(24).h(22).rounded(5).items_center().justify_center()
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip(tip).on_click(press).child(inner);
  }

  head(t) {
    return v_flex().flex_none().p(8).gap(7).children([
      h_flex().gap(2).items_center().children([
        div().flex_1().font_semibold().child("Merge requests"),
        // Its own slot, filled or not: the button must not slide when a slow request
        // shows up beside it.
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
            : "No open merge requests.")))
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

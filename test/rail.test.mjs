// Drives the MR panel and the rail together outside Herdr. The fake layout document is
// mutated by the same commands the rail issues, so what is checked is the protocol
// between the two mods, not just each one alone.
//
// The modules the mods import come from test/stub/ (see stub/register.mjs): the real source
// is imported as it is, nothing is copied, stripped or re-evaluated.
import { fake, log } from "./stub/herdr.mjs";
import GitlabMr, { pathOfRemote, projectOf, say, ago } from "../mods/gitlab-mr/main.js";
import Rail from "../mods/rail/main.js";

// --- the fake host ---
const tree = {
  id: "work-body",
  children: [
    { id: "main", type: "block" },
    { id: "sidepanel", type: "stack", hidden: true, active: "gitlab-mr", children: [{ id: "gitlab-mr", type: "block" }] },
    { id: "rail", type: "block" },
  ],
};
const node = (id, n = tree) => (n.id === id ? n : (n.children ?? []).map((c) => node(id, c)).find(Boolean));
const stack = () => node("sidepanel");

// What the mods ask for and what they are told, from the shared fake.
const calls = log.exec;
const runs = log.run;
const sharedStore = fake.shared;
fake.layout = tree;
fake.panes = [{ tab: "tb1", pane: "p1", cwd: "/home/dev/projects/company/platform/api", focused: true }];

// The rail's commands land on the layout document, as the app's would.
fake.onRun = (name, args) => {
  const s = stack();
  if (!s) return;
  if (name === "layout.hide") s.hidden = true;
  if (name === "layout.show") s.hidden = false;
  if (name === "layout.select") s.active = args.child;
};

// --- the data the fake glab answers with ---
const REPO = "/home/dev/projects/company/platform/api";
const REMOTE = "https://gitlab.example.com/acme/platform/trunk/source/code/api.git\n";
const NOREPO = "/home/dev/projects/company/platform";

const mr = (iid, path, status, days, draft = false) => ({
  iid, references: { full: `${path}!${iid}` }, title: `MR ${iid}`, target_branch: "main",
  author: { name: "Dev User" }, updated_at: new Date(Date.now() - days * 864e5).toISOString(),
  detailed_merge_status: status, draft, work_in_progress: draft,
});
const ALLMRS = [mr(57, "acme/platform/trunk/source/code/deploy", "mergeable", 0.2), mr(3, "acme/team/trunk/db", "conflict", 1),
  mr(21, "acme/edge/gateway/service", "draft_status", 0.5, true), mr(9, "acme/platform/trunk/source/code/api", "unchecked", 3)];
const PRJMRS = [mr(12, "acme/platform/trunk/source/code/api", "mergeable", 0.1)];

fake.panes = [{ tab: "tb1", pane: "p1", cwd: REPO, focused: true }];

// What git says in that repo: the branch is tracked on origin, and origin is that GitLab.
const gitAnswer = (args = []) =>
  args[0] === "rev-parse"
    ? { code: 0, stdout: "origin/main\n", stderr: "" }
    : { code: 0, stdout: REMOTE, stderr: "" };

// glab answers per scope
fake.exec = async (cmd, args) => {
  if (cmd === "git") return gitAnswer(args);
  return { code: 0, stdout: JSON.stringify(args[0] === "api" ? ALLMRS : PRJMRS), stderr: "" };
};
const broken = async (cmd, args) => {
  if (cmd === "git") return gitAnswer(args); // the repo is fine; glab is what hurts
  throw new Error("glab: command not found");
};
const reset = () => { log.exec.length = 0; };


let fails = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`ok   ${label}`);
  else { fails++; console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));
let notifies = 0;
const cx = {
  notify: () => { notifies++; },
  focus_handle: () => ({}),
  spawn: (fn) => fn(cx),
  // `after` waits like the real one: a request that lands before SLOW never gets to
  // raise a spinner, which is the whole point of the delay.
  timer: { every: () => ({}), after: (ms, fn) => { setTimeout(() => fn(cx), ms); return {}; } },
};

// --- the pure helpers, against what this machine really says ---
eq("pathOfRemote https", pathOfRemote(REMOTE.trim()), "acme/platform/trunk/source/code/api");
eq("pathOfRemote scp", pathOfRemote("git@git.example.com:acme/platform.git"), "acme/platform");
eq("pathOfRemote ssh+port", pathOfRemote("ssh://git@git.example.com:22/acme/edge/service.git"), "acme/edge/service");
eq("pathOfRemote junk", pathOfRemote("/not/a/url"), null);
eq("projectOf", projectOf({ references: { full: "acme/team/trunk/db!3" } }), "acme/team/trunk/db");
eq("projectOf missing", projectOf({}), "");
eq("say box", say("   ERROR  \n  Fatal: not a git repository (or any of the parent directories): .git\n  Try --help for usage."), "Fatal: not a git repository (or any of the parent directories): .git");
eq("say api", say('{"message":"404 Project Not Found"}glab: HTTP 404 (HTTP 404)'), "404 Project Not Found");
eq("say prefix", say("glab: command not found"), "command not found");
eq("say string", say("This space has no folder to read a repo from."), "This space has no folder to read a repo from.");
eq("ago", [Date.now() - 40 * 60e3, Date.now() - 9 * 864e5, 0].map(ago), ["40m", "9d", ""]);

// --- the panel, hidden by the layout ---
fake.props = { stack: "sidepanel", node: "gitlab-mr" };
const p = new GitlabMr();
p.init({}, cx);
await settle();
eq("hidden: the first load still happens", p.rows.length, 4);
eq("all: 也问 space 那台机器上的 glab", calls.filter((c) => c.cmd === "glab").at(0).opts, { on: "wsl", timeout: 45000 });
eq("hidden: onScreen is false", p.onScreen(), false);
reset();
p.next = 0; p.wasShown = true;
p.tick(cx);
await settle();
eq("hidden: a later tick does not ask glab", calls.filter((c) => c.cmd === "glab").length, 0);
eq("badge left for the rail", sharedStore["gitlab-mr.badge"], { n: 4, err: false, ready: true });

// --- the rail ---
const d = new Rail();
d.init({}, cx);
log.run.length = 0;
eq("rail: not showing while hidden", d.showing("gitlab-mr"), false);
d.click(cx, { child: "gitlab-mr" });
eq("rail: select then show, in that order", runs.map((r) => r[0]), ["layout.select", "layout.show"]);
eq("rail: the layout now says shown", d.showing("gitlab-mr"), true);

// the panel notices it came back and asks again at once, clock be damned
reset();
p.next = Date.now() + 999999;
p.tick(cx);
await settle();
eq("shown again: asks even when not due", calls.filter((c) => c.cmd === "glab").length, 1);

// --- closing, by the rail or by anything else ---
log.run.length = 0;
d.click(cx, { child: "gitlab-mr" });
eq("rail: clicking the showing icon hides the column", runs, [["layout.hide", { id: "sidepanel" }]]);
eq("rail: no longer showing", d.showing("gitlab-mr"), false);
stack().hidden = false; stack().active = "gitlab-mr";
eq("rail: follows a change it did not make", d.showing("gitlab-mr"), true);
stack().active = "history";
eq("rail: another child showing is not this one", d.showing("gitlab-mr"), false);
stack().hidden = true; stack().active = "gitlab-mr";

// --- a panel with no layout to ask about (check, or a block on its own) ---
fake.props = {};
const q = new GitlabMr();
q.init({}, cx);
await settle();
eq("no props: counts as shown", q.onScreen(), true);
eq("no props: still reads", q.rows.length, 4);

// --- the list itself: scope, order, and what a failure leaves on screen ---
fake.props = { stack: "sidepanel", node: "gitlab-mr" };
const w = new GitlabMr();
w.init({}, cx);
await settle();
eq("all: current project sorted first", w.groups().map(([x]) => x.split("/").pop()), ["api", "deploy", "service", "db"]);
eq("all: header line", w.where(), "4 open across 4 projects");

w.setMode(cx, "project");
await settle();
const asked = calls.filter((c) => c.cmd === "glab").at(-1);
eq("project: glab argv", asked.args, ["mr", "list", "-F", "json", "-P", "100"]);
eq("project: read where the shell is", asked.opts, { cwd: REPO, on: "wsl", timeout: 45000 });
eq("project: its own rows", w.rows.length, 1);
eq("project: names the repo", w.where(), "acme/platform/trunk/source/code/api");
eq("project: remembered", localStorage.getItem("mode"), "project");

// --- the window moves to another project: the list goes with it, at once ---
const said = fake.exec;
fake.exec = async (cmd, args, opts) =>
  cmd === "git" && opts && opts.cwd === "/tmp/elsewhere"
    ? (args[0] === "rev-parse"
        ? { code: 0, stdout: "origin/main\n", stderr: "" }
        : { code: 0, stdout: "https://gitlab.example.com/acme/other/thing.git\n", stderr: "" })
    : said(cmd, args, opts);
fake.panes = [{ tab: "tb1", pane: "p1", cwd: "/tmp/elsewhere", focused: true }];
stack().hidden = false;
eq("switched project: the old rows are stale at once", [w.stale(), w.where()], [true, "looking…"]);
reset();
w.next = Date.now() + 999999; // nowhere near a poll
w.wasShown = true;
w.tick(cx);
await settle();
eq("switched project: asked about at once, not at the next poll", calls.filter((c) => c.cmd === "glab").length, 1);
eq("switched project: asked about the folder the window is on", calls.filter((c) => c.cmd === "git").at(-1).opts.cwd, "/tmp/elsewhere");
eq("switched project: the new answer is what is up", [w.stale(), w.where()], [false, "acme/other/thing"]);

// a poll that fails keeps the list and says what went wrong
stack().hidden = false;
fake.exec = broken;
w.next = 0; w.wasShown = true;
w.tick(cx);
await settle();
eq("failed poll: keeps the rows", w.rows.length, 1);
eq("failed poll: says why", w.error, "command not found");
eq("failed poll: not stuck loading", w.loading, false);
eq("failed poll: badge says it hurt", sharedStore["gitlab-mr.badge"], { n: 1, err: true, ready: true });

// a failure while asking about another project must not bring the last one's rows along
fake.panes = [{ tab: "tb1", pane: "p1", cwd: "/tmp/broken-elsewhere", focused: true }];
eq("another project: its list is stale at once", w.stale(), true);
reset();
w.next = 0;
w.wasShown = true;
w.tick(cx);
await settle();
eq("another project: the failure is what is up", w.error, "command not found");
eq("another project: no rows from the one before it", w.rows.length, 0);
eq("another project: not stale any more", w.stale(), false);
eq("another project: badge says it hurt", sharedStore["gitlab-mr.badge"], { n: 0, err: true, ready: true });

// a switch that fails must not leave the other scope's rows on screen
w.setMode(cx, "all");
await settle();
eq("failed switch: drops the other scope's rows", w.rows.length, 0);
eq("failed switch: says why", w.error, "command not found");

// --- a folder that is not a repo must not keep naming the last good one ---
fake.exec = async (cmd) => (cmd === "git"
  ? { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" }
  : { code: 0, stdout: JSON.stringify(ALLMRS), stderr: "" });
fake.panes = [{ tab: "tb1", pane: "p1", cwd: NOREPO, focused: true }];
const u = new GitlabMr();
u.init({}, cx);
await settle();
reset(); // the all-mode read that just happened is not what this case is about
u.setMode(cx, "project");
await settle();
eq("no repo: glab is not asked", calls.filter((c) => c.cmd === "glab").length, 0);
eq("no repo: no raw git error on screen", u.error, "");
eq("no repo: rows cleared", u.rows.length, 0);
eq("no repo: label says so", u.where(), `no git repository at ${NOREPO}`);

fake.panes = [{ tab: "tb1", pane: "p1", cwd: REPO, focused: true }];
fake.exec = async (cmd, args) => (cmd === "git" ? gitAnswer(args) : { code: 0, stdout: "[]", stderr: "" });
u.load(cx);
await settle();
eq("back in a repo: the label follows", u.where(), "acme/platform/trunk/source/code/api");
eq("empty repo: nothing listed", u.groups().length, 0);
eq("empty repo: no error", u.error, "");
eq("empty repo: badge says zero", sharedStore["gitlab-mr.badge"], { n: 0, err: false, ready: true });

// --- only a GitLab upstream is worth a round trip ---
// an upstream on a host that runs no GitLab: no glab call, and the header says which host
reset();
fake.exec = async (cmd, args) =>
  cmd === "git" && args[1] === "get-url"
    ? { code: 0, stdout: "git@github.com:someone/app.git\n", stderr: "" }
    : cmd === "git"
      ? gitAnswer(args)
      : { code: 0, stdout: "[]", stderr: "" };
fake.panes = [{ tab: "tb1", pane: "p1", cwd: REPO, focused: true }];
const gh = new GitlabMr();
gh.init({}, cx);
await settle();
eq("github upstream: glab is not asked", calls.filter((c) => c.cmd === "glab").length, 0);
eq("github upstream: says which host", gh.where(), "github.com is not GitLab");
eq("github upstream: nothing listed", gh.rows.length, 0);
eq("github upstream: badge has nothing to report", sharedStore["gitlab-mr.badge"], { n: 0, err: false, ready: true });

// a branch nobody pushed: no upstream, so nothing of ours to list there
reset();
fake.exec = async (cmd) =>
  cmd === "git"
    ? { code: 128, stdout: "", stderr: "fatal: no upstream configured for branch 'work'" }
    : { code: 0, stdout: "[]", stderr: "" };
const nu = new GitlabMr();
nu.init({}, cx);
await settle();
eq("no upstream: glab is not asked", calls.filter((c) => c.cmd === "glab").length, 0);
eq("no upstream: says so", nu.where(), `no upstream branch in ${REPO}`);

// a self-hosted GitLab is a GitLab: it is asked
reset();
fake.exec = async (cmd, args) => (cmd === "git" ? gitAnswer(args) : { code: 0, stdout: JSON.stringify(PRJMRS), stderr: "" });
const gl = new GitlabMr();
gl.init({}, cx);
await settle();
eq("gitlab upstream: asked", calls.filter((c) => c.cmd === "glab").length, 1);
eq("gitlab upstream: its rows", gl.rows.length, 1);
eq("gitlab upstream: the label is the project", gl.where(), "acme/platform/trunk/source/code/api");

// "All projects" is the account's list, not this folder's: the gate does not apply there
reset();
fake.exec = async (cmd, args) =>
  cmd === "git" && args[1] === "get-url"
    ? { code: 0, stdout: "https://gitee.com/someone/app.git\n", stderr: "" }
    : cmd === "git"
      ? gitAnswer(args)
      : { code: 0, stdout: JSON.stringify(ALLMRS), stderr: "" };
const ap = new GitlabMr();
ap.init({}, cx);
await settle();
ap.setMode(cx, "all");
await settle();
eq("all projects: asked anyway", calls.filter((c) => c.cmd === "glab").length, 1);
eq("all projects: every open MR", ap.rows.length, 4);
eq("all projects: no project label borrowed from another host", ap.project, "");
// --- "All projects" is the account's list, but each machine answers for its own glab ---
globalThis.__ls.mode = "all";
fake.spaces = [{ id: "s1", name: "prs", folder: REPO, machine: "wsl", active: true, tabs: [{ id: "tb1" }] }];
fake.panes = [{ tab: "tb1", pane: "p1", cwd: REPO, focused: true }];
fake.exec = async (cmd, args) => (cmd === "git" ? gitAnswer(args) : { code: 0, stdout: JSON.stringify(ALLMRS), stderr: "" });
reset();
const am = new GitlabMr();
am.init({}, cx);
await settle();
eq("all: asked on the space's machine", calls.filter((c) => c.cmd === "glab").at(-1).opts, { on: "wsl", timeout: 45000 });

fake.spaces = [{ id: "s1", name: "prs", folder: REPO, machine: "desktop", active: true, tabs: [{ id: "tb1" }] }];
eq("another machine: the account list is stale at once", [am.stale(), am.where()], [true, "looking…"]);
reset();
am.next = Date.now() + 999999; // nowhere near a poll
am.wasShown = true;
notifies = 0;
am.tick(cx);
await settle();
eq("another machine: asked again, there", calls.filter((c) => c.cmd === "glab").at(-1).opts, { on: "desktop", timeout: 45000 });
eq("another machine: not stale once answered", am.stale(), false);
eq("another machine: the frame came off looking", notifies > 0, true);
fake.spaces = undefined;
globalThis.__ls.mode = "project";

// --- switching while glab is still answering ---
fake.panes = [{ tab: "tb1", pane: "p1", cwd: REPO, focused: true }];
let waiting = [];
fake.exec = async (cmd, args) => {
  if (cmd === "git") return gitAnswer(args);
  let done;
  const p = new Promise((r) => { done = r; });
  waiting.push(() => done({ code: 0, stdout: JSON.stringify(args[0] === "api" ? ALLMRS : PRJMRS), stderr: "" }));
  return p;
};
const z = new GitlabMr();
z.init({}, cx);
await settle();
eq("slow glab: the request is out", waiting.length, 1);
z.setMode(cx, "project");
await settle();
eq("switch mid-flight: nothing shown yet", z.rows, null);
for (let i = 0; i < 3 && waiting.length; i++) { waiting.shift()(); await settle(); }
eq("switch mid-flight: the stale answer never reaches the screen", z.rows.length, 1);
eq("switch mid-flight: the asked-for scope is what is up", z.where(), "acme/platform/trunk/source/code/api");
eq("switch mid-flight: not stuck loading", z.loading, false);

// --- a poll that brings no news must not redraw the panel at all ---
let payload = { all: ALLMRS, prj: PRJMRS };
let hold = null; // set to a delay to make glab answer slowly on purpose
fake.exec = async (cmd, args) => {
  if (cmd === "git") return gitAnswer(args);
  const body = JSON.stringify(args[0] === "api" ? payload.all : payload.prj);
  if (hold) await new Promise((r) => setTimeout(r, hold));
  return { code: 0, stdout: body, stderr: "" };
};
stack().hidden = false;
globalThis.__ls.mode = "all"; // the scope the earlier cases left behind is not this one
const g = new GitlabMr();
g.init({}, cx);
await settle();
eq("first load: the screen was drawn", g.rows.length, 4);

notifies = 0;
g.next = 0; g.wasShown = true;
g.tick(cx); // the same four MRs back again
await settle();
eq("unchanged poll: no redraw", notifies, 0);
eq("unchanged poll: no spinner", g.slow, false);
eq("unchanged poll: the list is the same objects", g.rows.length, 4);

notifies = 0;
payload = { all: [...ALLMRS, mr(88, "acme/new/repo", "mergeable", 0.01)], prj: PRJMRS };
g.next = 0; g.wasShown = true;
g.tick(cx);
await settle();
eq("news: one redraw", notifies, 1);
eq("news: the row arrived", g.rows.length, 5);
eq("news: badge followed", sharedStore["gitlab-mr.badge"], { n: 5, err: false, ready: true });

notifies = 0;
g.next = 0; g.wasShown = true;
g.tick(cx); // same news again
await settle();
eq("second look at the same news: no redraw", notifies, 0);

// a request that takes its time does say so, and takes it back afterwards
hold = 500;
g.next = 0; g.wasShown = true;
g.tick(cx);
await settle(420); // past SLOW, still waiting
eq("slow request: the spinner went up", g.slow, true);
await settle(400); // glab has answered by now
eq("slow request: the spinner came down", g.slow, false);
eq("slow request: not stuck loading", g.loading, false);
hold = 0;

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

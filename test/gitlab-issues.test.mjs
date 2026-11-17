// Drives the issues panel outside Herdr: what it asks glab for, how it reads the folder's
// remote, what a click finally opens, and the count the rail puts on the icon. Nothing here
// talks to GitLab, so no issue is created, closed or commented on by this test.
//
// The modules the mod imports come from test/stub/ (see stub/register.mjs): this is the real
// source, imported as it is, nothing copied or stripped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, log } from "./stub/herdr.mjs";
import { byId, textOf } from "./stub/element.mjs";
import GitlabIssues, { ago, pathOfRemote, projectOf, projectOfUrl, rowOf, say } from "../mods/gitlab-issues/main.js";
import Rail from "../mods/rail/main.js";

const REPO = "/home/dev/projects/acme/api";
const REMOTE = "https://gitlab.example.com/acme/platform/api.git\n";
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const calls = log.exec;
const runs = log.run;

// One layout document for the panel and the rail: the stack the rail opens, holding both
// GitLab children, so what is checked is the protocol between the two mods.
const TREE = {
  id: "work-body",
  children: [
    { id: "main", type: "block" },
    { id: "sidepanel", type: "stack", hidden: true, active: "gitlab-mr", children: [{ id: "gitlab-mr" }, { id: "gitlab-issues" }] },
    { id: "rail", type: "block" },
  ],
};
const node = (id, n = TREE) => (n.id === id ? n : (n.children ?? []).map((c) => node(id, c)).find(Boolean));
const stack = () => node("sidepanel");

// --- the data glab answers with ---
const issue = (iid, path, labels, days, over = {}) => ({
  iid, title: `Issue ${iid}`, references: { full: `${path}#${iid}` },
  web_url: `https://gitlab.example.com/${path}/-/issues/${iid}`,
  author: { name: "Dev User" }, assignees: [{ name: "Jane Doe" }],
  labels, updated_at: new Date(Date.now() - days * 864e5).toISOString(), user_notes_count: 2, ...over,
});
// This project's own issue last, so the grouping has something to sort: the space's project
// first, then the rest by when they last moved.
const ALL = [
  issue(7, "acme/team/db", ["bug"], 1),
  issue(2, "acme/edge/gateway", [], 3),
  issue(4, "acme/platform/api", ["feature", "p1", "backend"], 0.2),
];
// No `references` in this one: the project has to come out of the web_url.
const PRJ = [issue(12, "acme/platform/api", ["bug"], 0.1, { references: undefined })];

// What git says. `url` may be a function of the remote's name, for a checkout with two.
const git = (args = [], { remotes = ["origin"], upstream = "origin/main", url = REMOTE } = {}) => {
  if (args[0] === "remote" && args.length === 1) {
    return { code: 0, stdout: remotes.length ? remotes.join("\n") + "\n" : "", stderr: "" };
  }
  if (args[0] === "remote") {
    const ask = typeof url === "function" ? url(String(args[2] ?? "")) : url;
    return ask ? { code: 0, stdout: ask, stderr: "" } : { code: 128, stdout: "", stderr: "fatal: No such remote" };
  }
  if (args[0] === "rev-parse") {
    return upstream
      ? { code: 0, stdout: upstream + "\n", stderr: "" }
      : { code: 128, stdout: "", stderr: "fatal: no upstream configured for branch 'work'" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

// The world one case runs against: what git says, what glab answers per scope, and whether
// glab hurts.
let world = {};
const setup = (over = {}) => {
  world = { git: (args) => git(args), rows: (args) => (args[0] === "api" ? ALL : PRJ), fail: false, ...over };
  calls.length = 0;
  runs.length = 0;
  fake.shared = {};
  fake.onRun = null;
  delete globalThis.__shared;
  delete globalThis.__props;
  delete globalThis.__spaces;
  delete globalThis.__panes;
  globalThis.__ls = {}; // the scope this panel remembers, and gitlab-mr's key beside it
  fake.props = { stack: "sidepanel", node: "gitlab-issues" };
  fake.layout = TREE;
  fake.spaces = [{ id: "s1", name: "api", folder: REPO, machine: "wsl", active: true, tabs: [{ id: "tb1" }] }];
  fake.panes = [{ tab: "tb1", pane: "p1", cwd: REPO, focused: true }];
  fake.exec = async (cmd, args) => {
    if (cmd === "git") return world.git(args);
    if (world.fail) throw new Error("glab: command not found");
    return { code: 0, stdout: JSON.stringify(world.rows(args)), stderr: "" };
  };
  stack().hidden = true;
  stack().active = "gitlab-mr";
  return world;
};

// The app's cx, as much of it as the panel touches. \`after\` waits like the real one.
const cxFor = () => {
  const cx = {
    notified: 0,
    notify() { cx.notified++; },
    focus_handle: () => ({}),
    spawn: (fn) => fn(cx),
    timer: { every: () => 0, after: (ms, fn) => { setTimeout(() => fn(cx), ms); return 0; } },
  };
  return cx;
};

const open = async (over) => {
  const cx = cxFor();
  setup(over);
  const p = new GitlabIssues();
  p.init({}, cx);
  await settle();
  return { p, cx };
};

test("the pure helpers, against what this GitLab and this machine say", () => {
  assert.equal(projectOf({ references: { full: "acme/team/db#3" } }), "acme/team/db");
  assert.equal(projectOf({}), "");
  assert.equal(projectOfUrl("https://gitlab.example.com/acme/edge/gw/-/issues/2"), "acme/edge/gw");
  assert.equal(projectOfUrl(""), "");
  assert.equal(pathOfRemote(REMOTE.trim()), "acme/platform/api");
  assert.equal(pathOfRemote("git@git.example.com:acme/platform.git"), "acme/platform");
  assert.equal(pathOfRemote("ssh://git@git.example.com:22/acme/edge/service.git"), "acme/edge/service");
  assert.equal(pathOfRemote("/not/a/url"), null);
  assert.equal(say('{"message":"404 Project Not Found"}glab: HTTP 404 (HTTP 404)'), "404 Project Not Found");
  assert.equal(say("glab: command not found"), "command not found");
  assert.deepEqual([Date.now() - 40 * 60e3, Date.now() - 9 * 864e5, 0].map(ago), ["40m", "9d", ""]);
  // An issue with no `references` and a label payload that carries objects instead of names.
  const r = rowOf({
    iid: 4, title: " t ", labels: ["a", { name: "b" }, ""],
    assignees: [{ name: "Jane" }, { username: "jdoe" }], author: { username: "dev" },
    web_url: "https://h/g/p/-/issues/4", updated_at: "2024-05-01T00:00:00Z",
  }, 1);
  assert.deepEqual(
    [r.n, r.iid, r.path, r.title, r.author, r.who, r.labels, r.at],
    [1, 4, "g/p", " t ", "dev", "Jane, jdoe", ["a", "b"], Date.parse("2024-05-01T00:00:00Z")]);
});

test("all projects: the account's list, this project's own group first", async () => {
  const { p } = await open();
  const asked = calls.filter((c) => c.cmd === "glab").at(-1);
  assert.deepEqual(asked.args, ["api", "issues?scope=all&state=opened&per_page=100"]);
  // The account's list is every project's, but only on the machine that answered for it.
  assert.deepEqual(asked.opts, { on: "wsl", timeout: 45000 });
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.groups().map(([path]) => path), ["acme/platform/api", "acme/team/db", "acme/edge/gateway"]);
  assert.equal(p.where(), "3 open across 3 projects");
  assert.deepEqual(fake.shared["gitlab-issues.badge"], { n: 3, err: false, ready: true });
});

test("current project: glab issue list beside the shell, and the project is the remote", async () => {
  const { p, cx } = await open();
  p.setMode(cx, "project");
  await settle();
  const asked = calls.filter((c) => c.cmd === "glab").at(-1);
  assert.deepEqual(asked.args, ["issue", "list", "-F", "json", "-P", "100"]);
  assert.deepEqual(asked.opts, { cwd: REPO, on: "wsl", timeout: 45000 });
  assert.equal(p.rows.length, 1);
  // The project path came out of the web_url: this payload carries no references.
  assert.equal(p.rows[0].path, "acme/platform/api");
  assert.equal(p.where(), "acme/platform/api");
  assert.equal(localStorage.getItem("gitlab-issues.mode"), "project");
  // Storage is the application's, not this panel's: gitlab-mr's bare "mode" is left alone.
  assert.equal(localStorage.getItem("mode"), null);
});

test("origin is the project, even when the branch tracks another remote", async () => {
  const { p } = await open({
    git: (args) => git(args, {
      remotes: ["upstream", "origin"], upstream: "upstream/main",
      url: (name) => (name === "origin" ? REMOTE : "https://gitlab.example.com/acme/forked.git\n"),
    }),
  });
  assert.equal(p.project, "acme/platform/api");
  assert.deepEqual(calls.filter((c) => c.cmd === "git" && c.args[1] === "get-url").map((c) => c.args),
    [["remote", "get-url", "origin"]]);
});

test("no origin: the branch's upstream remote is the project", async () => {
  const { p } = await open({
    git: (args) => git(args, { remotes: ["fork"], upstream: "fork/main", url: "git@gitlab.example.com:acme/forked.git\n" }),
  });
  assert.equal(p.project, "acme/forked");
  assert.deepEqual(calls.filter((c) => c.cmd === "git" && c.args[1] === "get-url").map((c) => c.args),
    [["remote", "get-url", "fork"]]);
});

test("no remote at all: glab is not asked, and the header says why", async () => {
  const { p, cx } = await open({ git: (args) => git(args, { remotes: [] }) });
  calls.length = 0;
  p.setMode(cx, "project");
  await settle();
  assert.equal(calls.filter((c) => c.cmd === "glab").length, 0);
  assert.equal(p.error, "");
  assert.equal(p.rows.length, 0);
  assert.equal(p.where(), "no git remote in " + REPO);
  assert.match(textOf(p.render()), /no git remote in /);
});

test("a remote on a host that runs no GitLab: not asked, and named", async () => {
  const { p, cx } = await open({ git: (args) => git(args, { url: "git@github.com:someone/app.git\n" }) });
  calls.length = 0;
  p.setMode(cx, "project");
  await settle();
  assert.equal(calls.filter((c) => c.cmd === "glab").length, 0);
  assert.equal(p.where(), "github.com is not GitLab");
  assert.deepEqual(fake.shared["gitlab-issues.badge"], { n: 0, err: false, ready: true });
});

test("a failed poll keeps the rows it had, and the badge says it hurt", async () => {
  const { p, cx } = await open();
  stack().hidden = false;
  stack().active = "gitlab-issues";
  world.fail = true;
  p.next = 0;
  p.tick(cx);
  await settle();
  assert.equal(p.rows.length, 3);
  assert.equal(p.error, "command not found");
  assert.equal(p.loading, false);
  assert.deepEqual(fake.shared["gitlab-issues.badge"], { n: 3, err: true, ready: true });
  assert.match(textOf(p.render()), /command not found/);
});

test("a click opens a tab of its own, with that machine's glab", async () => {
  const { p, cx } = await open();
  const row = p.rows[0];
  const el = p.render();
  calls.length = 0;
  runs.length = 0;
  byId(el, "i-0")._h.on_click(null, cx);
  assert.deepEqual(runs, [[["tab.new"].at(0), {
    name: `#${row.iid} ${row.title}`.slice(0, 60),
    mod: "issue-review",
    props: { iid: String(row.iid), path: row.path, on: "wsl" },
  }]]);
  // A click is not a request: the tab does its own asking, on the machine it was handed.
  assert.equal(calls.filter((c) => c.cmd === "glab").length, 0);
});

test("clicking the same issue again shows the tab it already has", async () => {
  const { p } = await open();
  const row = p.rows[0];
  runs.length = 0;
  p.open(row);
  assert.deepEqual(runs.map((r) => r[0]), ["tab.new"]);

  // A tab's name is the only handle there is, and the title can change under it: the iid is
  // what is matched.
  fake.spaces = [{ id: "s1", name: "api", folder: REPO, machine: "wsl", active: true,
    tabs: [{ id: "tb1", name: "1" }, { id: "tb7", name: `#${row.iid} 改名之后` }] }];
  runs.length = 0;
  p.open(row);
  assert.deepEqual(runs, [["tab.select", { id: "tb7" }]]);

  // #77 is not #7: a longer iid must not be taken for a shorter one.
  runs.length = 0;
  p.open({ ...row, iid: Number(`${row.iid}7`) });
  assert.deepEqual(runs.map((r) => r[0]), ["tab.new"]);
});

test("an issue closed in its tab leaves the list at once, and a stale mark does not", async () => {
  const { p } = await open();
  const row = p.rows[0];
  const key = `${row.path}#${row.iid}`;
  assert.equal(p.shown().length, 3);

  // Older than the mark's age limit: a tab that closed it 20 minutes ago cannot still hide it.
  fake.shared["issue-review.done"] = { [key]: Date.now() - 20 * 60e3 };
  assert.equal(p.shown().length, 3);

  fake.shared["issue-review.done"] = { [key]: Date.now() };
  assert.equal(p.shown().length, 2);
  assert.equal(p.where(), "2 open across 2 projects");
  p.tell();
  assert.deepEqual(fake.shared["gitlab-issues.badge"], { n: 2, err: false, ready: true });
});

test("a poll that brings no news does not redraw; news does, once", async () => {
  const { p, cx } = await open();
  stack().hidden = false;
  stack().active = "gitlab-issues";
  cx.notified = 0;
  p.next = 0;
  p.tick(cx); // the same three issues back again
  await settle();
  assert.equal(cx.notified, 0);
  assert.equal(p.slow, false);

  // A label added to the same issue is news: the row is what the list is read for.
  world.rows = (args) => (args[0] === "api"
    ? [...ALL.slice(0, 2), issue(4, "acme/platform/api", ["feature", "p1", "backend", "needs design"], 0.2)]
    : PRJ);
  cx.notified = 0;
  p.next = 0;
  p.tick(cx);
  await settle();
  assert.equal(cx.notified, 1);
  assert.deepEqual(p.rows.find((m) => m.iid === 4).labels, ["feature", "p1", "backend", "needs design"]);
  // Two labels and a count: the extras are a number, not a third chip.
  assert.match(textOf(p.render()), /\+2/);
});

test("another machine: the list is stale at once, and asked for there", async () => {
  const { p, cx } = await open();
  fake.spaces = [{ id: "s1", name: "api", folder: REPO, machine: "desktop", active: true, tabs: [{ id: "tb1" }] }];
  assert.equal(p.stale(), true);
  assert.equal(p.where(), "looking…");
  calls.length = 0;
  p.next = Date.now() + 999999; // nowhere near a poll
  stack().hidden = false;
  stack().active = "gitlab-issues";
  p.wasShown = true;
  p.tick(cx);
  await settle();
  assert.deepEqual(calls.filter((c) => c.cmd === "glab").at(-1).opts, { on: "desktop", timeout: 45000 });
  assert.equal(p.stale(), false);
  assert.equal(p.where(), "3 open across 3 projects");
});

test("the rail's row: the count rides on the icon while the panel is away", async () => {
  const { p, cx } = await open();
  fake.onRun = (name, args) => {
    if (name === "layout.hide") stack().hidden = true;
    if (name === "layout.show") stack().hidden = false;
    if (name === "layout.select") stack().active = args.child;
  };
  const rail = new Rail();
  rail.init({}, cx);
  assert.equal(rail.showing("gitlab-issues"), false);
  assert.match(textOf(byId(rail.render(), "rail-1")), /3/);

  runs.length = 0;
  rail.click(cx, { child: "gitlab-issues" });
  assert.deepEqual(runs, [["layout.select", { stack: "sidepanel", child: "gitlab-issues" }], ["layout.show", { id: "sidepanel" }]]);
  assert.equal(rail.showing("gitlab-issues"), true);
  // On screen, the panel is the count: an icon that repeats it is noise.
  assert.doesNotMatch(textOf(byId(rail.render(), "rail-1")), /\d/);
  assert.equal(p.rows.length, 3);
});

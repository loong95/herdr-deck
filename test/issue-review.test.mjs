// Drives the issue tab outside Herdr: the two calls it makes, the description and the thread it
// builds from them, what a confirmed dialog finally runs, and the marks a close or a reopen
// leaves for the list. Nothing here talks to GitLab, so no issue is closed by this test.
//
// The modules the mod imports come from test/stub/ (see stub/register.mjs): this is the real
// source, imported as it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, log } from "./stub/herdr.mjs";
import { byId, textOf } from "./stub/element.mjs";
import IssueReview, {
  cellsOf, enc, labelsOf, markDone, markOpen, mdInline, mdLines, noteRows, refOf, say,
} from "../mods/issue-review/main.js";

// The app hands a command to every copy of a mod, whichever one it would really have picked, so
// the copies have to sort among themselves who acts. __send delivers one; __only drops the ones
// still waiting, which is what a new case wants (the panels earlier cases built are still alive).
const waiters = [];
globalThis.__nextCommand = () => new Promise((res) => { waiters.push(res); });
globalThis.__send = (c) => waiters.splice(0, waiters.length).forEach((res) => res(c));
globalThis.__only = () => { waiters.length = 0; };

const PROJECT = "acme/platform/api";
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const calls = log.exec;

const desc = [
  "# 复现",
  "",
  "- 打开登录页",
  "- 等 30 秒",
  "- 再点一次",
  "",
  "| 步骤 | 结果 |",
  "| --- | --- |",
  "| 1 | 500 |",
  "",
  "```",
  "GET /api/session 500",
  "```",
].join("\n");

const meta = (over = {}) => ({
  iid: 12, title: "登录超时之后再点一次就会 500", state: "opened", description: desc,
  labels: [
    { name: "bug", color: "#d9534f", text_color: "#ffffff" },
    { name: "p1", color: "#f0ad4e", text_color: "#333333" },
  ],
  assignees: [{ name: "Jane Doe" }, { username: "jdoe" }],
  author: { name: "Dev User" }, milestone: { title: "v1.2" }, due_date: "2026-12-31",
  created_at: "2026-01-01T09:00:00Z", updated_at: new Date(Date.now() - 40 * 60e3).toISOString(),
  web_url: "https://gitlab.example.com/acme/platform/api/-/issues/12", user_notes_count: 2,
  ...over,
});

const NOTES = [
  { id: 3, body: "修好了，见 !77\n\n- 加了一次重试\n- 补了测试", author: { username: "jdoe" }, created_at: "2026-01-02T10:00:00Z" },
  { id: 1, body: "我这边也复现了", author: { name: "Jane Doe" }, created_at: "2026-01-01T10:00:00Z" },
  { id: 2, body: "changed the description", system: true, author: { name: "Dev User" }, created_at: "2026-01-01T11:00:00Z" },
];

// What glab answers: the issue itself, its notes, and the two actions.
let world = {};
const setup = () => {
  world = { meta: meta(), notes: NOTES, failMeta: false, failNotes: false, failAction: false };
  globalThis.__only();
  globalThis.__shared = {};
  globalThis.__overlays = [];
  globalThis.__props = { iid: 12, path: PROJECT, on: "wsl" };
  // What the app was asked for is kept in log.exec (the stub's default), so a case that counts
  // calls clears that list rather than pointing the stub somewhere else.
  calls.length = 0;
  fake.settings = { zoom: 1 };
  globalThis.__reply = async (cmd, args) => {
    const ep = String(args.at(-1));
    if (args[0] === "api") {
      if (ep.includes("/notes")) {
        if (world.failNotes) throw new Error("glab: 403 Forbidden");
        return { code: 0, stdout: JSON.stringify(world.notes), stderr: "" };
      }
      if (world.failMeta) return { code: 1, stdout: "", stderr: "  ERROR  \n  glab: 404 Not Found (HTTP 404)\n" };
      return { code: 0, stdout: JSON.stringify(world.meta), stderr: "" };
    }
    if (args[0] === "issue") {
      if (world.failAction) return { code: 1, stdout: "", stderr: "  ERROR  \n  glab: 405 Method Not Allowed (HTTP 405)\n" };
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return world;
};

const cx = {
  notify: () => {},
  focus_handle: () => ({}),
  spawn: (fn) => fn(cx),
  stop_propagation: () => { cx.stopped = (cx.stopped ?? 0) + 1; },
  // App::write_to_clipboard, as a click handler is handed it.
  write_to_clipboard: (text) => { globalThis.__clipboard = text; },
  timer: { every: () => ({}), after: (ms, fn) => { setTimeout(() => fn(cx), ms).unref?.(); return {}; } },
};

// One panel, on a fresh world, with the earlier panels' commands dropped.
const make = async () => {
  setup();
  const p = new IssueReview();
  p.init({}, cx);
  await settle();
  return p;
};

// --- the pure helpers ---
test("the helpers: escaping, markdown, notes and labels", () => {
  assert.equal(enc("acme/platform/api"), "acme%2Fplatform%2Fapi");
  assert.equal(say('{"message":"404 Project Not Found"}glab: HTTP 404 (HTTP 404)'), "404 Project Not Found");
  assert.equal(say("glab: command not found"), "command not found");

  // A code span keeps its text, and emphasis across one keeps working.
  assert.equal(mdInline("**不进 `a` / `b`**"), "不进 a / b");
  assert.equal(mdInline("[说明](https://x/y) 在这里"), "说明 https://x/y 在这里");
  assert.equal(mdInline("user_session_id 是名字"), "user_session_id 是名字");

  const rows = mdLines(desc);
  assert.deepEqual(rows.map((r) => r.kind).filter((k) => k !== "gap"),
    ["head", "li", "li", "li", "table", "code"]);
  assert.equal(rows.find((r) => r.kind === "table").rows[0].join("|"), "1|500");
  assert.equal(rows.find((r) => r.kind === "code").text, "GET /api/session 500");
  assert.equal(cellsOf("| a \\| b | c |").join("|"), "a | b|c");

  const notes = noteRows(NOTES);
  assert.deepEqual(notes.map((n) => n.id), ["n1", "n2", "n3"]); // oldest first, whatever order they arrive in
  assert.deepEqual(notes.map((n) => n.system), [false, true, false]);
  assert.equal(notes[0].plain, "我这边也复现了");
  assert.equal(notes[2].body.filter((b) => b.kind === "li").length, 2);

  assert.deepEqual(labelsOf(meta()).map((l) => [l.name, l.color]), [["bug", "#d9534f"], ["p1", "#f0ad4e"]]);
  assert.deepEqual(labelsOf({ labels: ["bug", ""] }), [{ name: "bug", color: "", text: "" }]);
  assert.deepEqual(labelsOf({}), []);
});

// --- the two calls ---
test("the issue and its notes, asked for once each, on the tab's machine", async () => {
  const p = await make();
  const asked = calls.filter((c) => c.cmd === "glab");
  assert.deepEqual(asked.map((c) => c.args), [
    ["api", `projects/${enc(PROJECT)}/issues/12?with_labels_details=true`],
    ["api", "--paginate", `projects/${enc(PROJECT)}/issues/12/notes?per_page=100&sort=asc`],
  ]);
  // Both on the machine the list handed over: glab is quicker on the space's own box.
  assert.deepEqual(asked.map((c) => c.opts), [
    { on: "wsl", timeout: 45000 }, { on: "wsl", timeout: 45000 },
  ]);
  assert.equal(p.desc.filter((r) => r.kind !== "gap").length, 6);
  assert.equal(p.notes.length, 3);
  assert.equal(p.error, "");

  const el = p.render();
  const text = textOf(el);
  assert.match(text, /#12/);
  assert.match(text, /登录超时之后再点一次就会 500/);
  assert.match(text, /打开/); // the state chip
  assert.match(text, /bug/);
  assert.match(text, /p1/);
  assert.match(text, /Dev User · 指派给 Jane Doe, jdoe/);
  assert.match(text, /◆ v1\.2/);
  assert.match(text, /截止 2026-12-31/);
  assert.match(text, /讨论 2 条/);
  // The description and the thread are two panes, both there by default.
  assert.ok(byId(el, "ir-desc"));
  assert.ok(byId(el, "ir-talk"));
  // A row sizes its children's cross axis from *them*, and both panes hold only absolutely
  // positioned children: without h_full each is 2 px tall and the words are a strip down the
  // middle of the tab. The pixels cannot be checked here; the call that decides them can.
  assert.ok("h_full" in byId(el, "ir-desc-box")._a, "the description pane asks for the row's height");
  assert.ok("h_full" in byId(el, "ir-talk")._a, "the discussion pane asks for the row's height");
  assert.match(textOf(byId(el, "ir-desc")), /复现/);
  assert.match(textOf(byId(el, "ir-talk")), /我这边也复现了/);
  assert.match(textOf(byId(el, "ir-talk")), /修好了，见 !77/);
});

test("a thread that cannot be read does not cost the description", async () => {
  setup().failNotes = true;
  const p = new IssueReview();
  p.init({}, cx);
  await settle();
  assert.equal(p.error, "");
  assert.equal(p.notes.length, 0);
  assert.equal(p.desc.filter((r) => r.kind !== "gap").length, 6);
  assert.match(textOf(p.render()), /还没有人评论/);
});

test("an issue that cannot be read at all says why, and shows nothing else", async () => {
  setup().failMeta = true;
  const p = new IssueReview();
  p.init({}, cx);
  await settle();
  assert.equal(p.error, "404 Not Found");
  assert.equal(p.meta, null);
  const el = p.render();
  assert.match(textOf(el), /404 Not Found/);
  // No description and no thread: with nothing to read, the panes are not drawn at all.
  assert.equal(byId(el, "ir-desc"), null);
  assert.equal(byId(el, "ir-talk"), null);
});

// --- closing, behind a dialog that has to be answered ---
test("closing asks first, then runs glab issue close and tells the list", async () => {
  const p = await make();
  p.ask("close");
  const ask = globalThis.__overlays.at(-1);
  assert.equal(ask.mod, "confirm");
  assert.equal(ask.kind, "dialog");
  assert.equal(ask.props.command.name, "issue-review.confirm");
  assert.match(ask.props.title, /关闭 #12？/);
  assert.match(ask.props.detail, /关掉之后它从列表里消失/);
  // Nothing has run yet: the dialog is the only thing that happened.
  assert.deepEqual(calls.filter((c) => c.cmd === "glab" && c.args[0] === "issue"), []);

  calls.length = 0;
  globalThis.__send("issue-review.confirm");
  await settle();
  const ran = calls.filter((c) => c.cmd === "glab" && c.args[0] === "issue");
  assert.deepEqual(ran.map((c) => c.args), [["issue", "close", "12", "-R", PROJECT]]);
  assert.deepEqual(ran[0].opts, { on: "wsl", timeout: 90000 });
  assert.equal(globalThis.__shared["issue-review.pending"], null); // claimed, so a second copy cannot
  assert.ok(globalThis.__shared["issue-review.done"][`${PROJECT}#12`] > 0);
  assert.equal(p.note, "已关闭这个 issue。");
  assert.equal(p.noteBad, false);
  // The note is the strip under the page, and it is on screen.
  assert.match(textOf(p.render()), /已关闭这个 issue。/);
  // ...and the page was asked again afterwards: what is shown has to be what glab says now.
  assert.ok(calls.filter((c) => c.cmd === "glab" && c.args[0] === "api").length >= 1);
});

test("a command that is not this tab's confirmation does nothing", async () => {
  const p = await make();
  p.ask("close");
  calls.length = 0;
  globalThis.__send("confirm"); // the MR review's command name, not this one
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(globalThis.__shared["issue-review.done"], undefined);
});

test("a close glab refuses keeps the list and says why", async () => {
  const p = await make();
  world.failAction = true;
  p.ask("close");
  calls.length = 0;
  globalThis.__send("issue-review.confirm");
  await settle();
  assert.equal(p.noteBad, true);
  assert.match(p.note, /关闭没做成：405 Method Not Allowed/);
  assert.equal(globalThis.__shared["issue-review.done"], undefined);
});

// --- reopening, and the mark it takes back ---
test("a closed issue can be reopened, and the list's mark goes with it", async () => {
  const p = await make();
  world.meta = meta({ state: "closed" });
  p.load(cx);
  await settle();
  assert.match(textOf(p.render()), /已关闭/);
  markDone(PROJECT, 12);
  assert.ok(globalThis.__shared["issue-review.done"][`${PROJECT}#12`]);

  p.ask("reopen");
  assert.match(globalThis.__overlays.at(-1).props.title, /重新打开 #12？/);
  calls.length = 0;
  globalThis.__send("issue-review.confirm");
  await settle();
  assert.deepEqual(calls.filter((c) => c.cmd === "glab" && c.args[0] === "issue").map((c) => c.args),
    [["issue", "reopen", "12", "-R", PROJECT]]);
  assert.deepEqual(globalThis.__shared["issue-review.done"], {},
    "a reopened issue is in the list again: the mark that hid it has to go");
  assert.equal(p.note, "已重新打开这个 issue。");
});

test("the buttons follow the state, and one that cannot be pressed says why", async () => {
  const p = await make();
  assert.equal(p.verdict().canClose, true);
  assert.equal(p.verdict().canOpen, false);
  assert.match(String(byId(p.render(), "open-issue")._a.tooltip), /还开着/);

  world.meta = meta({ state: "closed" });
  p.load(cx);
  await settle();
  assert.equal(p.verdict().canClose, false);
  assert.equal(p.verdict().canOpen, true);
  assert.match(String(byId(p.render(), "close-issue")._a.tooltip), /已经关着了/);
});

// --- the browser, and the discussion toggle ---
test("the browser is a button: glab issue view --web, on the tab's machine", async () => {
  const p = await make();
  calls.length = 0;
  p.web();
  await settle();
  assert.deepEqual(calls.map((c) => [c.args, c.opts]),
    [[["issue", "view", "12", "-R", PROJECT, "--web"], { on: "wsl", timeout: 45000 }]]);
});

// --- the number in the header is the reference an agent is handed ---
test("the header's number copies group/project#iid, and says so", async () => {
  const p = await make();
  assert.equal(refOf(PROJECT, 12), "acme/platform/api#12");
  assert.equal(refOf("", 12), "#12", "no project, half a reference — still the number");

  const chip = () => byId(p.render(), "copy-ref");
  assert.equal(textOf(chip()), "#12", "the number is what the header shows");

  globalThis.__clipboard = "";
  chip()._h.on_click({}, cx);
  assert.equal(globalThis.__clipboard, "acme/platform/api#12");
  // Nothing on screen moves when a copy lands, so the ✓ is the receipt.
  assert.equal(textOf(chip()), "✓");

  // …and it is a receipt, not a state: the number comes back.
  await settle(1300);
  assert.equal(textOf(chip()), "#12");
});

test("the discussion folds away, and stays folded for the next tab", async () => {
  const p = await make();
  assert.ok(byId(p.render(), "ir-talk"));
  byId(p.render(), "show-talk")._h.on_click(null, cx);
  assert.deepEqual(globalThis.__shared["issue-review.view"], { talk: false });
  assert.equal(byId(p.render(), "ir-talk"), null);
  // A second tab opens the way the first one was left.
  const q = new IssueReview();
  q.init({}, cx);
  await settle();
  assert.equal(byId(q.render(), "ir-talk"), null);
});

test("markDone prunes what is too old to matter; markOpen takes a mark back", () => {
  setup();
  globalThis.__shared["issue-review.done"] = { "a/b#1": Date.now() - 40 * 60e3 };
  markDone("a/b", 2);
  assert.deepEqual(Object.keys(globalThis.__shared["issue-review.done"]), ["a/b#2"]);
  markOpen("a/b", 2);
  assert.deepEqual(globalThis.__shared["issue-review.done"], {});
});

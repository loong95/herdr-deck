// The agents board: what it says about the agents Herdr reports, and what its buttons run.
// The rail's rows for it are checked here too, because the two have to agree about which
// screen the board is.
import { test } from "node:test";
import assert from "node:assert/strict";
import Board, { agentName, tabLabel, ago, groups, needing, allTabs, KEY_BADGE, KEY_VIEW } from "../mods/board/main.js";
import Rail from "../mods/rail/main.js";
import { fake, log } from "./stub/herdr.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { byId, textOf } from "./stub/element.mjs";
import { theme } from "./stub/herdr.mjs";

const t = theme();
const agent = (address, status, over = {}) => ({
  address, pane: "p-" + address, space: "sp1", space_name: "app", tab: "tb-" + address, tab_index: 1,
  tab_name: "1", status, app: "pi", program: { name: "Pi", icon: null, tint: true }, title: "", seq: 1,
  pinned: false, focused: false, ...over,
});
const space = (tabs, over = {}) => ({ id: "sp1", index: 1, name: "app", named: false, folder: "/w/app", machine: null, branch: "main", active: true, status: null, tabs, ...over });

const reset = () => {
  fake.shared = {};
  fake.agents = [];
  fake.spaces = [];
  fake.layout = null;
  log.run.length = 0;
};

test("names and times are said the way a person would", () => {
  assert.equal(agentName(agent("t1", "working", { tab_name: "review" })), "review");
  assert.equal(agentName(agent("t1", "working", { tab_name: "3" })), "Pi", "an automatic tab name is not a name");
  assert.equal(agentName(null), "");
  assert.equal(tabLabel({ name: "2" }), "2");
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);
  assert.deepEqual([ago(now - 20e3, now), ago(now - 13 * 60e3, now), ago(now - 5 * 3600e3, now), ago(now - 50 * 3600e3, now), ago(null, now)],
    ["now", "13m", "5h", "2d", ""]);
});

test("tabs are grouped by status, and empty groups are left out", () => {
  const tabs = [
    { space: { id: "sp1", name: "app" }, tab: { id: "a", status: "blocked" } },
    { space: { id: "sp1", name: "app" }, tab: { id: "b", status: "working" } },
    { space: { id: "sp2", name: "web" }, tab: { id: "c", status: "working" } },
    { space: { id: "sp2", name: "web" }, tab: { id: "d", status: "idle" } },
  ];
  assert.deepEqual(groups(tabs, "status").map((g) => [g.title, g.items.length]), [["Needs you", 1], ["Working", 2], ["Resting", 1]]);
  assert.deepEqual(groups(tabs, "space").map((g) => [g.title, g.items.length]), [["app", 2], ["web", 2]]);
});

test("only the agents that wait for you are on the needs screen", () => {
  fake.agents = [agent("t1", "blocked"), agent("t2", "working"), agent("t3", "blocked")];
  assert.deepEqual(needing().map((a) => a.address), ["t1", "t3"]);
  assert.equal(allTabs([]).length, 0);
});

test("the board says all clear when nobody waits", () => {
  reset();
  fake.spaces = [space([])];
  const cx = fakeCx();
  const board = new Board();
  board.init({}, cx);
  const text = textOf(board.render(cx));
  assert.match(text, /All clear/);
  assert.match(text, /No agent waits for you/);
  assert.deepEqual(fake.shared[KEY_BADGE], { n: 0, err: false, ready: true });
});

test("a waiting agent is listed, and its terminal is what the button opens", () => {
  reset();
  fake.agents = [agent("t1", "blocked", { tab_name: "review" })];
  fake.spaces = [space([{ id: "tb-t1", name: "review", named: true, active: true, status: "blocked", changed_at: Date.now() }])];
  const cx = fakeCx();
  const board = new Board();
  board.init({}, cx);
  const el = board.render(cx);
  assert.match(textOf(el), /Needs you · 1/);
  assert.match(textOf(el), /review/);
  assert.deepEqual(fake.shared[KEY_BADGE], { n: 1, err: false, ready: true });
  // The card, by the id the click is on.
  byId(el, "needs-open")._h.on_click({}, cx);
  assert.deepEqual(log.run.map(([name]) => name), ["space.select", "tab.select", "agent.focus", "layout.select"]);
  assert.deepEqual(log.run[2], ["agent.focus", { terminal: "t1" }]);
  assert.deepEqual(log.run[3][1], { stack: "screens", child: "main" }, "the tab's panes come back");
});

test("the overview draws one card per open tab, and a card goes to its tab", () => {
  reset();
  fake.agents = [agent("t1", "blocked")];
  fake.spaces = [space([
    { id: "tb1", name: "1", named: false, active: true, status: "blocked", changed_at: Date.now(), settled: false },
    { id: "tb2", name: "2", named: false, active: false, status: "working", changed_at: Date.now(), settled: false },
    { id: "tb3", name: "3", named: false, active: false, status: "idle", changed_at: Date.now(), settled: true },
  ])];
  fake.shared[KEY_VIEW] = "overview";
  const cx = fakeCx();
  const board = new Board();
  board.init({}, cx);
  const el = board.render(cx);
  assert.ok(byId(el, "ov-tb1"), "the blocked tab has a card");
  assert.ok(byId(el, "ov-tb2"));
  assert.equal(byId(el, "ov-tb3"), null, "a put-away tab is not on the board");
  byId(el, "ov-tb2")._h.on_click({}, cx);
  assert.deepEqual(log.run.map(([name, args]) => [name, args?.id]), [["space.select", "sp1"], ["tab.select", "tb2"], ["layout.select", undefined]]);
});

test("a command from the shell or a key switches the view", async () => {
  reset();
  fake.spaces = [space([])];
  const waiting = [];
  globalThis.__nextCommand = () => new Promise((resolve) => waiting.push(resolve));
  const cx = fakeCx();
  const board = new Board();
  board.init({}, cx);
  assert.equal(fake.shared[KEY_VIEW], undefined, "nothing asked yet");
  waiting.shift()("overview");
  await cx.settle(20);
  assert.equal(fake.shared[KEY_VIEW], "overview");
  waiting.shift()("needs");
  await cx.settle(20);
  assert.equal(fake.shared[KEY_VIEW], "needs");
  delete globalThis.__nextCommand;
});

test("the rail's board rows switch the screen, and the second press puts the panes back", () => {
  reset();
  fake.layout = { id: "root", children: [{ id: "work-body", children: [
    { id: "screens", type: "stack", active: "main", hidden: false, children: [{ id: "main" }, { id: "board" }] },
    { id: "sidepanel", type: "stack", active: "gitlab-mr", hidden: true, children: [{ id: "gitlab-mr" }] },
    { id: "rail" },
  ] }] };
  fake.onRun = (name, args) => {
    const screens = fake.layout.children[0].children[0];
    if (name === "layout.select" && args.stack === "screens") screens.active = args.child;
  };
  const cx = fakeCx({ real: true });
  const rail = new Rail();
  rail.init({}, cx);
  const needs = { screen: "screens", child: "board", view: "needs" };
  const overview = { screen: "screens", child: "board", view: "overview" };
  assert.equal(rail.showing(needs), false, "the panes are up");
  rail.click(cx, needs);
  assert.equal(fake.shared[KEY_VIEW], "needs");
  assert.ok(rail.showing(needs), "the needs row is on");
  assert.equal(rail.showing(overview), false, "the same screen, another view: not this row");
  rail.click(cx, overview);
  assert.ok(rail.showing(overview));
  rail.click(cx, overview);
  assert.equal(rail.showing(overview), false, "pressed again: the panes are back");
  assert.equal(fake.layout.children[0].children[0].active, "main");
  cx.stopTimers();
});

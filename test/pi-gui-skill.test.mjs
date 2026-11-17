// A prompt Pi expanded from a skill. `/skill:pdf …` never reaches the model as typed: Pi
// replaces the command with the skill's whole file, and the session log keeps that file. Drawn
// as it came, one message is hundreds of lines of instructions the person never wrote — so the
// skill is its own folded row and the bubble keeps only the words.
import { test } from "node:test";
import assert from "node:assert/strict";
import PiGui, { skillSummary, splitSkill } from "../mods/pi-gui/main.js";
import { byId, textOf } from "./stub/base.mjs";
import { fakeCx } from "./fake-cx.mjs";

const BODY = [
  "References are relative to C:\\skills\\pdf.",
  "",
  "# pdf",
  "",
  "Fill in a form and read it back, keeping the layout exact.",
  "",
  "1. open the file",
].join("\n");
const PROMPT = '<skill name="pdf" location="C:\\skills\\pdf\\SKILL.md">\n' + BODY + "\n</skill>\n\nfill this one in";

// The fields init() lays down, without the discovery and the timers init() also starts.
const panel = (rows = []) => Object.assign(new PiGui(), {
  machine: null, want: {}, rows: [], older: [], olderFrom: null, localShow: 40,
  error: null, file: null, textSig: "", logKind: null, follow: true, bridge: null,
  picker: null, attachments: [], meta: null, open: {}, diagrams: {},
  input: { on: () => {}, focus: () => {} },
  state: { sessionId: "s1", status: "idle", busy: false, total: rows.length, from: 0, rows },
});

const skillRow = { kind: "skill", key: "s7", name: "pdf", location: "C:\\skills\\pdf\\SKILL.md", body: BODY, summary: skillSummary(BODY) };
const userRow = { kind: "user", key: "u7", text: "fill this one in" };

// The header is the click target, as on a tool card; the row's id is on the box around it.
const clickRow = (v, cx, key) => byId(v.render(cx), key).kids[0]._h.on_click({}, cx);

test("splitSkill keeps the file out of the words", () => {
  const skill = splitSkill(PROMPT);
  assert.equal(skill.name, "pdf");
  assert.equal(skill.location, "C:\\skills\\pdf\\SKILL.md");
  assert.equal(skill.text, "fill this one in");
  assert.match(skill.body, /^References are relative to/);
});

test("a plain prompt, an unclosed block and a nameless skill are text, not skills", () => {
  for (const text of [
    "what does /skill:pdf do?",
    'see <skill name="pdf" location="x">',
    '<skill name="pdf" location="x">\nunclosed body',
    "",
  ]) {
    assert.equal(splitSkill(text), null, JSON.stringify(text));
  }
});

test("the one line is the skill's first prose line, not its path or a heading", () => {
  assert.equal(skillSummary(BODY), "Fill in a form and read it back, keeping the layout exact.");
  assert.equal(skillSummary("# only a heading"), "");
});

test("the folded row is one line, and the file is behind the fold", () => {
  const v = panel([skillRow, userRow]);
  const cx = fakeCx();
  const row = textOf(byId(v.render(cx), "s7"));
  assert.match(row, /skill:pdf/);
  assert.match(row, /Fill in a form and read it back/);
  assert.doesNotMatch(row, /References are relative to/, "the file is not on screen while folded");
  assert.equal(byId(v.render(cx), "s7-body"), null, "and it is not in the tree at all");
  assert.match(textOf(byId(v.render(cx), "u7")), /fill this one in/, "the words keep their bubble");
});

test("clicking the row opens the skill file, and clicking again folds it", () => {
  const v = panel([skillRow, userRow]);
  const cx = fakeCx();
  clickRow(v, cx, "s7");
  assert.equal(v.open.s7, true);
  assert.ok(cx.notified > 0, "the panel redraws");
  assert.match(textOf(byId(v.render(cx), "s7-body")), /References are relative to/);
  clickRow(v, cx, "s7");
  assert.equal(byId(v.render(cx), "s7-body"), null);
});

test("the read-only log splits the same way", async () => {
  const { fake } = await import("./stub/herdr.mjs");
  fake.props = { agent: "pi", file: "C:\\logs\\skill.jsonl" };
  fake.readText = () => [
    { type: "message", id: "e1", parentId: null, message: { role: "user", content: [{ type: "text", text: PROMPT }] } },
    { type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  assert.deepEqual(v.rows.map((r) => r.kind), ["skill", "user", "assistant"]);
  assert.equal(v.rows[0].name, "pdf");
  assert.equal(v.rows[1].text, "fill this one in");
});

test("a skill file longer than the row carries is cut, and says so", async () => {
  const { fake } = await import("./stub/herdr.mjs");
  const long = PROMPT.replace("1. open the file", "x".repeat(20000));
  fake.props = { agent: "pi", file: "C:\\logs\\long.jsonl" };
  fake.readText = () => JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: [{ type: "text", text: long }] } }) + "\n";
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  assert.ok(v.rows[0].body.endsWith("\n…"), "the row says it was cut");
  assert.ok(v.rows[0].body.length < 13000);
});

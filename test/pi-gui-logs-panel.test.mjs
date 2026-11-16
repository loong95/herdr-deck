// The panel's read-only mode: the session log of an agent that keeps no bridge, turned into
// the rows the transcript draws. Codex goes through a process (readTail), the app's fs
// being off limits there; Claude Code is read straight.
import { test } from "node:test";
import assert from "node:assert/strict";
import PiGui from "../mods/pi-gui/main.js";
import { fake, log } from "./stub/herdr.mjs";
import { fakeCx } from "./fake-cx.mjs";

const CODEX_LINES = [
  { type: "session_meta", payload: { id: "th1", timestamp: "2026-10-29T01:41:11Z", cwd: "D:\\Projects\\demo" } },
  { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "group/model-a" } } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello there" }] } },
  { type: "response_item", payload: { type: "function_call", name: "find_files", namespace: "mcp__fff", arguments: "{}", call_id: "c1" } },
  { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "2 matches" }] } },
  { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "It is a test." }] } },
];

const panel = () => Object.assign(new PiGui(), {
  machine: null, want: {}, rows: [], localShow: 40, error: null, file: null, textSig: "", logKind: null, follow: false,
});

test("a Codex session is read by a process, and its rows land", async () => {
  fake.props = { agent: "codex", cwd: "D:/Projects/demo" };
  fake.exec = async (cmd) => ({ code: 0, stdout: "C:\\logs\\rollout-x.jsonl\n" + CODEX_LINES.map((l) => JSON.stringify(l)).join("\n") });
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  assert.deepEqual(v.rows.map((r) => r.kind), ["user", "tool", "assistant"]);
  assert.equal(v.rows[1].result, "2 matches");
  assert.equal(v.file, "C:\\logs\\rollout-x.jsonl");
  assert.equal(v.logMeta.model, "group/model-a");
  assert.equal(v.title(), "Codex");
  assert.equal(v.error, null);
  // Codex is asked of a shell, never of the app's fs.
  assert.ok(log.exec.some((c) => c.cmd === "powershell" || c.cmd === "sh"), "a shell was used");
});

test("the same tail twice is not re-drawn", async () => {
  fake.props = { agent: "codex" };
  fake.exec = async () => ({ code: 0, stdout: "C:\\logs\\a.jsonl\n" + JSON.stringify(CODEX_LINES[2]) });
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  const rows = v.rows;
  const before = cx.notified;
  await v.loadFile(cx);
  assert.equal(cx.notified, before, "nothing changed, nothing drawn");
  assert.equal(v.rows, rows);
});

test("no shell, no Codex: a sentence instead of a hang", async () => {
  fake.props = { agent: "codex" };
  fake.exec = async () => ({ code: 1, stdout: "", stderr: "no such command" });
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  assert.match(v.error, /No shell could list/);
  assert.equal(v.rows.length, 0);
});

test("a Claude session is read by a shell too, and says where it ran", async () => {
  fake.props = { agent: "claude", cwd: "D:\\Projects\\demo" };
  const claudeLines = [
    { type: "user", uuid: "u1", sessionId: "s1", cwd: "D:\\Projects\\demo", message: { role: "user", content: "fix it" } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ];
  fake.exec = async (cmd, args) => {
    // The shell is asked for the newest log of this folder: the slug is in the script.
    assert.ok(String(args).includes("D--Projects-demo"), "the project folder is the cwd with dashes");
    return { code: 0, stdout: "C:\\logs\\claude.jsonl\n" + claudeLines.map((l) => JSON.stringify(l)).join("\n") };
  };
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  assert.deepEqual(v.rows.map((r) => r.kind), ["user", "assistant"]);
  assert.equal(v.logMeta.cwd, "D:\\Projects\\demo");
  assert.equal(v.headerLabel(), "Claude Code · D:\\Projects\\demo");
  assert.equal(v.title(), "Claude Code");
});

// A Pi session log: a tree of entries, the panel showing the active branch.
const PI_LINES = [
  { type: "message", id: "e1", parentId: null, timestamp: "t1", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
  { type: "message", id: "e2", parentId: "e1", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } },
];
const piLog = () => PI_LINES.map((line) => JSON.stringify(line)).join("\n") + "\n";

// What hc answers for a log of `total` lines: the real two at the very end, filler
// before them, and the same window arithmetic hc does.
const manyLines = (total) => {
  const out = [];
  for (let i = 1; i <= total - PI_LINES.length; i++) out.push(JSON.stringify({ type: "session_info", id: "s" + i }));
  return out.concat(PI_LINES.map((line) => JSON.stringify(line)));
};
const hcReading = (lines) => async (cmd, args) => {
  if (cmd !== "hc") return { code: 1, stdout: "", stderr: "not asked" };
  const limit = Number(args[args.indexOf("--limit") + 1]);
  const first = args.includes("--offset") ? Number(args[args.indexOf("--offset") + 1]) : 1;
  const text = lines.slice(first - 1, first - 1 + limit).join("\n") + "\n";
  return { code: 0, stdout: JSON.stringify({ first, last: first + limit - 1, lines: lines.length, text }), stderr: "" };
};
const shellReading = (stdout) => async (cmd) => (cmd === "powershell" || cmd === "sh"
  ? { code: 0, stdout, stderr: "" }
  : { code: 1, stdout: "", stderr: "not asked" });

test("a Pi log too big for the app's read is read by hc, whole", async () => {
  log.exec.length = 0;
  fake.props = { agent: "pi", file: "C:\\logs\\big.jsonl" };
  fake.readText = () => null;                 // what readTextFile answers past 1 MiB
  fake.exec = hcReading(manyLines(2));
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  assert.equal(v.error, null);
  assert.deepEqual(v.rows.map((r) => r.text), ["hello", "hi there"]);
  assert.equal(v.headerLabel(), "C:\\logs\\big.jsonl", "the whole file, so no note");
  assert.equal(log.exec.every((c) => c.cmd === "hc"), true, "hc, not a shell");
  assert.equal(log.exec.length, 2, "one ask for the line count, one for the text");
});

test("a log longer than one window is read from its end, and says so", async () => {
  log.exec.length = 0;
  const lines = manyLines(3000);
  fake.props = { agent: "pi", file: "C:\\logs\\huge.jsonl" };
  fake.readText = () => null;
  fake.exec = hcReading(lines);
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  assert.deepEqual(v.rows.map((r) => r.text), ["hello", "hi there"], "the newest rows are up");
  assert.match(v.headerLabel(), /huge\.jsonl · end of the log$/, "and the header says which part");
  const window = log.exec[1].args.join(" ");
  assert.match(window, /--offset 1801/, "the window starts where the last 1200 lines do");
  assert.match(window, /--limit 1200/);
});

test("an answer cut by a line taller than a page falls back to a shell", async () => {
  log.exec.length = 0;
  fake.props = { agent: "pi", file: "C:\\logs\\cut.jsonl" };
  fake.readText = () => null;
  // hc says how many lines there are, then hands back JSON that does not parse.
  fake.exec = async (cmd, args) => {
    if (cmd !== "hc") return shellReading(piLog())("powershell");
    const limit = args[args.indexOf("--limit") + 1];
    return { code: 0, stdout: limit === "1" ? JSON.stringify({ first: 1, last: 1, lines: 2, text: "x\n" }) : '{"first":1,"text":"cut', stderr: "" };
  };
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  assert.deepEqual(v.rows.map((r) => r.text), ["hello", "hi there"]);
  assert.match(v.headerLabel(), /end of the log$/, "a tail is what a shell gives");
  const shell = log.exec.filter((c) => c.cmd === "powershell");
  assert.equal(shell.length, 1, "the shell was the last resort");
  assert.ok(String(shell[0].args).includes("Seek"), "and it read the end of the file");
});

test("a small Pi log is still the app's own read, with no process", async () => {
  log.exec.length = 0;
  fake.props = { agent: "pi", file: "C:\\logs\\small.jsonl" };
  fake.readText = () => piLog();
  fake.exec = async () => ({ code: 1, stdout: "", stderr: "not asked" });
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  assert.deepEqual(v.rows.map((r) => r.text), ["hello", "hi there"]);
  assert.equal(log.exec.length, 0, "neither hc nor a shell was needed");
  assert.equal(v.headerLabel(), "C:\\logs\\small.jsonl", "the whole log, so no note");
});

test("the same window twice is not re-drawn, though its length never changes", async () => {
  fake.props = { agent: "pi", file: "C:\\logs\\huge.jsonl" };
  fake.readText = () => null;
  fake.exec = hcReading(manyLines(3000));
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  const rows = v.rows;
  const before = cx.notified;
  await v.loadFile(cx);
  assert.equal(cx.notified, before, "nothing changed, nothing drawn");
  assert.equal(v.rows, rows);
});

test("a log nobody can read says what it could not read", async () => {
  fake.props = { agent: "pi", file: "C:\\logs\\gone.jsonl" };
  fake.readText = () => null;
  fake.exec = async () => ({ code: 1, stdout: "", stderr: "no such file" });
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  assert.match(v.error, /^Cannot read .*gone\.jsonl/);
  assert.equal(v.rows.length, 0);
});

// The panel's read-only mode: the session log of an agent that keeps no bridge, turned into
// the rows the transcript draws. Codex goes through a process (readCodexTail), the app's fs
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
  machine: null, want: {}, rows: [], localShow: 40, error: null, file: null, textLen: 0, logKind: null, follow: false,
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

test("a Claude session is read from the file, and says where it ran", async () => {
  fake.props = { agent: "claude", cwd: "D:/Projects/demo", file: "C:\\logs\\claude.jsonl" };
  globalThis.__home = "C:\\Users\\someone";
  fake.readText = async () => [
    JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", cwd: "D:\\Projects\\demo", message: { role: "user", content: "fix it" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
  ].join("\n");
  const cx = fakeCx();
  const v = panel();
  await v.loadFile(cx);
  assert.deepEqual(v.rows.map((r) => r.kind), ["user", "assistant"]);
  assert.equal(v.logMeta.cwd, "D:\\Projects\\demo");
  assert.equal(v.headerLabel(), "Claude Code · D:\\Projects\\demo");
  delete fake.readText;
  delete globalThis.__home;
});

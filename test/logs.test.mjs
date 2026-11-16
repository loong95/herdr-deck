// The session logs Claude Code and Codex leave behind, turned into the rows the panel draws.
//
// The fixtures are real lines, shortened: the field names and the noise around them are what
// the formats actually look like (checked against files in ~/.claude/projects and
// ~/.codex/sessions). The last two tests read those folders when they exist — a shape can be
// read wrong once and be right in a fixture for ever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentKind, claudeSlug, claudeEntries, claudeMeta, codexEntries, codexMeta, entriesFor, metaFor } from "../mods/pi-gui/logs.js";
import { buildRows } from "../extensions/pi-gui-bridge/rows.ts";

const jsonl = (...objects) => objects.map((o) => (typeof o === "string" ? o : JSON.stringify(o)));

test("the app name tells the agent", () => {
  assert.equal(agentKind("claude-code"), "claude");
  assert.equal(agentKind("codex"), "codex");
  assert.equal(agentKind("pi"), "pi");
  assert.equal(agentKind("bash"), null);
  assert.equal(agentKind(null), null);
});

test("a Claude project folder is its cwd with dashes", () => {
  assert.equal(claudeSlug("D:\\Projects\\app"), "D--Projects-app");
  assert.equal(claudeSlug("C:\\Users\\winlo"), "C--Users-winlo");
  assert.equal(claudeSlug("/srv/api"), "-srv-api");
});

const CLAUDE = jsonl(
  { type: "queue-operation", operation: "enqueue", sessionId: "s1", content: "Reply with exactly: ok" },
  { type: "attachment", uuid: "at1", cwd: "D:\\Projects\\demo", attachment: { type: "hook_success" } },
  // A real user turn: the message carries a string.
  { type: "user", uuid: "u1", isSidechain: false, cwd: "D:\\Projects\\demo", sessionId: "s1", timestamp: "2026-11-01T00:00:00Z",
    message: { role: "user", content: "fix the parser" } },
  // An assistant turn: thinking, a sentence, and a tool call in one message.
  { type: "assistant", uuid: "a1", isSidechain: false, message: { role: "assistant", content: [
    { type: "thinking", thinking: "look at the parser first" },
    { type: "text", text: "Let me look." },
    { type: "tool_use", id: "tu_1", name: "read", input: { file_path: "src/parse.js" } },
  ] } },
  // The result comes back as a user line with a tool_result block.
  { type: "user", uuid: "u2", isSidechain: false, message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "const x = 1;" }] },
  ] } },
  // A Task subagent's own conversation: not this one.
  { type: "assistant", uuid: "a2", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "sub agent says" }] } },
  { type: "api-request", uuid: "r1" },
  { type: "assistant", uuid: "a3", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "It is fixed." }] } },
);

test("a Claude session becomes the conversation, tool results hung on their call", () => {
  const entries = claudeEntries(CLAUDE);
  assert.deepEqual(entries.map((e) => e.message.role), ["user", "assistant", "toolResult", "assistant"]);
  const rows = buildRows(entries);
  assert.deepEqual(rows.map((r) => r.kind), ["user", "thinking", "assistant", "tool", "assistant"]);
  assert.equal(rows[0].text, "fix the parser");
  assert.equal(rows[1].text, "look at the parser first");
  assert.equal(rows[3].name, "read");
  assert.equal(rows[3].summary, "src/parse.js", "the telling argument is the one on the card");
  assert.equal(rows[3].result, "const x = 1;", "the result is on the card that asked for it");
  assert.equal(rows[4].text, "It is fixed.");
});

test("a Claude session says where it ran", () => {
  assert.deepEqual(claudeMeta(CLAUDE), { cwd: "D:\\Projects\\demo", at: "2026-11-01T00:00:00Z", id: "s1" });
});

const CODEX = jsonl(
  { timestamp: "2026-10-29T01:41:11Z", ordinal: 0, type: "session_meta",
    payload: { id: "th1", timestamp: "2026-10-29T01:41:11Z", cwd: "D:\\Projects\\app", cli_version: "0.165.0" } },
  { timestamp: "t", ordinal: 1, type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "group/model-a" } } },
  // Codex's own instructions: not the conversation.
  { timestamp: "t", ordinal: 2, type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex" }] } },
  { timestamp: "t", ordinal: 3, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "what is this project" }] } },
  { timestamp: "t", ordinal: 4, type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "read the README first" }] } },
  { timestamp: "t", ordinal: 5, type: "response_item", payload: { type: "function_call", name: "find_files", namespace: "mcp__fff",
    arguments: JSON.stringify({ query: "README", maxResults: 20 }), call_id: "call_1" } },
  { timestamp: "t", ordinal: 6, type: "response_item", payload: { type: "function_call_output", call_id: "call_1",
    output: [{ type: "input_text", text: "20/1443 matches" }] } },
  { timestamp: "t", ordinal: 7, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "It is a Windows desktop for pi." }] } },
  { timestamp: "t", ordinal: 8, type: "event_msg", payload: { type: "token_count" } },
);

test("a Codex rollout becomes the conversation, with its tool calls", () => {
  const entries = codexEntries(CODEX);
  const rows = buildRows(entries);
  assert.deepEqual(rows.map((r) => r.kind), ["user", "thinking", "tool", "assistant"]);
  assert.equal(rows[0].text, "what is this project", "the developer message is not the person");
  assert.equal(rows[2].name, "mcp__fff.find_files", "the namespace is part of the name");
  assert.equal(rows[2].summary, "README");
  assert.equal(rows[2].result, "20/1443 matches");
});

test("a Codex session says where, when and on which model", () => {
  assert.deepEqual(codexMeta(CODEX), { cwd: "D:\\Projects\\app", at: "2026-10-29T01:41:11Z", id: "th1", model: "group/model-a" });
});

test("a log that is not JSON, or a kind we do not know, is not fatal", () => {
  assert.deepEqual(claudeEntries(["not json", "", "{}"]), []);
  assert.deepEqual(codexEntries(["not json"]), []);
  assert.equal(entriesFor("pi", []), null, "pi's own JSONL is already in the shape");
  assert.deepEqual(metaFor("pi", []), { cwd: null, at: null, id: null });
});

// --- what the real files look like, when there are any ----------------------

const newestIn = (dir) => {
  let best = null;
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const p = join(at, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".jsonl") && (!best || st.size > best.size)) best = { p, size: st.size };
    }
  };
  if (existsSync(dir)) walk(dir);
  return best;
};

const readLines = (path, limit = 4000) => readFileSync(path, "utf8").split("\n").slice(0, limit);

test("a real Claude Code log turns into rows", (t) => {
  const found = newestIn(join(homedir(), ".claude", "projects"));
  if (!found) return t.skip("no ~/.claude/projects on this machine");
  const entries = claudeEntries(readLines(found.p));
  const rows = buildRows(entries);
  assert.ok(rows.length > 0, "a session with rows: " + found.p);
  assert.ok(rows.some((r) => r.kind === "assistant"), "and answers in it");
  const meta = claudeMeta(readLines(found.p));
  assert.ok(meta.cwd, "the log says which folder it ran in");
});

test("a real Codex rollout turns into rows", (t) => {
  const found = newestIn(join(homedir(), ".codex", "sessions"));
  if (!found) return t.skip("no ~/.codex/sessions on this machine");
  const rows = buildRows(codexEntries(readLines(found.p, 8000)));
  assert.ok(rows.length > 0, "a session with rows: " + found.p);
  assert.ok(rows.some((r) => r.kind === "tool"), "and tool calls in it");
  const meta = codexMeta(readLines(found.p, 20));
  assert.equal(meta.cwd, "D:\\Projects\\app", "the meta line says which folder it ran in");
});

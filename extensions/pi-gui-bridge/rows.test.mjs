// Run with: node --test ~/.pi/agent/extensions/pi-gui-bridge/rows.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRows, callSummary, oneLine, splitMermaid, textOf } from "./rows.ts";

const message = (id, message, parentId = null) => ({ type: "message", id, parentId, message });
const user = (id, text) => message(id, { role: "user", content: [{ type: "text", text }] });
const assistant = (id, content) => message(id, { role: "assistant", content });
const result = (id, toolCallId, text) => message(id, { role: "toolResult", toolCallId, content: [{ type: "text", text }] });

test("textOf joins text blocks and ignores the rest", () => {
  assert.equal(textOf([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(textOf([]), "");
  assert.equal(textOf(undefined), "");
});

test("oneLine collapses whitespace and truncates", () => {
  assert.equal(oneLine("  a\n\n b \t c "), "a b c");
  assert.equal(oneLine("x".repeat(20), 5), "xxxxx…");
  assert.equal(oneLine({ a: 1 }), '{"a":1}');
});

test("callSummary prefers the telling argument", () => {
  assert.equal(callSummary({ command: "ls -la", path: "/tmp" }), "ls -la");
  assert.equal(callSummary({ path: "/tmp/x.ts" }), "/tmp/x.ts");
  assert.equal(callSummary({ query: "needle" }), "needle");
  assert.equal(callSummary({ odd: 1 }), '{"odd":1}');
  assert.equal(callSummary(null), "");
});

test("user and assistant text become rows in branch order", () => {
  const rows = buildRows([user("1", "hi"), assistant("2", [{ type: "text", text: " hello " }])]);
  assert.deepEqual(rows.map((r) => [r.kind, r.text]), [["user", "hi"], ["assistant", "hello"]]);
  assert.deepEqual(rows.map((r) => r.key), ["u1", "a2-0"]);
});

test("thinking rows keep the text and are separate from answers", () => {
  const rows = buildRows([assistant("1", [
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: "answer" },
  ])]);
  assert.deepEqual(rows.map((r) => r.kind), ["thinking", "assistant"]);
  assert.equal(rows[0].text, "hmm");
});

test("a tool call is one card with its result attached", () => {
  const rows = buildRows([
    assistant("1", [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }]),
    result("2", "call_1", "file.txt"),
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { kind: rows[0].kind, name: rows[0].name, summary: rows[0].summary, result: rows[0].result },
    { kind: "tool", name: "bash", summary: "ls", result: "file.txt" },
  );
});

test("a tool call still renders while its result is missing", () => {
  const rows = buildRows([assistant("1", [{ type: "toolCall", id: "call_9", name: "read", arguments: { path: "a.ts" } }])]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, "");
});

test("orphan tool results, system messages and custom entries are skipped", () => {
  const rows = buildRows([
    result("1", "nobody", "ignored"),
    message("2", { role: "system", content: [{ type: "text", text: "sys" }] }),
    { type: "custom", id: "3", customType: "note", data: {} },
    user("4", "kept"),
  ]);
  assert.deepEqual(rows.map((r) => r.text), ["kept"]);
});

test("empty text blocks make no empty rows", () => {
  const rows = buildRows([user("1", "   "), assistant("2", [{ type: "text", text: "  \n " }, { type: "thinking", thinking: "" }])]);
  assert.deepEqual(rows, []);
});

test("maxRows keeps the tail", () => {
  const branch = Array.from({ length: 10 }, (_, i) => user(String(i), "m" + i));
  const rows = buildRows(branch, 3);
  assert.deepEqual(rows.map((r) => r.text), ["m7", "m8", "m9"]);
});

test("splitMermaid pulls fenced diagrams out of the text", () => {
  const text = "before\n\n```mermaid\ngraph TD; A-->B\n```\n\nafter";
  const { text: rest, blocks } = splitMermaid(text);
  assert.deepEqual(blocks, ["graph TD; A-->B"]);
  assert.equal(rest, "before\n\n▤ diagram\n\nafter");
});

test("splitMermaid leaves other fences alone", () => {
  const text = "```js\nconst a = 1;\n```";
  assert.deepEqual(splitMermaid(text), { text, blocks: [] });
});

test("entry ids keep row keys unique across branches", () => {
  const rows = buildRows([user("a", "one"), user("b", "two")]);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
});

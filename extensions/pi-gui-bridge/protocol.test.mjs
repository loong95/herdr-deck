// The bridge's wire: what every answer carries, so a panel can tell this bridge from another
// version of it. Pure, like rows.ts — no server, no Pi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL, CAPABILITIES, shaped, fail } from "./protocol.ts";

test("every object answer carries the protocol, with its own fields after it", () => {
  assert.deepEqual(shaped({ version: 7 }), { version: 7, protocol: PROTOCOL });
  assert.equal(shaped({ protocol: 99, version: 1 }).protocol, PROTOCOL, "ours wins, even over a stray field");
});

test("a non-object body is left alone", () => {
  assert.equal(shaped(null), null);
  assert.equal(shaped("text"), "text");
});

test("an error says what it was, not only how it reads", () => {
  assert.deepEqual(fail("forbidden"), { code: "forbidden", error: "forbidden" });
  assert.deepEqual(fail("busy", "Pi is busy"), { code: "busy", error: "Pi is busy" });
});

test("the capabilities are the routes the panel may expect", () => {
  for (const name of ["state", "rows", "meta", "sessions", "prompt", "diagram"]) assert.ok(CAPABILITIES.includes(name), name);
  assert.equal(new Set(CAPABILITIES).size, CAPABILITIES.length, "no name twice");
});

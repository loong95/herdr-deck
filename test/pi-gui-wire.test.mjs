// The panel's half of the bridge wire: a protocol it did not expect is said out loud, and a
// capability the bridge does not have is not offered.
import { test } from "node:test";
import assert from "node:assert/strict";
import PiGui from "../mods/pi-gui/main.js";
import { fakeCx } from "./fake-cx.mjs";

// The fields init() lays down, without the discovery and timers init() also starts.
const panel = () => Object.assign(new PiGui(), { error: null, wire: null, caps: null, picker: null, bridge: null });

test("the first answer records the protocol and the capabilities, quietly", () => {
  const v = panel();
  v.noteWire({ body: { protocol: 1, capabilities: ["state", "sessions"] } });
  assert.equal(v.wire, 1);
  assert.equal(v.error, null);
  assert.ok(v.can("sessions"));
  assert.equal(v.can("rows"), false, "a capability the bridge did not list is not offered");
});

test("another protocol is a sentence on screen, not a guess", () => {
  const v = panel();
  v.noteWire({ body: { protocol: 7 } });
  assert.equal(v.wire, 7);
  assert.match(v.error, /protocol 7/);
  assert.match(v.error, /panel speaks 1/);
});

test("a bridge that says nothing about itself is assumed to be ours", () => {
  const v = panel();
  v.noteWire({ body: { version: 3, state: {} } });
  assert.equal(v.wire, null);
  assert.equal(v.error, null);
  assert.equal(v.can("sessions"), true, "no list of capabilities: offer everything");
});

test("a reply that is not an object is ignored", () => {
  const v = panel();
  v.noteWire(null);
  v.noteWire({ error: "boom" });
  v.noteWire({ body: null });
  assert.equal(v.wire, null);
  assert.equal(v.error, null);
});

test("opening the session picker on an old bridge says why, and opens nothing", () => {
  const v = panel();
  const cx = fakeCx();
  v.bridge = { port: 1, token: "t" };
  v.caps = new Set(["state", "meta"]);
  v.sessions = [];
  v.filter = { set_value: () => {} };
  v.fileItems = [];
  v.openPicker("session", cx);
  assert.equal(v.picker, null);
  assert.match(v.error, /cannot list sessions/);
  assert.ok(cx.notified > 0, "the panel was asked to redraw");
});

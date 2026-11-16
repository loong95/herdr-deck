// Following a growing transcript. The panel pins itself to the end of the column, not to
// the top of the newest row: a reply still streaming has its first line on screen while its
// newest words land below the fold, and GPUI only scrolls to a child that is out of view.
import { test } from "node:test";
import assert from "node:assert/strict";
import PiGui from "../mods/pi-gui/main.js";
import { byId, calls } from "./stub/base.mjs";
import { fakeCx } from "./fake-cx.mjs";

// The fields init() lays down, without the discovery and the timers init() also starts.
const panel = (rows = [
  { kind: "user", key: "u1", text: "hello" },
  { kind: "assistant", key: "a1", text: "a reply, still growing" },
]) => Object.assign(new PiGui(), {
  machine: null, want: {}, rows: [], older: [], olderFrom: null, localShow: 40,
  error: null, file: null, textSig: "", logKind: null, follow: true, bridge: null,
  picker: null, attachments: [], meta: null, open: {}, diagrams: {},
  input: { on: () => {}, focus: () => {} },
  state: { sessionId: "s1", status: "working", busy: true, total: rows.length, from: 0, rows },
});

// The one element that scrolls: it is the one carrying the ScrollHandle. Own property,
// because the stub answers every other name with a builder.
function scroller(el) {
  if (!el || typeof el !== "object") return null;
  if (Object.hasOwn(el, "track")) return el;
  for (const kid of el.kids ?? []) {
    const found = scroller(kid);
    if (found) return found;
  }
  return null;
}

test("the column ends in a spacer, so following means the bottom of it", () => {
  const v = panel();
  const area = scroller(v.render(fakeCx()));
  assert.ok(area, "the transcript is a scroll area");
  const first = area.kids[0];
  assert.equal(first._a.h, "1px", "a spacer at the visual bottom, with a box to reveal");
  assert.equal((first.kids ?? []).length, 0, "and nothing in it");
  assert.notEqual(area.kids[1], first, "the newest row sits above the spacer, out of its way");
});

test("pinning asks for that spacer — the end — and never for a row", () => {
  const v = panel();
  v.scroll = { scroll_to_item: (index) => calls.push(["scroll_to_item", index]) };
  calls.length = 0;
  v.pinToLatest();
  assert.deepEqual(calls, [["scroll_to_item", 0]], "index 0, the spacer");
});

test("pinning before the first layout is not an error", () => {
  const v = panel();
  v.scroll = null;
  assert.doesNotThrow(() => v.pinToLatest());
});

test("a wheel by hand stops the follow, and says so", () => {
  const v = panel();
  const cx = fakeCx();
  assert.equal(byId(v.render(cx), "pi-latest"), null, "no chip while following");
  scroller(v.render(cx))._h.on_scroll_wheel({ delta: { x: 0, y: 40 } }, cx);
  assert.equal(v.follow, false, "the wheel is a wheel away from the newest row");
  assert.ok(cx.notified > 0, "and the panel redraws with the chip");
  assert.ok(byId(v.render(cx), "pi-latest"), "the ↓ latest chip is up");
});

test("the chip turns the follow back on and jumps to the end", () => {
  const v = panel();
  const cx = fakeCx();
  v.scroll = { scroll_to_item: (index) => calls.push(["scroll_to_item", index]) };
  v.follow = false;
  calls.length = 0;
  byId(v.render(cx), "pi-latest")._h.on_click({}, cx);
  assert.equal(v.follow, true);
  assert.deepEqual(calls, [["scroll_to_item", 0]]);
});

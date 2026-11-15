// Drives the Pi sessions panel outside Herdr, against a real temp sessions tree. The point
// of the panel is what it does NOT read, so most of these checks are call counts: a hidden
// panel reads nothing, a page reads its own rows, and a second look reads nothing again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The bundle this test sits in, so it checks the source next to it rather than whatever
// the running app happens to have loaded. MODS_HOME points it at a live home instead.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = process.env.MODS_HOME ?? ROOT;
const MOD = HOME + "/mods/pi-sessions/main.js";
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-sessions-harness-"));
const FAKE = path.join(SCRATCH, "home");
const SESS = path.join(FAKE, ".pi", "agent", "sessions");

// --- the sessions Pi left behind ---
const DEMO = "D:\\Projects\\demo";
const OTHER = "D:\\Projects\\other";
const CASEY = "D:\\Projects\\casey";
const DEMO_DIR = "--D--Projects-demo--";
const OTHER_DIR = "--D--Projects-other--";
const CASE_DIR = "--D--Projects-Casey--"; // Pi wrote it with another letter case

const stamp = (minute) =>
  new Date(Date.UTC(2026, 10, 1, 0, minute, 0, 0)).toISOString().replace(/:/g, "-").replace(".", "-");
const fileOf = (minute, id) => stamp(minute) + "_" + id + ".jsonl";

function session(minute, id, opts = {}) {
  const at = (m) => new Date(Date.UTC(2026, 10, 1, 0, m, 0, 0)).toISOString();
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: at(minute), cwd: opts.cwd ?? DEMO })];
  const entry = (n, extra) =>
    JSON.stringify(Object.assign({ type: "message", id: "e" + n, parentId: n ? "e" + (n - 1) : null, timestamp: at(minute + n) }, extra));
  if (opts.model) lines.push(JSON.stringify({ type: "model_change", id: "m", parentId: null, timestamp: at(minute), provider: "proxy", modelId: opts.model }));
  lines.push(entry(1, { message: { role: "user", content: opts.ask ?? "Hello there", timestamp: 0 } }));
  if (opts.assistant !== false) {
    lines.push(entry(2, { message: { role: "assistant", content: [{ type: "text", text: "Hi!" }], provider: "proxy", model: "group/model-a", timestamp: 0 } }));
  }
  if (opts.name) lines.push(JSON.stringify({ type: "session_info", id: "n", parentId: "e2", timestamp: at(minute + 3), name: opts.name }));
  return lines.join("\n") + "\n";
}

fs.mkdirSync(path.join(SESS, DEMO_DIR), { recursive: true });
fs.mkdirSync(path.join(SESS, OTHER_DIR), { recursive: true });
fs.mkdirSync(path.join(SESS, CASE_DIR), { recursive: true });

// Sixty sessions in the project the panel starts on: enough that a page is not the list.
const COUNT = 60;
for (let i = 0; i < COUNT; i++) {
  const id = "id" + String(i).padStart(4, "0") + "-1111-2222-3333-444455556666";
  const opts = { cwd: DEMO };
  if (i === COUNT - 1) opts.name = "the newest one";
  if (i === COUNT - 2) opts.name = "named one";
  if (i === COUNT - 3) opts.ask = [{ type: "text", text: "first line\nsecond line" }];
  if (i === COUNT - 4) opts.ask = "   spaced   out   ";
  fs.writeFileSync(path.join(SESS, DEMO_DIR, fileOf(i, id)), session(i, id, opts));
}
// A row that cannot be read: readFile on a directory throws, as it would for a locked file.
fs.mkdirSync(path.join(SESS, DEMO_DIR, fileOf(-1, "broken-0000-0000-0000-000000000000")));
// Two elsewhere, which this panel must never count as this project's.
fs.writeFileSync(path.join(SESS, OTHER_DIR, fileOf(2, "other-2222-3333-4444-555566667777")), session(2, "other", { name: "other project", cwd: OTHER }));
fs.writeFileSync(path.join(SESS, OTHER_DIR, fileOf(3, "other-3333-4444-5555-666677778888")), session(3, "other2", { cwd: OTHER }));
fs.writeFileSync(path.join(SESS, CASE_DIR, fileOf(4, "casey-4444-5555-6666-777788889999")), session(4, "casey", { name: "case insensitive", cwd: CASEY }));

// --- the fake host ---
const STUBS = `
const View = class {};
const el = () => new Proxy({}, { get: (t, k) => (k === "then" ? undefined : () => el()), set: () => true });
const div = el, h_flex = el, v_flex = el;
const join = (...parts) => globalThis.__fs.join(...parts);
const readdir = (dir, opts) => globalThis.__fs.readdir(dir, opts);
const readFile = (file) => globalThis.__fs.readFile(file);
const exec = (cmd, args, opts) => globalThis.__exec(cmd, args, opts);
const readTextFile = (file, opts) => globalThis.__readTextFile(file, opts);
const home = () => globalThis.__home;
const props = () => globalThis.__props || {};
const layout = () => globalThis.__tree;
const spaces = () => globalThis.__spaces;
const panes = () => globalThis.__panes;
const run = (name, args) => { globalThis.__runs.push([name, args]); return null; };
const theme = () => ({
  chrome: "#000", border: "#111", surface: "#222", foreground: "#eee", muted: "#888", dim: "#666",
  raised: "#333", hover: "#444", selected: "#555", solid: "#666", solid_foreground: "#fff",
  done: "#0f0", blocked: "#f00", working: "#ff0", unknown: "#999",
});
`;

let n = 0;
async function loadMod(file, names) {
  let src = fs.readFileSync(file, "utf8").replace(/^import .*$/gm, "").replace("export default class", "class");
  src += "\nglobalThis.__X = { " + names.join(", ") + " };\n";
  const tmp = SCRATCH + "/harness-" + n++ + ".mjs";
  fs.writeFileSync(tmp, STUBS + src);
  await import("file:///" + tmp.replace(/\\/g, "/"));
  return globalThis.__X;
}

let readdirs = [];
let reads = [];
let readDelay = 0; // ms per read, so a test can put the panel away mid-page
const readdir = async (dir, opts) => {
  readdirs.push(dir);
  const list = fs.readdirSync(dir, { withFileTypes: true });
  if (!opts) return list.map((d) => d.name);
  return list.map((d) => ({ name: d.name, isDirectory: () => d.isDirectory() }));
};
const readFile = async (file) => {
  reads.push(path.basename(file));
  if (readDelay) await new Promise((r) => setTimeout(r, readDelay));
  return fs.readFileSync(file, "utf8");
};

// The panel lives in the layout's sidepanel stack, which starts hidden.
const tree = {
  id: "work-body",
  children: [
    { id: "main", type: "block" },
    { id: "sidepanel", type: "stack", hidden: true, active: "gitlab-mr", children: [{ id: "gitlab-mr", type: "block" }, { id: "pi-sessions", type: "block" }] },
    { id: "dock", type: "block" },
  ],
};
const stack = () => tree.children.find((c) => c.id === "sidepanel");

globalThis.__fs = { join: path.join, readdir, readFile };
globalThis.__home = FAKE;
globalThis.__tree = tree;
globalThis.__props = { stack: "sidepanel", node: "pi-sessions" };
globalThis.__runs = [];
globalThis.__spaces = [{ id: "s1", name: "demo", folder: DEMO, machine: null, active: true, tabs: [{ id: "tb1" }] }];
globalThis.__panes = [{ tab: "tb1", pane: "p1", cwd: DEMO, focused: true }];

const { PiSessions, slugOf, ofFile, digest, oneLine, ago, shortModel } = await loadMod(MOD, [
  "PiSessions", "slugOf", "ofFile", "digest", "oneLine", "ago", "shortModel",
]);

let fails = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log("ok   " + label);
  else {
    fails++;
    console.log("FAIL " + label + "\n  got  " + JSON.stringify(got) + "\n  want " + JSON.stringify(want));
  }
};
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const reset = () => { readdirs = []; reads = []; };

let notifies = 0;
const cx = {
  notify: () => { notifies++; },
  focus_handle: () => ({}),
  spawn: (fn) => fn(cx),
  timer: { every: () => ({}), after: () => ({}) },
};

// --- the pure helpers ---
eq("slugOf windows", slugOf(DEMO), DEMO_DIR);
eq("slugOf unix", slugOf("/home/me/app"), "--home-me-app--");
eq("ofFile time", new Date(ofFile(fileOf(7, "abc")).at).toISOString(), "2026-11-01T00:07:00.000Z");
eq("ofFile id", ofFile(fileOf(7, "abc")).id, "abc");
eq("ofFile junk", ofFile("notes.txt"), { name: "notes.txt", id: "", at: 0 });
eq("oneLine squeezes", oneLine("  a \n b  "), "a b");
eq("oneLine cuts", oneLine("abcdef", 5), "abcd…");
eq("ago hours", ago(Date.now() - 3 * 3600e3), "3h");
eq("shortModel", shortModel("proxy/group/model-a"), "model-a");

const full = session(10, "d1", { name: "Refactor auth", model: "group/model-a" });
eq("digest name", digest(full).name, "Refactor auth");
eq("digest preview", digest(full).preview, "Hello there");
eq("digest turns", digest(full).turns, 1);
eq("digest model", digest(full).model, "proxy/group/model-a");
eq("digest at", digest(full).at, Date.UTC(2026, 10, 1, 0, 13, 0, 0));
eq("digest of blocks", digest(session(10, "d2", { ask: [{ type: "text", text: "a\nb" }] })).preview, "a b");
eq("digest of an empty session", digest(session(10, "d3", { ask: "" })).preview, "");
eq("digest of the ends only: no turn count", digest(session(10, "d4"), true).turns, 0);
eq("digest of the ends only: says it is partial", digest(session(10, "d5"), true).partial, true);

// --- a hidden panel asks and reads nothing ---
const p = new PiSessions();
p.init({}, cx);
await settle();
eq("hidden: no listing at all", [readdirs.length, reads.length], [0, 0]);
eq("hidden: nothing on screen yet", p.rows, null);

// --- shown: the list is one readdir, and a page of rows ---
stack().hidden = false;
stack().active = "pi-sessions";
p.tick(cx);
await settle();
eq("shown: lists the project's folder", readdirs[readdirs.length - 1], path.join(SESS, DEMO_DIR));
eq("shown: every session is a row", p.rows.length, COUNT + 1); // + the unreadable one
eq("shown: newest first", p.title(p.rows[0]), "the newest one");
eq("shown: a page, not the whole list", reads.length, 40);
eq("shown: the older ones are not read", p.meta[p.rows[43].name], undefined);
eq("shown: a page is drawn", p.limit, 40);
eq("shown: the header says so", p.where(), "61 sessions · showing 40");

// rows fill in as the digests land: a name, a preview, and the id while it is still blank
eq("row: a name wins over the preview", p.title(p.rows.find((r) => r.id.startsWith("id0058"))), "named one");
eq("row: blocks become one line", p.title(p.rows.find((r) => r.id.startsWith("id0057"))), "first line second line");
eq("row: a preview is squeezed", p.title(p.rows.find((r) => r.id.startsWith("id0056"))), "spaced out");
eq("row: every shown row has a digest", p.rows.filter((r) => p.meta[r.name]).length, 40);

// --- the next page reads only its own rows ---
reset();
p.more(cx);
await settle();
eq("older: the rest of the list, not another page", p.limit, COUNT + 1);
eq("older: reads only the rows it now shows", reads.length, 21);
eq("older: the header counts them", p.where(), "61 sessions");
p.more(cx);
await settle();
eq("older: the unreadable one is the oldest", p.failed[p.rows[p.rows.length - 1].name], true);
const askedOnce = reads.length;
p.fill(cx);
await settle();
eq("older: and is not asked twice", reads.length, askedOnce);

// --- looking again is cheap: no file is read twice ---
reset();
p.at = 0;
p.tick(cx);
await settle();
eq("again: re-lists the folder", readdirs.length, 1);
eq("again: reads no session again", reads.length, 0);

// --- put away in the middle of a page: the reads stop there ---
globalThis.__panes = [{ tab: "tb1", pane: "p1", cwd: OTHER, focused: true }];
p.tick(cx);
await settle(); // on the other project, a page of two
reset();
readDelay = 6;
globalThis.__panes = [{ tab: "tb1", pane: "p1", cwd: DEMO, focused: true }];
p.tick(cx); // back to the sixty: a fresh page, read one slow file at a time
await settle(20);
stack().hidden = true; // the dock puts the panel away
await settle(150); // the batch in hand ends, the loop stops
const stopped = reads.length;
const listed = readdirs.length;
p.tick(cx); // the five-second timer still fires, and does nothing
await settle(150);
eq("put away mid-page: the reads stop there", reads.length, stopped);
eq("put away mid-page: less than the page was read", stopped < 40, true);
eq("put away mid-page: not reading any more", p.reading, false);
eq("put away mid-page: no listing either", readdirs.length, listed);
readDelay = 0;
stack().hidden = false;
p.tick(cx); // shown again: listed again, and the page fills
await settle(500);
eq("shown again: the whole page is filled", p.rows.slice(0, p.limit).filter((r) => p.meta[r.name]).length, 40);

// --- a click opens the session in a tab of its own ---
globalThis.__runs.length = 0;
const newest = p.rows[0];
p.open(newest);
eq("open: a tab with the session file", globalThis.__runs, [
  ["tab.new", { name: "the newest one", folder: DEMO, argv: ["pi", "--session", path.join(SESS, DEMO_DIR, newest.name)] }],
]);

// --- another project in the same space is another list ---
reset();
globalThis.__panes = [{ tab: "tb1", pane: "p1", cwd: OTHER, focused: true }];
eq("other: the rows of the last project are stale at once", [p.stale(), p.where()], [true, "looking…"]);
p.tick(cx);
await settle();
eq("other: the new answer is what is up", p.stale(), false);
eq("other: lists the other folder", readdirs[readdirs.length - 1], path.join(SESS, OTHER_DIR));
eq("other: only its rows", p.rows.length, 2);
eq("other: starts at a page again", p.limit, 40);
eq("other: reads its own rows", reads.length, 2);
eq("other: its own rows, newest first", p.rows.map((r) => p.title(r)), ["Hello there", "other project"]);

// --- a folder Pi never ran in ---
globalThis.__panes = [{ tab: "tb1", pane: "p1", cwd: "D:\\Projects\\never", focused: true }];
p.tick(cx);
await settle();
eq("never: no rows", p.rows, []);
eq("never: says so", p.where(), "No Pi sessions here yet");

// --- a path whose letter case differs from Pi's own ---
reset();
globalThis.__panes = [{ tab: "tb1", pane: "p1", cwd: "D:\\Projects\\casey", focused: true }];
p.tick(cx);
await settle();
eq("case: finds the folder anyway", p.dir, path.join(SESS, CASE_DIR));
eq("case: its row", p.rows.length, 1);
eq("case: named", p.title(p.rows[0]), "case insensitive");
eq("case: one session is singular", p.where(), "1 session");

// --- a space on another machine reads its sessions there ---
const REMOTE_HOME = "/home/lin";
const REMOTE_ROOT = REMOTE_HOME + "/.pi/agent/sessions";
const REMOTE_CWD = "/home/lin/project/app";
const REMOTE_DIR = REMOTE_ROOT + "/--home-lin-project-app--";
const REMOTE_FILE = "2026-11-02T01-00-00-000Z_abcd-1111-2222-3333-444455556666.jsonl";
const remoteSession = session(0, "remote", { name: "from the other computer", cwd: REMOTE_CWD });
let execs = [];
let texts = [];
globalThis.__exec = async (cmd, args, opts) => {
  execs.push([cmd, args, opts]);
  if (cmd === "sh" && args[1] === 'printf %s "$HOME"') return { code: 0, stdout: REMOTE_HOME + "\n", stderr: "" };
  if (cmd === "sh") return { code: 0, stdout: remoteSession, stderr: "" };
  if (cmd === "ls" && args[1] === REMOTE_ROOT) return { code: 0, stdout: "--home-lin-project-app--\n--home-lin-elsewhere--\n", stderr: "" };
  if (cmd === "ls" && args[1] === REMOTE_DIR) return { code: 0, stdout: REMOTE_FILE + "\nnotes.txt\n", stderr: "" };
  return { code: 1, stdout: "", stderr: "ls: no such file or directory" };
};
globalThis.__readTextFile = async (file, opts) => {
  texts.push([file, opts]);
  return null; // the panel must not read megabytes of a session over the wire
};
reset();
globalThis.__spaces = [{ id: "s1", name: "app", folder: REMOTE_CWD, machine: "wsl", active: true, tabs: [{ id: "tb1" }] }];
globalThis.__panes = [{ tab: "tb1", pane: "p1", cwd: REMOTE_CWD, focused: true }];
p.tick(cx);
await settle();
eq("remote: asks the space's machine for its home", execs[0], ["sh", ["-c", 'printf %s "$HOME"'], { on: "wsl", timeout: 20000 }]);
eq("remote: lists Pi's folder there", execs[1], ["ls", ["-1", REMOTE_ROOT], { on: "wsl", timeout: 20000 }]);
eq("remote: the session folder on that machine", p.dir, REMOTE_DIR);
eq("remote: only its sessions, not its other files", p.rows.map((r) => r.name), [REMOTE_FILE]);
eq("remote: reads the ends of the row there", execs[3], [
  "sh",
  ["-c", 'head -c 65536 "$1"; printf "\n@@CUT@@\n"; tail -c 65536 "$1"', "sh", REMOTE_DIR + "/" + REMOTE_FILE],
  { on: "wsl", timeout: 20000 },
]);
eq("remote: the row says what the file says", p.title(p.rows[0]), "from the other computer");
eq("remote: a partial read does not count turns", p.meta[p.rows[0].name].turns, 0);
eq("remote: nothing read on this computer", reads.length, 0);
eq("remote: not through readTextFile either", texts.length, 0);

// --- the same folder seen from another machine is another list ---
globalThis.__spaces = [{ id: "s1", name: "app", folder: REMOTE_CWD, machine: "desktop", active: true, tabs: [{ id: "tb1" }] }];
eq("another machine: the list is stale at once", [p.stale(), p.where()], [true, "looking…"]);
reset();
execs = [];
p.tick(cx);
await settle();
eq("another machine: asks that machine's home", execs[0], ["sh", ["-c", 'printf %s "$HOME"'], { on: "desktop", timeout: 20000 }]);
eq("another machine: lists there", execs[1], ["ls", ["-1", REMOTE_ROOT], { on: "desktop", timeout: 20000 }]);
eq("another machine: the rows belong to it now", [p.stale(), p.title(p.rows[0])], [false, "from the other computer"]);
eq("another machine: its digests start over", Object.keys(p.meta).length, 1);

// --- a listing that fails keeps what is on screen ---
globalThis.__exec = null;
globalThis.__readTextFile = null;
globalThis.__spaces = [{ id: "s1", name: "demo", folder: DEMO, machine: null, active: true, tabs: [{ id: "tb1" }] }];
globalThis.__panes = [{ tab: "tb1", pane: "p1", cwd: DEMO, focused: true }];
p.tick(cx);
await settle();
eq("back here: the local list again", p.rows.length, COUNT + 1);
const before = p.rows.length;
const oldReaddir = globalThis.__fs.readdir;
globalThis.__fs.readdir = async () => { throw new Error("EACCES: permission denied"); };
p.dir = null;
p.dirOf = null;
p.at = 0;
p.tick(cx);
await settle();
eq("failed listing: keeps the rows", p.rows.length, before);
eq("failed listing: says why", p.where(), "EACCES: permission denied");
globalThis.__fs.readdir = oldReaddir;

// --- no folder at all (the space has nowhere to be) ---
globalThis.__spaces = [];
globalThis.__panes = [];
p.dirOf = null;
p.tick(cx);
await settle();
eq("no space: an empty list, not a crash", p.rows.length, 0);

console.log(fails ? "\n" + fails + " failed" : "\nall good");
process.exit(fails ? 1 : 0);

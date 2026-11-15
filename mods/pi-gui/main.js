// Pi GUI: a native chat view for a Pi session, next to its terminal — here or on
// another Herdr machine.
//
// Source of truth is the pi-gui-bridge extension (HTTP on 127.0.0.1, long-polled):
// transcript, model, thinking level, slash commands and @-files all come from
// Pi itself, so the panel never guesses. Without a bridge it falls back to the
// session JSONL, read-only.
// A bridge on this machine or another one: the header says which.
import { View, div, image } from "gpui-kit";
import { markdownView } from "./mdblocks.js";
import { v_flex, h_flex, TextView, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, props, appHome, readTextFile, watchFolder, home, settings, focused, panes, nextCommand, run, closeOverlay, exec, shared, setShared } from "herdr";
import { Buffer } from "buffer";
import { join, dirname } from "path";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";

/**
 * A mod cannot read clipboard images (read_from_clipboard is text only), so the
 * system clipboard is asked for a bitmap and it is saved as a PNG: Pi takes an
 * image content block, and base64 of that file is exactly that.
 */
async function clipboardImagePath() {
  // No platform gate: whichever clipboard tool exists answers. Everything that
  // fails is reported back, so a paste that finds nothing can say why.
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$img = $null;",
    "for ($i = 0; $i -lt 4 -and -not $img; $i++) {",
    "  try { $img = [System.Windows.Forms.Clipboard]::GetImage() } catch {};",
    "  if (-not $img) { Start-Sleep -Milliseconds 60 }",
    "};",
    "if (-not $img) { Write-Error 'clipboard has no bitmap'; exit 3 };",
    "$p = Join-Path $env:TEMP ('pi-gui-paste-' + [guid]::NewGuid().ToString('N').Substring(0,8) + '.png');",
    "$img.Save($p, [System.Drawing.Imaging.ImageFormat]::Png);",
    "Write-Output $p",
  ].join(" ");
  const out = [
    { cmd: "powershell", args: ["-NoProfile", "-STA", "-Command", ps] },
    { cmd: "pwsh", args: ["-NoProfile", "-STA", "-Command", ps] },
    { cmd: "pngpaste", args: [join(home(), "pi-gui-paste.png")] },
  ];
  const reasons = [];
  for (const attempt of out) {
    try {
      const result = await exec(attempt.cmd, attempt.args);
      const path = String(result.stdout || "").trim();
      if (result.code === 0 && path) return { path };
      reasons.push(attempt.cmd + " exit " + result.code + " " + String(result.stderr || "").trim().split(String.fromCharCode(10))[0]);
    } catch (error) {
      reasons.push(attempt.cmd + ": " + String((error && error.message) || error).slice(0, 60));
    }
  }
  return { path: null, reason: reasons.join(" | ") };
}

const TAIL = 400;
// A run in progress draws its own spinner. `frames` swaps the strings natively
// and only while the element is on screen, so no timer of ours and no repaint
// per tick: the panel stays quiet while Pi works.
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function slug(path) {
  // Pi names a folder's sessions after its cwd: separators become "-", and the
  // leading one is dropped (/home/x -> --home-x--, C:\x -> --C--x--).
  return "--" + String(path).replace(/^[\\/]+/, "").replace(/[:\\/]/g, "-") + "--";
}
function normPath(path) { return String(path || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, ""); }

// --- reaching Pi ---------------------------------------------------------
// A bridge answers HTTP on 127.0.0.1 of the machine Pi runs on. On this machine
// that is a plain fetch. On another Herdr machine the same request is one curl
// run there through herdr-core, which already holds the connection, so a remote
// Pi needs no exposed port and no tunnel. Reads of another machine's folders go
// the same way (readTextFile {on}); nothing is copied over by hand.

/** The machine a Herdr id is qualified by ("192.0.2.10/t17" -> "192.0.2.10"). */
function machineOf(id) {
  const text = String(id || "");
  const cut = text.indexOf("/");
  return cut > 0 ? text.slice(0, cut) : null;
}

/** The id as the machine it lives on writes it ("192.0.2.10/t17" -> "t17"). */
function localId(id) {
  const text = String(id || "");
  const cut = text.indexOf("/");
  return cut > 0 ? text.slice(cut + 1) : text;
}

/** base/name with the separator that machine uses (join() would write \\ on Windows). */
function child(base, name) {
  return String(base || "").replace(/[\\/]+$/, "") + "/" + name;
}

function diagramHash(path) {
  const found = /([0-9a-f]+)\.png$/.exec(String(path || ""));
  return found ? found[1] : null;
}

function parseJson(text) {
  try { const value = JSON.parse(String(text || "")); return value && typeof value === "object" ? value : null; } catch { return null; }
}

function firstLine(text) {
  return String(text || "").split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean)[0] || "";
}

// curl prints the status after the body, behind a marker no JSON body carries.
const HTTP_STATUS = "@@HTTP:";
// Windows caps a whole command line at 32 kB, so a body that is bigger than this
// (an image is megabytes) travels as a file instead of as an argument.
const ARG_LIMIT = 20000;
const NL = String.fromCharCode(10);
let uploads = 0;

function quoted(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

/** The same for PowerShell, which doubles a quote instead of ending it. */
function psQuoted(text) {
  return "'" + String(text).replace(/'/g, "''") + "'";
}

/**
 * base64 text in, a file of bytes out, done by the platform's own tool: this
 * host's writeFile takes text (a Uint8Array comes out empty), and a PNG has to
 * arrive as bytes.
 */
async function decodeBase64File(encoded, target) {
  const ps = "[IO.File]::WriteAllBytes(" + psQuoted(target) + ", [Convert]::FromBase64String((Get-Content -Raw -LiteralPath " + psQuoted(encoded) + ")))";
  const unix = "base64 -d < " + quoted(encoded) + " > " + quoted(target) + " || base64 -D < " + quoted(encoded) + " > " + quoted(target);
  for (const attempt of [
    { cmd: "powershell", args: ["-NoProfile", "-Command", ps] },
    { cmd: "pwsh", args: ["-NoProfile", "-Command", ps] },
    { cmd: "sh", args: ["-c", unix] },
  ]) {
    try {
      const result = await exec(attempt.cmd, attempt.args, { timeout: 60000 });
      if (result.code === 0) return true;
    } catch { /* the next tool */ }
  }
  return false;
}

/**
 * Where this panel may write. A mod may write only inside the folders its
 * manifest grants, and those are named relative to the mod's folder — which,
 * installed with -Link, is a junction the app resolves to its real path, so
 * nothing inside it matches. A sibling folder under mods/ is the same file
 * either way, so the cache lives there.
 */
function writeDir(...parts) {
  return join(appHome(), "mods", "pi-gui-cache", ...parts);
}

/**
 * Pipes a body to the other machine with `hc file write`, which takes it on stdin
 * — no command line, no size limit. Returns the file's path there.
 */
async function pushBody(machine, payload) {
  const local = writeDir("upload", "body-" + Date.now() + "-" + (++uploads) + ".json");
  const remote = "/tmp/pi-gui-body-" + Date.now() + "-" + uploads + ".json";
  try {
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, payload);
  } catch {
    return null;
  }
  const win = "Get-Content -Raw -LiteralPath " + psQuoted(local) + " | hc file write --on " + psQuoted(machine) + " " + psQuoted(remote);
  const unix = "cat " + quoted(local) + " | hc file write --on " + quoted(machine) + " " + quoted(remote);
  for (const attempt of [
    { cmd: "powershell", args: ["-NoProfile", "-Command", win] },
    { cmd: "pwsh", args: ["-NoProfile", "-Command", win] },
    { cmd: "sh", args: ["-c", unix] },
  ]) {
    try {
      const result = await exec(attempt.cmd, attempt.args, { timeout: 60000 });
      if (result.code === 0) return remote;
    } catch { /* the next shell */ }
  }
  return null;
}

/** Runs a shell script on another machine; extra args arrive as "$@". */
function shellOn(machine, script, args, timeout) {
  return exec("sh", ["-c", script, "pi-gui", ...args], { on: machine, timeout });
}

/**
 * One HTTP request to a bridge, however this panel can reach it:
 * {method, payload, wait, timeout, binary} -> {status, body | text, error}, where
 * `text` is base64 when `binary`.
 */
async function bridgeCall(machine, url, options) {
  const optionsIn = options || {};
  const method = optionsIn.method === "POST" ? "POST" : "GET";
  const seconds = Math.max(2, Math.round((optionsIn.wait || 0) + 10));
  const timeout = optionsIn.timeout || 40000;
  const target = quoted(url);

  if (!machine) {
    const init = { method };
    if (optionsIn.payload !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(optionsIn.payload);
    }
    try {
      const res = await fetch(url, init);
      if (optionsIn.binary) return { status: res.status, bytes: null, error: null };
      const text = await res.text();
      return { status: res.status, body: parseJson(text), error: null };
    } catch (error) {
      return { status: 0, body: null, error: String((error && error.message) || error) };
    }
  }

  const marker = "-w " + quoted(NL + HTTP_STATUS + "%{http_code}");
  let script;
  const extra = [];
  if (optionsIn.binary) {
    // The bytes are base64 after the status line, so the status comes first.
    script = [
      "f=$(mktemp 2>/dev/null) || f=/tmp/pi-gui-diagram-$$",
      "code=$(curl -sS -m " + seconds + " -o \"$f\" -w '%{http_code}' " + target + ")",
      "printf '" + HTTP_STATUS + "%s\\n' \"$code\"",
      '[ "$code" = "200" ] && base64 < "$f"',
      'rm -f "$f"',
    ].join(NL);
  } else if (optionsIn.payload !== undefined) {
    const payload = JSON.stringify(optionsIn.payload);
    const pushed = payload.length > ARG_LIMIT ? await pushBody(machine, payload) : null;
    if (payload.length > ARG_LIMIT && !pushed) {
      return { status: 0, body: null, error: "Too big to send to " + machine + " (" + Math.round(payload.length / 1024) + " kB)" };
    }
    // Small body: written to a temp file there and posted from it, so no command
    // line ever carries it. Large body: the same, from a file hc put there.
    const source = pushed || "/tmp/pi-gui-body-$$";
    if (!pushed) extra.push(payload);
    script = [
      pushed ? ":" : "f=" + source + "; printf %s \"$@\" > \"$f\"",
      "curl -sS -m " + seconds + " -X POST -H 'content-type: application/json' --data-binary \"@" + (pushed ? source : "$f") + "\" " + marker + " " + target,
      pushed ? 'rm -f "' + source + '"' : 'rm -f "$f"',
    ].join(NL);
  } else {
    script = "curl -sS -m " + seconds + (method === "POST" ? " -X POST" : "") + " " + marker + " " + target;
  }

  let result;
  try {
    result = await shellOn(machine, script, extra, timeout);
  } catch (error) {
    const reason = String((error && error.message) || error).slice(0, 120);
    return { status: 0, body: null, error: "Cannot run a command on " + machine + ": " + reason };
  }
  const out = String(result.stdout || "");
  const why = firstLine(result.stderr);

  if (optionsIn.binary) {
    const cut = out.indexOf(HTTP_STATUS);
    if (cut < 0) return { status: 0, body: null, error: why || "curl exit " + result.code };
    const end = out.indexOf(NL, cut);
    const status = Number(out.slice(cut + HTTP_STATUS.length, end).trim()) || 0;
    if (status !== 200) return { status, body: null, error: why || "HTTP " + status };
    // base64 as it came: turning it into bytes is the platform's job (decodeBase64File).
    return { status, text: out.slice(end + 1).replace(/[^A-Za-z0-9+/=]/g, ""), error: null };
  }

  const cut = out.lastIndexOf(NL + HTTP_STATUS);
  if (cut < 0) return { status: 0, body: null, error: why || "curl exit " + result.code };
  const status = Number(out.slice(cut + 1 + HTTP_STATUS.length).trim()) || 0;
  return { status, body: parseJson(out.slice(0, cut)), error: status ? null : why || "no answer" };
}

function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* a half-written last line */ }
  }
  return out;
}

/** Active branch: last entry, then its ancestors. */
function branch(entries) {
  const byId = new Map();
  let last = null;
  for (const e of entries) { if (e && e.id) { byId.set(e.id, e); last = e; } }
  const chain = [];
  let cur = last;
  const seen = new Set();
  while (cur && cur.id && !seen.has(cur.id)) { seen.add(cur.id); chain.push(cur); cur = cur.parentId ? byId.get(cur.parentId) : null; }
  return chain.reverse();
}

function textOf(blocks) {
  return (blocks || []).filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
}

function oneLine(value, max = 140) {
  let s;
  try { s = typeof value === "string" ? value : JSON.stringify(value ?? {}); } catch { s = String(value); }
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function callSummary(name, args) {
  const a = args && typeof args === "object" ? args : {};
  for (const k of ["command", "path", "file_path", "query", "pattern", "url", "prompt", "script", "description"]) {
    if (typeof a[k] === "string") return oneLine(a[k]);
  }
  return oneLine(a);
}

function buildRows(entries) {
  const results = new Map();
  for (const e of entries) {
    const m = e && e.type === "message" ? e.message : null;
    if (m && m.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, textOf(m.content));
  }
  const rows = [];
  for (const e of branch(entries)) {
    if (!e || e.type !== "message" || !e.message) continue;
    const m = e.message;
    const id = e.id || "e" + rows.length;
    if (m.role === "user") {
      const text = textOf(m.content);
      if (text) rows.push({ key: "u" + id, kind: "user", text });
    } else if (m.role === "assistant") {
      (m.content || []).forEach((b, i) => {
        if (!b) return;
        const key = "a" + id + "-" + i;
        if (b.type === "text" && b.text && b.text.trim()) rows.push({ key, kind: "assistant", text: b.text.trim() });
        else if (b.type === "thinking" && b.thinking && b.thinking.trim()) rows.push({ key, kind: "thinking", text: b.thinking.trim() });
        else if (b.type === "toolCall") rows.push({ key, kind: "tool", name: b.name || "tool", summary: callSummary(b.name, b.arguments), result: results.get(b.id) || "" });
      });
    }
  }
  return rows;
}

/**
 * Runs of process rows (thinking + tool calls) become one collapsed group, so the
 * panel reads as a conversation: answers and questions, with the work folded away.
 */
function groupRows(rows) {
  const groups = [];
  for (const row of rows) {
    const isStep = row.kind === "thinking" || row.kind === "tool";
    const last = groups[groups.length - 1];
    if (!isStep) { groups.push({ kind: "row", key: row.key, row }); continue; }
    if (last && last.kind === "steps") { last.rows.push(row); continue; }
    groups.push({ kind: "steps", key: "steps:" + row.key, rows: [row] });
  }
  return groups;
}

/** "12 steps · codemode ×8, read ×3, +1 · thinking 1.4k" */
function stepsSummary(rows) {
  const tools = new Map();
  let thinking = 0;
  for (const row of rows) {
    if (row.kind === "tool") tools.set(row.name, (tools.get(row.name) || 0) + 1);
    else thinking += String(row.text || "").length;
  }
  const parts = [rows.length + (rows.length === 1 ? " step" : " steps")];
  const names = [...tools.entries()].sort((a, b) => b[1] - a[1]);
  if (names.length) {
    parts.push(names.slice(0, 3).map(([name, n]) => name + " ×" + n).join(", ") +
      (names.length > 3 ? " +" + (names.length - 3) : ""));
  }
  if (thinking) parts.push("thinking " + (thinking >= 1000 ? (thinking / 1000).toFixed(1) + "k" : thinking + " chars"));
  return parts.join("  ·  ");
}

/** A pause that belongs to this view: it dies with the pane that asked for it. */
function sleep(cx, ms) {
  return new Promise((resolve) => { cx.timer.after(ms, () => resolve()); });
}

/**
 * The pane list a mod reads is the host's *last snapshot*, not the window: a
 * pane.split that was just issued is not in it yet. Waiting for the change it
 * asked for is the difference between "the panel fills the tab" and "the panel
 * ended up as a split beside the terminal" — the right-click bug this replaced,
 * which happened whenever the guess (one command per 260 ms tick) came up short.
 * A deadline answers null instead of hanging, so the overlay always closes.
 */
async function waitFor(cx, done, ms) {
  const until = Date.now() + (ms || 4000);
  for (;;) {
    const hit = done();
    if (hit) return hit;
    if (Date.now() >= until) return null;
    await sleep(cx, 40);
  }
}

/**
 * Focus a pane and leave it alone in its tab.
 *
 * `pane.focus` already moves the tab's zoom to the pane it focuses — measured,
 * not assumed: with the terminal zoomed, focusing the panel moves `zoomed` from
 * the terminal to the panel. So a tab that was zoomed on the *other* pane needs
 * nothing more, and a `pane.zoom` on top of that would toggle the zoom back off
 * — which is exactly the split a right-click used to be left with. Only a tab
 * zoomed on nothing gets the extra call.
 */
async function showOnly(cx, pane) {
  const mine = panes().find((p) => p.pane === pane) || null;
  const zoomed = mine ? panes().find((p) => p.tab === mine.tab && p.zoomed === true) || null : null;
  run("pane.focus", { pane });
  if (!zoomed) run("pane.zoom", { pane });
  await waitFor(cx, () => (panes().find((p) => p.pane === pane) || {}).zoomed === true, 1500);
}

/** …and back to the whole split, for the pane whose zoom is in the way. */
async function zoomOff(cx, pane) {
  run("pane.zoom", { pane });
  await waitFor(cx, () => (panes().find((p) => p.pane === pane) || {}).zoomed !== true, 1500);
}

/** Split the panel in beside the clicked pane, then let it have the tab. */
async function splitPanel(cx, tab, target, anchor) {
  // A tab that already has one keeps it: two panels in a tab are two copies of
  // the same conversation, and the second one is never the one asked for.
  let gui = panes().find((p) => p.mod === "pi-gui" && p.tab === tab) || null;
  if (!gui) {
    run("pane.split", { direction: "right", ...(anchor ? { pane: anchor } : {}), mod: "pi-gui", props: target });
    gui = await waitFor(cx, () => panes().find((p) => p.mod === "pi-gui" && p.tab === tab), 5000);
  }
  if (gui) await showOnly(cx, gui.pane);
}

/**
 * What to run to swap the terminal and the panel in one tab. pane.zoom means
 * "show only this pane, or all again", so going from one zoomed pane to the
 * other is unzoom, then zoom.
 */
function swapSteps(tab, target, anchor) {
  const tabPanes = panes().filter((p) => p.tab === tab);
  const gui = tabPanes.find((p) => p.mod === "pi-gui") || null;
  const term = tabPanes.find((p) => p.terminal) || null;
  const steps = [];
  if (term && term.zoomed === true) {
    steps.push((cx) => zoomOff(cx, term.pane).then(() => splitPanel(cx, tab, target, anchor)));
  } else if (gui && gui.zoomed === true) {
    steps.push((cx) => zoomOff(cx, gui.pane));
    steps.push((cx) => (term ? showOnly(cx, term.pane) : null));
  } else if (gui) {
    steps.push((cx) => showOnly(cx, gui.pane));
  } else if (target && target.terminal) {
    steps.push((cx) => splitPanel(cx, tab, target, anchor));
  }
  return steps;
}

/**
 * A right-click asks for the panel, not for the key's swap: show the pane this
 * tab already has, or split one in beside the pane that was clicked, and never
 * move the panel out of the way.
 */
function showSteps(tab, target, anchor) {
  const tabPanes = panes().filter((p) => p.tab === tab);
  const gui = tabPanes.find((p) => p.mod === "pi-gui") || null;
  const term = tabPanes.find((p) => p.terminal) || null;
  const steps = [];
  if (gui) {
    steps.push((cx) => showOnly(cx, gui.pane));
  } else {
    // A zoomed terminal leaves no room to split into: show the whole tab first.
    if (term && term.zoomed === true) steps.push((cx) => zoomOff(cx, term.pane));
    steps.push((cx) => splitPanel(cx, tab, target, anchor));
  }
  return steps;
}

/** One step at a time; a step may wait for the host to catch up. */
async function runSteps(cx, steps) {
  for (const step of steps) await step(cx);
}

export default class PiGui extends View {
  init(_props, cx) {
    // Key trampoline. A key cannot pass props to a mod pane, so ctrl-alt-p runs
    // "mod.open:pi-gui": this copy opens as an overlay and immediately becomes a
    // real pane beside the focused terminal — or focuses the pane this tab already
    // has, instead of showing a second one.
    const overlay = (props() || {}).overlay;
    if (overlay) {
      // mod.open carries no props, and a right-click does not have to move the
      // focus, so the terminal-menu row leaves the pane it was clicked on in
      // shared(). A key press leaves nothing, and there the focused pane is the
      // one meant. The note is used once: it is cleared as soon as it is read.
      const asked = shared("pi-gui.target");
      const fresh = asked && typeof asked.at === "number" && Date.now() - asked.at < 15000 ? asked : null;
      if (fresh) setShared("pi-gui.target", null);
      const here = focused();
      const clicked = fresh && fresh.pane ? panes().find((p) => p.pane === fresh.pane) || null : null;
      const tab = clicked ? clicked.tab : here && here.tab ? here.tab : null;
      const tabPanes = panes().filter((p) => p.tab === tab);
      const gui = tabPanes.find((p) => p.mod === "pi-gui") || null;
      const terminal = (fresh && fresh.terminal) || (clicked && clicked.terminal) || (here && here.terminal) || null;
      const target = { terminal, cwd: (fresh && fresh.cwd) || (clicked && clicked.cwd) || (here && here.cwd) || null };
      const anchor = clicked ? clicked.pane : null;
      // The terminal this tab shows: the focused one when the terminal has the
      // keyboard, else the tab's own terminal pane.
      const termPane = here && here.terminal && here.pane
        ? here.pane
        : ((tabPanes.find((p) => p.terminal) || {}).pane || null);

      // One at a time, with no zoom to reason about: the side that is not shown
      // has no pane at all. The terminal keeps running while parked, and the GUI
      // pane is cheap to close and reopen, so both directions are one observable
      // fact — does this tab have a terminal pane?
      const termInfo = tabPanes.find((p) => p.terminal) || null;
      if (!terminal && !gui) return; // nothing here to swap with

      // A click names its pane; a key press does not, and there the focused tab's
      // own state decides (that is the swap).
      const steps = fresh && fresh.pane ? showSteps(tab, target, anchor) : swapSteps(tab, target, anchor);
      if (!steps.length) return; // nothing to swap with: leave the overlay as it is
      this.trampoline = true;
      // The overlay leaves once the steps have really landed, not on a clock; the
      // guard is only for a host that stops answering, so it can never stay up.
      const guard = cx.timer.after(9000, () => closeOverlay(overlay));
      cx.spawn(async (cx) => {
        try { await runSteps(cx, steps); } finally {
          try { guard.cancel(); } catch {}
          closeOverlay(overlay);
        }
      });
      return;
    }

    this.bridge = null;
    this.state = null;
    this.meta = null;
    this.version = -1;
    this.rows = [];
    this.file = null;
    this.textLen = 0;
    this.open = {};
    this.picker = null;          // {kind: "model"|"thinking"|"command"|"file"|"session", filter}
    this.fileItems = [];
    this.sessions = [];
    this.error = null;
    this.sending = false;
    this.watching = false;
    this.searchToken = 0;
    this.attachments = [];       // pasted images, sent as image content blocks
    this.older = [];             // earlier rows, fetched on demand
    this.olderFrom = null;       // index of the oldest row this panel holds
    this.localShow = 40;         // fallback mode: how much of the tail to show
    this.bound = false;          // a live bridge answered
    this.want = { terminal: null, cwd: null, session: null };  // what this panel is for
    this.scan = null;            // what the last look at a machine's registrations found
    this.machine = null;         // the Herdr machine Pi runs on (null: this computer)
    this.remoteHome = null;      // its home folder, asked once
    this.diagrams = {};          // hash -> path here, or null when asked (remote PNGs)
    this.scroll = ScrollHandle.new();
    this.follow = true;          // keep the newest row in view until you scroll away
    this.handle = cx.focus_handle();

    this.input = InputState.new({ placeholder: "Message Pi…  / for commands, @ for files" });
    this.input.on("change", (_e, cx) => this.onCompose(cx));
    this.input.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.input.on("submit", (_e, cx) => this.send(cx));

    this.filter = InputState.new({ placeholder: "Filter…" });
    this.filter.on("change", (_e, cx) => {
      if (!this.picker) return;
      this.picker.filter = this.filter.value();
      if (this.picker.kind === "file") this.searchFiles(cx);
      cx.notify();
    });
    this.filter.on("submit", (_e, cx) => {
      const items = this.pickerItems();
      if (items.length) this.choose(items[0], cx);
    });

    // Debug/shortcut: attach an image at start, e.g. props {"attach":"C:/shot.png"}.
    const attachWith = (props() || {}).attach;
    if (attachWith) cx.timer.after(300, (cx) => this.attach(String(attachWith), cx));

    // Debug/shortcut: open with a picker already up, e.g. props {"open":"model"}.
    const openWith = (props() || {}).open;
    if (openWith) this.picker = { kind: String(openWith), filter: "", driven: false };

    // A chat panel wants the keyboard: opening it means you are about to type.
    cx.timer.after(400, () => this.input.focus());
    this.discover(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        // The app hands a command to every copy on screen, so two panels would both swap,
        // both paste. The first one acts; the others see it here and skip it.
        const last = shared("pi-gui.command");
        const now = Date.now();
        if (last && last.command === command && now - last.at < 150) continue;
        setShared("pi-gui.command", { command, at: now });
        if (command === "focus") {
          // Coming in through ctrl-alt-p: if this copy is bound to a Pi in another
          // tab (the only bridge that was alive at the time), look again now.
          const here = focused();
          const away = here && here.tab && this.bridge && this.bridge.tab && localId(this.bridge.tab) !== localId(here.tab);
          const moved = machineOf(here && here.tab) !== this.machine;
          if (this.bridge && (away || moved)) this.discover(cx);
          this.input.focus();
          cx.notify();
        } else if (command === "paste") {
          this.pasteImage(cx);      // same as Ctrl+V with a screenshot on the clipboard
        } else if (command === "terminal") {
          this.showTerminal(cx);   // same as the header's "⇤ Terminal"
        } else if (command === "toggle") {
          // "herdr-app do pi-gui.toggle" (or a key bound to it): swap views.
          const here = focused();
          const tab = here && here.tab ? here.tab : null;
          runSteps(cx, swapSteps(tab, {
            terminal: (here && here.terminal) || this.address(this.bridge && this.bridge.terminal) || null,
            cwd: (here && here.cwd) || null,
          }));
        }
      }
    });
  }

  // --- connection ---------------------------------------------------------

  /**
   * The machine this panel is about: props.machine when given, else the machine
   * of the terminal it was opened for, else the machine of its own tab (a panel
   * in a space on another computer is drawn here, and so is its data).
   */
  targetMachine() {
    const given = props() || {};
    if (given.machine) return String(given.machine);
    const asked = machineOf(given.terminal);
    if (asked) return asked;
    const mine = given.pane ? panes().find((pane) => pane.pane === given.pane) : null;
    if (mine) return machineOf(mine.tab);
    const here = focused();
    return here ? machineOf(here.tab) : null;
  }

  /** A terminal as Herdr's commands name it: qualified when it lives elsewhere. */
  address(terminal) {
    if (!terminal) return terminal;
    return this.machine && !machineOf(terminal) ? this.machine + "/" + terminal : terminal;
  }

  /** ~/.pi/agent/<kind> on the machine this panel looks at. */
  async piDir(kind) {
    if (!this.machine) return join(home(), ".pi", "agent", kind);
    return child(await this.homeOf(), ".pi/agent/" + kind);
  }

  /** base/name in that machine's own separator. */
  sub(base, name) {
    return this.machine ? child(base, name) : join(base, name);
  }

  /** Another machine's home folder, asked once. */
  async homeOf() {
    if (this.remoteHome) return this.remoteHome;
    try {
      const result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.machine, timeout: 15000 });
      this.remoteHome = String(result.stdout || "").trim() || "/";
    } catch {
      this.remoteHome = "/";
    }
    return this.remoteHome;
  }

  /** One folder's names: read here, or listed over there. */
  async listNames(dir) {
    if (!this.machine) {
      try { return await readdir(dir); } catch { return []; }
    }
    try {
      const result = await shellOn(this.machine, 'ls -1 "$1" 2>/dev/null', [dir], 20000);
      return String(result.stdout || "").split(NL).map((name) => name.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** One request to this panel's bridge, wherever it runs. */
  call(bridge, path, options) {
    const url = "http://127.0.0.1:" + bridge.port + path + (path.includes("?") ? "&" : "?") + "t=" + bridge.token;
    return bridgeCall(bridge.machine || null, url, options || {});
  }

  /**
   * Every registration on one machine: files in a folder here, or one shell that
   * prints them all over there, so a look costs one round trip either way.
   */
  async registrations(machine) {
    const out = [];
    if (!machine) {
      const dir = await this.piDir("gui");
      let names = [];
      try { names = (await readdir(dir)).filter((name) => name.endsWith(".json")); } catch {}
      for (const name of names) {
        // A Pi that just shut down unlinks its own file: a name from the listing
        // can be gone by the time it is read, and that must not fail the look.
        let text = null;
        try { text = await readTextFile(join(dir, name)); } catch { continue; }
        const info = parseJson(text);
        if (info) out.push(info);
      }
      return { list: out, error: null };
    }
    const script = [
      'd="$HOME/.pi/agent/gui"',
      'for f in "$d"/*.json; do',
      '  [ -f "$f" ] || continue',
      '  printf "' + NL + '@@REG %s' + NL + '" "$(basename "$f")"',
      '  cat "$f"',
      '  printf "' + NL + '"',
      'done',
    ].join(NL);
    let text = "";
    try {
      const result = await shellOn(machine, script, [], 25000);
      text = String(result.stdout || "");
    } catch (error) {
      const reason = String((error && error.message) || error).slice(0, 120);
      return { list: out, error: "Cannot reach " + machine + ": " + reason };
    }
    for (const block of text.split(NL + "@@REG ").slice(1)) {
      const cut = block.indexOf(NL);
      const info = parseJson(cut < 0 ? "" : block.slice(cut + 1));
      if (info) out.push(info);
    }
    return { list: out, error: null };
  }

  /**
   * Prefer the bridge bound to props().terminal, else the Pi in this tab, else
   * this folder — on the machine this pane is about.
   */
  discover(cx) {
    // One look at a time: a focus, a lost bridge and the 3 s retry can all ask
    // at once, and three probes of the same dead port help nobody.
    if (this.looking) return;
    this.looking = true;
    cx.spawn(async (cx) => {
      try {
        await this.look(cx);
      } catch (error) {
        // A look that throws used to leave the panel on "Loading…" for ever: no
        // scan, no retry, and nothing on screen to say why. Say it, and keep
        // looking — the next look may be the one that answers.
        const why = String((error && error.message) || error).slice(0, 160);
        if (!this.scan) this.scan = { machine: this.machine, registrations: 0, matching: 0, alive: 0, error: why };
        this.error = "Cannot look for Pi" + this.why() + ": " + why;
        cx.notify();
      } finally {
        this.looking = false;
        // A Pi can start any time after this pane opened, and a look can fail:
        // keep looking either way while nothing answers.
        if (!this.bound) cx.timer.after(3000, (cx) => { if (!this.bound) this.discover(cx); });
      }
    });
  }

  /** The look itself: registrations on that machine, best match, bind or fall back. */
  async look(cx) {
    const machine = this.targetMachine();
    this.machine = machine;
    const given = props() || {};
    const wantTerminal = localId(this.want.terminal || given.terminal || "");
    const wantSession = this.want.session || given.session || null;
    const cwd = normPath(given.cwd || (focused() && focused().cwd) || "");
    // Our own tab, not the focused one: a pane split in beside another terminal
    // is bound before it has the keyboard, so focus still names the neighbour.
    const mine = given.pane ? panes().find((pane) => pane.pane === given.pane) || null : null;
    const ctxTab = localId((mine && mine.tab) || (focused() && focused().tab));
    // A tab whose terminal was closed has nothing for the panel to bind to.
    // Telling that apart from "Pi is not running yet" is the difference between
    // an explanation and a panel that waits for ever.
    this.tabHasTerminal = panes().some((pane) => localId(pane.tab) === ctxTab && pane.terminal);
    // Bounded here, not in the host: a machine's exec or a folder read can hang
    // past its own timeout, and an await that never returns is a panel stuck on
    // "Loading…" with no retry (the catch only covers what throws). Losing the
    // race leaves the look running; its answer is simply ignored.
    const found = await Promise.race([
      this.registrations(machine),
      sleep(cx, 8000).then(() => ({ list: [], error: "the registration folder did not answer in 8 s" })),
    ]);
    const ranked = [];
    for (const info of found.list) {
      if (!info.port || !info.token) continue;
      let score = 0;
      // A terminal named in props is what the panel was opened for; the tab is a
      // guess by comparison, so it can break a tie but never overrule the name.
      if (wantTerminal && localId(info.terminal) === wantTerminal) score += 500;
      else if (ctxTab && localId(info.tab) === ctxTab) score += 300;
      if (wantSession && info.sessionId === wantSession) score += 50;
      if (cwd && normPath(info.cwd) === cwd) score += 20;
      ranked.push({ info: { ...info, machine }, score });
    }
    // A registration can outlive a force-killed Pi: take the best one that answers.
    // A score of 0 means "nothing about this panel matches it", so it is only
    // used when it is the only Pi on that machine — never to hijack another
    // folder's or another tab's session.
    ranked.sort((a, b) => b.score - a.score);
    const matches = ranked.filter((candidate) => candidate.score > 0);
    const pool = matches.length ? matches : ranked.length === 1 ? ranked : [];
    this.scan = { machine, registrations: ranked.length, matching: matches.length, alive: 0, error: found.error };
    for (const candidate of pool) {
      const body = await this.probe(candidate.info);
      if (body === null) continue;
      this.bridge = candidate.info;
      this.bound = true;
      this.follow = true;      // a fresh bind shows the newest row again
      this.want = {
        terminal: candidate.info.terminal || this.want.terminal,
        cwd: candidate.info.cwd || this.want.cwd,
        session: candidate.info.sessionId || this.want.session,
      };
      this.scan.alive += 1;
      this.file = candidate.info.sessionFile || null;
      this.error = null;
      if (body && body.state) { this.state = body.state; this.version = body.version; }
      this.refreshMeta(cx, candidate.info);
      this.poll(cx, candidate.info);
      this.collectDiagrams(cx);
      if (this.picker && this.picker.kind === "file") this.searchFiles(cx);
      if (this.picker && this.picker.kind === "session") this.loadSessions(cx);
      cx.notify();
      return;
    }
    this.bridge = null;
    await this.loadFile(cx);
    if (!this.watching) {
      this.watching = true;
      // A folder on this computer can be watched; one on another machine cannot.
      if (machine) this.watchRemote(cx);
      else { this.watchFile(cx); this.watchBridges(cx); }
    }
  }

  /**
   * The registration folder tells us the moment a Pi appears or a stale entry is
   * rewritten, so an unbound panel binds without polling. This computer only:
   * another machine's folder has no watch, so that one is looked at again.
   */
  watchBridges(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const dir = await this.piDir("gui");
        await watchFolder(dir);
        if (this.bridge) {
          // Still bound: only care if our own registration went away.
          const still = await readTextFile(join(dir, String(this.bridge.sessionId) + ".json"));
          if (still) continue;
        }
        this.discover(cx);
      }
    });
  }

  /** A remote folder cannot be watched, so the session file is read again. */
  watchRemote(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((done) => cx.timer.after(3000, () => done()));
        if (this.bridge) continue;         // bound: the long poll carries the news
        await this.loadFile(cx);
      }
    });
  }

  /**
   * Rows from a bridge on another machine carry PNGs rendered there, which this
   * machine cannot draw: they are fetched once and kept beside the local cache.
   */
  collectDiagrams(cx) {
    if (!this.machine) return;           // this machine's PNGs are where image() looks
    const rows = (this.state && this.state.rows) || [];
    for (const row of rows.concat(this.older)) {
      for (const path of Array.isArray(row.diagrams) ? row.diagrams : []) {
        const hash = diagramHash(path);
        if (!hash || hash in this.diagrams) continue;
        this.diagrams[hash] = null;    // asked; a path or null lands here
        this.fetchDiagram(hash, cx);
      }
    }
  }

  fetchDiagram(hash, cx) {
    const bridge = this.bridge;
    if (!bridge) return;
    // image() reads from the app's own folder, so the path kept here is relative to it.
    const target = "mods/pi-gui-cache/mermaid/" + hash + ".png";
    const png = writeDir("mermaid", hash + ".png");
    cx.spawn(async (cx) => {
      const reply = await this.call(bridge, "/diagram?hash=" + hash, { binary: true, timeout: 60000 });
      if (this.bridge !== bridge || !reply.text) return;
      try {
        await mkdir(dirname(png), { recursive: true });
        await writeFile(png + ".b64", reply.text);
        if (!await decodeBase64File(png + ".b64", png)) throw new Error("no tool to write " + png);
        this.diagrams[hash] = target;
        cx.notify();
      } catch (error) {
        this.error = "Cannot keep a diagram here: " + String((error && error.message) || error);
        cx.notify();
      }
    });
  }

  /** The PNGs this panel can draw for a row. */
  diagramPaths(row) {
    const paths = Array.isArray(row.diagrams) ? row.diagrams : [];
    if (!this.machine) return paths;
    const here = [];
    for (const path of paths) {
      const kept = this.diagrams[diagramHash(path)];
      if (typeof kept === "string") here.push(kept);
    }
    return here;
  }

  /** One screenful of older rows, either from the bridge or from the loaded JSONL. */
  loadOlder(cx) {
    if (!this.bridge) { this.localShow += 40; cx.notify(); return; }
    const before = this.olderFrom == null ? 0 : this.olderFrom;
    if (!before) return;
    const bridge = this.bridge;
    cx.spawn(async (cx) => {
      const reply = await this.call(bridge, "/rows?before=" + before + "&count=40", { timeout: 40000 });
      if (this.bridge !== bridge) return;
      const body = reply.body;
      if (!body) {
        this.error = "Could not load earlier rows" + this.why() + (reply.error ? " — " + reply.error : "");
        cx.notify();
        return;
      }
      this.older = (body.rows || []).concat(this.older);
      this.olderFrom = typeof body.from === "number" ? body.from : 0;
      this.follow = false;
      this.collectDiagrams(cx);
      cx.notify();
    });
  }

  /** " on 192.0.2.10" — where Pi runs, when it is not here. */
  why() {
    return this.machine ? " on " + this.machine : "";
  }

  /** One cheap request: the snapshot if this bridge is alive, else null. */
  async probe(info) {
    // Short: a bridge that is listening but wedged must not hold the whole look
    // (and the panel's "Loading…") for twenty seconds per candidate.
    const reply = await this.call(info, "/state?since=-1&wait=0", { timeout: 5000 });
    if (reply.status === 204) return {};
    if (reply.status !== 200 || !reply.body) return null;
    return reply.body;
  }

  /** Long-poll the snapshot; one request in flight, no timers. */
  poll(cx, bridge) {
    cx.spawn(async (cx) => {
      for (;;) {
        let body;
        const reply = await this.call(bridge, "/state?since=" + this.version + "&wait=25&rows=40", { wait: 25, timeout: 45000 });
        if (this.bridge !== bridge) return;
        if (reply.status === 204) continue;
        body = reply.status === 200 ? reply.body : null;
        if (!body) {
          this.bridge = null;
          this.bound = false;
          this.error = "Pi bridge" + this.why() + " lost" + (reply.error ? " (" + reply.error + ")" : "") + " — looking for it again";
          cx.notify();
          cx.timer.after(2500, (cx) => { if (!this.bridge) this.discover(cx); });
          return;
        }
        if (body && body.state) {
          const previous = this.state && this.state.sessionId;
          if (previous && body.state.sessionId !== previous) { this.older = []; this.olderFrom = null; this.localShow = 40; }
          this.state = body.state;
          this.version = body.version;
          if (!this.older.length) this.olderFrom = body.state.from;
          this.error = null;
          this.collectDiagrams(cx);
          if (this.follow) this.pinToLatest();
          cx.notify();
        }
      }
    });
  }

  refreshMeta(cx, bridge) {
    const target = bridge || this.bridge;
    if (!target) return;
    cx.spawn(async (cx) => {
      const reply = await this.call(target, "/meta", { timeout: 25000 });
      if (this.bridge !== target || !reply.body) {
        if (reply.error) { this.error = "Pi meta failed" + this.why() + ": " + reply.error; cx.notify(); }
        return;
      }
      this.meta = reply.body;
      cx.notify();
    });
  }

  async loadFile(cx) {
    const path = props().file || await this.latest();
    if (!path) { this.error = "No Pi session" + this.why() + " for this folder"; cx.notify(); return; }
    if (path !== this.file) { this.file = path; this.textLen = 0; }
    const text = await readTextFile(path, { on: this.machine || null });
    if (text == null) { this.error = "Cannot read " + path + this.why(); cx.notify(); return; }
    if (text.length === this.textLen) return;
    this.textLen = text.length;
    this.rows = buildRows(parseJsonl(text));
    this.error = null;
    if (this.follow) this.pinToLatest();
    cx.notify();
  }

  async latest() {
    const root = await this.piDir("sessions");
    const dirs = await this.listNames(root);
    if (!dirs.length) return null;
    const cwd = props().cwd || (focused() && focused().cwd) || "";
    const want = cwd ? slug(cwd) : "";
    const tail = cwd ? String(cwd).split(/[\\/]/).filter(Boolean).slice(-2).join("-").replace(/:/g, "-") : "";
    const ordered = want && dirs.includes(want) ? [want] : [...dirs].sort((a, b) => {
      const sa = tail && a.includes(tail) ? 1 : 0, sb = tail && b.includes(tail) ? 1 : 0;
      return sb - sa || (a < b ? 1 : -1);
    }).slice(0, 6);
    let best = null;
    for (const d of ordered) {
      if (want && d !== want && !(tail && d.includes(tail))) continue;
      const dir = this.sub(root, d);
      const files = (await this.listNames(dir)).filter((f) => f.endsWith(".jsonl")).sort();
      const newest = files[files.length - 1];
      if (newest && (!best || newest > best.name)) best = { name: newest, path: this.sub(dir, newest) };
    }
    return best ? best.path : null;
  }

  watchFile(cx) {
    cx.spawn(async (cx) => {
      const root = await this.piDir("sessions");
      for (;;) {
        await watchFolder(root);
        if (this.bridge) return;
        await this.loadFile(cx);
      }
    });
  }

  // --- bridge actions -----------------------------------------------------

  /** A POST to the bridge: {error} instead of a body when it did not answer. */
  post(path, payload, cx) {
    const bridge = this.bridge;
    if (!bridge) return Promise.resolve(null);
    return this.call(bridge, path, { method: "POST", payload, timeout: 90000 })
      .then((reply) => reply.body || (reply.error ? { error: reply.error } : null));
  }

  send(cx) {
    // Enter completes an open picker instead of sending.
    if (this.picker) {
      const items = this.pickerItems();
      if (items.length) { this.choose(items[0], cx); return; }
      this.picker = null;
    }
    const message = String(this.input.value() || "").trim();
    const images = this.attachments.map((a) => ({ data: a.data, mimeType: a.mimeType }));
    if ((!message && !images.length) || !this.bridge) return;
    // "/model", "/compact" and friends are handled here: Pi's own TUI-level
    // commands would not run through a prompt.
    const builtin = /^\/([a-z-]+)\s*$/.exec(message);
    if (builtin && ["model", "thinking", "compact", "stop"].includes(builtin[1])) {
      this.input.set_value("");
      return this.runCommand(builtin[1], cx);
    }
    this.input.set_value("");
    this.attachments = [];
    this.sending = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const reply = await this.post("/prompt", images.length ? { message, images } : { message }, cx);
      if (reply && reply.error) this.error = "Send failed: " + reply.error;
      this.sending = false;
      cx.notify();
    });
  }

  abort(cx) {
    cx.spawn(async (cx) => {
      await this.post("/abort", undefined, cx);
      cx.notify();
    });
  }

  // --- pickers ------------------------------------------------------------

  openPicker(kind, cx) {
    if (!this.bridge) return;
    this.picker = { kind, filter: "", driven: false };
    this.fileItems = [];
    this.sessions = [];
    this.filter.set_value("");
    cx.notify();
    this.refreshMeta(cx);
    if (kind === "file") this.searchFiles(cx);
    if (kind === "session") this.loadSessions(cx);
  }

  /** Sessions of this folder, newest first, for the session picker. */
  loadSessions(cx) {
    const bridge = this.bridge;
    if (!bridge) return;
    cx.spawn(async (cx) => {
      try {
        const reply = await this.call(bridge, "/sessions", { timeout: 40000 });
        if (this.bridge !== bridge) return;
        if (!reply.body) {
          this.sessions = [];
          this.error = "Session list failed" + this.why() + (reply.error ? ": " + reply.error : "");
          cx.notify();
          return;
        }
        this.sessions = reply.body.sessions || [];
        cx.notify();
      } catch (error) {
        this.sessions = [];
        this.error = "Session list failed" + this.why();
        cx.notify();
      }
    });
  }

  closePicker(cx) {
    this.picker = null;
    this.input.focus();
    cx.notify();
  }

  /**
   * The "/" or "@" word being typed at the end of the composer, if any.
   * The composer is the picker's filter: typing refines, deleting closes.
   */
  tokenAt(text) {
    const m = /(^|\s)([/@])([^\s]*)$/.exec(String(text || ""));
    if (!m) return null;
    return { kind: m[2] === "/" ? "command" : "file", query: m[3], start: m.index + m[1].length };
  }

  onCompose(cx) {
    const token = this.tokenAt(this.input.value());
    const open = this.picker;
    if (!token) {
      if (open && open.driven) this.picker = null;
      cx.notify();
      return;
    }
    const switched = !open || !open.driven || open.kind !== token.kind;
    if (switched) {
      this.picker = { kind: token.kind, filter: token.query, driven: true, start: token.start };
      if (token.kind === "file") this.searchFiles(cx);
      else this.refreshMeta(cx);
    } else {
      open.filter = token.query;
      open.start = token.start;
      if (token.kind === "file") this.searchFiles(cx);
    }
    cx.notify();
  }

  searchFiles(cx) {
    if (!this.bridge) return;
    const query = this.picker ? this.picker.filter : "";
    const token = ++this.searchToken;
    cx.spawn(async (cx) => {
      try {
        const reply = await this.call(this.bridge, "/files?q=" + encodeURIComponent(query), { timeout: 40000 });
        if (token !== this.searchToken) return;
        if (!reply.body) {
          this.fileItems = [];
          this.error = "File search failed" + this.why() + (reply.error ? ": " + reply.error : "");
          cx.notify();
          return;
        }
        this.fileItems = reply.body.files || [];
        cx.notify();
      } catch (error) {
        if (token !== this.searchToken) return;
        this.fileItems = [];
        this.error = "File search failed" + this.why();
        cx.notify();
      }
    });
  }

  /** Items the open picker shows, already filtered. */
  pickerItems() {
    const p = this.picker;
    if (!p) return [];
    const q = String(p.filter || "").toLowerCase();
    if (p.kind === "thinking") return ((this.meta && this.meta.thinking && this.meta.thinking.levels) || []).map((level) => ({ key: level, label: level }));
    if (p.kind === "model") {
      const models = (this.meta && this.meta.models) || [];
      return models
        .map((m) => ({ key: m.provider + "/" + m.id, label: m.label === m.id ? m.label : m.label + "  " + m.provider + "/" + m.id, provider: m.provider, id: m.id }))
        .filter((m) => !q || m.key.toLowerCase().includes(q));
    }
    if (p.kind === "command") {
      const commands = (this.meta && this.meta.commands) || [];
      return commands.filter((c) => !q || c.name.toLowerCase().includes(q)).map((c) => ({ key: c.name, label: "/" + c.name, description: c.description }));
    }
    if (p.kind === "session") {
      return this.sessions
        .filter((s) => !q || (s.first + " " + (s.name || "")).toLowerCase().includes(q))
        .map((s) => ({
          key: s.path,
          path: s.path,
          label: (s.current ? "● " : "") + (s.name || s.first || s.id.slice(0, 8)),
          description: (s.messages == null ? "" : s.messages + " msgs · ") + String(s.modified || "").slice(0, 16).replace("T", " "),
        }));
    }
    return this.fileItems.map((path) => ({ key: path, label: path }));
  }

  choose(item, cx) {
    const p = this.picker;
    if (!p) return;
    if (p.kind === "thinking") {
      cx.spawn(async (cx) => {
        const reply = await this.post("/thinking", { level: item.key }, cx);
        if (reply && reply.error) this.error = "Thinking: " + reply.error;
        this.picker = null;
        this.refreshMeta(cx);
        cx.notify();
      });
      return;
    }
    if (p.kind === "model") {
      cx.spawn(async (cx) => {
        const reply = await this.post("/model", { provider: item.provider, id: item.id }, cx);
        if (reply && reply.error) this.error = "Model: " + reply.error;
        this.picker = null;
        this.refreshMeta(cx);
        cx.notify();
      });
      return;
    }
    if (p.kind === "session") {
      cx.spawn(async (cx) => {
        const reply = await this.post("/sessions/switch", { id: item.key, path: item.path }, cx);
        if (reply && reply.error) this.error = "Switch: " + reply.error;
        this.picker = null;
        this.refreshMeta(cx);
        cx.notify();
      });
      return;
    }
    // Autocomplete, not invocation: the picked text lands in the composer, where
    // Enter runs it. The word being replaced is the token that opened the picker.
    const current = String(this.input.value() || "");
    const start = typeof p.start === "number" ? p.start : current.length;
    const head = current.slice(0, start);
    const text = p.kind === "command" ? "/" + item.key + " " : "@" + item.key + " ";
    this.picker = null;
    this.input.set_value(head + text);
    this.input.focus();
    cx.notify();
  }

  runCommand(name, cx) {
    this.picker = null;
    if (name === "model") return this.openPicker("model", cx);
    if (name === "thinking") return this.openPicker("thinking", cx);
    if (name === "stop") return this.abort(cx);
    if (name === "compact") {
      cx.spawn(async (cx) => {
        const reply = await this.post("/compact", undefined, cx);
        if (reply && reply.error) this.error = "Compact: " + reply.error;
        cx.notify();
      });
      return;
    }
  }

  /** A paste that carried no text is usually an image: take it from the clipboard. */
  pasteImage(cx) {
    cx.spawn(async (cx) => {
      const found = await clipboardImagePath();
      if (!found.path) { this.error = "Clipboard holds no image — " + String(found.reason || "?"); cx.notify(); return; }
      await this.attach(found.path, cx);
    });
  }

  /** Read an image file into the pending attachments. */
  async attach(path, cx) {
    try {
      const bytes = await readFile(path);
      const mimeType = /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png";
      const name = String(path).replace(/\\/g, "/").split("/").pop();
      this.attachments.push({ path, name, mimeType, data: Buffer.from(bytes).toString("base64") });
      if (this.attachments.length > 4) this.attachments.shift();
      this.error = null;
      this.input.focus();
    } catch {
      this.error = "Cannot read " + path;
    }
    cx.notify();
  }

  /** Leave the panel for the terminal: the terminal alone fills the tab. */
  showTerminal(cx) {
    const here = focused();
    const tab = here && here.tab ? here.tab : null;
    const tabPanes = panes().filter((p) => p.tab === tab);
    const gui = tabPanes.find((p) => p.mod === "pi-gui") || null;
    const term = tabPanes.find((p) => p.terminal) || null;
    const steps = [];
    if (gui && gui.zoomed === true) steps.push(() => run("pane.zoom", { pane: gui.pane }));   // back to the split
    if (term) steps.push(() => { run("pane.focus", { pane: term.pane }); run("pane.zoom", { pane: term.pane }); });
    runSteps(cx, steps);
  }

  /** A dialog Pi is waiting on lives in the terminal; peek at it over the tab. */
  toTerminal(cx) {
    const terminal = this.address((this.bridge && this.bridge.terminal) || props().terminal ||
      (focused() && focused().terminal) || null);
    if (!terminal) return;
    run("terminal.peek", { terminal });
    cx.notify();
  }

  toggle(key, cx) {
    this.open[key] = !this.open[key];
    cx.notify();
  }

  // --- view ---------------------------------------------------------------

  render(cx) {
    if (this.trampoline) return div().size_full();
    const t = theme();
    const mono = settings().font_family || "JetBrains Mono";
    const state = this.state;
    const meta = this.meta;
    // Only a window of the transcript is held and drawn: the newest screenful
    // first, older rows on demand. A long session no longer costs a full build
    // and a full render on every poll.
    const tail = state ? state.rows : this.rows.slice(Math.max(0, this.rows.length - this.localShow));
    const all = this.older.length ? this.older.concat(tail) : tail;
    const count = all.length;
    const total = state ? (typeof state.total === "number" ? state.total : all.length) : this.rows.length;
    const earlier = state
      ? (typeof this.olderFrom === "number" ? this.olderFrom : 0)
      : Math.max(0, this.rows.length - this.localShow);
    // Oldest first in data; the column is reversed so the tail sits at the bottom
    // and the view starts there, like a chat. Extra rows go off the top.
    // Oldest first, folded into groups, then reversed so the newest group is at
    // the bottom (the column is flex_col_reverse).
    const kept = count > TAIL ? all.slice(count - TAIL) : all;
    const groups = groupRows(kept).reverse();
    const where = state ? (state.name || state.cwd || "") : (this.file || "");
    const modelChip = meta && meta.model ? meta.model.id : (state && state.model ? state.model : null);
    const level = meta && meta.thinking ? meta.thinking.level : null;
    const busy = Boolean(state && state.busy);
    // Sending counts as working: the POST is out and the first snapshot has not
    // landed yet, which is exactly the moment the panel used to look asleep.
    const working = busy || this.sending;
    // The transcript's children, built before the tree: the column is reversed, so
    // the run's spinner is placed first (the bottom) and the empty hint only fills
    // an idle panel. Built here, not inside .children(), because that one call is
    // already at the loader's limit for a single expression.
    const body = groups.length
      ? groups.map((g) => this.groupEl(g, t, mono, cx))
      : working ? []
      : [div().p(8).text_color(t.dim).child(this.error
          || (this.bridge ? "No messages yet — type below, or / for commands, @ for files"
          : this.scan
            ? (this.tabHasTerminal === false
              ? "This tab has no terminal — the Pi that lived here is gone, so there is nothing to bind to. Split a terminal back into this tab (pane.split) and the panel follows it."
              : this.scan.error
              ? "No live Pi bridge" + this.why() + " — " + this.scan.error + ". Check the machine in Herdr (hc machine ls)."
              : "No live Pi bridge" + this.why() + " — " + this.scan.registrations + " registration" + (this.scan.registrations === 1 ? "" : "s") +
                ", " + this.scan.matching + " for this tab or folder, 0 answering. Start or restart Pi " +
                (this.machine ? "there" : "here") + "; the panel binds as soon as it appears.")
            : div().frames(["Loading", "Loading.", "Loading..", "Loading..."], 400)))];
    const items = working ? [this.busyRow(t)].concat(body) : body;
    const live = state ? state.status : null;
    const usage = state && state.usage && typeof state.usage.tokens === "number" ? Math.round(state.usage.tokens / 1000) + "k" : null;

    const chip = (id, label, action, active) => h_flex().id(id).px(7).py(2).rounded(5).text_size(10)
      .bg(active ? t.selected : t.raised).text_color(active ? t.foreground : t.muted)
      .when(Boolean(action), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action))
      .child(label);

    return v_flex().id("pi-gui").size_full().bg(t.surface).text_size(13).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape" && this.picker) { this.closePicker(cx); cx.stop_propagation(); } })
      .child(h_flex().flex_none().h(38).px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Pi"))

        .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate().child(where))
        .when(Boolean(this.machine), (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border)
          .text_size(9).text_color(t.dim).child(String(this.machine))))
        .when(Boolean(usage), (e) => e.child(div().text_size(10).text_color(t.dim).child(usage)))
        .when(Boolean(modelChip), (e) => e.child(chip("pi-model", String(modelChip), (_ev, cx) => this.openPicker("model", cx), this.picker && this.picker.kind === "model")))
        .when(Boolean(level), (e) => e.child(chip("pi-thinking", String(level), (_ev, cx) => this.openPicker("thinking", cx), this.picker && this.picker.kind === "thinking")))
        .when(Boolean(state) && Boolean(this.bridge), (e) => e.child(chip("pi-session",
          state.name ? String(state.name) : "Sessions",
          (_ev, cx) => this.openPicker("session", cx),
          this.picker && this.picker.kind === "session")))
        .when(Boolean(this.bridge), (e) => e.child(chip("pi-terminal", "⇤ Terminal", (_ev, cx) => this.showTerminal(cx), false)))
        .when(busy, (e) => e.child(chip("pi-stop", "Stop", (_ev, cx) => this.abort(cx), false)))
        // The run's own state, in motion while it works: a still "working" reads
        // as a panel that stopped listening once a tool call runs for a minute.
        .when(Boolean(live), (e) => e.child(h_flex().id("pi-live").px(7).py(2).rounded(5).text_size(10)
          .bg(live === "working" ? t.selected : t.raised).text_color(live === "working" ? t.foreground : t.muted)
          .child(div().frames(live === "working" ? SPIN.map((frame) => "working " + frame) : [String(live)], 120))))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.dim)
          .child(count === total ? String(count) + " rows" : count + " / " + total + " rows")))
      .when(Boolean(state && state.prompt), (e) => e.child(h_flex().flex_none().px(10).py(6).gap(8).items_center()
        .bg(t.blocked).child(div().text_size(11).text_color(t.background).truncate().flex_1()
          .child("Pi is asking: " + String((state.prompt && state.prompt.title) || (state.prompt && state.prompt.kind) || "a dialog")))
        .child(h_flex().id("pi-to-terminal").px(8).py(2).rounded(5).bg(t.background).cursor_pointer()
          .on_click((_ev, cx) => this.toTerminal(cx))
          .child(div().text_size(10).text_color(t.foreground).child("Go to terminal")))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().size_full().flex_col_reverse().overflow_y_scrollbar()
          .track_scroll(this.scroll)
          // Scrolling by hand stops the follow; the chip below brings it back.
          .on_scroll_wheel((_e, cx) => { if (this.follow) { this.follow = false; cx.notify(); } })
          .px(12).py(10).gap(8)
          .children(items)
          // Reversed column: the last child is the visual top, where older rows go.
          .when(earlier > 0, (e) => e.child(h_flex().id("pi-earlier").py(4).w_full().justify_center()
            .rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_ev, cx) => this.loadOlder(cx))
            .child(div().text_size(10).text_color(t.dim).child("↑ earlier · " + earlier + " rows")))))
        .when(!this.follow && groups.length > 0, (e) => e.child(h_flex().id("pi-latest")
          .absolute().bottom(10).right(16).px(8).py(3).rounded(6).bg(t.raised).border_1().border_color(t.border)
          .cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_ev, cx) => { this.follow = true; this.pinToLatest(); cx.notify(); })
          .child(div().text_size(10).text_color(t.muted).child("↓ latest")))))
      .when(Boolean(this.picker), (e) => e.child(this.pickerEl(t, cx)))
      .when(Boolean(this.error) && groups.length > 0, (e) => e.child(div().px(12).pb(4).text_size(11).text_color(t.ansi1).child(this.error)))
      .child(v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
        .when(this.attachments.length > 0, (e) => e.child(this.attachmentRow(t, cx)))
        .child(h_flex().gap(6).items_center()
        .child(div().id("pi-input").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8)
          .border_1().border_color(t.border).bg(t.background).cursor_text()
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.input.focus(); cx.notify(); })
          .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .when(Boolean(this.bridge), (e) => e.child(h_flex().id("pi-send").h(32).px(14).items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12).cursor_pointer()
          .on_click((_ev, cx) => this.send(cx)).child(this.sending ? "…" : "Send")))
        .when(!this.bridge, (e) => e.child(div().h(32).px(10).flex().items_center().text_size(11).text_color(t.dim).child("read-only · no bridge")))));
  }

  /**
   * The run's own row. Streaming text shows that Pi is talking, but a long tool
   * call, a slow first token or a remote round trip shows nothing at all — and a
   * panel with no motion reads as a panel that died. The spinner is `frames`, so
   * it ticks in GPUI: no timer here, no notify, no rerender.
   */
  busyRow(t) {
    return h_flex().id("pi-working").flex_none().px(8).py(3).gap(6).items_center()
      .child(div().text_size(11).text_color(t.muted).frames(SPIN, 90))
      .child(div().text_size(10).text_color(t.dim).child(this.sending ? "sending…" : "Pi is working"));
  }

  /** One chip per pasted image, with a × to drop it before sending. */
  attachmentRow(t, cx) {
    return h_flex().gap(6).children(this.attachments.map((a, index) =>
      h_flex().id("pi-att-" + index).px(7).py(2).gap(6).items_center().rounded(5)
        .bg(t.raised).border_1().border_color(t.border)
        .child(div().text_size(10).text_color(t.muted).child("🖼 " + a.name))
        .child(div().id("pi-att-x-" + index).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_ev, cx) => { this.attachments.splice(index, 1); cx.notify(); })
          .child("×"))));
  }

  pickerEl(t, cx) {
    const p = this.picker;
    const items = this.pickerItems().slice(0, 60);
    const base = p.kind === "model" ? "Model" : p.kind === "thinking" ? "Thinking"
      : p.kind === "command" ? "Commands" : p.kind === "session" ? "Sessions" : "Files";
    const title = p.driven && p.filter ? base + " · " + p.filter : base;
    const needsFilter = p.kind !== "thinking" && !p.driven;
    const listItems = items.length
      ? items.map((item) => h_flex().id("pi-pick-" + item.key).px(8).py(4).gap(8).items_center().rounded(5)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_ev, cx) => this.choose(item, cx))
          .child(div().text_size(12).truncate().child(item.label))
          .when(Boolean(item.description), (e) => e.child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(item.description))))
      : [div().px(8).py(4).text_size(11).text_color(t.dim).child(p.kind === "file" ? "No matching files" : "Nothing to show")];
    return v_flex().flex_none().border_t(1).border_color(t.border).bg(t.canvas).p(8).gap(6)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(11).text_color(t.dim).child(title))
        .when(needsFilter, (e) => e.child(div().id("pi-filter").flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6)
          .border_1().border_color(t.input).bg(t.background)
          .child(Input.new(this.filter).h_full().text_size(11).text_color(t.foreground))))
        .child(div().flex_1())
        .child(div().id("pi-picker-close").px(6).py(2).rounded(5).text_size(10).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_ev, cx) => this.closePicker(cx)).child("Esc")))
      .child(v_flex().max_h(190).overflow_y_scrollbar().gap(1).children(listItems));
  }

  /** The newest row is child 0 (the column is reversed), i.e. the bottom of the view. */
  pinToLatest() {
    try { this.scroll.scroll_to_item(0); } catch { /* not laid out yet */ }
  }

  /** A conversation row, or a folded run of steps. */
  groupEl(group, t, mono, cx) {
    if (group.kind === "row") return this.rowEl(group.row, t, mono, cx);
    const open = Boolean(this.open[group.key]);
    const failed = group.rows.some((r) => r.kind === "tool" && !r.result);
    return v_flex().id(group.key).flex_none().w_full().gap(4)
      .child(h_flex().px(8).py(3).gap(6).items_center().rounded(5).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggle(group.key, cx))
        .child(div().text_size(9).text_color(t.dim).child(open ? "▾" : "▸"))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(failed ? t.ansi3 : t.dim)
          .child(stepsSummary(group.rows)))
        .child(div().text_size(9).text_color(t.dim).child(open ? "hide" : "show")))
      .when(open, (e) => e.child(v_flex().pl(10).gap(4)
        .children(group.rows.map((r) => this.rowEl(r, t, mono, cx)))));
  }

  rowEl(r, t, mono, cx) {
    const open = Boolean(this.open[r.key]);
    if (r.kind === "user") {
      return v_flex().id(r.key).flex_none().w_full().p(8).rounded(8).bg(t.raised)
        .child(div().text_size(10).text_color(t.dim).child("You"))
        .child(markdownView(r.key, r.text, t, { mono, size: 13 }));
    }
    if (r.kind === "assistant") {
      // Mermaid fences come back as PNGs the bridge rendered; until then a line
      // says so instead of leaving the diagram looking lost. A bridge on another
      // machine renders them there, so the PNG is fetched before it can be drawn.
      const diagrams = this.diagramPaths(r);
      return v_flex().id(r.key).flex_none().w_full().p(8).rounded(8).bg(t.canvas)
        .child(markdownView(r.key, r.text, t, { mono, size: 13 }))
        .when(diagrams.length > 0, (e) => e.children(diagrams.map((path, index) =>
          div().id(r.key + "-d" + index).mt(8).w_full().max_h(460).overflow_hidden()
            .child(image(path)))))
        .when(diagrams.length === 0 && Boolean(r.mermaid), (e) => e.child(div().mt(6).text_size(10)
          .text_color(t.dim).child(this.machine ? "▯ diagram drawn on " + this.machine : "▯ rendering diagram…")));
    }
    if (r.kind === "thinking") {
      return v_flex().id(r.key).flex_none().w_full().p(6).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggle(r.key, cx))
        .child(div().text_size(10).text_color(t.dim).child("thinking · " + r.text.length + " chars" + (open ? "" : " · click")))
        .when(open, (e) => e.child(div().text_size(11).text_color(t.muted).child(r.text)));
    }
    return v_flex().id(r.key).flex_none().w_full().rounded(6).border_1().border_color(t.border)
      .child(h_flex().px(8).py(5).gap(8).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggle(r.key, cx))
        .child(div().text_size(11).text_color(r.result ? t.ansi2 : t.ansi3).child((r.result ? "✓ " : "… ") + r.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(r.summary)))
      .when(open, (e) => e.child(div().px(8).pb(6).font_family(mono).text_size(11).text_color(t.muted)
        .child(r.result ? r.result.slice(0, 4000) : "(no result)")));
  }
}

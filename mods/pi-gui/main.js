// Pi GUI: a native chat view for a Pi session, next to its terminal.
//
// Source of truth is the pi-gui-bridge extension (HTTP on 127.0.0.1, long-polled):
// transcript, model, thinking level, slash commands and @-files all come from
// Pi itself, so the panel never guesses. Without a bridge it falls back to the
// session JSONL, read-only.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, props, readTextFile, watchFolder, home, settings, focused, panes, nextCommand, run, closeOverlay, exec } from "herdr";
import { Buffer } from "buffer";
import { join } from "path";
import { readdir, readFile } from "fs/promises";

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

function sessionsRoot() { return join(home(), ".pi", "agent", "sessions"); }
function bridgeRoot() { return join(home(), ".pi", "agent", "gui"); }
function slug(path) { return "--" + String(path).replace(/[:\\/]/g, "-") + "--"; }
function normPath(path) { return String(path || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, ""); }

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

/**
 * What to run, tick by tick, to swap the terminal and the panel in one tab.
 * pane.zoom means "show only this pane, or all again", so going from one zoomed
 * pane to the other is unzoom, then zoom — one command per tick.
 */
function swapSteps(tab, target) {
  const tabPanes = panes().filter((p) => p.tab === tab);
  const gui = tabPanes.find((p) => p.mod === "pi-gui") || null;
  const term = tabPanes.find((p) => p.terminal) || null;
  const freshGui = () => panes().find((p) => p.mod === "pi-gui" && p.tab === tab) || null;
  const steps = [];

  if (term && term.zoomed === true) {
    steps.push(() => run("pane.zoom", { pane: term.pane }));                      // back to the split
    steps.push(() => { if (!freshGui()) run("pane.split", { direction: "right", mod: "pi-gui", props: target }); });
    steps.push(() => { const g = freshGui(); if (g) { run("pane.focus", { pane: g.pane }); run("pane.zoom", { pane: g.pane }); } });
  } else if (gui && gui.zoomed === true) {
    steps.push(() => run("pane.zoom", { pane: gui.pane }));                       // back to the split
    steps.push(() => { if (term) { run("pane.focus", { pane: term.pane }); run("pane.zoom", { pane: term.pane }); } });
  } else if (gui) {
    steps.push(() => run("pane.focus", { pane: gui.pane }));
    steps.push(() => { const g = freshGui(); if (g) run("pane.zoom", { pane: g.pane }); });
  } else if (target && target.terminal) {
    steps.push(() => run("pane.split", { direction: "right", mod: "pi-gui", props: target }));
    steps.push(() => { const g = freshGui(); if (g) { run("pane.focus", { pane: g.pane }); run("pane.zoom", { pane: g.pane }); } });
  }
  return steps;
}

/** One command per tick: zoom and pane changes settle in the background. */
function runSteps(cx, steps) {
  steps.forEach((step, index) => cx.timer.after(index * 260, () => step()));
}

export default class PiGui extends View {
  init(_props, cx) {
    // Key trampoline. A key cannot pass props to a mod pane, so ctrl-alt-p runs
    // "mod.open:pi-gui": this copy opens as an overlay and immediately becomes a
    // real pane beside the focused terminal — or focuses the pane this tab already
    // has, instead of showing a second one.
    const overlay = (props() || {}).overlay;
    if (overlay) {
      const here = focused();
      const tab = here && here.tab ? here.tab : null;
      const tabPanes = panes().filter((p) => p.tab === tab);
      const gui = tabPanes.find((p) => p.mod === "pi-gui") || null;
      const terminal = (here && here.terminal) || null;
      const target = { terminal, cwd: (here && here.cwd) || null };
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

      const steps = swapSteps(tab, target);
      if (!steps.length) return; // nothing to swap with: leave the overlay as it is
      this.trampoline = true;
      runSteps(cx, steps);
      cx.timer.after(steps.length * 260 + 80, () => closeOverlay(overlay));
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
    this.scan = null;            // what the last look at ~/.pi/agent/gui found
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
        if (command === "focus") {
          // Coming in through ctrl-alt-p: if this copy is bound to a Pi in another
          // tab (the only bridge that was alive at the time), look again now.
          const here = focused();
          if (this.bridge && here && here.tab && this.bridge.tab && this.bridge.tab !== here.tab) this.discover(cx);
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
            terminal: (here && here.terminal) || (this.bridge && this.bridge.terminal) || null,
            cwd: (here && here.cwd) || null,
          }));
        }
      }
    });
  }

  // --- connection ---------------------------------------------------------

  /** Prefer the bridge bound to props().terminal, else the Pi in this tab, else this folder. */
  discover(cx) {
    cx.spawn(async (cx) => {
      const dir = bridgeRoot();
      const wantTerminal = this.want.terminal || props().terminal || null;
      const wantSession = this.want.session || props().session || null;
      const cwd = normPath(props().cwd || (focused() && focused().cwd) || "");
      const here = focused();
      const ctxTab = here && here.tab ? here.tab : null;
      let names = [];
      try { names = (await readdir(dir)).filter((n) => n.endsWith(".json")); } catch {}
      const ranked = [];
      for (const name of names) {
        const text = await readTextFile(join(dir, name));
        if (!text) continue;
        let info;
        try { info = JSON.parse(text); } catch { continue; }
        if (!info || !info.port || !info.token) continue;
        let score = 0;
        if (wantTerminal && info.terminal === wantTerminal) score += 100;
        if (ctxTab && info.tab && info.tab === ctxTab) score += 300;
        if (wantSession && info.sessionId === wantSession) score += 50;
        if (cwd && normPath(info.cwd) === cwd) score += 20;
        ranked.push({ info, score });
      }
      // A registration can outlive a force-killed Pi: take the best one that answers.
      // A score of 0 means "nothing about this panel matches it", so it is only
      // used when it is the only Pi on the machine — never to hijack another
      // folder's or another tab's session.
      ranked.sort((a, b) => b.score - a.score);
      const matches = ranked.filter((candidate) => candidate.score > 0);
      const pool = matches.length ? matches : ranked.length === 1 ? ranked : [];
      this.scan = { registrations: ranked.length, matching: matches.length, alive: 0 };
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
        if (this.picker && this.picker.kind === "file") this.searchFiles(cx);
        if (this.picker && this.picker.kind === "session") this.loadSessions(cx);
        cx.notify();
        return;
      }
      this.bridge = null;
      await this.loadFile(cx);
      if (!this.watching) { this.watching = true; this.watchFile(cx); this.watchBridges(cx); }
      // A Pi can start any time after this pane opened: look again, quietly.
      cx.timer.after(3000, (cx) => { if (!this.bridge) this.discover(cx); });
    });
  }

  /**
   * The registration folder tells us the moment a Pi appears or a stale entry is
   * rewritten, so an unbound panel binds without polling.
   */
  watchBridges(cx) {
    const dir = bridgeRoot();
    cx.spawn(async (cx) => {
      for (;;) {
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

  /** One screenful of older rows, either from the bridge or from the loaded JSONL. */
  loadOlder(cx) {
    if (!this.bridge) { this.localShow += 40; cx.notify(); return; }
    const before = this.olderFrom == null ? 0 : this.olderFrom;
    if (!before) return;
    const bridge = this.bridge;
    cx.spawn(async (cx) => {
      try {
        const res = await fetch("http://127.0.0.1:" + bridge.port + "/rows?t=" + bridge.token + "&before=" + before + "&count=40");
        const body = await res.json();
        if (this.bridge !== bridge) return;
        this.older = ((body && body.rows) || []).concat(this.older);
        this.olderFrom = body && typeof body.from === "number" ? body.from : 0;
        this.follow = false;
        cx.notify();
      } catch {
        this.error = "Could not load earlier rows";
        cx.notify();
      }
    });
  }

  /** One cheap request: the snapshot if this bridge is alive, else null. */
  async probe(info) {
    try {
      const res = await fetch("http://127.0.0.1:" + info.port + "/state?t=" + info.token + "&since=-1&wait=0");
      if (res.status === 204) return {};
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Long-poll the snapshot; one request in flight, no timers. */
  poll(cx, bridge) {
    cx.spawn(async (cx) => {
      for (;;) {
        let body;
        try {
          const res = await fetch("http://127.0.0.1:" + bridge.port + "/state?t=" + bridge.token + "&since=" + this.version + "&wait=25&rows=40");
          if (res.status === 204) continue;
          body = await res.json();
        } catch (error) {
          this.bridge = null;
          this.bound = false;
          this.error = "Pi bridge lost — looking for it again";
          cx.notify();
          cx.timer.after(2500, (cx) => { if (!this.bridge) this.discover(cx); });
          return;
        }
        if (this.bridge !== bridge) return;
        if (body && body.state) {
          const previous = this.state && this.state.sessionId;
          if (previous && body.state.sessionId !== previous) { this.older = []; this.olderFrom = null; this.localShow = 40; }
          this.state = body.state;
          this.version = body.version;
          if (!this.older.length) this.olderFrom = body.state.from;
          this.error = null;
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
      try {
        const res = await fetch("http://127.0.0.1:" + target.port + "/meta?t=" + target.token);
        const body = await res.json();
        if (this.bridge !== target || !body) return;
        this.meta = body;
        cx.notify();
      } catch (error) {
        this.error = "Pi meta failed: " + String((error && error.message) || error);
        cx.notify();
      }
    });
  }

  async loadFile(cx) {
    const path = props().file || await this.latest();
    if (!path) { this.error = "No Pi session for this folder"; cx.notify(); return; }
    if (path !== this.file) { this.file = path; this.textLen = 0; }
    const text = await readTextFile(path);
    if (text == null) { this.error = "Cannot read " + path; cx.notify(); return; }
    if (text.length === this.textLen) return;
    this.textLen = text.length;
    this.rows = buildRows(parseJsonl(text));
    this.error = null;
    if (this.follow) this.pinToLatest();
    cx.notify();
  }

  async latest() {
    const root = sessionsRoot();
    let dirs = [];
    try { dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return null; }
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
      let files = [];
      try { files = (await readdir(join(root, d))).filter((f) => f.endsWith(".jsonl")).sort(); } catch { continue; }
      const newest = files[files.length - 1];
      if (newest && (!best || newest > best.name)) best = { name: newest, path: join(root, d, newest) };
    }
    return best ? best.path : null;
  }

  watchFile(cx) {
    const root = sessionsRoot();
    cx.spawn(async (cx) => {
      for (;;) {
        await watchFolder(root);
        if (this.bridge) return;
        await this.loadFile(cx);
      }
    });
  }

  // --- bridge actions -----------------------------------------------------

  post(path, payload, cx) {
    const bridge = this.bridge;
    if (!bridge) return Promise.resolve(null);
    const url = "http://127.0.0.1:" + bridge.port + path + "?t=" + bridge.token;
    const options = payload === undefined
      ? { method: "POST" }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
    return fetch(url, options).then((res) => res.json()).catch((error) => ({ error: String((error && error.message) || error) }));
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
        const res = await fetch("http://127.0.0.1:" + bridge.port + "/sessions?t=" + bridge.token);
        const body = await res.json();
        if (this.bridge !== bridge) return;
        this.sessions = (body && body.sessions) || [];
        cx.notify();
      } catch (error) {
        this.sessions = [];
        this.error = "Session list failed";
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
        const res = await fetch("http://127.0.0.1:" + this.bridge.port + "/files?t=" + this.bridge.token + "&q=" + encodeURIComponent(query));
        const body = await res.json();
        if (token !== this.searchToken) return;
        this.fileItems = (body && body.files) || [];
        cx.notify();
      } catch (error) {
        if (token !== this.searchToken) return;
        this.fileItems = [];
        this.error = "File search failed";
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
        const reply = await this.post("/sessions/switch", { path: item.path }, cx);
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
    const terminal = (this.bridge && this.bridge.terminal) || props().terminal ||
      (focused() && focused().terminal) || null;
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
        .when(Boolean(usage), (e) => e.child(div().text_size(10).text_color(t.dim).child(usage)))
        .when(Boolean(modelChip), (e) => e.child(chip("pi-model", String(modelChip), (_ev, cx) => this.openPicker("model", cx), this.picker && this.picker.kind === "model")))
        .when(Boolean(level), (e) => e.child(chip("pi-thinking", String(level), (_ev, cx) => this.openPicker("thinking", cx), this.picker && this.picker.kind === "thinking")))
        .when(Boolean(state) && Boolean(this.bridge), (e) => e.child(chip("pi-session",
          state.name ? String(state.name) : "Sessions",
          (_ev, cx) => this.openPicker("session", cx),
          this.picker && this.picker.kind === "session")))
        .when(Boolean(this.bridge), (e) => e.child(chip("pi-terminal", "⇤ Terminal", (_ev, cx) => this.showTerminal(cx), false)))
        .when(busy, (e) => e.child(chip("pi-stop", "Stop", (_ev, cx) => this.abort(cx), false)))
        .when(Boolean(live), (e) => e.child(chip("pi-live", String(live), null, live === "working")))
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
          .children(groups.length
            ? groups.map((g) => this.groupEl(g, t, mono, cx))
            : [div().p(8).text_color(t.dim).child(this.error
                || (this.bridge ? "No messages yet — type below, or / for commands, @ for files"
                : this.scan
                  ? "No live Pi bridge — " + this.scan.registrations + " registration" + (this.scan.registrations === 1 ? "" : "s") +
                    ", " + this.scan.matching + " for this tab or folder, 0 answering. Start or restart Pi here; the panel binds as soon as it appears."
                  : "Loading…"))])
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
        .child(TextView.markdown("m" + r.key, r.text));
    }
    if (r.kind === "assistant") {
      // Mermaid fences come back as PNGs the bridge rendered; until then a line
      // says so instead of leaving the diagram looking lost.
      const diagrams = Array.isArray(r.diagrams) ? r.diagrams : [];
      return v_flex().id(r.key).flex_none().w_full().p(8).rounded(8).bg(t.canvas)
        .child(TextView.markdown("m" + r.key, r.text).text_size(13))
        .when(diagrams.length > 0, (e) => e.children(diagrams.map((path, index) =>
          div().id(r.key + "-d" + index).mt(8).w_full().max_h(460).overflow_hidden()
            .child(image(path)))))
        .when(diagrams.length === 0 && Boolean(r.mermaid), (e) => e.child(div().mt(6).text_size(10)
          .text_color(t.dim).child("▯ rendering diagram…")));
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

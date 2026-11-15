// pi-gui-bridge: exposes this Pi session to Herdr's "pi-gui" mod.
//
// A Herdr mod cannot hold a pipe, so it cannot attach to Pi's stdio RPC. Instead
// this extension answers HTTP on 127.0.0.1 and registers itself in
// ~/.pi/agent/gui/<sessionId>.json for the mod to discover.
//
//   GET  /state?t=<token>&since=<version>&wait=<sec>   long-poll snapshot
//   GET  /meta?t=<token>                              model, thinking levels, models, commands
//   GET  /files?t=<token>&q=<text>                    @-mention candidates in cwd
//   GET  /sessions?t=<token>                          sessions of this folder
//   GET  /diagram?t=<token>&hash=<hash>               a rendered mermaid PNG, for
//                                                     a panel on another machine
//   POST /prompt?t=<token>   {"message": "..."}       a real user message
//   POST /model?t=<token>    {"provider": "…", "id": "…"}
//   POST /thinking?t=<token> {"level": "high"}
//   POST /sessions/switch?t=<token> {"path": "…"}
//   POST /compact?t=<token>
//   POST /abort?t=<token>
//
// Set PI_GUI_BRIDGE=0 to keep it off.
// @ts-nocheck
import { createServer } from "node:http";
import { mkdir, writeFile, unlink, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildRows, splitMermaid } from "./rows.ts";
import { browserPath, cacheDir, closeBrowser, hashOf, imagePathFor, renderDiagram } from "./diagrams.ts";

const run = promisify(execFile);

const GUI_DIR = join(homedir(), ".pi", "agent", "gui");
const APP_HOME = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const MAX_ROWS = 4000;      // kept in the cache; a poll only carries a window
const DEFAULT_WINDOW = 40;  // rows a poll carries unless the caller asks otherwise
const COALESCE_MS = 120;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor", "coverage",
  ".next", ".nuxt", ".venv", "venv", "__pycache__", ".turbo", ".cache", ".idea", ".vscode",
]);

let server = null;
let port = 0;
let token = "";
let regFile = "";
let lastCtx = null;
let status = "idle";
// A dialog Pi is blocked on (ctx.ui.select/confirm/input/editor from any extension):
// the panel can say so and send you to the terminal, but only the TUI can answer it.
let promptInfo = null;
// The assistant message being streamed: it is only in the session branch once it
// ends, so without this the panel shows a run's text after it finishes, not during.
let liveMessage = null;
let version = 0;
let pending = false;
let flushTimer = null;
let waiters = [];
// Herdr gives a terminal no env vars naming it, so the pane identity is found
// once by matching this process id against herdr-core's terminals.
let identity = null;
let identityTried = false;

function samePath(a, b) {
  return String(a || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "") ===
         String(b || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Drop registrations of Pi processes that are gone. */
async function sweep() {
  let names = [];
  try { names = await readdir(GUI_DIR); } catch { return; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const full = join(GUI_DIR, name);
    try {
      const info = JSON.parse(await readFile(full, "utf8"));
      if (info && info.pid && info.pid !== process.pid && !alive(info.pid)) await unlink(full);
    } catch {
      try { await unlink(full); } catch {}
    }
  }
}

/** This Pi's Herdr terminal, space and tab, by process id. Cached; null outside Herdr. */
async function findIdentity(cwd) {
  if (identityTried) return identity;
  identityTried = true;
  let terminals = [];
  try {
    const { stdout } = await run("hc", ["ls", "--json"], { timeout: 8000 });
    terminals = (JSON.parse(stdout) || {}).terminals || [];
  } catch {
    return (identity = null);
  }
  const local = terminals.filter((t) => t && t.address && !String(t.address).includes("/"));
  const near = local.filter((t) => samePath(t.cwd, cwd));
  const piOnes = local.filter((t) => t.agent === "pi" && !near.includes(t));
  const rest = local.filter((t) => !near.includes(t) && !piOnes.includes(t));
  for (const t of [...near, ...piOnes, ...rest]) {
    try {
      const { stdout } = await run("hc", ["get", t.address, "--json"], { timeout: 8000 });
      const info = JSON.parse(stdout);
      const pid = info && info.foreground ? info.foreground.pid : info ? info.pid : null;
      if (pid === process.pid) {
        const labels = (info && info.labels) || {};
        identity = { terminal: t.address, space: labels["herdr.space"] || null, tab: labels["herdr.tab"] || null };
        return identity;
      }
    } catch {}
  }
  return (identity = null);
}

/** Tell every waiting poll that the snapshot moved. */
function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!pending) return;
  pending = false;
  version += 1;
  const list = waiters;
  waiters = [];
  for (const wake of list) wake();
}

/** Coalesce token-by-token streaming into one bump per COALESCE_MS. */
function bump() {
  pending = true;
  if (flushTimer) return;
  flushTimer = setTimeout(flush, COALESCE_MS);
  flushTimer.unref?.();
}

function modelList(ctx) {
  const out = [];
  try {
    const available = ctx && ctx.modelRegistry && ctx.modelRegistry.getAvailable ? ctx.modelRegistry.getAvailable() : [];
    for (const m of available) {
      if (!m || !m.provider || !m.id) continue;
      out.push({ provider: m.provider, id: m.id, label: m.name || m.id, reasoning: Boolean(m.reasoning) });
    }
  } catch {}
  return out;
}

function modelLabelOf(model) {
  return model ? [model.provider, model.id].filter(Boolean).join("/") : null;
}

/** Everything the panel needs to offer choices, not just to draw them. */
function meta(pi, ctx) {
  const active = ctx && ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
  const commands = [
    { name: "model", description: "Pick the model", source: "panel" },
    { name: "thinking", description: "Set the thinking level", source: "panel" },
    { name: "compact", description: "Compact the session", source: "panel" },
    { name: "stop", description: "Stop the current run", source: "panel" },
  ];
  try {
    for (const c of pi.getCommands() || []) {
      if (String(c.name).startsWith("gui-")) continue; // our own plumbing
      commands.push({ name: c.name, description: c.description || "", source: c.source || "extension" });
    }
  } catch {}
  return {
    version,
    cwd: ctx && ctx.sessionManager && ctx.sessionManager.getCwd ? ctx.sessionManager.getCwd() : null,
    sessionId: ctx && ctx.sessionManager && ctx.sessionManager.getSessionId ? ctx.sessionManager.getSessionId() : null,
    name: ctx && ctx.sessionManager && ctx.sessionManager.getSessionName ? ctx.sessionManager.getSessionName() ?? null : null,
    model: active,
    thinking: { level: pi.getThinkingLevel ? pi.getThinkingLevel() : null, levels: THINKING_LEVELS },
    models: modelList(ctx),
    commands,
  };
}

/** A shallow breadth-first walk, enough for an @-mention list. */
async function findFiles(root, query, limit = 60) {
  const q = String(query || "").toLowerCase();
  const found = [];
  const queue = [["", 0]];
  let visited = 0;
  while (queue.length && found.length < limit && visited < 20000) {
    const [rel, depth] = queue.shift();
    if (depth > 6) continue;
    let entries = [];
    try { entries = await readdir(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited += 1;
      const relPath = rel ? rel + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        queue.push([relPath, depth + 1]);
        continue;
      }
      if (!q || relPath.toLowerCase().includes(q)) found.push(relPath);
      if (found.length >= limit) break;
    }
  }
  return found.sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(0, limit);
}

/** Sessions of this folder, newest first — what the panel's session picker lists. */
async function sessionList(ctx, limit = 30) {
  const cwd = ctx && ctx.sessionManager && ctx.sessionManager.getCwd ? ctx.sessionManager.getCwd() : process.cwd();
  let sessions = [];
  try {
    sessions = await SessionManager.list(cwd);
  } catch {
    return [];
  }
  const currentId = ctx && ctx.sessionManager && ctx.sessionManager.getSessionId ? ctx.sessionManager.getSessionId() : null;
  const currentFile = ctx && ctx.sessionManager && ctx.sessionManager.getSessionFile ? ctx.sessionManager.getSessionFile() : null;
  const rows = sessions
    .filter((s) => s && s.path)
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      path: s.path,
      name: s.name || null,
      messages: s.messageCount ?? null,
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified || ""),
      first: String(s.firstMessage || "").replace(/\s+/g, " ").trim().slice(0, 160),
      current: Boolean((currentId && s.id === currentId) || (currentFile && samePath(s.path, currentFile))),
    }));
  // A session with no entries yet is not on disk as a listable session, but it is
  // the one you are in: put it first so the picker always shows where you are.
  if (currentId && currentFile && !rows.some((s) => s.current)) {
    rows.unshift({
      id: currentId,
      path: currentFile,
      name: ctx && ctx.sessionManager.getSessionName ? ctx.sessionManager.getSessionName() ?? null : null,
      messages: null,
      modified: new Date().toISOString(),
      first: "(this session — nothing yet)",
      current: true,
    });
  }
  return rows;
}

// Rows are rebuilt only when the session actually moved: a long-poll that wakes
// up for a status change must not re-walk a 4000-row branch.
let rowCache = { key: "", rows: [] };

function allRows() {
  const ctx = lastCtx;
  const mgr = ctx && ctx.sessionManager;
  const branch = mgr && mgr.getBranch ? mgr.getBranch() : [];
  const last = branch.length ? branch[branch.length - 1] : null;
  const liveSize = liveMessage ? JSON.stringify(liveMessage.content || "").length : -1;
  const key = branch.length + "|" + (last ? last.id || "" : "") + "|" + liveSize;
  if (key === rowCache.key) return rowCache.rows;
  const entries = liveMessage
    ? branch.concat([{ type: "message", id: "live", parentId: null, message: liveMessage }])
    : branch;
  const rows = buildRows(entries, MAX_ROWS);
  // Fences are pulled out once, when the branch changes: the row keeps its
  // sources so later snapshots only have to look their PNGs up.
  for (const row of rows) {
    if (row.kind !== "assistant" || !row.text) continue;
    const split = splitMermaid(row.text);
    if (!split.blocks.length) continue;
    row.text = split.text;
    row.mermaidCodes = split.blocks;
  }
  rowCache = { key, rows };
  return rowCache.rows;
}

// --- mermaid -----------------------------------------------------------------
// The panel draws a diagram as an image, so an assistant message's fences become
// PNGs here. Rendering runs in a headless browser, one at a time, cached by
// content hash: the same diagram is never rendered twice.
const diagramQueue = [];
const diagramsRendering = new Set();
const diagramSource = new Map();
let diagramBusy = false;

async function pumpDiagrams() {
  if (diagramBusy) return;
  diagramBusy = true;
  try {
    while (diagramQueue.length) {
      const hash = diagramQueue.shift();
      try { await renderDiagram(APP_HOME, diagramSource.get(hash) || "", "dark"); } catch {}
      diagramsRendering.delete(hash);
      bump();
    }
  } finally {
    diagramBusy = false;
  }
}

function requestDiagram(hash) {
  if (diagramsRendering.has(hash)) return;
  diagramsRendering.add(hash);
  diagramQueue.push(hash);
  pumpDiagrams();
}

/** Fences -> image paths for the rows about to be sent; the rest are queued. */
function withDiagrams(rows) {
  if (!rows.length || !browserPath()) return rows;
  for (const row of rows) {
    if (!row.mermaidCodes) continue;
    const ready = [];
    let waiting = false;
    for (const code of row.mermaidCodes) {
      const hash = hashOf(code);
      diagramSource.set(hash, code);
      let exists = false;
      try { exists = existsSync(join(cacheDir(APP_HOME), hash + ".png")); } catch {}
      if (exists) ready.push(imagePathFor(hash));
      else { waiting = true; requestDiagram(hash); }
    }
    row.diagrams = ready;
    row.mermaid = waiting;
  }
  return rows;
}

/** The tail of the transcript, plus where it starts — the poll's payload. */
function windowOf(size) {
  const all = allRows();
  const take = Math.min(Math.max(Number(size) || DEFAULT_WINDOW, 1), MAX_ROWS);
  const from = Math.max(0, all.length - take);
  return { rows: withDiagrams(all.slice(from)), from, total: all.length };
}

function usageOf(ctx) {
  try {
    const usage = ctx && ctx.getContextUsage ? ctx.getContextUsage() : null;
    return usage && typeof usage.tokens === "number" ? { tokens: usage.tokens, limit: usage.limit ?? null } : null;
  } catch {
    return null;
  }
}

function snapshot(windowSize) {
  const ctx = lastCtx;
  const mgr = ctx && ctx.sessionManager;
  const window = windowOf(windowSize);
  return {
    sessionId: mgr && mgr.getSessionId ? mgr.getSessionId() : null,
    sessionFile: mgr && mgr.getSessionFile ? mgr.getSessionFile() : null,
    name: mgr && mgr.getSessionName ? mgr.getSessionName() ?? null : null,
    cwd: mgr && mgr.getCwd ? mgr.getCwd() : null,
    model: modelLabelOf(ctx && ctx.model),
    busy: ctx && ctx.isIdle ? ctx.isIdle() === false : false,
    status,
    prompt: promptInfo,
    usage: usageOf(ctx),
    rows: window.rows,
    from: window.from,
    total: window.total,
  };
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function handler(pi) {
  return async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.searchParams.get("t") !== token) return json(res, 403, { error: "forbidden" });
    const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 20), 0), 60);

    if (req.method === "GET" && url.pathname === "/state") {
      const since = Number(url.searchParams.get("since") ?? -1);
      flush();
      if (since === version && wait > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, wait * 1000);
          timer.unref?.();
          waiters.push(() => { clearTimeout(timer); resolve(); });
        });
      }
      if (since === version) { res.writeHead(204); return res.end(); }
      return json(res, 200, { version, state: snapshot(url.searchParams.get("rows")) });
    }

    // Older rows, on demand: the panel starts at the newest screenful.
    if (req.method === "GET" && url.pathname === "/rows") {
      const all = allRows();
      const before = Math.min(Math.max(Number(url.searchParams.get("before") ?? all.length), 0), all.length);
      const count = Math.min(Math.max(Number(url.searchParams.get("count")) || DEFAULT_WINDOW, 1), MAX_ROWS);
      const from = Math.max(0, before - count);
      return json(res, 200, { rows: all.slice(from, before), from, total: all.length });
    }

    if (req.method === "GET" && url.pathname === "/meta") {
      flush();
      return json(res, 200, meta(pi, lastCtx));
    }

    if (req.method === "GET" && url.pathname === "/sessions") {
      return json(res, 200, { sessions: await sessionList(lastCtx) });
    }

    // A panel on another machine cannot draw a PNG that lives here, and the
    // panel's HTTP cannot reach 127.0.0.1 of this machine either: so it asks for
    // the bytes over the same channel it already uses.
    if (req.method === "GET" && url.pathname === "/diagram") {
      const hash = String(url.searchParams.get("hash") || "").replace(/[^0-9a-f]/g, "");
      if (!hash) return json(res, 400, { error: "missing hash" });
      let png = null;
      try { png = await readFile(join(cacheDir(APP_HOME), hash + ".png")); } catch {}
      if (!png) return json(res, 404, { error: "no such diagram" });
      res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
      return res.end(png);
    }

    if (req.method === "GET" && url.pathname === "/files") {
      const root = lastCtx && lastCtx.sessionManager && lastCtx.sessionManager.getCwd
        ? lastCtx.sessionManager.getCwd()
        : process.cwd();
      return json(res, 200, { root, files: await findFiles(root || process.cwd(), url.searchParams.get("q") || "") });
    }

    if (req.method === "POST" && url.pathname === "/prompt") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "bad json" }); }
      const message = typeof body.message === "string" ? body.message.trim() : "";
      // A pasted image arrives as base64, the same shape Pi's own ImageContent has.
      const images = Array.isArray(body.images) ? body.images : [];
      const content = [];
      if (message) content.push({ type: "text", text: message });
      for (const image of images) {
        if (!image || typeof image.data !== "string" || !image.data) continue;
        content.push({ type: "image", data: image.data, mimeType: image.mimeType || "image/png" });
      }
      if (!content.length) return json(res, 400, { error: "empty message" });
      const ctx = lastCtx;
      try {
        const options = {};
        if (ctx && ctx.isIdle && ctx.isIdle() === false) options.deliverAs = "steer";
        // "/skill:…", "/template …" and extension commands only run when expanded.
        if (message.startsWith("/")) options.expandPromptTemplates = true;
        pi.sendUserMessage(content.length === 1 && content[0].type === "text" ? message : content, options);
      } catch (error) {
        return json(res, 500, { error: String((error && error.message) || error) });
      }
      return json(res, 200, { ok: true, images: images.length });
    }

    if (req.method === "POST" && url.pathname === "/sessions/switch") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "bad json" }); }
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) return json(res, 400, { error: "missing id" });
      const ctx = lastCtx;
      if (ctx && ctx.isIdle && ctx.isIdle() === false) return json(res, 409, { error: "Pi is busy; stop the run first" });
      try {
        // switchSession lives on the command context, not on event contexts, so
        // the panel goes through a command of ours (an id, since paths have spaces).
        pi.sendUserMessage("/gui-switch-session " + id, { expandPromptTemplates: true });
      } catch (error) {
        return json(res, 500, { error: String((error && error.message) || error) });
      }
      return json(res, 200, { ok: true });
    }


    if (req.method === "POST" && url.pathname === "/model") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "bad json" }); }
      const ctx = lastCtx;
      const model = ctx && ctx.modelRegistry && ctx.modelRegistry.find ? ctx.modelRegistry.find(body.provider, body.id) : null;
      if (!model) return json(res, 404, { error: "no such model" });
      let ok = false;
      try { ok = await pi.setModel(model); } catch (error) { return json(res, 500, { error: String((error && error.message) || error) }); }
      bump();
      return json(res, ok ? 200 : 409, ok ? { ok: true, model: modelLabelOf(model) } : { error: "no authentication for that provider" });
    }

    if (req.method === "POST" && url.pathname === "/thinking") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "bad json" }); }
      const level = String(body.level || "");
      if (!THINKING_LEVELS.includes(level)) return json(res, 400, { error: "unknown level" });
      try { pi.setThinkingLevel(level); } catch (error) { return json(res, 500, { error: String((error && error.message) || error) }); }
      bump();
      return json(res, 200, { ok: true, level: pi.getThinkingLevel ? pi.getThinkingLevel() : level });
    }

    if (req.method === "POST" && url.pathname === "/compact") {
      try { lastCtx && lastCtx.compact && lastCtx.compact({}); } catch (error) { return json(res, 500, { error: String((error && error.message) || error) }); }
      bump();
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/abort") {
      try { lastCtx && lastCtx.abort && lastCtx.abort(); } catch {}
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "no such route" });
  };
}

async function start(pi, ctx) {
  if (server) return;
  lastCtx = ctx;
  token = randomUUID();
  server = createServer(handler(pi));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  port = server.address().port;
  await mkdir(GUI_DIR, { recursive: true });
  await sweep();
  // Publish before looking up the Herdr terminal: the panel can bind at once and
  // the identity arrives a few hc calls later.
  await publish(ctx);
  const cwd = ctx && ctx.sessionManager && ctx.sessionManager.getCwd ? ctx.sessionManager.getCwd() : process.cwd();
  findIdentity(cwd).then(async () => {
    if (!server) return;
    try { await publish(lastCtx || ctx); } catch {}
    bump();
  });
}

async function publish(ctx) {
  const mgr = ctx && ctx.sessionManager;
  const sessionId = mgr && mgr.getSessionId ? mgr.getSessionId() : randomUUID();
  const next = join(GUI_DIR, sessionId + ".json");
  if (regFile && regFile !== next) { try { await unlink(regFile); } catch {} }
  regFile = next;
  await writeFile(regFile, JSON.stringify({
    port,
    token,
    pid: process.pid,
    sessionId,
    sessionFile: mgr && mgr.getSessionFile ? mgr.getSessionFile() : null,
    name: mgr && mgr.getSessionName ? mgr.getSessionName() ?? null : null,
    cwd: mgr && mgr.getCwd ? mgr.getCwd() : process.cwd(),
    mode: ctx && ctx.mode,
    // Herdr's terminal/space/tab for this Pi (see findIdentity).
    terminal: identity ? identity.terminal : null,
    space: identity ? identity.space : null,
    tab: identity ? identity.tab : null,
    version,
    startedAt: new Date().toISOString(),
  }, null, 2));
}

export default function (pi) {
  if (process.env.PI_GUI_BRIDGE === "0") return;

  // The panel cannot call ctx.switchSession (event contexts do not have it), so
  // switching runs here, where the command context does. Hidden from the panel's
  // command list by the "gui-" prefix.
  pi.registerCommand("gui-switch-session", {
    description: "Switch Pi session (used by the pi-gui panel)",
    handler: async (id, ctx) => {
      const wanted = String(id || "").trim();
      if (!wanted) return;
      let sessions = [];
      try {
        sessions = await SessionManager.list(ctx.sessionManager.getCwd());
      } catch {
        return;
      }
      const match = sessions.find((s) => s && s.id === wanted);
      if (!match) return;
      try {
        await ctx.switchSession(match.path, { withSession: async () => {} });
      } catch {}
      bump();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // TUI only: an RPC or print-mode session already has a client driving it.
    if (!ctx || ctx.mode !== "tui") return;
    try {
      await start(pi, ctx);
      lastCtx = ctx;
      await publish(ctx);
      status = ctx.isIdle && ctx.isIdle() === false ? "working" : "idle";
      bump();
    } catch (error) {
      // A GUI bridge must never break Pi; stay quiet and keep the TUI working.
      server = null;
      console.error("[pi-gui-bridge] " + String((error && error.message) || error));
    }
  });

  for (const name of [
    "message_start", "message_end", "message_update",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "turn_start", "turn_end", "model_select", "thinking_level_select", "session_info_changed",
  ]) {
    pi.on(name, (_event, ctx) => { if (ctx) lastCtx = ctx; bump(); });
  }

  pi.on("agent_start", (_event, ctx) => { if (ctx) lastCtx = ctx; status = "working"; bump(); });

  // Streaming: keep the partial assistant message in the snapshot until it ends.
  pi.on("message_start", (event) => {
    if (event && event.message && event.message.role === "assistant") liveMessage = event.message;
  });
  pi.on("message_update", (event) => {
    if (event && event.message) liveMessage = event.message;
  });
  pi.on("message_end", (event) => {
    if (!event || !event.message || event.message.role === "assistant") liveMessage = null;
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx) lastCtx = ctx;
    liveMessage = null;
    status = ctx && ctx.isIdle && ctx.isIdle() !== false ? "idle" : status;
    bump();
  });

  // Pi is blocked on a dialog another extension opened: only the TUI can answer
  // it, so the panel points at the terminal instead of pretending to.
  pi.on("ui_prompt_start", (event) => {
    promptInfo = { kind: (event && event.kind) || "dialog", title: (event && event.title) || null };
    bump();
  });
  pi.on("ui_prompt_end", () => { promptInfo = null; bump(); });

  pi.on("session_shutdown", async () => {
    closeBrowser().catch(() => {});
    const file = regFile;
    regFile = "";
    if (file) { try { await unlink(file); } catch {} }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const list = waiters;
    waiters = [];
    for (const wake of list) { try { wake(); } catch {} }
    const current = server;
    server = null;
    if (current) { try { current.close(); } catch {} }
  });
}

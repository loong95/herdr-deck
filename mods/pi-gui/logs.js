// The conversation of an agent that keeps no bridge: Claude Code and Codex write a session
// log, and that is what this panel draws. Pure (no gpui, no herdr), so test/logs.test.mjs runs
// it under bare node — and the shapes here are read off real files, not guessed:
//
//   Claude Code  ~/.claude/projects/<cwd as dashes>/<session-uuid>.jsonl
//                lines of {type: user|assistant|attachment|system|api-request|…}, the two that
//                matter carrying a message whose content is text / thinking / tool_use, and a
//                tool result coming back as a user line with a tool_result block.
//   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
//                lines of {type: session_meta|response_item|event_msg|…}; response_item
//                payloads are message / reasoning / function_call / function_call_output.
//
// Both are turned into the shape the panel's buildRows already eats (Pi's own): entries of
// {type:"message", message:{role, content}}, a tool call being {type:"toolCall"} and a result
// a message of role "toolResult" that names its call.

// The app name Herdr reports for an agent's terminal ("claude-code", "codex", "pi").
export const KINDS = {
  claude: { label: "Claude Code", app: ["claude-code", "claude"] },
  codex: { label: "Codex", app: ["codex"] },
  pi: { label: "Pi", app: ["pi"] },
};

export function agentKind(app) {
  const name = String(app ?? "").toLowerCase();
  for (const kind of Object.keys(KINDS)) {
    if (KINDS[kind].app.includes(name)) return kind;
  }
  return null;
}

// Claude Code names a folder's project after its cwd: every character that is not a letter or
// a digit becomes a dash, so D:\Projects\app is D--Projects-app. The drive letter's case is not
// stable in files on disk, so a caller compares case-insensitively.
export function claudeSlug(cwd) {
  return String(cwd ?? "").replace(/[^A-Za-z0-9]/g, "-");
}

const textOfContent = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block.text === "string") return block.text;
      if (block && typeof block.content === "string") return block.content;
      if (block && block.content) return textOfContent(block.content);
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
};

const trimText = (value) => String(value ?? "").trim();

// --- Claude Code ------------------------------------------------------------

// One session's lines -> entries. Sidechains (a Task subagent's own conversation) are left
// out: they would interleave two conversations in one column.
export function claudeEntries(lines) {
  const out = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.isSidechain === true) continue;
    const message = entry.message;
    if (!message) continue;

    if (entry.type === "assistant") {
      const blocks = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!block) continue;
        if (block.type === "text" && trimText(block.text)) blocks.push({ type: "text", text: block.text });
        else if (block.type === "thinking" && trimText(block.thinking)) blocks.push({ type: "thinking", thinking: block.thinking });
        else if (block.type === "tool_use") blocks.push({ type: "toolCall", id: block.id, name: block.name || "tool", arguments: block.input ?? {} });
      }
      if (blocks.length) out.push({ id: entry.uuid || "a" + out.length, type: "message", message: { role: "assistant", content: blocks } });
    } else if (entry.type === "user") {
      const content = message.content;
      if (Array.isArray(content)) {
        // A tool result is a user line: one conversation entry per result, so the panel can
        // hang it on the card that asked.
        for (const block of content) {
          if (block && block.type === "tool_result" && block.tool_use_id) {
            out.push({
              id: (entry.uuid || "u") + ":" + block.tool_use_id,
              type: "message",
              message: { role: "toolResult", toolCallId: block.tool_use_id, content: [{ type: "text", text: textOfContent(block.content) }] },
            });
          }
        }
        const said = content.filter((block) => block && block.type === "text" && trimText(block.text))
          .map((block) => block.text).join("\n").trim();
        if (said) out.push({ id: entry.uuid || "u" + out.length, type: "message", message: { role: "user", content: [{ type: "text", text: said }] } });
      } else if (typeof content === "string" && trimText(content)) {
        out.push({ id: entry.uuid || "u" + out.length, type: "message", message: { role: "user", content: [{ type: "text", text: content }] } });
      }
    }
  }
  return out;
}

// What the header may say about a Claude session: its cwd and when it started. The first line
// with a cwd is often an attachment (a hook's report); a line that also names the session is
// the better answer, so a partial one is kept and the walk goes on.
export function claudeMeta(lines) {
  let partial = null;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || !entry.cwd) continue;
    const found = { cwd: entry.cwd, at: entry.timestamp || null, id: entry.sessionId || null };
    if (found.at && found.id) return found;
    partial = partial ?? found;
  }
  return partial ?? { cwd: null, at: null, id: null };
}

// --- Codex -----------------------------------------------------------------

const codexArgs = (raw) => {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return { raw: String(raw) }; }
};

export function codexEntries(lines) {
  const out = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.type !== "response_item" || !entry.payload) continue;
    const payload = entry.payload;
    const id = payload.id || "r" + out.length;

    if (payload.type === "message") {
      const text = (Array.isArray(payload.content) ? payload.content : [])
        .filter((part) => part && typeof part.text === "string").map((part) => part.text).join("\n").trim();
      if (!text) continue;
      // A developer message is Codex's own instructions, not the conversation.
      if (payload.role === "user") out.push({ id, type: "message", message: { role: "user", content: [{ type: "text", text }] } });
      else if (payload.role === "assistant") out.push({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
    } else if (payload.type === "reasoning") {
      const text = (Array.isArray(payload.summary) ? payload.summary : [])
        .map((part) => (typeof part === "string" ? part : part && part.text)).filter(Boolean).join("\n").trim();
      if (text) out.push({ id, type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } });
    } else if (payload.type === "function_call") {
      const name = payload.namespace ? payload.namespace + "." + payload.name : (payload.name || "tool");
      out.push({ id, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: payload.call_id || id, name, arguments: codexArgs(payload.arguments) }] } });
    } else if (payload.type === "function_call_output") {
      out.push({
        id,
        type: "message",
        message: { role: "toolResult", toolCallId: payload.call_id || id, content: [{ type: "text", text: textOfContent(payload.output) }] },
      });
    }
  }
  return out;
}

// What the header may say about a Codex session: where it ran, when, and the model it was on.
export function codexMeta(lines) {
  const meta = { cwd: null, at: null, id: null, model: null };
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry) continue;
    const payload = entry.payload;
    if (entry.type === "session_meta" && payload) {
      meta.cwd = payload.cwd ?? meta.cwd;
      meta.id = payload.id ?? meta.id;
      meta.at = payload.timestamp ?? meta.at;
    } else if (entry.type === "event_msg" && payload && payload.thread_settings && payload.thread_settings.model) {
      meta.model = meta.model ?? payload.thread_settings.model;
    }
    if (meta.cwd && meta.model) break;
  }
  return meta;
}

// The conversation of one log, whatever kind it is: entries for buildRows.
export function entriesFor(kind, lines) {
  if (kind === "claude") return claudeEntries(lines);
  if (kind === "codex") return codexEntries(lines);
  return null;
}

export function metaFor(kind, lines) {
  if (kind === "claude") return claudeMeta(lines);
  if (kind === "codex") return codexMeta(lines);
  return { cwd: null, at: null, id: null };
}

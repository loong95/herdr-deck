// The display model behind the Pi GUI: pure functions, no I/O, so node --test
// can exercise them without a Pi session.

/** Rows the panel draws, newest last; the panel reverses for layout. */
export function textOf(blocks) {
  return (blocks || [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function oneLine(value, max = 140) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  } catch {
    text = String(value);
  }
  text = String(text ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) + "…" : text;
}

const SUMMARY_KEYS = ["command", "path", "file_path", "query", "pattern", "url", "prompt", "script", "description"];

/** The one line a tool card shows: the most telling argument. */
export function callSummary(args) {
  const object = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  for (const key of SUMMARY_KEYS) {
    if (typeof object[key] === "string") return oneLine(object[key]);
  }
  // No arguments (or none that say anything): an empty card beats "{}".
  return Object.keys(object).length ? oneLine(object) : "";
}

const MERMAID = /^```mermaid[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;

/** Pulls mermaid fences out of a message: the text without them, and the sources. */
export function splitMermaid(text) {
  const blocks = [];
  const rest = String(text || "").replace(MERMAID, (_whole, code) => {
    blocks.push(String(code).trim());
    return "▤ diagram";
  });
  return { text: rest.trim(), blocks };
}

/**
 * Turn branch entries (oldest first) into rows: user text, assistant text,
 * collapsible thinking, and one card per tool call with its result attached.
 */
export function buildRows(branch, maxRows = 400) {
  const results = new Map();
  for (const entry of branch) {
    const message = entry && entry.type === "message" ? entry.message : null;
    if (message && message.role === "toolResult" && message.toolCallId) {
      results.set(message.toolCallId, textOf(message.content));
    }
  }

  const rows = [];
  for (const entry of branch) {
    if (!entry || entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const id = entry.id || "e" + rows.length;

    if (message.role === "user") {
      const text = textOf(message.content);
      if (text) rows.push({ key: "u" + id, kind: "user", text });
      continue;
    }
    if (message.role !== "assistant") continue;

    (message.content || []).forEach((block, index) => {
      if (!block) return;
      const key = "a" + id + "-" + index;
      if (block.type === "text" && block.text && block.text.trim()) {
        rows.push({ key, kind: "assistant", text: block.text.trim() });
      } else if (block.type === "thinking" && block.thinking && block.thinking.trim()) {
        rows.push({ key, kind: "thinking", text: block.thinking.trim() });
      } else if (block.type === "toolCall") {
        rows.push({
          key,
          kind: "tool",
          name: block.name || "tool",
          summary: callSummary(block.arguments),
          result: results.get(block.id) || "",
        });
      }
    });
  }

  return rows.length > maxRows ? rows.slice(rows.length - maxRows) : rows;
}

// The wire between the bridge (a Pi extension) and the panel (a Herdr mod).
//
// Both ends are installed separately — the panel here, the bridge where Pi runs, sometimes on
// another machine — so they will drift. Two rules keep that from being a mystery:
//
//   protocol      a number in every JSON answer. The panel speaks 1; another number is said
//                 out loud instead of drawing a field it guessed the meaning of.
//   capabilities  what this bridge can be asked for. A panel hides what is missing, so an old
//                 bridge degrades instead of failing.
//   code          an error carries a word as well as a sentence: "busy", "no-session",
//                 "forbidden", "bad-request".
export const PROTOCOL = 1;

export const CAPABILITIES = [
  "state", // long-polled snapshot + rows window
  "rows", // older rows, on demand
  "meta", // model, thinking levels, commands
  "files", // @-mention candidates
  "sessions", // list and switch
  "prompt", // a user message, with images
  "model",
  "thinking",
  "compact",
  "abort",
  "diagram", // a mermaid PNG, for a panel on another machine
] as const;

// A body as it goes on the wire: its own fields, and the protocol this server really speaks
// (so a body that carried one of its own cannot claim another version).
export function shaped(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), protocol: PROTOCOL };
}

// An error body: the sentence the panel shows, and the word it may act on.
export function fail(code: string, message?: string): { code: string; error: string } {
  return { code, error: message ?? code };
}

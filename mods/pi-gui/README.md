# pi-gui — a native GUI for Pi inside Herdr

Herdr mods draw native GPUI: no webview, no HTML. So the GUI is a real Herdr
panel that talks to Pi over localhost HTTP — on this machine, or through
herdr-core on another one.

## Pieces

| Piece | Path | Role |
|---|---|---|
| bridge (Pi extension) | `~/.pi/agent/extensions/pi-gui-bridge/` | `index.ts` (server) + `rows.ts` (display model) + `rows.test.mjs` |
| panel (Herdr mod) | `~/.config/herdr-app/mods/pi-gui/` | transcript, pickers, composer |

Pi writes `~/.pi/agent/gui/<sessionId>.json` with `{port, token, pid, sessionId,
cwd, terminal, space, tab}`. Herdr gives a terminal no env vars naming it, so the
bridge finds its own terminal by matching `process.pid` against
`hc get <terminal> --json` → `foreground.pid`, and rewrites the file once it knows.

Set `PI_GUI_BRIDGE=0` to load the extension without its server.

## Open it

```sh
# beside the pi terminal t7 (terminal id from: herdr-app ls)
herdr-app do pane.split '{"direction":"right","mod":"pi-gui","props":{"terminal":"t7"}}'
# a tab whose only pane is the GUI, bound by folder
herdr-app do tab.new '{"mod":"pi-gui","props":{"cwd":"D:/Projects/api"}}'
# the key: ctrl-alt-p (keys.json -> "mod.open:pi-gui") shows the panel alone,
# or the terminal alone, or opens the panel if this tab has none yet.
# open with a picker already up: "model" | "thinking" | "command" | "file" | "session"
herdr-app do pane.split '{"direction":"right","mod":"pi-gui","props":{"terminal":"t7","open":"model"}}'
# a Pi on another Herdr machine: same panel, machine-qualified terminal
herdr-app do pane.split '{"direction":"right","mod":"pi-gui","props":{"terminal":"10.0.0.5/t7"}}'
# …or by machine and folder, with no terminal named
herdr-app do tab.new '{"mod":"pi-gui","props":{"machine":"10.0.0.5","cwd":"/srv/api"}}'
# …or with the composer already holding text
herdr-app do pane.split '{"direction":"right","mod":"pi-gui","props":{"terminal":"t7","seed":"/co"}}'
```

By command instead of the key:

```sh
herdr-app do mod.open --name pi-gui   # the switch; works from any state
herdr-app do pi-gui.toggle            # same switch while the panel is on screen
herdr-app do pi-gui.terminal          # leave the panel for the terminal alone
```

The command palette does **not** list it: `mod.open` takes a required `name`
argument and the palette only offers commands it can run on its own, and a mod's
`<mod>.<command>` is never listed. Shell and keys.json are the command forms.
`pi-gui.toggle` (the mod's own command) is delivered to copies that are on
screen, so it answers while the panel is visible and reports "unknown command"
once the panel is zoomed away; `mod.open` is the one that always works.

There is also a clickable entry: right-click a Pi terminal →
**Pi panel** (`mods/menu-pi`, a clone of Herdr's `menu` with one row added, wired
by `"terminal_menu": "menu-pi"` in `layouts/deck.json`). Its hint shows
`ctrl-alt-p`, and it opens the same copy — with two differences that come from
being a click rather than a key:

- **it shows the panel, it never swaps.** A key press is a toggle ("show what is
  not showing"); a right-click on a terminal means "the panel for this one", so
  the panel is split in beside it — or the tab's existing panel comes forward —
  and stays in front.
- **the clicked terminal is carried, not guessed.** `mod.open` takes no props and
  a right-click does not have to move the keyboard focus, so the row leaves
  `{terminal, pane, cwd}` in `shared("pi-gui.target")` and the panel reads it once
  (15 s, then it is stale). That is what makes the entry work for a Pi on another
  machine while the focus sits in a local tab.

Shift+right-click reaches it even when the program owns the mouse.

`ctrl-alt-p` is one key and one visible thing: the key runs `mod.open:pi-gui`,
which starts a copy as an overlay; that copy reads live data and turns itself
into what you asked for —

| What the tab shows now | What the key does |
|---|---|
| a Pi terminal and the panel (split) | zooms the panel: it alone fills the tab |
| the panel alone | unzooms, then zooms the terminal: it alone fills the tab |
| the terminal alone | unzooms, then zooms the panel |
| no panel at all | splits one in beside the terminal, then zooms it |

`pane.zoom` is "show only this pane, or all again", so swapping from one zoomed
pane to the other is unzoom-then-zoom; the hidden side keeps running (a Pi in a
zoomed-away pane is still working).

`pane.focus` **moves the tab's zoom to the pane it focuses** (measured: with
the terminal zoomed, focusing the panel moves `zoomed` from the terminal to the
panel). So showing a pane alone is one call when the tab is already zoomed on
the other side, and `pane.zoom` on top of that toggles the zoom back **off** —
that is what left a right-click as a split whenever the terminal was the zoomed
pane, both before and after the timing fix. Only a tab zoomed on nothing gets
`pane.zoom`.

Each step **waits for the change it asked for** instead of sleeping a tick: the
pane list a mod reads is the host's last snapshot, so "the split is up" is only
true once `panes()` says so (`waitFor`, 40 ms apart, deadline 4–5 s, and
`null` at the deadline so the overlay always closes). That snapshot guess used
to be "one command per 260 ms", which is why a right-click sometimes left the
**split** up instead of the panel alone: the pane was not in the list yet when
the zoom step looked, the step was skipped, and the overlay closed over a split
tab. A tab that already has a panel is never split again — two panels in one tab
are two copies of the same conversation.

Losing and finding the bridge: a registration can outlive a killed Pi, so every
candidate is probed before use, and a candidate that matches nothing about this
panel is only taken when it is the *only* Pi on the machine — a dead Pi in another
folder can never hijack the panel. While unbound the panel watches
`~/.pi/agent/gui` with `watchFolder` and also looks again every 3 s, so a Pi
started or restarted later binds by itself. When nothing answers it says so with
numbers: "No live Pi bridge — 3 registrations, 1 for this tab or folder, 0
answering".

Binding order: `props().terminal` > the Pi in the panel's own tab
(`info.tab` vs `props().pane`'s tab, else `focused().tab`) > same folder >
read-only JSONL fallback. A name beats a guess: a panel split in beside another
terminal binds to the terminal it was opened for even before it has the keyboard,
and its own tab is used instead of the focused one for the same reason. Every
candidate is probed first, so a registration left by a force-killed Pi is skipped.
On another machine both sides are compared without their `machine/` prefix: the
bridge names its terminal, tab and space as its own machine does.

`mod.json` sets `"focusable": true`, so `pane.go` hands the panel the keyboard;
it focuses its own composer on open and on click.

## What the panel does

- **Transcript** in chat order and **process folded away**: runs of thinking and
  tool calls collapse into one row by default —
  `▸ 12 steps · codemode ×8, read ×3 · thinking 1.4k  show` — so the panel reads
  as a conversation. Clicking the row unfolds the individual steps, where each
  tool card still opens to show its result. Answers render as markdown
  (`TextView.markdown`) in user/assistant bubbles. The column is
  `flex_col_reverse`, so the newest row sits at the bottom. **Only the newest
  screenful is held and drawn** (40 rows): the poll asks for
  `/state?…&rows=40`, older pages come from `/rows?before=<index>&count=40` when
  the `↑ earlier · N rows` chip at the top is clicked, and the header reads
  `40 / 200 rows`. A 400-row session used to cost a 670 KB response and a full
  re-render on every poll. The scroll area
  carries a `ScrollHandle` and pins itself to the newest row after every update
  (`scroll_to_item(0)`), so a growing session never throws the view back to the
  top. Scrolling by hand stops that follow and shows a **↓ latest** chip that
  turns it back on.
- **A run in progress is drawn, not implied.** Streaming text shows Pi talking,
  but a long tool call, a slow first token or a remote round trip shows nothing
  at all — so while `busy` (or while a send is in flight) the transcript gains a
  spinner row at the newest position (`⠋ Pi is working`) and the header's status
  chip animates (`working ⠋`). Both are `frames`: GPUI swaps the strings at 90 /
  120 ms by itself, only while on screen, so no timer, no `notify` and no
  re-render per tick. The empty state's "Loading…" animates the same way.
  The children list is built above the `return` because the pane's tree is one
  huge expression and the loader rejects it once a call inside it (here
  `.children(…)`) is wrapped once more: `Unexpected token ';'` at the end of the
  statement, with no line to blame.
- **Model chip** → picker over `ctx.modelRegistry.getAvailable()`; `pi.setModel`.
- **Thinking chip** → off/minimal/low/medium/high/xhigh/max; `pi.setThinkingLevel`.
- **Sessions chip** → the folder's sessions (`SessionManager.list`, newest first,
  the current one marked ●) and switching to one, which replaces the live session
  in place. A brand-new session has no entries, so it is added to the list by hand.
- **Typed `/` and `@`** — the composer is the picker's filter, there are no
  buttons. A `/` or `@` word at the end of the composer opens the list, typing
  refines it, deleting the word closes it, and Enter completes the top match into
  the composer (it does not send). Then:
  - `/name` → `pi.getCommands()` (extension commands, prompt templates, skills)
    plus panel builtins: /model, /thinking, /compact, /stop. Enter runs a builtin
    in the panel; anything else goes through
    `sendUserMessage("/name …", {expandPromptTemplates: true})`.
  - `@path` → file search in the session's cwd (breadth-first, skips
    node_modules, dist, .git, …), so Enter inserts `@path` and Pi resolves it.
- **`⇤ Terminal` button** in the header — the panel and the terminal trade places
  with one click. It is there because the right-click entry lives on the
  *terminal*, which the panel is hiding: without it, once the panel filled the
  tab there was nothing to click to get back.
- **Blocked banner** — when another extension opens a Pi dialog, the panel shows
  what Pi is waiting for plus **Go to terminal** (`terminal.peek`). Pi's dialogs
  are rendered by its own TUI, so that is where they are answered.
- **Pasted images** — `InputState` reports a paste with no text as `paste_other`;
  a mod cannot read clipboard bytes (`read_from_clipboard` is text only), so the
  panel asks the system clipboard for a bitmap: it tries
  `powershell -NoProfile -STA … Clipboard.GetImage()` (with four attempts, since
  some apps publish the image a beat late), then `pwsh`, then `pngpaste` — no
  platform gate, whichever exists answers — saves the bitmap as a temp PNG and
  reads that file back as base64. `herdr-app do pi-gui.paste` runs the same thing
  from a command, and when it finds nothing the panel names every attempt and its
  exit code. The image waits as a `🖼 name ×` chip above the
  composer (up to 4, × drops one) and goes out with the next send as Pi's own
  image content block: `POST /prompt {message, images:[{data, mimeType}]}` →
  `sendUserMessage([{type:"text"},{type:"image"}…])`.
  `props {"attach": "<path>"}` attaches a file at startup, for checks.
- **Send / Stop** → `/prompt` (steer when busy) and `/abort`.

## Bridge protocol

```
GET  /state?t=<token>&since=<version>&wait=<sec>   long-poll; 204 when nothing changed
GET  /meta?t=<token>                              model, thinking levels, models, commands
GET  /files?t=<token>&q=<text>                    @-mention candidates in cwd
GET  /sessions?t=<token>                          sessions of this folder, newest first
POST /prompt?t=<token>   {"message":"...","images":[{"data":"<base64>","mimeType":"image/png"}]}
                                                  real user message (steer when busy)
GET  /rows?t=<token>&before=<index>&count=<n>    one page of older rows
GET  /diagram?t=<token>&hash=<hash>               a rendered mermaid PNG, for a
                                                  panel on another machine
POST /model?t=<token>    {"provider":"…","id":"…"}
POST /thinking?t=<token> {"level":"high"}
POST /sessions/switch?t=<token> {"id":"…"}        refuses while Pi is busy
POST /compact?t=<token>
POST /abort?t=<token>
```

`/state` returns `{version, state:{sessionId, sessionFile, name, cwd, model, busy,
status, prompt, usage, rows, from, total}}` — `rows` is a window of the
transcript (`rows=<n>`, default 40), `from` is its index and `total` the whole
row count. The built rows are cached in the bridge and rebuilt only when the
branch's length, last entry id or the streaming text length changes, so a bump
that carries no new content does not re-walk a long session. `rows` is already the display model
(`user`, `assistant`, `thinking`, `tool` with `summary` and `result`): shaping
happens in the bridge, so the panel stays a renderer. Events are coalesced to one
bump per 120 ms, so token streaming does not cost one request per token.

Two things worth knowing:

- `ctx.switchSession` only exists on the *command* context, so the panel's switch
  goes through the bridge's own `/gui-switch-session` command (by id, since paths
  have spaces). Its name is filtered out of the panel's command list.
- A session switch reloads extensions, so the bridge closes its server, comes back
  on a new port and rewrites its registration; the panel notices the drop, waits
  2.5 s and rediscovers. That is expected, not a failure.

The bridge only starts when `ctx.mode === "tui"`; RPC and print-mode sessions
already have a client driving them. A bridge failure is swallowed so it can
never break Pi.

## Tests

```sh
cd ~/.pi/agent/extensions/pi-gui-bridge
node --test rows.test.mjs
```

Covers the display model only (row building, tool summaries, trimming), which is
why it lives in `rows.ts` with no I/O. The panel and the server are checked by
`herdr-app check` and by looking at the window.

## Fallback: read-only

With no live bridge (Pi not running, or an old Pi), the panel falls back to
Pi's session JSONL — `~/.pi/agent/sessions/--<cwd>--/*.jsonl`, watched with
`watchFolder` — and renders the active branch read-only.

## Pi on another machine

A Pi on any Herdr machine (`hc machine ls`) gets the same panel. The only extra
step is once per machine: the bridge is a Pi extension, so it has to be installed
where Pi runs, and Pi restarted there.

```powershell
./install.ps1 -Remote 10.0.0.5
```

Where this panel looks is decided per panel, in this order:

| Given | Machine |
|---|---|
| `props.machine` | exactly that |
| `props.terminal` = `"10.0.0.5/t7"` | the machine in the address |
| its own tab (a panel inside a remote space) | that tab's machine |
| nothing of the above | this computer |

It then reads that machine's `~/.pi/agent/gui/` (`exec {on}` + `readTextFile {on}`)
and speaks HTTP to the bridge found there with one `curl` per request, run on that
machine through herdr-core. So nothing is exposed: the bridge still listens on
127.0.0.1, and there is no tunnel to hold open.

What that costs, and how the awkward parts are handled:

- **Round trips.** A long poll (`wait=25`) is one process there per 25 s; each
  send, model change or file search is one round trip (~0.2–0.5 s). The panel
  shows the same "working" as always while it waits.
- **Big bodies.** Windows caps a command line at 32 kB and an image is megabytes,
  so a body over ~20 kB is written here and piped to the other machine with
  `hc file write` (stdin, no limit); `curl` posts it from that file.
- **Diagrams.** Mermaid is rendered where Pi runs (headless Chrome there). The
  panel asks `/diagram` for the PNG once, keeps it in
  `~/.config/herdr-app/mods/pi-gui-cache/mermaid/` and draws that. Without a
  browser on that machine the row says so instead.
- **Watching.** A folder on another machine cannot be watched, so the read-only
  fallback re-reads it every 3 s instead of on change.
- **Writing.** A mod writes only where `mod.json` grants it
  (`capabilities.fs.write`), and a linked mod folder resolves to its real path,
  which no grant matches — so the cache lives in the sibling folder
  `mods/pi-gui-cache`, named `../pi-gui-cache` in the manifest.

## Known limits
- Image paste uses PowerShell's clipboard (Windows) or `pngpaste` (macOS, if
  installed). Linux has no command wired yet; there the paste reports
  "Clipboard holds no image" plus the attempts it made. Typing `@path` to an
  image file still works everywhere.
- The transcript shows the active branch, newest 400 rows; the session file keeps
  all of it.
- A remote panel is slower to answer than a local one (one round trip per action),
  and it needs that machine's core reachable: when it is not, the header says
  which machine and the last error says why.
- A space named after its folder turns into `~` when the Pi inside it runs with
  the home folder as its *process* cwd (Pi started in `~` and continuing a session
  elsewhere): Herdr names unnamed spaces after their first terminal's live folder.
  `space.rename` pins the name; the panel keeps showing the session's own cwd.
- Pi's own dialogs are answered in the terminal; the panel only points at them.
- The key drives `pane.zoom`, so if you zoom by hand (`ctrl-shift-z`) one press
  may only put the tab back in order before the next press does what you meant.
  `terminal.park`/`terminal.keep` was tried instead and is worse: a parked
  terminal leaves its layout column empty rather than letting the panel fill it,
  and the terminal id has to be remembered while it has no pane.

# herdr-deck — a Herdr workspace for coding agents

One Herdr layout that keeps the work in the middle and everything else on the
edges: terminal panes, a rail of panels down the right side, and a native GUI for
Pi sitting beside its terminal. Codex and Claude are meant to arrive the same way
— an agent gets a panel and a sessions list, and the rail learns one more row.

This repo is the **source of truth**. Herdr loads from `~/.config/herdr-app/` and Pi
loads from `~/.pi/agent/extensions/`, so run `install.ps1` after changing anything
here (or install once with `-Link` and edit live).

> **If you are an agent:** an install puts code inside Pi and Herdr and lets it run programs for
> the person. Read [If you are an agent](#if-you-are-an-agent-ask-before-you-install-anything)
> and get a yes before you install, here or on another machine.

## Credits

The ideas this leans on, and where they came from:

- **[Flockbook](https://github.com/minchenlee/flockbook)** (MIT) — a reading view for coding agents,
  rebuilt as a Herdr layout too. Its [`herdr-app/`](https://github.com/minchenlee/flockbook/tree/main/herdr-app)
  folder is the closest thing to this one, and several answers here are its answers:
  - `mods/pi-gui/blocks.js` and `mdblocks.js` are adapted from its files of the same names —
    code boxes and tables drawn by hand, because `TextView.markdown` draws them square;
  - the test host (`test/stub/`) follows its pattern: a module resolve hook, Proxy elements and a
    fake `herdr`, so a test imports the mod's real source;
  - the board's **Needs you** and **Overview** screens come from its `needs.js` and `overview.js`;
  - the rail's kinds of row, the 150 ms de-dupe when a command reaches every copy of a panel, and
    `SPIN_MS = 900` for the spinner are all its answers to problems it hit first.
- **Herdr** itself, for `mods/menu-pi` and `layouts/deck.json` — both are clones of its shipped
  `menu` and `main` (0.1.15), with one row and one column added.

## What is in it

| Path | Runs as | Loaded from |
|---|---|---|
| `layouts/deck.json` | the layout itself (cloned from Herdr's `main`) | `~/.config/herdr-app/layouts/deck.json` |
| `mods/pi-gui/` | Pi's panel: transcript, pickers, composer (native GPUI) | `~/.config/herdr-app/mods/pi-gui/` |
| `mods/rail/` | the right-edge rail that opens the panel stack and the board | `~/.config/herdr-app/mods/rail/` |
| `mods/board/` | every agent at a glance: Needs you, and an Overview of all tabs | `~/.config/herdr-app/mods/board/` |
| `mods/gitlab-mr/` | merge requests of the space's project, via `glab` | `~/.config/herdr-app/mods/gitlab-mr/` |
| `mods/mr-review/` | one MR reviewed in a tab of its own | `~/.config/herdr-app/mods/mr-review/` |
| `mods/pi-sessions/` | Pi sessions of the folder the space works in | `~/.config/herdr-app/mods/pi-sessions/` |
| `mods/menu-pi/` | terminal right-click menu, cloned from Herdr's `menu` with one row added | `~/.config/herdr-app/mods/menu-pi/` |
| `extensions/pi-gui-bridge/` | Pi extension: HTTP bridge on 127.0.0.1 | `~/.pi/agent/extensions/pi-gui-bridge/` |

Two of those are clones of Herdr's own mods rather than imports: `menu-pi`
(`menu` 0.1.15) and `deck.json` (`main` 0.1.15). A Herdr update means re-cloning both
from the new version and re-applying the additions — one checklist, one place.

`mods/pi-gui/` is the deep end and has its own README: the key behaviour, the
bridge protocol, remote machines, known limits.

MIT (see LICENSE). `mods/pi-gui/blocks.js` and `mdblocks.js` are adapted from
[Flockbook](https://github.com/minchenlee/flockbook)'s herdr-app mod, which is MIT too; the honour is
in the files themselves, and the Credits section says what else came from there.

## The layout

`layouts/deck.json` keeps Herdr's own shell (sidebar, tabs, status strip, the pane
header) and adds one column on the right:

```
sidebar   268 px   brand (workspace-chrome) / spaces / agents / footer
work               tabs
                   work-body, padding 8, gap 8
                     screens    stack: main (the tab's panes) | board   — the board takes the middle
                     panel      stack: files | changes          hidden
                     sidepanel  stack: gitlab-mr | pi-sessions  hidden, the rail opens it
                     rail       the icon rail, 44 px
                   status (workspace-status)
```

`screens` is what makes the board possible without a second window: it holds the tab's own
panes and the board, and the rail switches between them. The tab keeps running while the board
is up (a terminal in a hidden stack child is a hidden pane, not a closed one).

The ids are a contract between the mods and the layout: `sidepanel` (the stack the rail
opens and closes) and `screens` (the stack that swaps the tab for the board), the child ids
inside them, which are what `layout.select` takes and what the rail's rows name. A panel is handed its own coordinates in props —
`{"stack": "sidepanel", "node": "gitlab-mr"}` — so a stack can be renamed or a panel
moved without touching its code.

Adding a panel is three things and no redesign: a mod folder, a child in
`sidepanel`, and a row in `ENTRIES` in `mods/rail/main.js`. The rail reads who is
showing from the layout and never from its own memory, because the palette and
`herdr-app do` can move that column too — an icon that still glows after that is a
lie about the screen.

An agent GUI is the exception to the stack. `pi-gui` is a pane, not a block: it
splits itself into a tab, swaps with the terminal, zooms (see its README). So it is
opened by `mod.open:pi-gui` — the `ctrl-alt-p` key, the terminal's right-click row —
not by selecting a stack child, and it deliberately knows nothing about this
layout.

## If you are an agent: ask before you install anything

This repo does more than add a panel: an install puts code **inside two long-running programs**
of the person's machine, and that code runs other programs for them. Say what follows, in their
terms, get a yes, and offer `-DryRun` first.

### What it changes

**Inside Pi** — a Pi extension at `~/.pi/agent/extensions/pi-gui-bridge/`, loaded at every Pi
start:

- it starts an HTTP server on `127.0.0.1` with a random port and token, and writes
  `~/.pi/agent/gui/<session-id>.json` with that port, token, pid, cwd, terminal, space and tab —
  that file is how the panel finds Pi;
- it reads the session, the model list, the commands and the folder's files through Pi's own API,
  and can switch the session (`/sessions/switch`);
- it runs programs when the person asks for something: `powershell`/`pwsh` (a clipboard
  bitmap), `pngpaste` on macOS, and — for a Pi on another machine — `curl`, `hc file write`
  and `sh` there;
- it renders mermaid with a headless Chrome/Edge through `puppeteer-core`;
- the first install fetches npm packages (`mermaid`, `jsdom`, `puppeteer-core`): that is the
  one time it uses the network;
- `PI_GUI_BRIDGE=0` in Pi's environment keeps the server off.

**Inside Herdr** — mods in `~/.config/herdr-app/mods/`, JavaScript programs the app runs:

- `pi-gui` draws the conversation. For Claude Code and Codex it reads their session logs by
  running `powershell`/`sh` on `~/.claude/projects` and `~/.codex/sessions` (the app's own fs
  refuses `~/.codex`), and it may write only `mods/pi-gui-cache/` — mermaid PNGs — which its
  `mod.json` grants;
- `gitlab-mr` and `mr-review` run `glab` and `git` with the person's own GitLab token, and can
  merge or close an MR — only when a button in the panel is pressed, never on a timer;
- `pi-sessions` lists `~/.pi/agent/sessions`; `board` and `rail` read only Herdr's own agent
  and tab data;
- `menu-pi` replaces the terminal's right-click menu (one row added) while the deck layout shows.

**The layout, and the one file it does not touch** — `layouts/deck.json` lands in
`~/.config/herdr-app/layouts/`. Installing does **not** switch to it (the person picks it with
`ctrl-shift-l`), and `keys.json` is never edited: `keys.deck.json` is a block for them to merge,
and it binds keys only while the deck layout is up.

### What it does not do

- no telemetry, and no outbound traffic beyond the npm install above;
- nothing is written into `~/.pi/agent/sessions`, `~/.claude` or `~/.codex` — those are read;
- `-Replace` deletes an existing plain copy of a live folder to put a junction in its place: say
  so before using it;
- `-Remote <machine>` writes files onto **another computer** and runs `npm install` there: ask
  about that machine separately.

### The order to do it in

1. `./install.ps1 -DryRun` and show the person the plan.
2. Ask, and wait for a yes.
3. `./install.ps1` — or `-Link` if they mean to edit this repo live.
4. Say what has to restart: Pi (extensions load at start) and Herdr (a linked mod is not
   hot-reloaded).
5. Offer `keys.deck.json` for the `ctrl-alt-p` key; do not merge it unasked.

## Install

```powershell
./install.ps1                    # copy files into place (keeps node_modules where it is)
./install.ps1 -Link              # junction instead: edit here, Herdr reloads live
./install.ps1 -Link -Replace     # swap an older plain copy for the junction
./install.ps1 -DryRun            # say what would happen, write nothing
./install.ps1 -Remote 10.0.0.5   # the Pi bridge on another Herdr machine
```

### A test home, before touching your own

herdr-app reads `$HERDR_APP_HOME` when it is set, and so does this script — the same order
(`-HerdrHome`, then the variable, then `~/.config/herdr-app`), so a layout can be tried
without going near the one that is running. The Pi extension is left alone there: it belongs to
the Pi that runs, not to a layout.

```powershell
$env:HERDR_APP_HOME = "$env:TEMPdeck-test-home"
./install.ps1                    # only that folder is written
herdr-app                        # a second window, on the test home
# in it: ctrl-shift-l -> 'deck'; close the window and delete the folder afterwards
```

`-Link` makes the live folders junctions to this repo, so the running app reads
these files directly. Herdr reloads a mod on save when it watches the mod folder
itself; a junction is skipped by that watcher, so a linked panel keeps drawing the
code it started with until Herdr restarts (a save does reload an unlinked copy,
which is the way to see a change without restarting). Pi needs a restart for
extension changes either way. It refuses to replace a folder that is not already a
link pointing here unless `-Replace` says so — that is the switch that turns the
old hand-copied mods into links.

The layout is one file and lands in a folder full of other layouts, so it is linked
file by file (a hard link, which needs no admin rights) rather than as a folder.

## Claude Code and Codex, without a bridge

Pi is the only agent with an extension API, so it is the only one with a live bridge. The other
two are read from the session logs they leave behind, and the same panel draws them — read-only,
with the agent's name in the header and `read-only · Claude Code` (or `Codex`) under the
composer:

```powershell
# beside the terminal it is about (no props: it looks at the terminal of its own tab)
herdr-app do pane.split '{"direction":"right","mod":"pi-gui"}'
# or ask for one directly
herdr-app do tab.new '{"mod":"pi-gui","props":{"agent":"claude","cwd":"D:/Projects/api"}}'
herdr-app do tab.new '{"mod":"pi-gui","props":{"agent":"codex"}}'
```

| Agent | Where the conversation comes from | How it is read |
|---|---|---|
| Pi | the bridge (live), else `~/.pi/agent/sessions/` | `readTextFile` |
| Claude Code | `~/.claude/projects/<cwd as dashes>/<session>.jsonl` | one `powershell` (or `sh`) call: the newest session in that folder, its last 600 lines |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | the same, over the newest rollout |

`mods/pi-gui/logs.js` turns each format into the rows the panel already drew for Pi: a
Claude `tool_use` block and a Codex `function_call` become tool cards, their results hang on the
card that asked, thinking stays folded, and the noise (attachments, `api-request`, token counts,
Codex's own instructions) is dropped. The formats were read off real files, and the tests that
check them run against the real folders when they exist.

Three things worth knowing, each found the hard way:

- **Neither folder is read through the app's fs any more.** `~/.codex` is off limits: a
  `readTextFile` or `readdir` under it never answers, and it takes the whole mod runtime
  with it — every panel in the window stops until the tab is closed (Herdr keeps the agent's
  `auth.json` there). `~/.claude` answers, but slowly enough to leave the panel on "Loading"
  for half a minute. A shell has neither problem, and it can print the tail of a 40 MB log
  instead of the first 1 MiB a read would stop at.
- **Codex shows the newest session, not the one for a folder.** A rollout's name carries its
  start time and its id, not its cwd, and every candidate would cost a process to look at. The
  header says which folder the session on screen ran in.
- **Read-only is real.** Nothing is typed into those terminals: approvals and answers are the
  agent's own TUI. A bridge for them — the way Pi's extension is one — is the next step, not
  a side effect of this.

## Keys

One file outside this repo has to know about the deck: `keys.json`. It takes the deck's keys
**only while this layout shows**, in a `layout:deck` section — a `global` entry would keep the
key on every other layout too. keys.deck.json is the block to merge in:

```json
{
  "layout:deck": {
    "ctrl-alt-p": "mod.open:pi-gui"
  }
}
```

Sections are `global`, `layout:<name>`, `terminal` and `mod:<name>`, and the more
specific one wins (Herdr's own AGENTS.md). Do not put a `mod:deck` section in: with one,
Flockbook's author found no key worked at all.

## Pi on another machine

The panel is not tied to this computer. A Pi running on a Herdr machine
(`hc machine ls`) gets the same transcript, pickers and composer; the panel
carries each request there through herdr-core, so the bridge keeps listening on
that machine's `127.0.0.1` and no port is exposed or tunnelled:

```powershell
./install.ps1 -Remote 10.0.0.5   # once: the bridge is a Pi extension, so it lives where Pi runs
# then restart the Pi on that machine (extensions load at start)

herdr-app do pane.split '{"direction":"right","mod":"pi-gui","props":{"terminal":"10.0.0.5/t7"}}'
herdr-app do tab.new '{"mod":"pi-gui","props":{"machine":"10.0.0.5","cwd":"/srv/api"}}'
```

A panel opened inside a remote space needs no props at all: the machine of its own
tab is where it looks. Right-clicking a remote Pi terminal → **Pi panel** works
too: the row hands the panel the pane it was clicked on, not the focused one.
Discovery reads that machine's `~/.pi/agent/gui/`; polling is one `curl` there per
long poll (25 s), a send is one round trip, a body bigger than a command line
(32 kB everywhere on Windows) is piped over with `hc file write`, and a mermaid PNG
rendered there is fetched once into
`~/.config/herdr-app/mods/pi-gui-cache/mermaid/` so `image()` can draw it. The
read-only fallback works remotely too, re-reading the session folder every 3 s
(a folder on another machine cannot be watched).

## What the panels do

- **rail** — one cell per panel, an icon each. Clicking the glowing one closes the
  column; clicking another shows that one. A panel with something to report
  (gitlab-mr's MR count, or `!` for a failure) puts a badge on its icon through
  shared state, so the rail needs to know nothing about GitLab.
- **gitlab-mr** — the space's project and every open MR the token can see, grouped
  by project, the space's own one first; a row opens mr-review in a tab of its own.
  CI status is not shown: this GitLab leaves `pipeline` out of both list endpoints,
  so the verdict is `detailed_merge_status`.
- **mr-review** — changed files on the left, their diff on the right, merge and close
  along the top. Everything comes from the API: the repo does not have to be on
  this machine, and nothing is written into a local `.git`.
- **board** — two views of what the whole window is doing, from Herdr's own `agents()` and
  `spaces()`: **Needs you** lists every agent that is blocked (and opens its terminal), and
  **Overview** draws every open tab as a card, grouped by status or by workspace, with how long
  ago it changed. The rail's bell says how many are waiting: the board puts that count in shared
  state, the way gitlab-mr puts its MR count there, so neither has to know the other.
- **pi-sessions** — the folder's Pi sessions, newest first; a row opens that session
  in a tab of its own. A page is the most that is ever read: one `readdir` per row,
  and a session file only once its row is on screen.
- **pi-gui** — the conversation itself: transcript, model and thinking pickers,
  `/` commands, `@` files, pasted images, mermaid diagrams, and the ⇤ Terminal
  swap. Its README is the one to read before touching it.

## Tests

```powershell
npm test
```

Four harnesses, and none of them needs Herdr:

| Test | Checks |
|---|---|
| `test/rail.test.mjs` | the rail and the MR panel against one fake layout document, so what is checked is the protocol between them: who is showing, badges, hide and show |
| `test/mr-review.test.mjs` | what the review asks `glab` for, the file list it builds, what a confirmed dialog finally runs — no GitLab is ever touched |
| `test/pi-sessions.test.mjs` | a real temp sessions tree, and mostly call counts, because the point of the panel is what it does *not* read |
| `test/board.test.mjs` | the board's names, groups and counts, and the rail rows that open it |
| `test/blocks.test.mjs` | the markdown splitter pi-gui draws code boxes and tables from (pure: bare node) |
| `test/mdblocks.test.mjs` | the code boxes and tables themselves, walked as an element tree |
| `test/pi-gui-wire.test.mjs` | the panel's half of the bridge protocol: a version apart is said, a missing capability is not offered |
| `test/logs.test.mjs` | Claude Code and Codex logs turned into rows (fixtures, plus the real folders when they exist) |
| `test/pi-gui-logs-panel.test.mjs` | the panel reading those logs: read-only rows, no re-draw, Codex through a shell, and a Pi log past 1 MiB read through `hc` (or a shell, when its JSON comes back cut) |
| `test/pi-gui-scroll.test.mjs` | following the transcript: what is pinned (the end of the column, not the newest row), and the wheel that stops it |
| `extensions/pi-gui-bridge/protocol.test.mjs` | the bridge's half: what every answer carries |
| `test/imports.test.mjs` | every mod loads, and its manifest has a place |
| `test/skeleton.test.mjs` | the layout, the mods, the rail's rows and `install.ps1` still agree with each other |
| `extensions/pi-gui-bridge/rows.test.mjs` | the display model only: row building, tool summaries, mermaid fence extraction |

### How a mod is tested

`test/stub/` stands in for the app, and `node --import ./test/stub/register.mjs` is what puts it
there (a module resolve hook). So a test imports the mod's **real file** —

```js
import Rail from "../mods/rail/main.js";
```

— and the `gpui-kit` / `gpui-base` / `herdr` / `fs/promises` imports inside it resolve to the
fakes. Nothing is copied, stripped or rewritten, so a failure points at a real line.

- `stub/element.mjs` — elements are Proxies: any chain of styling calls works, and what
  matters is kept (`child`/`children`, ids, handlers, text), so a test can walk the tree
  (`byId`, `textOf`) and fire a click.
- `stub/kit.mjs` and `stub/base.mjs` are **separate on purpose**: importing `Input` from
  `gpui-kit` fails here the way it fails in the app ("Could not find export 'Input' in
  module 'gpui-kit'"). Add a name to `base.mjs` when a mod starts using one.
- `stub/herdr.mjs` holds the world in `fake` (spaces, panes, the layout document, what `exec`
  answers) and what the mod asked for in `log`; `fake.onRun` lets a test move the layout the
  way the app would. `test/fake-cx.mjs` collects spawned work and timers, and
  `settle()` lets a task loop go instead of hanging the test.

The GPUI side itself is still checked with `herdr-app check mods/<name>` plus `herdr-app shot`:
a fake proves the logic, not the pixels.

## How it fits together

```
Pi terminal ── pi-gui-bridge (extension) ── HTTP 127.0.0.1:<port> ── pi-gui (mod)
                    │  /state (windowed rows, long-poll)                │ image(), TextView.markdown
                    │  /rows, /meta, /files, /sessions, /prompt, …      │ InputState, pickers
                    └  mermaid → headless Chrome → PNG in .cache/mermaid ┘

deck.json ── sidepanel stack ── gitlab-mr / pi-sessions ── glab, fs
          └─ rail ── layout() + run("layout.show|hide|select") + shared badges
```

The bridge answers a `protocol` number and a `capabilities` list on every reply, and
an error carries a `code` beside its sentence (extensions/pi-gui-bridge/protocol.ts).
The panel speaks 1: another number is a sentence on screen instead of a field whose meaning was
guessed, and a capability the bridge does not list (an older bridge, say) is not offered. That
matters because the two ends are installed apart — the panel here, the bridge where Pi runs,
sometimes on another machine.

Design notes worth keeping:

- A mod cannot hold a pipe, so the bridge speaks JSON over long-poll.
- A mod cannot read clipboard images; the clipboard's bitmap is saved by
  PowerShell and read back as base64.
- The panel can only draw what GPUI rasterizes: mermaid's own SVG comes out
  blank, hence the headless-browser PNG — and a diagram from another machine is
  carried over as bytes, since the panel can only draw local files.
- A mod writes only inside folders its `mod.json` grants, and those are named
  relative to the mod's folder, which `-Link` turns into a junction the app
  resolves away from the grant: the panel's cache therefore lives beside the mod
  (`mods/pi-gui-cache`, `"../pi-gui-cache"` in the manifest), where a grant holds
  in both install modes.
- Rows are windowed (40 per poll, `/rows` pages older ones) and cached by
  branch state, so a long session does not cost a full rebuild per poll.
- A layout change is not one of the things that re-renders a mod, so the rail asks
  for a look (`cx.notify`) once its commands have landed.
- Panels are cheap by construction: a hidden copy keeps its timers running, so
  every panel checks a shared value (or a folder listing) between the real
  requests and reads only what is on screen.

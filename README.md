# herdr-layout — a native Pi GUI for Herdr

A Herdr panel that talks to Pi over localhost HTTP: transcript, model and
thinking pickers, `/` commands, `@` files, pasted images, mermaid diagrams, and
a key that swaps it with the terminal.

This repo is the **source of truth**. Herdr and Pi load from
`~/.config/herdr-app/mods/` and `~/.pi/agent/extensions/`, so run `install.ps1`
after changing anything here (or install once with `-Link` and edit live).

## Layout

| Path | Runs as | Loaded from |
|---|---|---|
| `extensions/pi-gui-bridge/` | Pi extension: HTTP bridge on 127.0.0.1 | `~/.pi/agent/extensions/pi-gui-bridge/` |
| `mods/pi-gui/` | the panel (native GPUI) | `~/.config/herdr-app/mods/pi-gui/` |
| `mods/menu-pi/` | terminal right-click menu, cloned from Herdr's `menu` with one row added | `~/.config/herdr-app/mods/menu-pi/` |

`extensions/pi-gui-bridge/` needs `npm install` (mermaid, jsdom, puppeteer-core).

## Install

```powershell
./install.ps1            # copy files into place (keeps node_modules where it is)
./install.ps1 -Link      # junction instead: edit here, Herdr reloads live
./install.ps1 -Remote 10.0.0.5   # the bridge on another Herdr machine
```

`-Link` makes the live folders junctions to this repo, so the running app reads
these files directly. Herdr reloads a mod on save when it watches the mod folder
itself; a junction is skipped by that watcher, so a linked panel keeps drawing
the code it started with until Herdr restarts (a save does reload an unlinked
copy, which is the way to see a change without restarting). Pi needs a restart
for extension changes either way. It refuses to replace a folder that is not already a link
pointing here.

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
too: the row hands the panel the pane it was clicked on, not the focused one. Discovery reads that machine's `~/.pi/agent/gui/`; polling
is one `curl` there per long poll (25 s), a send is one round trip, a body bigger
than a command line (32 kB everywhere on Windows) is piped over with
`hc file write`, and a mermaid PNG rendered there is fetched once into
`~/.config/herdr-app/mods/pi-gui-cache/mermaid/` so `image()` can draw it. The
read-only fallback works remotely too, re-reading the session folder every 3 s
(a folder on another machine cannot be watched).

## Two edits live outside this repo

Both are the person's own files; `install.ps1` only reminds you:

- `~/.config/herdr-app/keys.json` → `"ctrl-alt-p": "mod.open:pi-gui"`
- `~/.config/herdr-app/layouts/<layout>.json` → `"terminal_menu": "menu-pi"`

## Tests

```powershell
cd extensions/pi-gui-bridge
node --test rows.test.mjs
```

`rows.ts` is pure on purpose (row building, tool summaries, mermaid fence
extraction), so it runs under bare `node`. The panel and the server are checked
with `herdr-app check mods/pi-gui` plus `herdr-app shot`.

## How it fits together

```
Pi terminal ── pi-gui-bridge (extension) ── HTTP 127.0.0.1:<port> ── pi-gui (Herdr mod)
                    │  /state (windowed rows, long-poll)                 │ image(), TextView.markdown
                    │  /rows, /meta, /files, /sessions, /prompt, …        │ InputState, pickers
                    └  mermaid → headless Chrome → PNG in .cache/mermaid ─┘
```

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

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
```

`-Link` makes the live folders junctions to this repo, so the running app reads
these files directly (Herdr hot-reloads a mod on save; Pi needs a restart for
extension changes). It refuses to replace a folder that is not already a link
pointing here.

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
  blank, hence the headless-browser PNG.
- Rows are windowed (40 per poll, `/rows` pages older ones) and cached by
  branch state, so a long session does not cost a full rebuild per poll.

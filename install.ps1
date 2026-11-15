# Puts this repo's sources where Herdr and Pi load them from.
#
#   ./install.ps1                     copy into place here
#   ./install.ps1 -Link               junction instead (edit here, Herdr reloads live)
#   ./install.ps1 -Link -Replace      swap an older plain copy for the junction
#   ./install.ps1 -Remote 10.0.0.5    put the Pi bridge on another Herdr machine
param([switch]$Link, [switch]$Replace, [string]$Remote)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridge = Join-Path $repo "extensions/pi-gui-bridge"

# --- another machine: the panel reaches Pi there, so the bridge has to live there
if ($Remote) {
  $files = @("index.ts", "rows.ts", "diagrams.ts", "package.json", "package-lock.json")
  $homeDir = ((hc exec --on $Remote 'printf %s "$HOME"') | Out-String).Trim()
  if (-not $homeDir) { throw "could not ask $Remote for its home folder (is it in 'hc machine ls'?)" }
  $dest = "$homeDir/.pi/agent/extensions/pi-gui-bridge"
  hc exec --on $Remote "mkdir -p '$dest'" | Out-Null
  foreach ($f in $files) {
    $from = Join-Path $bridge $f
    if (-not (Test-Path $from)) { continue }
    Get-Content -Raw -LiteralPath $from | hc file write --on $Remote "$dest/$f" | Out-Null
    Write-Host ("wrote " + $Remote + ":" + $dest + "/" + $f)
  }
  Write-Host "npm install on $Remote (mermaid, jsdom, puppeteer-core)…"
  hc exec --on $Remote "cd '$dest' && npm install --no-audit --no-fund" | Select-Object -Last 3
  Write-Host ""
  Write-Host "Now restart the Pi on $Remote (extensions load at start). The panel there"
  Write-Host "binds to it by itself; from this computer, open one for its terminal:"
  Write-Host "  herdr-app do pane.split '{""direction"":""right"",""mod"":""pi-gui"",""props"":{""terminal"":""$Remote/t7""}}'"
  exit 0
}

# --- the mods and the Pi extension: folders, so a junction can stand in for a copy
$targets = @(
  @{ name = "mods/rail";                live = Join-Path $env:USERPROFILE ".config/herdr-app/mods/rail" },
  @{ name = "mods/gitlab-mr";           live = Join-Path $env:USERPROFILE ".config/herdr-app/mods/gitlab-mr" },
  @{ name = "mods/mr-review";           live = Join-Path $env:USERPROFILE ".config/herdr-app/mods/mr-review" },
  @{ name = "mods/pi-sessions";         live = Join-Path $env:USERPROFILE ".config/herdr-app/mods/pi-sessions" },
  @{ name = "mods/pi-gui";              live = Join-Path $env:USERPROFILE ".config/herdr-app/mods/pi-gui" },
  @{ name = "mods/menu-pi";             live = Join-Path $env:USERPROFILE ".config/herdr-app/mods/menu-pi" },
  @{ name = "extensions/pi-gui-bridge"; live = Join-Path $env:USERPROFILE ".pi/agent/extensions/pi-gui-bridge" }
)

foreach ($t in $targets) {
  $source = Join-Path $repo $t.name
  $live = $t.live
  if ($Link) {
    if (Test-Path $live) {
      $item = Get-Item $live -Force
      if ($item.LinkType -eq "Junction") {
        if ($item.Target -eq $source) { Write-Host "already linked: $live"; continue }
        throw "$live is a junction to $($item.Target); remove it first"
      }
      if (-not $Replace) {
        throw "$live exists and is not a junction; it holds the live copy (rerun with -Replace to drop it and link instead)"
      }
      Remove-Item $live -Recurse -Force
      Write-Host "removed the plain copy at $live"
    }
    New-Item -ItemType Junction -Path $live -Target $source | Out-Null
    Write-Host "linked $live -> $source"
  } else {
    New-Item -ItemType Directory -Force -Path $live | Out-Null
    Copy-Item (Join-Path $source "*") $live -Recurse -Force
    Write-Host "copied $source -> $live"
  }
}

# --- the layout: one file, and the folder it lands in holds other layouts too, so it
# goes in file by file instead of junctioning the folder. A hard link needs no admin
# rights and reads as an ordinary file to Herdr — but it cannot cross drives, and a
# repo on D: with Herdr's home on C: is exactly that, so a symlink is tried next
# (that one does need admin or Developer Mode) and a copy is the last resort.
$layoutSource = Join-Path $repo "layouts/deck.json"
$layoutLive = Join-Path $env:USERPROFILE ".config/herdr-app/layouts/deck.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $layoutLive) | Out-Null
if ($Link) {
  $kind = if (Test-Path $layoutLive) { (Get-Item $layoutLive -Force).LinkType } else { $null }
  if ($kind -in @("HardLink", "SymbolicLink")) { Write-Host "already linked: $layoutLive" }
  else {
    if (Test-Path $layoutLive) {
      if (-not $Replace) { throw "$layoutLive exists; rerun with -Replace to overwrite it" }
      Remove-Item $layoutLive -Force
    }
    $linked = $false
    foreach ($type in @("HardLink", "SymbolicLink")) {
      try { New-Item -ItemType $type -Path $layoutLive -Target $layoutSource -ErrorAction Stop | Out-Null; $linked = $true; break }
      catch { }
    }
    if ($linked) { Write-Host "linked $layoutLive -> $layoutSource" }
    else {
      Copy-Item $layoutSource $layoutLive -Force
      Write-Host "copied $layoutSource -> $layoutLive"
      Write-Host "  (a hard link cannot cross drives and a symlink needs admin here, so this one is a copy:"
      Write-Host "   rerun install.ps1 after editing the layout file)"
    }
  }
} else {
  Copy-Item $layoutSource $layoutLive -Force
  Write-Host "copied $layoutSource -> $layoutLive"
}

Push-Location $bridge
if (-not (Test-Path "node_modules")) { npm install --no-audit --no-fund }
Pop-Location

Write-Host ""
Write-Host "One file outside this repo still has to know about it:"
Write-Host '  ~/.config/herdr-app/keys.json   "ctrl-alt-p": "mod.open:pi-gui"'
Write-Host ""
Write-Host "Then: restart the Pi in the terminal (extensions load at start),"
Write-Host "      press ctrl-alt-p, or right-click a Pi terminal -> Pi panel."
Write-Host "      ctrl-shift-l switches layouts: 'deck' is the one this repo owns."
Write-Host ""
Write-Host "An older copy of the layout may still sit in that folder as main-mr.json;"
Write-Host "it is not ours to delete, but switching to 'deck' once is enough to retire it."
Write-Host ""
Write-Host "A Pi on another Herdr machine needs its bridge there too:"
Write-Host "  ./install.ps1 -Remote <machine>      (then restart Pi on that machine)"

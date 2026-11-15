# Puts this repo's sources where Herdr and Pi load them from.
#
#   ./install.ps1                     copy into place here
#   ./install.ps1 -Link               junction instead (edit here, Herdr reloads live)
#   ./install.ps1 -Remote 10.0.0.5    put the bridge on another Herdr machine
param([switch]$Link, [string]$Remote)

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
    Write-Host "wrote ${Remote}:$dest/$f"
  }
  Write-Host "npm install on $Remote (mermaid, jsdom, puppeteer-core)…"
  hc exec --on $Remote "cd '$dest' && npm install --no-audit --no-fund" | Select-Object -Last 3
  Write-Host ""
  Write-Host "Now restart the Pi on $Remote (extensions load at start). The panel there"
  Write-Host "binds to it by itself; from this computer, open one for its terminal:"
  Write-Host "  herdr-app do pane.split '{""direction"":""right"",""mod"":""pi-gui"",""props"":{""terminal"":""$Remote/t7""}}'"
  exit 0
}

# --- this machine
$targets = @(
  @{ name = "mods/pi-gui";             live = Join-Path $env:USERPROFILE ".config/herdr-app/mods/pi-gui" },
  @{ name = "mods/menu-pi";            live = Join-Path $env:USERPROFILE ".config/herdr-app/mods/menu-pi" },
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
      throw "$live exists and is not a junction; remove it first (it holds the live copy)"
    }
    New-Item -ItemType Junction -Path $live -Target $source | Out-Null
    Write-Host "linked $live -> $source"
  } else {
    New-Item -ItemType Directory -Force -Path $live | Out-Null
    Copy-Item (Join-Path $source "*") $live -Recurse -Force
    Write-Host "copied $source -> $live"
  }
}

Push-Location $bridge
if (-not (Test-Path "node_modules")) { npm install --no-audit --no-fund }
Pop-Location

Write-Host ""
Write-Host "Two files outside this repo still have to know about it:"
Write-Host '  ~/.config/herdr-app/keys.json      "ctrl-alt-p": "mod.open:pi-gui"'
Write-Host '  ~/.config/herdr-app/layouts/*.json "terminal_menu": "menu-pi"'
Write-Host ""
Write-Host "Then: restart the Pi in the terminal (extensions load at start),"
Write-Host "      press ctrl-alt-p, or right-click a Pi terminal -> Pi panel."
Write-Host ""
Write-Host "A Pi on another Herdr machine needs its bridge there too:"
Write-Host "  ./install.ps1 -Remote <machine>      (then restart Pi on that machine)"

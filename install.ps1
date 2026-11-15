# Puts this repo's sources where Herdr and Pi load them from.
param([switch]$Link)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path

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

Push-Location (Join-Path $repo "extensions/pi-gui-bridge")
if (-not (Test-Path "node_modules")) { npm install --no-audit --no-fund }
Pop-Location

Write-Host ""
Write-Host "Two files outside this repo still have to know about it:"
Write-Host '  ~/.config/herdr-app/keys.json      "ctrl-alt-p": "mod.open:pi-gui"'
Write-Host '  ~/.config/herdr-app/layouts/*.json "terminal_menu": "menu-pi"'
Write-Host ""
Write-Host "Then: restart the Pi in the terminal (extensions load at start),"
Write-Host "      press ctrl-alt-p, or right-click a Pi terminal -> Pi panel."

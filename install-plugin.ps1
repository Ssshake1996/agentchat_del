param([string]$CodexCommand = 'codex')
$ErrorActionPreference = 'Stop'

# Register a new personal plugin while preserving other marketplace entries.
$source = Join-Path $PSScriptRoot 'plugins\agentchat-del'
$sourceManifest = Get-Content -LiteralPath (Join-Path $source '.codex-plugin\plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($sourceManifest.name -ne 'agentchat-del') { throw 'Invalid plugin source.' }
$destination = Join-Path $env:USERPROFILE 'plugins\agentchat-del'
$marketPath = Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json'
if (Test-Path -LiteralPath $marketPath) {
    $market = Get-Content -LiteralPath $marketPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($market.name -notmatch '^[A-Za-z0-9_-]+$' -or $null -eq $market.plugins) {
        throw 'Existing personal marketplace is invalid; no changes made.'
    }
} else {
    $market = [PSCustomObject]@{ name = 'personal'; interface = @{ displayName = 'Personal' }; plugins = @() }
}
$existing = @($market.plugins | Where-Object { $_.name -eq 'agentchat-del' })
if ($existing.Count -gt 1 -or ($existing.Count -eq 1 -and
    ($existing[0].source.source -ne 'local' -or $existing[0].source.path -ne './plugins/agentchat-del'))) {
    throw 'An existing agentchat-del entry points elsewhere; no changes made.'
}
if (Test-Path -LiteralPath $destination) {
    $installedManifestPath = Join-Path $destination '.codex-plugin\plugin.json'
    if (-not (Test-Path -LiteralPath $installedManifestPath)) { throw 'Destination is not this plugin; no changes made.' }
    $old = Get-Content -LiteralPath $installedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($old.name -ne 'agentchat-del') { throw 'Destination belongs to another plugin; no changes made.' }
}
Get-Command $CodexCommand -ErrorAction Stop | Out-Null
Get-Command node -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
}
if ($existing.Count -eq 0) {
    $entry = [PSCustomObject]@{
        name = 'agentchat-del'; source = @{ source = 'local'; path = './plugins/agentchat-del' }
        policy = @{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }; category = 'Productivity'
    }
    $market.plugins = @($market.plugins) + $entry
    New-Item -ItemType Directory -Path (Split-Path -Parent $marketPath) -Force | Out-Null
    [System.IO.File]::WriteAllText($marketPath, ($market | ConvertTo-Json -Depth 50), [System.Text.UTF8Encoding]::new($false))
}
& $CodexCommand plugin add ('agentchat-del@' + $market.name) --json
if ($LASTEXITCODE -ne 0) { throw 'Codex plugin installation failed; source was preserved.' }
Write-Host 'Installed. Open a new Codex chat to use AgentChat Delete.'

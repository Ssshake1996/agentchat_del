param([string]$Destination = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
# This optional installer only creates a shortcut. It never modifies Codex.
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$script = Join-Path $PSScriptRoot (([char]0x542f) + [char]0x52a8 + [char]0x5220 + [char]0x9664 + [char]0x7248 + 'Codex.vbs')
if (-not (Test-Path -LiteralPath $script)) { throw 'Keep install.ps1 inside the extracted codex-delete-only directory.' }
if (-not (Test-Path -LiteralPath $Destination -PathType Container)) { throw 'Shortcut destination must already exist.' }
$shortcutPath = Join-Path $Destination 'Codex Delete Only.lnk'
if (Test-Path -LiteralPath $shortcutPath) { throw ('Shortcut already exists; no file was replaced: ' + $shortcutPath) }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $wscript
$shortcut.Arguments = '"' + $script + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'Codex with a sidebar delete button'
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Output ('Created shortcut: ' + $shortcutPath)

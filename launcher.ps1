param(
    [string]$Executable = '',
    [int]$Port = 19379,
    [switch]$Doctor
)
$ErrorActionPreference = 'Stop'
try {
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $entry = Join-Path $PSScriptRoot 'src\launcher.mjs'
    $nodeArgs = @(('"' + $entry + '"'), '--port', [string]$Port)
    if ($Executable) { $nodeArgs += @('--exe', ('"' + $Executable + '"')) }
    if ($Doctor) {
        $directArgs = @($entry, '--port', [string]$Port, '--doctor')
        if ($Executable) { $directArgs += @('--exe', $Executable) }
        & $nodeCommand.Source @directArgs
        exit $LASTEXITCODE
    }
    $logDirectory = Join-Path $env:LOCALAPPDATA 'CodexDeleteOnly\logs'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $logDirectory ($stamp + '.log')
    $stderr = Join-Path $logDirectory ($stamp + '.error.log')
    $process = Start-Process -FilePath $nodeCommand.Source -ArgumentList $nodeArgs -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if ($process.ExitCode -ne 0) {
        $message = (Get-Content -LiteralPath $stderr -Encoding UTF8 -Raw).Trim()
        if (-not $message) { $message = 'Launcher failed. See logs: ' + $logDirectory }
        throw $message
    }
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Codex Delete Only', 'OK', 'Error') | Out-Null
    exit 1
}

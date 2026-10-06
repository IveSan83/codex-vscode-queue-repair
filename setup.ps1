param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$taskArtifacts = Join-Path $taskRoot 'artifacts'
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Windows x64 is required.' }
foreach ($program in @('node', 'npm.cmd', 'python', 'code')) {
    if (-not (Get-Command $program -ErrorAction SilentlyContinue)) { throw ('Required program is missing from PATH: ' + $program + '. See README.md.') }
}
$taskNodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or ([version]($taskNodeVersion -replace '^v', '')).Major -lt 22) { throw 'Node.js 22 or newer is required.' }
$taskNodeArchitecture = & node -p process.arch
if ($LASTEXITCODE -ne 0 -or $taskNodeArchitecture -ne 'x64') { throw 'The Node.js x64 installation is required.' }
& python -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 or newer is required.' }
New-Item -ItemType Directory -Path $taskArtifacts -Force | Out-Null
Push-Location -LiteralPath $taskRoot
Start-Transcript -LiteralPath (Join-Path $taskArtifacts 'setup.log') -Append | Out-Null
try {
    Write-Output 'Codex queue repair 2.4 - IveSan83'
    Write-Output 'https://github.com/IveSan83/codex-vscode-queue-repair'
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & python build.py --prepare
    if ($LASTEXITCODE -ne 0) { throw 'Official extension download or verification failed.' }
    & node tools/verify.cjs --runtime all
    if ($LASTEXITCODE -ne 0) { throw 'Required regression checks failed; installation blocked.' }
    if (-not (Test-Path -LiteralPath (Join-Path $taskArtifacts 'build-report.json'))) {
        & python build.py
        if ($LASTEXITCODE -ne 0) { throw 'Package build failed. If interrupted, extract the release into a new folder.' }
    }
    if ($VerifyOnly) { & (Join-Path $taskRoot 'install.ps1') -VerifyOnly }
    else { & (Join-Path $taskRoot 'install.ps1') }
} finally {
    Stop-Transcript | Out-Null
    Pop-Location
}

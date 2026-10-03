param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$expectedRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
if (-not [Environment]::Is64BitOperatingSystem) { throw 'This package supports Windows x64 only' }
& node (Join-Path $expectedRoot 'tools\verify.cjs') --check
if ($LASTEXITCODE -ne 0) { throw 'Release verification gate failed' }
$report = Get-Content -LiteralPath (Join-Path $expectedRoot 'artifacts\build-report.json') -Raw | ConvertFrom-Json
$verification = Get-Content -LiteralPath (Join-Path $expectedRoot 'artifacts\verify-report.json') -Raw | ConvertFrom-Json
if ($report.sourceFingerprint -ne $verification.fingerprint.digest) { throw 'Build was made from different sources' }
if ($report.patchVersion -ne '2.2' -or $report.baseVersion -ne '26.930.31730') { throw 'Unexpected repair version' }
$vsix = $report.patched.path
if ((Get-FileHash -LiteralPath $vsix -Algorithm SHA256).Hash.ToLowerInvariant() -ne $report.patched.sha256) { throw 'Patched VSIX hash mismatch' }
if (-not $report.packagedStartup.passed -or $report.packagedStartup.vsixSha256 -ne $report.patched.sha256) { throw 'Packaged startup was not verified for this VSIX' }
& python (Join-Path $expectedRoot 'build.py') --smoke-vsix $vsix
if ($LASTEXITCODE -ne 0) { throw 'Packaged host storage cannot start; installation blocked' }
if ($VerifyOnly) { Write-Output 'Package, source and startup checks passed; installation was not requested.'; return }
$journal = Join-Path $env:APPDATA 'Code\User\globalStorage\openai.chatgpt\queue-repair-v1\queue.json'
$legacyLock = Join-Path ([IO.Path]::GetDirectoryName($journal)) 'writer.lock'
if (Test-Path -LiteralPath $legacyLock -PathType Leaf) { throw 'A legacy writer.lock file exists. Close old repair hosts and inspect that file before upgrading. The saved queue has not been changed.' }
$backup = $null
if (Test-Path -LiteralPath $journal) {
    $backup = Join-Path $expectedRoot ('artifacts\private-queue-before-v2-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff') + '.json')
    # One atomic file read; never edit, delete or replay saved user messages.
    [IO.File]::WriteAllBytes($backup, [IO.File]::ReadAllBytes($journal))
}
& code --install-extension $vsix --force
if ($LASTEXITCODE -ne 0) { throw 'VS Code extension installation failed' }
$extensionRoot = Join-Path $env:USERPROFILE '.vscode\extensions'
$entries = Get-Content -LiteralPath (Join-Path $extensionRoot 'extensions.json') -Raw | ConvertFrom-Json
$installed = @($entries | Where-Object { $_.identifier.id -eq 'openai.chatgpt' -and $_.version -eq $report.baseVersion })
if ($installed.Count -ne 1) { throw 'Expected exactly one installed repaired extension' }
$installedDirectory = [IO.Path]::GetFullPath((Join-Path $extensionRoot $installed[0].relativeLocation))
if ([IO.Path]::GetDirectoryName($installedDirectory) -ne [IO.Path]::GetFullPath($extensionRoot)) { throw 'Unexpected installed extension path' }
$pkg = Get-Content -LiteralPath (Join-Path $installedDirectory 'package.json') -Raw | ConvertFrom-Json
if ($pkg.codexLocalQueueRepair.version -ne '2.2' -or $pkg.codexLocalQueueRepair.sourceFingerprint -ne $report.sourceFingerprint) { throw 'Installed package identity mismatch' }
if (-not $installed[0].metadata.pinned) { throw 'Local VSIX was not pinned; verify before activating' }
$manifest = Get-Content -LiteralPath (Join-Path $installedDirectory 'queue-repair-manifest.json') -Raw | ConvertFrom-Json
foreach ($file in $report.manifest.files.PSObject.Properties) {
    $actual = (Get-FileHash -LiteralPath (Join-Path $installedDirectory $file.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $file.Value.patched) { throw ('Installed patched bundle mismatch: ' + $file.Name) }
}
foreach ($file in $report.manifest.helpers.PSObject.Properties) {
    $actual = (Get-FileHash -LiteralPath (Join-Path $installedDirectory $file.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $file.Value) { throw ('Installed helper mismatch: ' + $file.Name) }
}
$native = Join-Path $installedDirectory ($report.native.path -replace '^extension/', '')
if ((Get-FileHash -LiteralPath $native -Algorithm SHA256).Hash.ToLowerInvariant() -ne $report.native.sha256) { throw 'Installed native runtime mismatch' }
$obsoleteStore = Join-Path $installedDirectory 'out\codex-queue-store.cjs'
if (Test-Path -LiteralPath $obsoleteStore) {
    # Remove only the old, byte-identical packaging alias, if VS Code retained it.
    $expectedStoreHash = $report.manifest.helpers.'out/queue-store.cjs'
    if ((Get-FileHash -LiteralPath $obsoleteStore -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedStoreHash) { throw 'Unexpected file under the obsolete store name; refusing to remove it' }
    Remove-Item -LiteralPath $obsoleteStore
}
& node (Join-Path $expectedRoot 'tools\package-smoke.cjs') --all $installedDirectory
if ($LASTEXITCODE -ne 0) { throw 'Installed host storage cannot start' }
$installation = @{ version = $report.baseVersion; patchVersion = '2.2'; installedDirectory = $installedDirectory; pinned = $true; packagedStartupVerified = $true; installedStartupVerified = $true; vsixSha256 = $report.patched.sha256; queueBackup = $backup; finishedAt = [DateTime]::UtcNow.ToString('o'); activation = 'pending-full-restart' }
$installation | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $expectedRoot 'artifacts\install-report.json') -Encoding UTF8
Write-Output ('Verified installation: ' + $installedDirectory)
Write-Output 'Installed. Fully close every VS Code window and reopen to activate the repair.'

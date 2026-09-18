<#
.SYNOPSIS
  Installs the Windows installer silently, the way a customer gets it, and
  fails unless every shipped executable, DLL and .node module is signed.

.DESCRIPTION
  Windows 11 Smart App Control blocks any unsigned executable or DLL that has
  no reputation, and the Microsoft Store accepts an EXE installer only when it
  and every PE file inside it are signed. Until 4.7.3 only the installer was
  signed; everything it installed was not.

  Accepted: a valid, timestamped signature by Suisse IT GmbH (a timestamp keeps
  it valid after the certificate expires), or a valid signature by Microsoft
  for the DLLs Microsoft itself ships inside Electron.

  Afterwards the installed app is started once with the test hooks that turn
  off Sentry and block all remote requests, to prove the signed binaries still
  run, and is then uninstalled again.
#>
param(
  [Parameter(Mandatory = $true)] [string] $Installer,
  [string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\suisse-notes-desktop'),
  [switch] $KeepInstalled
)

$ErrorActionPreference = 'Stop'
$ours = 'CN=Suisse IT GmbH,'
$vendors = @('CN=Microsoft Corporation,', 'CN=Microsoft Windows,')

function Get-Signature([string] $File) {
  $signature = Get-AuthenticodeSignature -LiteralPath $File
  [pscustomobject]@{
    File    = $File
    Status  = [string] $signature.Status
    Signer  = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
    Stamped = [bool] $signature.TimeStamperCertificate
  }
}

function Test-Accepted($Signature, [bool] $MustBeOurs) {
  if ($Signature.Status -ne 'Valid') { return $false }
  if ($Signature.Signer.StartsWith($ours)) { return $Signature.Stamped }
  if ($MustBeOurs) { return $false }
  foreach ($vendor in $vendors) { if ($Signature.Signer.StartsWith($vendor)) { return $true } }
  return $false
}

if (-not (Test-Path -LiteralPath $Installer)) { throw "Installer not found: $Installer" }
if (Test-Path -LiteralPath $InstallDir) {
  throw "$InstallDir already exists. Run this on a machine without Suisse Meets installed."
}

$results = @()
$installerSignature = Get-Signature $Installer
$results += [pscustomobject]@{ Signature = $installerSignature; Accepted = (Test-Accepted $installerSignature $true) }

Write-Host "Installing $(Split-Path $Installer -Leaf) silently..."
$setup = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
if ($setup.ExitCode -ne 0) { throw "Installer exited with code $($setup.ExitCode)" }
$appExe = Join-Path $InstallDir 'Suisse Meets.exe'
$deadline = (Get-Date).AddMinutes(3)
while (-not (Test-Path -LiteralPath $appExe) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
if (-not (Test-Path -LiteralPath $appExe)) { throw "Installed app not found at $appExe" }

$peFiles = Get-ChildItem -LiteralPath $InstallDir -Recurse -File |
  Where-Object { $_.Extension -in '.exe', '.dll', '.node' }
foreach ($file in $peFiles) {
  $signature = Get-Signature $file.FullName
  # Microsoft's own DLLs may keep Microsoft's signature; every executable and
  # every file we build or bundle must carry ours.
  $mustBeOurs = $file.Extension -ne '.dll' -or -not $signature.Signer.StartsWith('CN=Microsoft')
  $results += [pscustomobject]@{ Signature = $signature; Accepted = (Test-Accepted $signature $mustBeOurs) }
}

$results | ForEach-Object {
  [pscustomobject]@{
    OK      = if ($_.Accepted) { 'yes' } else { 'NO' }
    Status  = $_.Signature.Status
    Stamped = $_.Signature.Stamped
    Signer  = ($_.Signature.Signer -split ',')[0]
    File    = $_.Signature.File.Replace($InstallDir, '<install>')
  }
} | Format-Table -AutoSize | Out-String -Width 300 | Write-Host

$sizeMb = [math]::Round((Get-ChildItem -LiteralPath $InstallDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "Installed size: $sizeMb MB, $($peFiles.Count) PE files"

$rejected = @($results | Where-Object { -not $_.Accepted })
if ($rejected.Count -gt 0) {
  $names = ($rejected | ForEach-Object { Split-Path $_.Signature.File -Leaf }) -join ', '
  throw "$($rejected.Count) shipped file(s) are not properly signed: $names"
}
Write-Host "All $($results.Count) files are signed (installer + $($peFiles.Count) installed PE files)."

# Smoke test: the signed binaries must still start. The test hooks turn Sentry
# off and block every remote request, so this run reaches no server.
$testProfile = Join-Path ([IO.Path]::GetTempPath()) ("suisse-sign-smoke-" + [guid]::NewGuid())
$env:SUISSE_E2E_HOOKS = '1'
$env:SUISSE_TEST_USERDATA = $testProfile
$env:SUISSE_TEST_NETWORK_ISOLATION = '1'
$env:API_BASE_URL = 'http://127.0.0.1:9'
$app = Start-Process -FilePath $appExe -PassThru
Start-Sleep -Seconds 20
if ($app.HasExited) { throw "The installed app exited within 20 s (exit code $($app.ExitCode))" }
Write-Host "Installed app is running (pid $($app.Id)); stopping it."
& taskkill.exe /PID $app.Id /T /F | Out-Null
Start-Sleep -Seconds 3

if (-not $KeepInstalled) {
  $uninstaller = Join-Path $InstallDir 'Uninstall Suisse Meets.exe'
  $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
  Write-Host "Uninstalled (exit code $($remove.ExitCode))."
}
Remove-Item -LiteralPath $testProfile -Recurse -Force -ErrorAction SilentlyContinue

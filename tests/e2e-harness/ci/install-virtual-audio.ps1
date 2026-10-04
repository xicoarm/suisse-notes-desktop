# Give a hosted Windows runner a sound card, for s20-teams-call only.
#
# GitHub's Windows runners have no audio device at all, so the Teams stand-in would
# have nowhere to play and no microphone to hold. VB-CABLE (VB-Audio, donationware)
# adds one virtual output ("CABLE Input") looped to one virtual input ("CABLE Output").
# The output becomes Teams' speaker; the input, renamed to a headset name, becomes
# Teams' microphone (the app ignores inputs called "CABLE Output" on purpose, they
# carry the computer's own sound). Nothing here runs on a developer machine.
#
# Integrity: the driver catalog must carry a valid Authenticode signature from
# VB-Audio or Microsoft's hardware publisher, or the job stops before installing.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'CI only: this installs a kernel audio driver' }

$work = Join-Path $env:RUNNER_TEMP 'vbcable'
New-Item -ItemType Directory -Force $work | Out-Null
$zip = Join-Path $work 'VBCABLE_Driver_Pack45.zip'
Invoke-WebRequest -Uri 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip' -OutFile $zip
Write-Host ('VB-CABLE pack sha256 ' + (Get-FileHash $zip -Algorithm SHA256).Hash)
Expand-Archive $zip -DestinationPath $work -Force

$inf = Get-ChildItem $work -Recurse -Filter '*64_win10.inf' | Select-Object -First 1
if (-not $inf) { $inf = Get-ChildItem $work -Recurse -Filter 'vbMmeCable64_win7.inf' | Select-Object -First 1 }
if (-not $inf) { throw 'No 64-bit VB-CABLE INF in the pack' }
$catName = (Select-String -Path $inf.FullName -Pattern '^\s*CatalogFile\s*=\s*(\S+)' | Select-Object -First 1).Matches[0].Groups[1].Value
$cat = Join-Path $inf.DirectoryName $catName
$signature = Get-AuthenticodeSignature $cat
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'VB-Audio|Microsoft Windows Hardware Compatibility Publisher') {
  throw ('Driver catalog signature not trusted: ' + $signature.Status + ' ' + $signature.SignerCertificate.Subject)
}
Write-Host ('Driver signed by: ' + $signature.SignerCertificate.Subject)
# A vendor-signed driver installs without a prompt only when its publisher is trusted.
$cer = Join-Path $work 'publisher.cer'
[IO.File]::WriteAllBytes($cer, $signature.SignerCertificate.Export('Cert'))
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null

$hardwareId = (Select-String -Path $inf.FullName -Pattern ',\s*(VBAudio\w+)' | Select-Object -First 1).Matches[0].Groups[1].Value
$devcon = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Tools' -Recurse -Filter devcon.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $devcon) { throw 'devcon.exe (Windows Driver Kit) not found on this runner' }

foreach ($service in 'AudioEndpointBuilder', 'Audiosrv') {
  Set-Service -Name $service -StartupType Automatic
  Start-Service -Name $service
}
Write-Host ("Installing $($inf.Name) as $hardwareId with $($devcon.FullName)")
& $devcon.FullName install $inf.FullName $hardwareId
if ($LASTEXITCODE -ne 0) { throw "devcon install failed ($LASTEXITCODE)" }

# The stand-in lists what Windows offers; wait until the cable is there.
node tests/e2e-harness/teams-sim/build.js | Out-Null
$sim = 'tests\e2e-harness\work\teams-sim\ms-teams-sim.exe'
$deadline = (Get-Date).AddSeconds(90)
do {
  Start-Sleep -Seconds 3
  $devices = & $sim --list
} until (($devices -match '"flow":"output"') -and ($devices -match '"flow":"input"') -or (Get-Date) -gt $deadline)
if (-not ($devices -match '"flow":"output"')) { throw 'No audio output appeared after installing VB-CABLE' }

& $sim --rename 'CABLE Output' --flow capture --to 'Headset-Mikrofon'
if ($LASTEXITCODE -ne 0) { throw 'Could not give the virtual microphone a headset name' }
& $sim --list

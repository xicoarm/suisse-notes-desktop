# Evidence for CI only: how does the virtual cable play a call stream?
#
# Plays the same speech through the Teams stand-in twice on the cable's "Speakers"
# output - once as an ordinary stream, once marked AudioCategory_Communications like
# Teams - and records what each capture path hears: endpoint loopback of both cable
# outputs and process loopback. Also prints the audio processing modes the driver
# declares. Never fails the job; it documents why the CI call runs uncategorised.
$ErrorActionPreference = 'Stop'
$sim = 'tests\e2e-harness\work\teams-sim\ms-teams-sim.exe'
$helper = 'resources\sysloopback\win-x64\sysloopback.exe'
$out = Join-Path $env:RUNNER_TEMP 'call-stream-probe'
New-Item -ItemType Directory -Force $out | Out-Null

Write-Host '== processing modes declared per output (Communications = {98951333-B9CD-48B1-A0A3-FF40682D73F7})'
$base = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
Get-ChildItem $base | ForEach-Object {
  if ((Get-ItemProperty $_.PSPath).DeviceState -ne 1) { return }
  $props = Get-ItemProperty -Path (Join-Path $_.PSPath 'Properties') -ErrorAction SilentlyContinue
  $fx = Get-ItemProperty -Path (Join-Path $_.PSPath 'FxProperties') -ErrorAction SilentlyContinue
  $modes = @()
  if ($fx) { foreach ($p in $fx.PSObject.Properties) { if ($p.Name -like '{d3993a3f-99c2-4402-b5ec-a92a0367664b},*') { $modes += ($p.Value | ForEach-Object { $_ }) } } }
  Write-Host ("  {0}: {1}" -f $props.'{a45c254e-df1c-4efd-8020-67d146a850e0},2', (($modes | Sort-Object -Unique) -join ' '))
}

$devices = (& $sim --list) | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.flow -eq 'output' }
$speakers = ($devices | Where-Object { $_.name -like 'Speakers*' } | Select-Object -First 1).id
$sixteen = ($devices | Where-Object { $_.name -like 'CABLE In 16*' } | Select-Object -First 1).id
node tests/e2e-harness/run.js teams-call-selftest | Out-Null   # renders work/teams-call/*_48000.wav
$speech = 'tests\e2e-harness\work\teams-call\local_48000.wav'

function Level($file) {
  if (-not (Test-Path $file)) { return 'missing' }
  $bytes = [IO.File]::ReadAllBytes($file)
  $peak = 0
  for ($i = 44; $i + 1 -lt $bytes.Length; $i += 2) {
    $v = [Math]::Abs([BitConverter]::ToInt16($bytes, $i))
    if ($v -gt $peak) { $peak = $v }
  }
  if ($peak -eq 0) { return '-inf dBFS' }
  return ('{0:N1} dBFS' -f (20 * [Math]::Log10($peak / 32768)))
}

foreach ($category in 'none', 'communications') {
  $captures = @(
    (Start-Process -PassThru -NoNewWindow -FilePath $helper -ArgumentList @('--device', $speakers, '--seconds', '8', '--out', "$out\$category-speakers.wav")),
    (Start-Process -PassThru -NoNewWindow -FilePath $helper -ArgumentList @('--device', $sixteen, '--seconds', '8', '--out', "$out\$category-16ch.wav")),
    (Start-Process -PassThru -NoNewWindow -FilePath $helper -ArgumentList @('--process-loopback', '--exclude-pid', '4', '--seconds', '8', '--out', "$out\$category-process.wav"))
  )
  Start-Sleep -Seconds 1
  $simArgs = @('--play', $speech, '--device', $speakers, '--linger', '0')
  if ($category -ne 'none') { $simArgs += @('--category', $category) }
  # The stand-in stops when its stdin closes: a 6-second pipe keeps it playing that long.
  cmd /c "(ping -n 7 127.0.0.1 >NUL) | `"$sim`" $($simArgs -join ' ')" | Out-Null
  $captures | Wait-Process -Timeout 20 -ErrorAction SilentlyContinue
  Write-Host ("== stream category {0}: Speakers loopback {1}, 16 Ch loopback {2}, process loopback {3}" -f $category,
    (Level "$out\$category-speakers.wav"), (Level "$out\$category-16ch.wav"), (Level "$out\$category-process.wav"))
}

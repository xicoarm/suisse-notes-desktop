/**
 * Ground-truth audio for realistic end-to-end tests.
 *
 * Every generated file is a REAL meeting simulation:
 *  - Actual spoken sentences (Windows SAPI TTS, alternating voices) so codecs,
 *    VAD-ish detectors and the transcript pipeline see genuine speech.
 *  - A pilot-pulse oracle mixed underneath: a short 7 kHz tone burst every
 *    PULSE_PERIOD_S seconds at a known level. After a test, verify.js finds
 *    every pulse in the app's OUTPUT file — count, spacing and level expose
 *    gaps, duplicated audio, truncation, level shifts and (with a second
 *    pilot frequency) mic-vs-system-audio desync, all without listening.
 *
 * Segment types compose scenarios: 'speech' (healthy meeting), 'zeros'
 * (dead-but-open device — the Angela phase 1), 'quiet' (speech at -30 dB —
 * Angela phase 2), 'noise' (room tone, no speech).
 *
 * Everything is 48 kHz mono 16-bit WAV — exactly what the capture pipeline
 * expects from a real microphone.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const FFMPEG = require('@ffmpeg-installer/ffmpeg').path;

const SAMPLE_RATE = 48000;
const PULSE_FREQ_HZ = 7000;      // above speech formants, far below the Opus cutoff
const PULSE_PERIOD_S = 10;       // one pulse every 10s
const PULSE_LEN_S = 0.4;
const PULSE_GAIN = 0.18;         // ≈ -15 dBFS — comfortably above the -50 dB detector floor

const WORK_DIR = path.join(__dirname, '..', 'work');
const CACHE_DIR = path.join(WORK_DIR, 'audio-cache');

function ensureDirs() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function ff(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}

/**
 * Meeting script: alternating speakers, natural sentence lengths, brief pauses.
 * Deterministic (seeded by index) so a scenario regenerates identically.
 */
const SENTENCES = [
  'Good morning everyone, thank you for joining todays meeting.',
  'Let us start with a quick review of the action items from last week.',
  'The quarterly numbers look stable, but we need to discuss the budget for the next phase.',
  'I agree with that proposal, although the timeline seems quite ambitious to me.',
  'Could you elaborate on the second point regarding the infrastructure costs?',
  'We should schedule a follow up with the engineering team before Friday.',
  'The customer feedback from the pilot phase was overwhelmingly positive.',
  'There are still two open questions about the data migration strategy.',
  'Let me summarize the decisions we have made so far in this session.',
  'I will send the updated documentation to everyone right after this call.',
  'Das klingt vernünftig, aber wir sollten die Risiken noch einmal genau prüfen.',
  'Der nächste Meilenstein ist für Ende des Monats geplant.',
];

/**
 * Generate spoken dialogue via Windows SAPI. Produces a 48 kHz mono WAV of
 * roughly `seconds` length (TTS speaks until the budget is filled, then we
 * trim/pad precisely with ffmpeg). Cached — TTS is slow.
 */
function generateSpeechBase(seconds) {
  ensureDirs();
  const cached = path.join(CACHE_DIR, `speech_${seconds}s.wav`);
  if (fs.existsSync(cached)) return cached;

  const rawPath = path.join(CACHE_DIR, `speech_${seconds}s_raw.wav`);
  // PowerShell SAPI script: alternate through installed voices, speak
  // sentences with 0.6s pauses until the duration budget is exceeded.
  const ps = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
$synth.SetOutputToWaveFile('${rawPath.replace(/\\/g, '\\\\')}')
$sentences = @(${SENTENCES.map(s => `'${s.replace(/'/g, "''")}'`).join(', ')})
$i = 0
$budgetTicks = ${seconds} * 10000000
while ($synth.State -ne 'Speaking') { break }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
# SAPI writes faster than realtime; approximate spoken length by character count
$estimatedSeconds = 0
while ($estimatedSeconds -lt ${seconds}) {
  $s = $sentences[$i % $sentences.Count]
  if ($voices.Count -gt 1) { $synth.SelectVoice($voices[$i % $voices.Count]) }
  $synth.Speak($s)
  $b = New-Object System.Speech.Synthesis.PromptBuilder
  $b.AppendBreak([TimeSpan]::FromMilliseconds(600))
  $synth.Speak($b)
  $estimatedSeconds += ($s.Length / 14.0) + 0.6
  $i++
}
$synth.Dispose()
`;
  const psPath = path.join(CACHE_DIR, `tts_${seconds}.ps1`);
  fs.writeFileSync(psPath, ps, 'utf8');
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, { stdio: 'inherit', timeout: 15 * 60_000 });

  // Resample to 48k mono, trim or pad with silence to EXACTLY `seconds`.
  ff([
    '-i', rawPath,
    '-af', `aresample=${SAMPLE_RATE},apad`,
    '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-t', String(seconds),
    '-c:a', 'pcm_s16le',
    cached,
  ]);
  fs.rmSync(rawPath, { force: true });
  return cached;
}

/** One segment WAV of the requested type and length. */
function generateSegment(type, seconds, outPath, opts = {}) {
  ensureDirs();
  switch (type) {
    case 'speech': {
      const base = generateSpeechBase(seconds);
      fs.copyFileSync(base, outPath);
      return outPath;
    }
    case 'quiet': {
      // Real speech attenuated ~30 dB — the Angela phase-2 signature.
      const base = generateSpeechBase(seconds);
      ff(['-i', base, '-af', `volume=${opts.gainDb ?? -30}dB`, '-c:a', 'pcm_s16le', outPath]);
      return outPath;
    }
    case 'zeros': {
      // TRUE digital silence — a dead-but-open device delivers exact zeros.
      ff(['-f', 'lavfi', '-i', `aevalsrc=0:s=${SAMPLE_RATE}:d=${seconds}`, '-c:a', 'pcm_s16le', outPath]);
      return outPath;
    }
    case 'noise': {
      // Faint steady room tone (~ -55 dBFS) — a silent meeting pause. Must
      // NOT trigger zero-signal or low-level detectors.
      ff(['-f', 'lavfi', '-i', `anoisesrc=color=pink:sample_rate=${SAMPLE_RATE}:duration=${seconds}:amplitude=0.002`,
        '-ac', '1', '-c:a', 'pcm_s16le', outPath]);
      return outPath;
    }
    default:
      throw new Error(`Unknown segment type: ${type}`);
  }
}

/**
 * Mix the pilot-pulse oracle over a WAV. Pulses ride on every segment type
 * EXCEPT 'zeros' regions (a dead device outputs nothing — pulses there would
 * falsify the simulation), which is handled by muting the pulse track inside
 * the given zero windows.
 */
function addPilotPulses(inPath, outPath, totalSeconds, zeroWindows = [], freq = PULSE_FREQ_HZ) {
  // Pulse train: sine gated to PULSE_LEN_S bursts every PULSE_PERIOD_S.
  let gate = `lt(mod(t\\,${PULSE_PERIOD_S})\\,${PULSE_LEN_S})`;
  // Mute pulses inside zero windows (dead device = absolutely nothing).
  for (const [start, end] of zeroWindows) {
    gate = `${gate}*(1-between(t\\,${start}\\,${end}))`;
  }
  const pulseExpr = `${PULSE_GAIN}*sin(2*PI*${freq}*t)*(${gate})`;
  // The bundled 2018 ffmpeg's amix lacks normalize=0 and force-averages the
  // inputs (halving each) — same quirk the app's own merge works around.
  // Pre-boost both inputs by 2.0 so the net result is unity gain.
  ff([
    '-i', inPath,
    '-f', 'lavfi', '-i', `aevalsrc=${pulseExpr}:s=${SAMPLE_RATE}:d=${totalSeconds}`,
    '-filter_complex', '[0:a]volume=2.0[a];[1:a]volume=2.0[b];[a][b]amix=inputs=2:duration=first[out]',
    '-map', '[out]', '-c:a', 'pcm_s16le',
    outPath,
  ]);
  return outPath;
}

/**
 * Build a scenario WAV from a segment plan.
 * plan: [{ type: 'speech'|'zeros'|'quiet'|'noise', seconds, gainDb? }, ...]
 * Returns { wavPath, timeline } where timeline lists each segment with its
 * absolute [start, end] — verify.js uses it as the expected ground truth.
 */
function buildScenario(name, plan, opts = {}) {
  ensureDirs();
  const dir = path.join(WORK_DIR, 'scenarios');
  fs.mkdirSync(dir, { recursive: true });

  const segPaths = [];
  const timeline = [];
  let t = 0;
  plan.forEach((seg, i) => {
    const p = path.join(dir, `${name}_seg${i}_${seg.type}.wav`);
    generateSegment(seg.type, seg.seconds, p, seg);
    segPaths.push(p);
    timeline.push({ type: seg.type, start: t, end: t + seg.seconds, gainDb: seg.gainDb });
    t += seg.seconds;
  });

  // Concat all segments
  const listPath = path.join(dir, `${name}_concat.txt`);
  fs.writeFileSync(listPath, segPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const concatPath = path.join(dir, `${name}_base.wav`);
  ff(['-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'pcm_s16le', concatPath]);

  // Overlay the pilot oracle, muted inside zero windows
  const zeroWindows = timeline.filter(s => s.type === 'zeros').map(s => [s.start, s.end]);
  const wavPath = path.join(dir, `${name}.wav`);
  addPilotPulses(concatPath, wavPath, t, zeroWindows, opts.pilotFreq || PULSE_FREQ_HZ);

  const meta = { name, totalSeconds: t, timeline, pilot: { freq: opts.pilotFreq || PULSE_FREQ_HZ, periodS: PULSE_PERIOD_S, lenS: PULSE_LEN_S } };
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(meta, null, 2));
  return { wavPath, metaPath: path.join(dir, `${name}.json`), ...meta };
}

module.exports = {
  buildScenario,
  generateSegment,
  SAMPLE_RATE,
  PULSE_FREQ_HZ,
  PULSE_PERIOD_S,
  PULSE_LEN_S,
  PULSE_GAIN,
  FFMPEG,
  WORK_DIR,
};

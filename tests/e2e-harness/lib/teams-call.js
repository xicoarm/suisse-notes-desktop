/**
 * A synthetic Teams call: the conversation, its voices, and the proof that both
 * sides of it are in the finished recording.
 *
 * Three participants speak German with three different synthetic voices:
 *   - "local"  (Stefan): the person using the desktop app — the microphone side;
 *   - "remote" (Katja, Hedda): the far end — what Teams plays, i.e. system audio.
 * One exchange deliberately overlaps (double talk), as real calls do.
 *
 * The voices are rendered once with the Windows speech engine and committed as
 * lossless FLAC (fixtures/teams-call), so every machine and every hosted runner
 * plays exactly the same audio — hosted runners have no German voices.
 *   node tests/e2e-harness/run.js teams-call-fixtures   (Windows; re-render)
 *
 * The verifier needs no speech recognition: it compares the loudness contour
 * (10 ms frames) of every single utterance with the recording. Speech contours
 * are as distinctive as fingerprints, survive Opus and resampling, and are
 * immune to gain changes. Per utterance it reports where it was found, how well
 * it matches and how much of it is covered — a dropped side, a missing sentence,
 * a gap inside a sentence or a time jump in one source all fail.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { FFMPEG, WORK_DIR } = require('./audio');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'teams-call');
const OUT_DIR = path.join(WORK_DIR, 'teams-call');
const FIXTURE_RATE = 24000;   // TTS bandwidth is ~11 kHz; 24 kHz keeps all of it
const PLAY_RATE = 48000;      // what the fake microphone and the Teams stand-in play
const ANALYSIS_RATE = 16000;
const HOP_S = 0.01;           // 10 ms loudness frames
const FLOOR_DB = -75;

const LEAD_IN_S = 2.0;
const GAP_S = 1.0;
const OVERLAP_S = 1.2;
const TAIL_S = 3.0;

const VOICES = { local: 'Stefan', remote1: 'Katja', remote2: 'Hedda' };

// Keywords are what a transcript must contain (live check); everything else is
// natural meeting talk. Swiss spelling (ss), no numbers spelled as digits.
const CONVERSATION = [
  { id: 'u1', who: 'local', text: 'Guten Morgen zusammen, danke, dass ihr Zeit habt. Heute besprechen wir das Projekt Bergkristall.', keywords: ['Bergkristall'] },
  { id: 'u2', who: 'remote1', text: 'Guten Morgen. Die Offerte für die Firma Alpenblick ist fertig, sie liegt bei achtzehntausend Franken.', keywords: ['Alpenblick', 'Offerte'] },
  { id: 'u3', who: 'remote2', text: 'Die Lieferung der Geräte ist für Donnerstag, den zwölften November, geplant.', keywords: ['Lieferung', 'Donnerstag'] },
  { id: 'u4', who: 'local', text: 'Sehr gut. Wer übernimmt die Schulung der Mitarbeitenden in Luzern?', keywords: ['Schulung', 'Luzern'] },
  { id: 'u5', who: 'remote1', text: 'Das übernehme ich. Ich brauche dafür zwei Tage und einen Beamer.', keywords: ['Beamer'] },
  { id: 'u6', who: 'remote2', text: 'Ich schicke euch die Unterlagen bis spätestens am Freitagmittag.', keywords: ['Unterlagen', 'Freitag'] },
  { id: 'u7', who: 'local', overlapPrevious: true, text: 'Perfekt, vielen Dank.', keywords: ['Perfekt'] },
  { id: 'u8', who: 'local', text: 'Dann halten wir fest: Offerte an Alpenblick, Lieferung im November und die Schulung in Luzern.', keywords: ['Alpenblick', 'Luzern'] },
  { id: 'u9', who: 'remote1', text: 'Einverstanden. Bis nächste Woche, tschüss zusammen.', keywords: ['Einverstanden'] },
];

const sideOf = who => (who === 'local' ? 'local' : 'remote');

function ff(args, opts = {}) {
  return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    { maxBuffer: 1024 * 1024 * 1024, ...opts });
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Any audio file -> mono Float32Array at `rate`. */
function decodeMono(file, rate = ANALYSIS_RATE) {
  const buf = ff(['-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-']);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

function writeWav16(file, samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

// ---- rendering the voices (Windows, once) -------------------------------------------

/** WinRT speech (the OneCore voices Stefan, Katja, Hedda), one WAV per line. */
function synthesizeLines(lines, dir) {
  const jobs = lines.map(line => ({ voice: line.voice, text: line.text, out: path.join(dir, `${line.id}.wav`) }));
  const jobsFile = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify(jobs), 'utf8');
  const script = path.join(dir, 'tts.ps1');
  fs.writeFileSync(script, `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$jobs = Get-Content -Raw -Encoding UTF8 '${jobsFile.replace(/'/g, "''")}' | ConvertFrom-Json
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
foreach ($job in $jobs) {
  $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -like ('*' + $job.voice + '*') -and $_.Language -like 'de-*' } | Select-Object -First 1
  if (-not $voice) { throw ('German voice not installed: ' + $job.voice) }
  $synth.Voice = $voice
  $stream = Await ($synth.SynthesizeTextToStreamAsync($job.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $size = [uint32]$stream.Size
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $null = Await ($reader.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  [IO.File]::WriteAllBytes($job.out, $bytes)
}
`, 'utf8');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'inherit', timeout: 10 * 60_000 });
}

/** Leading/trailing silence of a TTS clip removed (the engine pads ~0.2 s). */
function trimSilence(samples, rate) {
  const threshold = 10 ** (-50 / 20);
  let first = 0;
  let last = samples.length - 1;
  while (first < samples.length && Math.abs(samples[first]) < threshold) first++;
  while (last > first && Math.abs(samples[last]) < threshold) last--;
  const pad = Math.round(0.03 * rate);
  return samples.subarray(Math.max(0, first - pad), Math.min(samples.length, last + pad + 1));
}

/**
 * Renders the conversation into two time-aligned tracks (local = microphone,
 * remote = what Teams plays) and writes the committed fixture.
 */
function renderFixtures() {
  if (process.platform !== 'win32') throw new Error('Rendering the voices needs the Windows speech engine');
  const tmp = path.join(OUT_DIR, 'render');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const lines = CONVERSATION.map(line => ({ ...line, voice: VOICES[line.who] }));
  synthesizeLines(lines, tmp);

  const clips = lines.map(line => trimSilence(decodeMono(path.join(tmp, `${line.id}.wav`), FIXTURE_RATE), FIXTURE_RATE));
  const utterances = [];
  let cursor = LEAD_IN_S;
  let previousEnd = LEAD_IN_S;
  lines.forEach((line, i) => {
    const seconds = clips[i].length / FIXTURE_RATE;
    const start = line.overlapPrevious ? Math.max(LEAD_IN_S, previousEnd - OVERLAP_S) : cursor;
    const end = start + seconds;
    utterances.push({
      id: line.id, side: sideOf(line.who), speaker: line.who, voice: line.voice, text: line.text,
      keywords: line.keywords, overlap: Boolean(line.overlapPrevious) || Boolean(lines[i + 1]?.overlapPrevious),
      start: Number(start.toFixed(3)), end: Number(end.toFixed(3)),
    });
    previousEnd = end;
    cursor = Math.max(cursor, end) + GAP_S;
  });
  const total = Math.max(...utterances.map(u => u.end)) + TAIL_S;
  const tracks = { local: new Float32Array(Math.ceil(total * FIXTURE_RATE)), remote: new Float32Array(Math.ceil(total * FIXTURE_RATE)) };
  utterances.forEach((u, i) => {
    const track = tracks[u.side];
    const at = Math.round(u.start * FIXTURE_RATE);
    // Two remote voices never overlap each other, so adding is placing.
    for (let s = 0; s < clips[i].length && at + s < track.length; s++) track[at + s] += clips[i][s] * 0.8;
  });

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const files = {};
  for (const side of ['local', 'remote']) {
    const wav = path.join(tmp, `${side}.wav`);
    writeWav16(wav, tracks[side], FIXTURE_RATE);
    const flac = path.join(FIXTURE_DIR, `${side}.flac`);
    ff(['-i', wav, '-c:a', 'flac', '-compression_level', '12', flac]);
    files[side] = { file: `${side}.flac`, sha256: sha256File(flac) };
  }
  const manifest = {
    description: 'Synthetic Teams call, German, three Windows OneCore voices. Rendered by `node tests/e2e-harness/run.js teams-call-fixtures`.',
    renderedAt: new Date().toISOString(),
    voices: VOICES,
    rate: FIXTURE_RATE,
    seconds: Number(total.toFixed(3)),
    files,
    utterances,
  };
  fs.writeFileSync(path.join(FIXTURE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// ---- playing the call ----------------------------------------------------------------

/** Committed fixture -> 48 kHz WAVs for the fake microphone and the Teams stand-in. */
function prepareCall() {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const wavs = {};
  for (const side of ['local', 'remote']) {
    const flac = path.join(FIXTURE_DIR, manifest.files[side].file);
    if (sha256File(flac) !== manifest.files[side].sha256) throw new Error(`Fixture ${flac} does not match its manifest`);
    wavs[side] = path.join(OUT_DIR, `${side}_${PLAY_RATE}.wav`);
    ff(['-i', flac, '-ac', '1', '-ar', String(PLAY_RATE), '-c:a', 'pcm_s16le', wavs[side]]);
  }
  return { manifest, localWav: wavs.local, remoteWav: wavs.remote };
}

// ---- proving the call is in the recording --------------------------------------------

/** Loudness contour: dB per 10 ms frame (20 ms window), floored. */
function contour(samples, rate = ANALYSIS_RATE) {
  const hop = Math.round(HOP_S * rate);
  const win = hop * 2;
  const frames = Math.max(0, Math.floor((samples.length - win) / hop) + 1);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const at = f * hop;
    for (let i = 0; i < win; i++) sum += samples[at + i] * samples[at + i];
    out[f] = Math.max(FLOOR_DB, 10 * Math.log10(sum / win + 1e-12));
  }
  return out;
}

function pearson(a, aStart, b, bStart, length) {
  let sa = 0, sb = 0;
  for (let i = 0; i < length; i++) { sa += a[aStart + i]; sb += b[bStart + i]; }
  const ma = sa / length;
  const mb = sb / length;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < length; i++) {
    const da = a[aStart + i] - ma;
    const db = b[bStart + i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
}

/**
 * @param recordingFile the app's finished recording
 * @param call          prepareCall() result
 * @param opts.searchS  [min, max] seconds a track may start after the recording starts
 * @returns {{ pass, problems, notes, sides, utterances }}
 */
function verifyCall(recordingFile, call, { searchS = [-5, 40], minScore = 0.6, minOverlapScore = 0.4,
  minCoverage = 0.9, maxJitterMs = 150 } = {}) {
  const problems = [];
  const notes = [];
  const rec = contour(decodeMono(recordingFile));
  const refs = { local: contour(decodeMono(call.localWav)), remote: contour(decodeMono(call.remoteWav)) };
  const recordingS = rec.length * HOP_S;
  notes.push(`recording ${recordingS.toFixed(1)} s, conversation ${call.manifest.seconds.toFixed(1)} s`);

  const minLag = Math.round(searchS[0] / HOP_S);
  const maxLag = Math.round(searchS[1] / HOP_S);
  const results = call.manifest.utterances.map(u => {
    const ref = refs[u.side];
    const from = Math.max(0, Math.floor((u.start - 0.15) / HOP_S));
    const to = Math.min(ref.length, Math.ceil((u.end + 0.15) / HOP_S));
    const length = to - from;
    let best = { lag: null, score: -1 };
    for (let lag = minLag; lag <= maxLag; lag++) {
      const at = from + lag;
      if (at < 0 || at + length > rec.length) continue;
      const score = pearson(ref, from, rec, at, length);
      if (score > best.score) best = { lag, score };
    }
    return { u, from, length, best };
  });

  // Where does each side's track sit in the recording? The position most of its
  // sentences agree on (within the jitter). One damaged sentence or a chance match
  // elsewhere cannot move it; a side with no majority is missing.
  const sides = {};
  const jitterFrames = Math.round(maxJitterMs / 1000 / HOP_S);
  for (const side of ['local', 'remote']) {
    const mine = results.filter(r => r.u.side === side);
    const strong = mine.filter(r => r.best.lag !== null && r.best.score >= (r.u.overlap ? minOverlapScore : minScore));
    let lag = null;
    let support = 0;
    let supportScore = -Infinity;
    for (const candidate of strong) {
      const agreeing = strong.filter(r => Math.abs(r.best.lag - candidate.best.lag) <= jitterFrames);
      const score = agreeing.reduce((sum, r) => sum + r.best.score, 0);
      if (agreeing.length > support || (agreeing.length === support && score > supportScore)) {
        support = agreeing.length;
        supportScore = score;
        lag = Math.round(median(agreeing.map(r => r.best.lag)));
      }
    }
    if (support < Math.ceil(mine.length / 2)) lag = null;
    sides[side] = { lagFrames: lag, offsetS: lag === null ? null : Number((lag * HOP_S).toFixed(3)), agreeingSentences: support, sentences: mine.length };
    if (lag === null) {
      problems.push(`${side === 'local' ? 'Microphone' : 'Meeting (system audio)'} side missing: only ${support} of ${mine.length} of its sentences found in the recording`);
    }
  }

  const utterances = results.map(({ u, from, length, best }) => {
    const side = sides[u.side];
    const entry = { id: u.id, side: u.side, voice: u.voice, text: u.text, bestOffsetS: best.lag === null ? null : Number((best.lag * HOP_S).toFixed(3)) };
    if (side.lagFrames === null) return { ...entry, found: false };
    // Score where the sentence must be (its track's position), allowing the jitter.
    const jitter = Math.round(maxJitterMs / 1000 / HOP_S);
    let atTrack = { lag: side.lagFrames, score: -1 };
    for (let lag = side.lagFrames - jitter; lag <= side.lagFrames + jitter; lag++) {
      const at = from + lag;
      if (at < 0 || at + length > rec.length) continue;
      const score = pearson(refs[u.side], from, rec, at, length);
      if (score > atTrack.score) atTrack = { lag, score };
    }
    // Coverage: of the frames where the voice is clearly speaking, how many are
    // audible in the recording too (a dropout inside a sentence lowers this).
    let speaking = 0, heard = 0, levelSum = 0;
    for (let i = 0; i < length; i++) {
      if (refs[u.side][from + i] < -45) continue;
      speaking++;
      const r = rec[from + atTrack.lag + i];
      if (r === undefined) continue;
      levelSum += r;
      if (r > -60) heard++;
    }
    const coverage = speaking ? heard / speaking : 0;
    const threshold = u.overlap ? minOverlapScore : minScore;
    const found = atTrack.score >= threshold && coverage >= minCoverage;
    const shiftMs = Math.round((atTrack.lag - side.lagFrames) * HOP_S * 1000);
    return {
      ...entry, found, score: Number(atTrack.score.toFixed(3)), coverage: Number(coverage.toFixed(3)),
      shiftMs, levelDb: speaking ? Number((levelSum / speaking).toFixed(1)) : null, overlap: u.overlap,
    };
  });

  for (const u of utterances) {
    const who = u.side === 'local' ? 'microphone' : 'meeting';
    if (u.found === false && u.score === undefined) continue; // whole side missing, reported above
    if (u.score < (u.overlap ? minOverlapScore : minScore)) {
      problems.push(`AUDIO GAP: ${u.id} (${who}, ${u.voice}) not recognisable in the recording (match ${u.score}): "${u.text}"`);
    } else if (u.coverage < minCoverage) {
      problems.push(`AUDIO GAP: ${u.id} (${who}, ${u.voice}) only ${(u.coverage * 100).toFixed(0)} % audible: "${u.text}"`);
    }
    if (Math.abs(u.shiftMs) >= maxJitterMs) {
      problems.push(`TIME JUMP: ${u.id} (${who}) sits ${u.shiftMs} ms off its track — audio lost or duplicated before it`);
    }
  }

  if (sides.local.offsetS !== null && sides.remote.offsetS !== null) {
    notes.push(`microphone track starts at ${sides.local.offsetS.toFixed(2)} s, meeting track at ${sides.remote.offsetS.toFixed(2)} s of the recording`);
  }
  const lastEnd = Math.max(...call.manifest.utterances.map(u => u.end));
  for (const side of ['local', 'remote']) {
    if (sides[side].offsetS !== null && sides[side].offsetS + lastEnd > recordingS + 0.5) {
      notes.push(`${side} track runs past the end of the recording (stopped early?)`);
    }
  }
  return { pass: problems.length === 0, problems, notes, sides, utterances };
}

/** Live check: every keyword of every sentence appears in the transcript text. */
function transcriptRecall(transcriptText, manifest) {
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
  const text = norm(transcriptText);
  const perSide = { local: { total: 0, found: 0, missing: [] }, remote: { total: 0, found: 0, missing: [] } };
  for (const u of manifest.utterances) {
    for (const keyword of u.keywords) {
      const bucket = perSide[u.side];
      bucket.total++;
      if (text.includes(norm(keyword))) bucket.found++;
      else bucket.missing.push(`${u.id}:${keyword}`);
    }
  }
  return perSide;
}

module.exports = {
  CONVERSATION, VOICES, FIXTURE_DIR, OUT_DIR,
  renderFixtures, prepareCall, verifyCall, transcriptRecall, contour, decodeMono, writeWav16,
};

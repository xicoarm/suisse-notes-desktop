// Real media for the data flows (review round 14, F15): valid WebM/Opus made with
// the bundled ffmpeg and judged by the bundled decoder, past the counters of the
// rig (the functions as they were before the sinks). A truncated or corrupted
// Matroska file still decodes with exit code 0 and starts with the EBML magic;
// only the decoded samples tell: their hash and their number.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { sinks } from './globalSinks.js';

const require = createRequire(import.meta.url);
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path;
const FFPROBE = require('@ffprobe-installer/ffprobe').path;
const RATE = 48000;

function run(binary, args, onData) {
  return new Promise((resolve, reject) => {
    const child = sinks.original.cp.spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, err: err.trim() }));
  });
}

async function make(args) {
  const { code, err } = await run(FFMPEG, ['-v', 'error', ...args], () => {});
  if (code !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${err}`);
}

/** A chirp, each moment unlike the others, as MediaRecorder writes it: live WebM without duration or cues. */
export const makeLiveWebm = (file, { seconds, base = 200, amplitude = 0.25 }) => make([
  '-f', 'lavfi', '-i', `aevalsrc='${amplitude}*sin(2*PI*(${base}+60*t)*t)':s=${RATE}:d=${seconds}`,
  '-c:a', 'libopus', '-b:a', '64k', '-ac', '1', '-f', 'webm', '-live', '1', '-y', file,
]);
/** The same packets, repeated (a long recording without encoding all of it). */
export const loopWebm = (from, to, times) => make(['-stream_loop', String(times - 1), '-i', from, '-c:a', 'copy', '-f', 'webm', '-live', '1', '-y', to]);
/** The same packets in a finished file (duration in the header), as the app publishes it. */
export const finishWebm = (from, to) => make(['-i', from, '-c:a', 'copy', '-avoid_negative_ts', 'make_zero', '-y', to]);
/** The raw system audio of a recording: 48 kHz, mono, s16le. */
export const makePcm = (file, { seconds, base }) => make([
  '-f', 'lavfi', '-i', `aevalsrc='0.25*sin(2*PI*(${base}+40*t)*t)':s=${RATE}:d=${seconds}`, '-ac', '1', '-f', 's16le', '-y', file,
]);

/** Decodes the first audio stream. @returns {{ sha, samples, seconds, code, err, pcm? }} */
export async function decode(file, { rate = RATE, raw = false, format = [] } = {}) {
  const hash = crypto.createHash('sha256');
  const parts = [];
  let bytes = 0;
  const { code, err } = await run(FFMPEG, ['-v', 'error', ...format, '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'], (d) => {
    hash.update(d);
    bytes += d.length;
    if (raw) parts.push(d);
  });
  const samples = bytes / 2;
  return { sha: hash.digest('hex'), samples, seconds: samples / rate, code, err, pcm: raw ? Buffer.concat(parts) : null };
}

/** The duration the container states (ffprobe, what the product reads). */
export async function statedSeconds(file) {
  let out = '';
  const { code } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], (d) => { out += d; });
  return code === 0 ? Number.parseFloat(out) : NaN;
}

/** Problems of a file that must be the reference's audio, sample for sample. */
export async function exactAudio(file, reference, label) {
  if (!fs.existsSync(file)) return [`${label}: no file`];
  const got = await decode(file);
  const out = [];
  if (got.code !== 0) out.push(`${label}: does not decode (${got.code})`);
  if (got.err) out.push(`${label}: decoder errors: ${got.err.slice(0, 160)}`);
  if (got.samples !== reference.samples) out.push(`${label}: decoded ${got.seconds.toFixed(3)} s of ${reference.seconds.toFixed(3)} s`);
  if (got.sha !== reference.sha) out.push(`${label}: decoded samples differ from the source`);
  const stated = await statedSeconds(file);
  if (!(Math.abs(stated - reference.seconds) < 0.25)) out.push(`${label}: states ${stated} s of ${reference.seconds.toFixed(3)} s`);
  return out;
}

const pearson = (a, b, lag) => {
  let sa = 0; let sb = 0; let aa = 0; let bb = 0; let ab = 0; let n = 0;
  for (let i = Math.max(0, lag); i < a.length && i - lag < b.length; i++) {
    const x = a[i]; const y = b[i - lag];
    sa += x; sb += y; aa += x * x; bb += y * y; ab += x * y; n++;
  }
  const d = Math.sqrt((n * aa - sa * sa) * (n * bb - sb * sb));
  return d ? (n * ab - sa * sb) / d : 0;
};
const samplesOf = (pcm) => new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));

const SIMILAR_RATE = 8000;
const WINDOWS = 8;

/** The decoded samples of a reference for similarAudio (optionally mixed from several). */
export async function similarReference(sources) {
  const decoded = [];
  for (const { file, format } of sources) decoded.push(samplesOf((await decode(file, { rate: SIMILAR_RATE, raw: true, format })).pcm));
  const length = Math.max(...decoded.map((d) => d.length));
  const mix = new Int32Array(length);
  for (const d of decoded) d.forEach((v, i) => { mix[i] += v; });
  return mix;
}

/**
 * Problems of a file that was encoded again (lossy: no hash): it decodes, has the
 * reference's length and every one of eight windows of it follows the reference
 * (a lost or damaged part lowers its own window, not only the average).
 */
export async function similarAudio(file, reference, label, minimum = 0.9) {
  if (!fs.existsSync(file)) return [`${label}: no file`];
  const got = await decode(file, { rate: SIMILAR_RATE, raw: true });
  const out = [];
  if (got.code !== 0) out.push(`${label}: does not decode (${got.code})`);
  if (got.err) out.push(`${label}: decoder errors: ${got.err.slice(0, 160)}`);
  const pcm = samplesOf(got.pcm);
  const seconds = reference.length / SIMILAR_RATE;
  if (Math.abs(pcm.length - reference.length) / SIMILAR_RATE > 0.25) out.push(`${label}: decoded ${got.seconds.toFixed(3)} s of ${seconds.toFixed(3)} s`);
  let lag = 0;
  let best = -2;
  const span = Math.min(pcm.length, reference.length);
  for (let l = -240; l <= 240; l++) {
    const c = pearson(pcm.subarray(0, Math.min(span, 8000)), reference.subarray(0, Math.min(span, 8000)), l);
    if (c > best) { best = c; lag = l; }
  }
  const size = Math.floor(span / WINDOWS);
  for (let w = 0; w < WINDOWS && size > 0; w++) {
    const start = w * size;
    const c = pearson(pcm.subarray(Math.max(0, start + lag), start + size + lag), reference.subarray(start, start + size), 0);
    if (!(c >= minimum)) out.push(`${label}: window ${w + 1}/${WINDOWS} follows the source only ${c.toFixed(3)}`);
  }
  return out;
}

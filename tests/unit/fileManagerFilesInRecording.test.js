// @vitest-environment node
// ELECTRON-8R: two recordings of a Mac customer could not be recovered any more
// ("Native audio sources: invalid source ID; originals retained") once one
// entry that is not a source sat in their native-sources folder. Finder writes
// such a file (.DS_Store) into every folder a person opens. The strict checks
// of a recording's folders pass over a file manager's own files; everything
// else that does not belong there still stops them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ffmpeg = require('fluent-ffmpeg');
const FFMPEG = process.env.SUISSE_TEST_FFMPEG || require('@ffmpeg-installer/ffmpeg').path;
const FFPROBE = process.env.SUISSE_TEST_FFPROBE || require('@ffprobe-installer/ffprobe').path;
ffmpeg.setFfmpegPath(FFMPEG);
ffmpeg.setFfprobePath(FFPROBE);
const { isFileManagerMetadataName, isFileManagerMetadata, describeEntry, findFileManagerMetadata } =
  require('../../src-electron/file-manager-metadata');
const { beginSource, markSourceStarted, saveSourceChunk, endSource, inspectNativeSources, sourceFingerprint, describeSourceListExtras } =
  require('../../src-electron/native-source-persistence');
const { beginPcmAttempt, markPcmEvent, endPcmAttempt, inspectPcmCaptureEvidence, pcmEvidenceFingerprint } =
  require('../../src-electron/pcm-capture-evidence');
const { assessRecordingUpload } = require('../../src-electron/recording-upload-eligibility');
const { createRecordingPersistence, readFinalizedRecording } = require('../../src-electron/recording-persistence');
const { createNativeSourceFinalization } = require('../../src-electron/native-source-finalization');
const { validateNativeMedia } = require('../../src-electron/native-media-validation');
const { concatenateFiles } = require('../../src-electron/durable-files');

// What Finder and Explorer leave behind. A .DS_Store begins with these bytes;
// the checks go by name and kind of entry, not by content.
const FINDER = Buffer.from('0000000142756431', 'hex');
const STRAYS = ['.DS_Store', '._chunk_0.webm', 'desktop.ini', 'Thumbs.db'];

let recordings, root, sourceId;
const sourcesRoot = () => path.join(root, 'native-sources');
const sourceDirectory = () => path.join(sourcesRoot(), sourceId);
const chunksDirectory = () => path.join(sourceDirectory(), 'chunks');
async function strayFilesIn(...directories) {
  const written = [];
  for (const directory of directories) {
    for (const name of STRAYS) {
      await fs.promises.writeFile(path.join(directory, name), FINDER);
      written.push(path.join(directory, name));
    }
  }
  return written;
}
async function link(target, entry) {
  await fs.promises.symlink(target, entry, process.platform === 'win32' ? 'junction' : 'dir');
}
async function startedSource() {
  await beginSource(root, { sourceId, kind: 'microphone', startOffsetMs: 10, mimeType: 'audio/webm;codecs=opus', settings: { channelCount: 1 } });
  await markSourceStarted(root, sourceId, { startOffsetMs: 35 });
  await saveSourceChunk(root, sourceId, Buffer.from('audio-0'), 0);
}

beforeEach(async () => {
  recordings = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-file-manager-files-'));
  root = path.join(recordings, randomUUID());
  await fs.promises.mkdir(root);
  sourceId = randomUUID();
});
afterEach(async () => {
  const resolved = path.resolve(recordings);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('suisse-file-manager-files-')) {
    throw new Error('Unsafe fixture cleanup');
  }
  await fs.promises.rm(resolved, { recursive: true, force: true });
});

describe('what counts as a file manager\'s own file', () => {
  it('knows Finder\'s and Explorer\'s files by name, whatever their case, and nothing else', () => {
    for (const name of ['.DS_Store', '.ds_store', '._chunk_0.webm', '._x', 'desktop.ini', 'Desktop.ini', 'Thumbs.db', 'thumbs.db']) {
      expect(isFileManagerMetadataName(name), name).toBe(true);
    }
    for (const name of ['._', '.DS_Store.tmp', 'DS_Store', '.hidden', 'chunk_0.webm', 'manifest.json', randomUUID(), '', null, undefined, 7]) {
      expect(isFileManagerMetadataName(name), String(name)).toBe(false);
    }
  });

  it('counts a regular file only: a folder or a link of such a name is not passed over', async () => {
    await fs.promises.writeFile(path.join(root, '.DS_Store'), FINDER);
    await fs.promises.writeFile(path.join(root, 'audio.webm'), 'audio');
    await fs.promises.mkdir(path.join(root, 'Thumbs.db'));
    await fs.promises.mkdir(path.join(root, 'target'));
    await link(path.join(root, 'target'), path.join(root, 'desktop.ini'));
    expect(isFileManagerMetadata(root, '.DS_Store')).toBe(true);
    expect(isFileManagerMetadata(root, 'audio.webm')).toBe(false);
    expect(isFileManagerMetadata(root, 'Thumbs.db')).toBe(false);
    expect(isFileManagerMetadata(root, 'desktop.ini')).toBe(false);
    expect(isFileManagerMetadata(root, '._missing')).toBe(false);
  });

  it('describes a refused entry by kind and extension, never by its name', async () => {
    await fs.promises.writeFile(path.join(root, 'Interview Hans Muster.M4A'), 'x');
    await fs.promises.writeFile(path.join(root, '.secret plan.txt'), 'x');
    await fs.promises.writeFile(path.join(root, 'noextension'), 'x');
    await fs.promises.mkdir(path.join(root, '.DS_Store'));
    await fs.promises.mkdir(path.join(root, 'folder'));
    await link(path.join(root, 'folder'), path.join(root, 'shortcut'));
    const mark = name => createHash('sha256').update(name).digest('hex').slice(0, 8);
    expect(describeEntry(root, 'Interview Hans Muster.M4A')).toBe(`file .m4a (name: 25 characters, mark ${mark('Interview Hans Muster.M4A')})`);
    expect(describeEntry(root, '.secret plan.txt')).toBe(`hidden file .txt (name: 16 characters, mark ${mark('.secret plan.txt')})`);
    expect(describeEntry(root, 'noextension')).toBe(`file (name: 11 characters, mark ${mark('noextension')})`);
    // a known system name is told from anything else by its mark, which is always the same
    expect(describeEntry(root, '.DS_Store')).toBe(`hidden directory (name: 9 characters, mark ${mark('.DS_Store')})`);
    expect(describeEntry(root, 'folder')).toBe(`directory (name: 6 characters, mark ${mark('folder')})`);
    expect(describeEntry(root, 'shortcut')).toBe(`link (name: 8 characters, mark ${mark('shortcut')})`);
    expect(describeEntry(root, 'gone')).toBe(`entry (name: 4 characters, mark ${mark('gone')})`);
    expect(mark('.DS_Store')).not.toBe(mark('.localized'));
    for (const name of ['Interview Hans Muster.M4A', '.secret plan.txt']) expect(describeEntry(root, name)).not.toMatch(/Hans|secret|plan/);
  });

  it('lists the file-manager files of a recording for the log, bounded, without the name an AppleDouble file carries', async () => {
    await startedSource();
    await fs.promises.writeFile(path.join(root, '.DS_Store'), FINDER);
    await fs.promises.writeFile(path.join(sourcesRoot(), '.DS_Store'), FINDER);
    await fs.promises.writeFile(path.join(chunksDirectory(), '._Interview Hans Muster.m4a'), FINDER);
    await fs.promises.mkdir(path.join(sourceDirectory(), 'Thumbs.db')); // a folder: not a file manager's file
    const found = findFileManagerMetadata(root);
    expect(found.sort()).toEqual(['.DS_Store', 'native-sources/.DS_Store', `native-sources/${sourceId}/chunks/._*`].sort());
    expect(found.join(' ')).not.toContain('Hans');
    expect(findFileManagerMetadata(root, { maxFound: 1 })).toHaveLength(1);
    expect(findFileManagerMetadata(root, { maxEntries: 0 })).toEqual([]);
    expect(findFileManagerMetadata(root, { maxDepth: 1 })).toEqual(['.DS_Store']);
    expect(findFileManagerMetadata(path.join(root, 'missing'))).toEqual([]);
  });
});

describe('native sources of a recording a person opened in a file manager', () => {
  it('are inspected, fingerprinted and written as before, and the stray files are left alone', async () => {
    await startedSource();
    const before = sourceFingerprint(root);
    const strays = await strayFilesIn(sourcesRoot(), sourceDirectory(), chunksDirectory());

    expect(sourceFingerprint(root)).toBe(before);
    expect(inspectNativeSources(root)).toHaveLength(1);
    expect(inspectNativeSources(root)[0]).toMatchObject({ sourceId, chunkCount: 1, gaps: [], interrupted: true });
    // the running recording goes on saving: every chunk write inspects the source folder
    await saveSourceChunk(root, sourceId, Buffer.from('audio-1'), 1);
    await endSource(root, sourceId, { endOffsetMs: 2000, chunkCount: 2, reason: 'stop' });
    expect(inspectNativeSources(root)[0]).toMatchObject({ chunkCount: 2, complete: true, terminalMismatch: false });
    for (const file of strays) expect(fs.readFileSync(file)).toEqual(FINDER);
    expect(fs.readdirSync(chunksDirectory()).filter(name => name.startsWith('chunk_')).sort()).toEqual(['chunk_0.webm', 'chunk_1.webm']);
  });

  it('pass over every plain file in the source list, which is made of folders, and describe it for the log without its name', async () => {
    await startedSource();
    const before = sourceFingerprint(root);
    const names = [`${sourceId}.zip`, 'Interview Hans Muster.m4a', '.hidden', 'notes.txt', '.ds_store'];
    for (const name of names) await fs.promises.writeFile(path.join(sourcesRoot(), name), 'not a source');
    await fs.promises.writeFile(path.join(chunksDirectory(), '.ds_store'), FINDER); // lower case, as on another file system

    expect(inspectNativeSources(root)).toHaveLength(1);
    expect(sourceFingerprint(root)).toBe(before);
    await saveSourceChunk(root, sourceId, Buffer.from('audio-1'), 1);
    expect(inspectNativeSources(root)[0].chunkCount).toBe(2);
    const extras = describeSourceListExtras(root);
    expect(extras).toHaveLength(4); // the file manager's own file is not listed here
    expect(extras.join('; ')).toMatch(/file \.zip \(name: 40 characters, mark [0-9a-f]{8}\)/);
    expect(extras.join('; ')).toMatch(/file \.m4a \(name: 25 characters, mark [0-9a-f]{8}\)/);
    expect(extras.join('; ')).not.toMatch(/Hans|notes/);
    expect(describeSourceListExtras(path.join(root, 'missing'))).toEqual([]);
    for (const name of names) expect(fs.readFileSync(path.join(sourcesRoot(), name), 'utf8')).toBe('not a source');
  });

  it('still stop at a folder or a link in the source list that is no source, and at a plain file that carries a source\'s name', async () => {
    await startedSource();
    const refused = async (name, make, message) => {
      const entry = path.join(sourcesRoot(), name);
      await make(entry);
      let error;
      try { inspectNativeSources(root); } catch (caught) { error = caught; }
      expect(error, name).toMatchObject({ code: 'NATIVE_SOURCE_INVALID' });
      expect(error.message, name).toMatch(message);
      expect(error.message).toMatch(/^Native audio sources: .*; originals retained$/);
      expect(error.message).not.toContain('Hans');
      expect(() => sourceFingerprint(root)).toThrow(message);
      expect(fs.lstatSync(entry)).toBeTruthy();
      await fs.promises.rm(entry, { recursive: true, force: true });
      expect(inspectNativeSources(root)).toHaveLength(1);
    };
    await refused('.DS_Store', async entry => {
      await fs.promises.mkdir(entry);
      await fs.promises.writeFile(path.join(entry, 'chunk_0.webm'), 'audio of unknown origin');
    }, /unexpected hidden directory \(name: 9 characters, mark [0-9a-f]{8}\) in source list/);
    await refused('desktop.ini', entry => link(sourceDirectory(), entry), /unexpected link \.ini \(name: 11 characters, mark [0-9a-f]{8}\) in source list/);
    await refused('Interview Hans Muster', entry => fs.promises.mkdir(entry), /unexpected directory \(name: 21 characters, mark [0-9a-f]{8}\) in source list/);
    // a source that has become a plain file is a broken source, not a stray file
    await refused(randomUUID(), entry => fs.promises.writeFile(entry, 'x'), /missing or unsafe directory/);
    // a plain file that names a source which has no folder may be all that is left of it
    await refused(`${randomUUID()}.zip`, entry => fs.promises.writeFile(entry, 'archive of a source that is gone'),
      /unexpected file \.zip \(name: 40 characters, mark [0-9a-f]{8}\) in source list/);
    await refused(randomUUID().toUpperCase(), entry => fs.promises.writeFile(entry, 'x'),
      /unexpected file \(name: 36 characters, mark [0-9a-f]{8}\) in source list/);
    await refused(`Copy of ${randomUUID()} (2)`, entry => fs.promises.writeFile(entry, 'x'),
      /unexpected file \(name: 48 characters, mark [0-9a-f]{8}\) in source list/);
  });

  it('do not build a recording without a source whose folder was archived and removed', async () => {
    await startedSource();
    const second = randomUUID();
    await beginSource(root, { sourceId: second, kind: 'system', startOffsetMs: 10, mimeType: 'audio/webm;codecs=opus', settings: {} });
    await markSourceStarted(root, second, { startOffsetMs: 40 });
    await saveSourceChunk(root, second, Buffer.from('participants'), 0);
    expect(inspectNativeSources(root).map(source => source.kind).sort()).toEqual(['microphone', 'system']);
    // someone compresses the folder of the second source: the archive beside the folder changes nothing …
    await fs.promises.writeFile(path.join(sourcesRoot(), `${second}.zip`), 'archive');
    expect(inspectNativeSources(root)).toHaveLength(2);
    // … and removes the folder: the recording must not be built from the microphone alone
    await fs.promises.rename(path.join(sourcesRoot(), second), path.join(recordings, 'removed-source'));
    expect(() => inspectNativeSources(root)).toThrow(/unexpected file \.zip .* in source list/);
    expect(() => sourceFingerprint(root)).toThrow('in source list');
  });

  it('still stop at an unknown file beside the manifest and at a folder among the chunks', async () => {
    await startedSource();
    await fs.promises.writeFile(path.join(sourceDirectory(), 'notes.txt'), 'x');
    expect(() => inspectNativeSources(root)).toThrow('unrecognized source entry notes.txt');
    await expect(saveSourceChunk(root, sourceId, Buffer.from('audio-1'), 1)).rejects.toThrow('unrecognized source entry');
    await fs.promises.rm(path.join(sourceDirectory(), 'notes.txt'));

    await fs.promises.mkdir(path.join(chunksDirectory(), '.DS_Store'));
    expect(() => inspectNativeSources(root)).toThrow('unrecognized source chunk .DS_Store');
    await fs.promises.rmdir(path.join(chunksDirectory(), '.DS_Store'));
    await fs.promises.writeFile(path.join(chunksDirectory(), 'chunk_7.mp3'), 'x');
    expect(() => inspectNativeSources(root)).toThrow('unrecognized source chunk chunk_7.mp3');
  });
});

describe('system audio evidence of a recording a person opened in a file manager', () => {
  const attemptsRoot = () => path.join(root, 'pcm-capture-attempts');
  async function successfulAttempt(attemptId) {
    await beginPcmAttempt(root, { attemptId, required: true, requestOffsetMs: 0, requestedAt: '2026-11-13T08:51:45.000Z' });
    await markPcmEvent(root, attemptId, { event: 'first-data', elapsedMs: 35, activeOffsetMs: 35, byteLength: 4 });
    await fs.promises.appendFile(path.join(root, 'system_audio.raw'), Buffer.from([1, 2, 3, 4]));
    await endPcmAttempt(root, attemptId, { success: true, childClosed: true, diskDrained: true, endOffsetMs: 1000, elapsedMs: 1000, reason: 'stopped' });
  }

  it('reads the same evidence with the stray files beside the attempts and inside one', async () => {
    const attemptId = randomUUID();
    await successfulAttempt(attemptId);
    const before = inspectPcmCaptureEvidence(root), fingerprint = pcmEvidenceFingerprint(root);
    expect(before).toMatchObject({ canFinalize: true, complete: true });
    const strays = await strayFilesIn(attemptsRoot(), path.join(attemptsRoot(), attemptId));

    expect(inspectPcmCaptureEvidence(root)).toEqual(before);
    expect(inspectPcmCaptureEvidence(root, { recovery: true })).toMatchObject({ canFinalize: true });
    expect(pcmEvidenceFingerprint(root)).toBe(fingerprint);
    for (const file of strays) expect(fs.readFileSync(file)).toEqual(FINDER);
  });

  it('treats an attempts folder that holds only a file manager\'s file as the empty folder it is', async () => {
    await fs.promises.mkdir(attemptsRoot());
    const empty = inspectPcmCaptureEvidence(root);
    await fs.promises.writeFile(path.join(attemptsRoot(), '.DS_Store'), FINDER);
    expect(inspectPcmCaptureEvidence(root)).toEqual(empty);
    expect(inspectPcmCaptureEvidence(root).warnings.map(issue => issue.kind)).toContain('capture-reservation-interrupted');
  });

  it('reads an interrupted reservation the same with a file manager\'s file inside its staging folder', async () => {
    const staging = path.join(attemptsRoot(), `${randomUUID()}.${randomUUID()}.tmp`);
    await fs.promises.mkdir(staging, { recursive: true });
    await fs.promises.writeFile(path.join(staging, 'manifest.json'), '{"version":1}');
    const before = inspectPcmCaptureEvidence(root), fingerprint = pcmEvidenceFingerprint(root);
    expect(before.warnings.map(issue => issue.kind)).toContain('capture-reservation-interrupted');
    await fs.promises.writeFile(path.join(staging, '.DS_Store'), Buffer.alloc(20000, 1)); // larger than evidence may be
    expect(inspectPcmCaptureEvidence(root)).toEqual(before);
    expect(pcmEvidenceFingerprint(root)).toBe(fingerprint);
  });

  it('still stops at a folder of such a name and at any other unknown file', async () => {
    const attemptId = randomUUID();
    await successfulAttempt(attemptId);
    await fs.promises.mkdir(path.join(attemptsRoot(), '.DS_Store'));
    expect(() => inspectPcmCaptureEvidence(root)).toThrow('invalid attempt ID');
    await fs.promises.rmdir(path.join(attemptsRoot(), '.DS_Store'));
    await fs.promises.writeFile(path.join(attemptsRoot(), attemptId, 'notes.txt'), 'x');
    expect(() => inspectPcmCaptureEvidence(root)).toThrow('unrecognized attempt file notes.txt');
  });
});

describe('upload gate of a recording a person opened in a file manager', () => {
  const recordId = () => path.basename(root);
  const filePath = () => path.join(root, 'audio.webm');
  const assess = () => assessRecordingUpload({ recordId: recordId(), filePath: filePath(), recordingsRoot: recordings });
  async function finalizedFromChunks() {
    await fs.promises.mkdir(path.join(root, 'chunks'));
    await fs.promises.writeFile(path.join(root, 'chunks/chunk_0.webm'), 'saved meeting');
    const persistence = createRecordingPersistence({
      prepareRaw: async () => ({}), remux: (input, output) => fs.promises.copyFile(input, output),
      concatSessions: concatenateFiles, validate: async file => ({ valid: (await fs.promises.stat(file)).size > 0 }), probe: async () => 3,
    });
    return persistence.finalize(root);
  }

  it('lets the finished recording through with the stray files in every source folder', async () => {
    await finalizedFromChunks();
    expect(await assess()).toEqual({ allowed: true, requiresFinalization: false });
    const [batch] = fs.readdirSync(path.join(root, 'source-chunks'));
    const strays = await strayFilesIn(root, path.join(root, 'chunks'), path.join(root, 'source-chunks'),
      path.join(root, 'source-chunks', batch), path.join(root, 'sessions'));
    const audio = fs.readFileSync(filePath()), receipt = fs.readFileSync(path.join(root, 'finalized.json'));

    expect(await assess()).toEqual({ allowed: true, requiresFinalization: false });
    expect(fs.readFileSync(filePath())).toEqual(audio);
    expect(fs.readFileSync(path.join(root, 'finalized.json'))).toEqual(receipt);
    for (const file of strays) expect(fs.readFileSync(file)).toEqual(FINDER);
  });

  it('does not take a chunks folder that holds only a file manager\'s file for source audio', async () => {
    await fs.promises.writeFile(filePath(), 'legacy recording');
    await fs.promises.mkdir(path.join(root, 'chunks'));
    await fs.promises.writeFile(path.join(root, 'chunks', '.DS_Store'), FINDER);
    expect(await assess()).toEqual({ allowed: true, requiresFinalization: false });
  });

  it('still holds the upload for a folder of such a name, an unknown file, or late audio', async () => {
    await finalizedFromChunks();
    const [batch] = fs.readdirSync(path.join(root, 'source-chunks'));
    const held = async (entry, make) => {
      await make(entry);
      expect(await assess(), entry).toMatchObject({ allowed: false, requiresFinalization: true });
      await fs.promises.rm(entry, { recursive: true, force: true });
      expect(await assess(), entry).toEqual({ allowed: true, requiresFinalization: false });
    };
    await held(path.join(root, 'sessions', '.DS_Store'), entry => fs.promises.mkdir(entry));
    await held(path.join(root, 'source-chunks', batch, 'notes.txt'), entry => fs.promises.writeFile(entry, 'x'));
    await held(path.join(root, 'source-chunks', 'Thumbs.db'), entry => fs.promises.mkdir(entry));
    await held(path.join(root, 'chunks', 'chunk_1.webm'), entry => fs.promises.writeFile(entry, 'late participants'));
  });
});

describe('ELECTRON-8R end to end: recovery with the real builder', () => {
  function run(command) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { command.kill('SIGKILL'); reject(new Error('Media fixture timeout')); }, 60000);
      command.on('error', error => { clearTimeout(timer); reject(error); }).on('end', () => { clearTimeout(timer); resolve(); }).run();
    });
  }
  function wave(seconds, hz) {
    const samples = Math.round(seconds * 48000), bytes = Buffer.alloc(44 + samples * 2);
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
    for (let sample = 0; sample < samples; sample++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * sample / 48000) * 3276), 44 + sample * 2);
    return bytes;
  }
  // A two-second recording saved in two chunks, made outside the recording's folder.
  async function recordedSource() {
    const wav = path.join(recordings, 'tone.wav'), webm = path.join(recordings, 'tone.webm');
    await fs.promises.writeFile(wav, wave(2, 440));
    await run(ffmpeg(wav).audioCodec('libopus').output(webm));
    const bytes = fs.readFileSync(webm), cuts = [0, Math.floor(bytes.length / 2), bytes.length];
    await beginSource(root, { sourceId, kind: 'microphone', startOffsetMs: 0, mimeType: 'audio/webm;codecs=opus', settings: { channelCount: 1 } });
    await markSourceStarted(root, sourceId, { startOffsetMs: 0 });
    for (let index = 0; index < 2; index++) await saveSourceChunk(root, sourceId, bytes.subarray(cuts[index], cuts[index + 1]), index);
    await endSource(root, sourceId, { endOffsetMs: 2000, chunkCount: 2, reason: 'stop' });
  }
  function persistence() {
    const build = (directory, outputPath, options) => createNativeSourceFinalization({ ffmpeg, ffprobePath: FFPROBE, validate: validateNativeMedia,
      probe: file => new Promise((resolve, reject) => ffmpeg.ffprobe(file, (error, data) => error ? reject(error) : resolve(Number(data.format.duration)))),
      run: command => run(command.on('progress', () => {})) }).build(directory, outputPath, options);
    return createRecordingPersistence({ nativeBuild: build, validate: file => validateNativeMedia(file), probe: async () => 2 });
  }

  it('recovers and releases for upload a recording whose folders hold Finder\'s files, and changes none of its audio', async () => {
    await recordedSource();
    const [source] = inspectNativeSources(root);
    const chunks = source.chunkPaths.map(file => fs.readFileSync(file));
    const strays = await strayFilesIn(root, sourcesRoot(), sourceDirectory(), chunksDirectory());

    const recovered = await persistence().finalize(root, '.webm', { recovery: true, expectedDurationSec: 2 });
    expect(recovered).toMatchObject({ success: true, outputPath: path.join(root, 'audio.webm') });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'finalized.json'), 'utf8'))).toMatchObject({
      sourceMode: 'native', sourceIds: [sourceId], recovered: true,
    });
    expect(await readFinalizedRecording(root)).toMatchObject({ success: true, outputPath: recovered.outputPath });
    expect(await assessRecordingUpload({ recordId: path.basename(root), filePath: recovered.outputPath, recordingsRoot: recordings }))
      .toEqual({ allowed: true, requiresFinalization: false });
    expect(source.chunkPaths.map(file => fs.readFileSync(file))).toEqual(chunks);
    for (const file of strays) expect(fs.readFileSync(file)).toEqual(FINDER);
    // a file manager writing its file again later does not undo the completion
    await fs.promises.writeFile(path.join(sourcesRoot(), '.DS_Store'), Buffer.concat([FINDER, FINDER]));
    expect(await readFinalizedRecording(root)).toMatchObject({ success: true });
  }, 120000);

  it('keeps refusing a recording with a folder of that name that holds audio of unknown origin', async () => {
    await recordedSource();
    const unknown = path.join(sourcesRoot(), '.DS_Store');
    await fs.promises.mkdir(unknown);
    await fs.promises.copyFile(path.join(recordings, 'tone.webm'), path.join(unknown, 'chunk_0.webm'));
    await expect(persistence().finalize(root, '.webm', { recovery: true, expectedDurationSec: 2 }))
      .rejects.toMatchObject({ code: 'NATIVE_SOURCE_INVALID' });
    expect(fs.existsSync(path.join(root, 'finalized.json'))).toBe(false);
    expect(fs.readFileSync(path.join(unknown, 'chunk_0.webm'))).toEqual(fs.readFileSync(path.join(recordings, 'tone.webm')));
  }, 120000);
});

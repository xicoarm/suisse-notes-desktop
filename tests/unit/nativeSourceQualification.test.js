// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { installMixerFault, assessSourcePreservation, parseOptions, parseCli } = require('../e2e-harness/native-source-qualification');

const coded = (offset = 0) => ({ groups: Array.from({ length: 90 }, (_, id) => ({ id,
  start: id * 0.5 + 0.02 + offset, end: id * 0.5 + 0.48 + offset })) });
const valid = () => ({ problems: [] });
function assessment(overrides = {}) {
  return assessSourcePreservation({ direct: coded(), final: coded(0.2), directVerification: valid(), finalVerification: valid(),
    snapshot: { acquisitions: [{ settings: [{ sampleRate: 48000 }] }], errors: [], recorders: [
      { role: 'direct-witness', startCalledAt: 1000, startedAt: 1020, stoppedAt: 50000, timesliceMs: 1000 },
      { role: 'actual-application', startCalledAt: 1200, startedAt: 1240, stoppedAt: 48000, timesliceMs: 1000 },
    ] },
    fault: { completed: true, safetyRelease: false, suspendedAt: 16000, releasedAt: 17000, resumedAt: 17020 },
    expectPreserved: false, ...overrides });
}

describe('native source qualification verdicts', () => {
  it('separates a successful baseline reproducer from a passing application candidate', () => {
    const final = coded(0.2);
    final.groups = final.groups.filter(group => group.id !== 30 && group.id !== 31);
    const baseline = assessment({ final });
    expect(baseline).toMatchObject({ controlsValid: true, lossReproduced: true, contentPreserved: false, expectationMet: true });
    expect(baseline.affectedNearInjection).toEqual([30, 31]);
    expect(assessment({ final, expectPreserved: true }).expectationMet).toBe(false);
  });

  it('accepts preserved source identities with a constant endpoint offset but does not claim baseline loss', () => {
    expect(assessment()).toMatchObject({ contentPreserved: true, lossReproduced: false, expectationMet: false });
    expect(assessment({ expectPreserved: true })).toMatchObject({ contentPreserved: true, expectationMet: true });
  });

  it('does not count an unrelated missing marker as the injected loss', () => {
    const final = coded(); final.groups = final.groups.filter(group => group.id !== 70);
    expect(assessment({ final })).toMatchObject({ expectationMet: false, lossReproduced: false, contentPreserved: false });
  });

  it('rejects attribution if the native witness itself lost supplied markers', () => {
    const final = coded(); final.groups = final.groups.filter(group => group.id !== 30);
    const result = assessment({ final, directVerification: { problems: ['MISSING FRAMES: 30'] } });
    expect(result).toMatchObject({ controlsValid: false, expectationMet: false, lossReproduced: false });
  });

  it('rejects an incomplete or excessive fault instead of qualifying an ineffective injection', () => {
    for (const fault of [{}, { completed: true, suspendedAt: 16000, releasedAt: 19000, resumedAt: 19001 },
      { completed: true, safetyRelease: true, suspendedAt: 16000, releasedAt: 17000, resumedAt: 17001 }]) {
      expect(assessment({ fault, expectPreserved: true }).controlsValid).toBe(false);
    }
  });

  it('detects reordering, duplicate identities and excessive source-relative drift', () => {
    const reordered = coded(); [reordered.groups[30], reordered.groups[31]] = [reordered.groups[31], reordered.groups[30]];
    expect(assessment({ final: reordered, expectPreserved: true }).expectationMet).toBe(false);
    const duplicate = coded(); duplicate.groups.splice(31, 0, { ...duplicate.groups[30] });
    expect(assessment({ final: duplicate, expectPreserved: true }).expectationMet).toBe(false);
    const drifted = coded(); for (const group of drifted.groups.slice(32)) { group.start += 0.2; group.end += 0.2; }
    expect(assessment({ final: drifted, expectPreserved: true }).preservationProblems).toContain('Final/native source alignment drift exceeds 100 ms');
  });

  it('accepts extra application native recorders while retaining a single direct acquisition witness', () => {
    const snapshot = { acquisitions: [{ settings: [{ sampleRate: 48000 }] }], errors: [], recorders: [
      { role: 'direct-witness', startCalledAt: 1000, startedAt: 1020, stoppedAt: 50000, timesliceMs: 1000 },
      ...['archive', 'mixed'].map(() => ({ role: 'actual-application', startCalledAt: 1200, startedAt: 1240, stoppedAt: 48000, timesliceMs: 1000 })),
    ] };
    expect(assessment({ snapshot, expectPreserved: true }).expectationMet).toBe(true);
  });

  it('bounds standalone capture and requires an explicit candidate expectation', () => {
    expect(parseOptions()).toEqual({ seconds: 45, injectAtS: 15, expectPreserved: false });
    expect(parseCli(['--seconds', '60', '--expect-preserved', '--bundle-sha', 'abc'])).toEqual({ seconds: 60, expectPreserved: true, bundleSha: 'abc' });
    for (const seconds of [0, 44, 61, 50.5, NaN]) expect(() => parseOptions({ seconds })).toThrow('45–60');
    expect(() => parseCli(['--seconds'])).toThrow('incomplete');
    expect(() => parseCli(['--unexpected'])).toThrow('Unknown');
  });
});

function faultFixture({ archiveOnly = false, ambiguous = false, failedResume = false } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let nextDestination = 0;
  class Context {
    constructor() { this.state = 'running'; this.currentTime = 1; this.listeners = {}; this.nativeResumes = 0; }
    createMediaStreamSource() { return {}; }
    createMediaStreamDestination() {
      const id = 'dest-' + ++nextDestination;
      return { stream: { getAudioTracks: () => [{ id }] } };
    }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    suspend() { this.state = 'suspended'; for (const listener of this.listeners.statechange || []) listener(); return Promise.resolve(); }
    resume() { this.nativeResumes++; if (failedResume) return Promise.reject(new Error('resume failure')); this.state = 'running'; return Promise.resolve(); }
  }
  const applicationTrackIds = [];
  const window = { AudioContext: Context, webkitAudioContext: Context, __directMixedWitness: { snapshot: () => ({
    acquisitions: [{ sourceTrackIds: ['mic'] }], recorders: [{ role: 'actual-application', trackIds: applicationTrackIds }],
  }) } };
  vm.runInNewContext('(' + installMixerFault.toString() + ')()', { window, performance, setTimeout, clearTimeout });
  const monitor = new window.AudioContext(); monitor.createMediaStreamSource({ getAudioTracks: () => [{ id: 'mic' }] });
  const mixer = new window.AudioContext(); mixer.createMediaStreamSource({ getAudioTracks: () => [{ id: 'mic' }] });
  const destination = mixer.createMediaStreamDestination();
  if (!archiveOnly) applicationTrackIds.push(destination.stream.getAudioTracks()[0].id);
  if (ambiguous) {
    const other = new window.AudioContext(); other.createMediaStreamSource({ getAudioTracks: () => [{ id: 'mic' }] });
    const otherDestination = other.createMediaStreamDestination();
    if (!archiveOnly) applicationTrackIds.push(otherDestination.stream.getAudioTracks()[0].id);
  }
  let appResume;
  mixer.addEventListener('statechange', () => { appResume = mixer.resume(); appResume.catch(() => {}); });
  return { window, mixer, monitor, Original: Context, get appResume() { return appResume; } };
}

afterEach(() => vi.useRealTimers());

describe('bounded mixer fault topology and cleanup', () => {
  it('suspends the recorded destination only and holds the app auto-resume until one second elapses', async () => {
    const fixture = faultFixture();
    const injected = fixture.window.__nativeSourceFault.inject();
    await vi.advanceTimersByTimeAsync(999);
    expect(fixture.mixer.state).toBe('suspended');
    expect(fixture.monitor.state).toBe('running');
    expect(fixture.mixer.nativeResumes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const result = await injected;
    expect(result.fault).toMatchObject({ completed: true, heldResumeCalls: 1, selection: 'recorded-destination-track', releasedAt: 1000 });
    await fixture.appResume;
    expect(fixture.mixer.nativeResumes).toBe(1);
    expect(Object.hasOwn(fixture.mixer, 'resume')).toBe(false);
    await fixture.window.__nativeSourceFault.dispose();
    expect(fixture.window.AudioContext).toBe(fixture.Original);
  });

  it('supports a source archive without a mixed recorder only with unique microphone/destination topology', async () => {
    const fixture = faultFixture({ archiveOnly: true });
    const injected = fixture.window.__nativeSourceFault.inject();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await injected).fault.selection).toBe('unique-microphone-source-and-destination');
    await fixture.window.__nativeSourceFault.dispose();
  });

  it('refuses ambiguous mixer contexts before suspending either one', async () => {
    const fixture = faultFixture({ ambiguous: true });
    await expect(fixture.window.__nativeSourceFault.inject()).rejects.toThrow('uniquely');
    expect(fixture.mixer.state).toBe('running');
    await fixture.window.__nativeSourceFault.dispose();
  });

  it('releases held app resumes and restores constructors when cleanup interrupts the fault', async () => {
    const fixture = faultFixture();
    const injected = fixture.window.__nativeSourceFault.inject();
    await vi.advanceTimersByTimeAsync(100);
    await fixture.window.__nativeSourceFault.dispose();
    await injected; await fixture.appResume;
    expect(fixture.mixer.state).toBe('running');
    expect(fixture.window.AudioContext).toBe(fixture.Original);
    expect(fixture.window.__nativeSourceFault.snapshot().fault.releasedAt).toBe(100);
  });

  it('reports native resume failure and rejects the held application resume instead of stranding it', async () => {
    const fixture = faultFixture({ failedResume: true });
    const injected = fixture.window.__nativeSourceFault.inject();
    const rejected = expect(injected).rejects.toThrow('resume failure');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    await expect(fixture.appResume).rejects.toThrow('resume failure');
    expect(fixture.window.__nativeSourceFault.snapshot().errors).toContain('resume failure');
  });
});

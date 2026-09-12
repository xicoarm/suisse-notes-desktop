// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

function readWorkflow(name) {
  return yaml.load(fs.readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'));
}

const reliability = readWorkflow('audio-reliability.yml');
const packaged = readWorkflow('audio-macos-packaged.yml');
const modeNames = ['run_endurance', 'run_capture_clock', 'run_failure_diagnostics', 'run_macos_packaged'];
const executionJobs = ['synthetic-capture', 'manual-endurance', 'failure-diagnostics', 'macos-packaged'];

// These job expressions use the boolean/string subset shared by JavaScript and
// Actions. Evaluate the parsed workflow itself for every dispatch combination.
function selectedJobs(eventName, inputs) {
  return executionJobs.filter(name => {
    const expression = reliability.jobs[name].if;
    expect(expression.startsWith('${{')).toBe(true);
    expect(expression.endsWith('}}')).toBe(true);
    return vm.runInNewContext(expression.slice(3, -2), {
      github: { event_name: eventName }, inputs
    }, { timeout: 100 });
  });
}

describe('manual macOS packaged qualification routing', () => {
  it.each(Array.from({ length: 16 }, (_, combination) => [combination]))(
    'selects at most the requested mode for dispatch combination %i', combination => {
      const inputs = Object.fromEntries(modeNames.map((name, index) => [name, Boolean(combination & (1 << index))]));
      const enabled = modeNames.filter(name => inputs[name]);
      let expected = [];
      if (enabled.length === 0 || (enabled.length === 1 && inputs.run_capture_clock)) expected = ['synthetic-capture'];
      else if (enabled.length === 1 && inputs.run_endurance) expected = ['manual-endurance'];
      else if (enabled.length === 1 && inputs.run_failure_diagnostics) expected = ['failure-diagnostics'];
      else if (enabled.length === 1 && inputs.run_macos_packaged) expected = ['macos-packaged'];
      expect(selectedJobs('workflow_dispatch', inputs)).toEqual(expected);
    }
  );

  it('preserves the ordinary PR suite and keeps the packaged job manual', () => {
    expect(selectedJobs('pull_request', {})).toEqual(['synthetic-capture']);
    expect(reliability.on.pull_request).toEqual({ branches: ['main'] });
    expect(reliability.on.workflow_dispatch.inputs.run_macos_packaged).toMatchObject({
      type: 'boolean', default: false, required: false
    });
    expect(reliability.jobs['macos-packaged'].uses).toBe('./.github/workflows/audio-macos-packaged.yml');
    expect(Object.keys(packaged.on)).toEqual(['workflow_call']);
    expect(reliability.jobs['macos-packaged'].secrets).toBeUndefined();
  });
});

describe('macOS packaged qualification boundaries', () => {
  const job = packaged.jobs['packaged-capture'];
  const steps = job.steps;

  it('uses fresh native Intel and ARM runners with checked-out LFS resources', () => {
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job.strategy.matrix.include).toEqual([
      { name: 'macos-intel', os: 'macos-15-intel', arch: 'x64' },
      { name: 'macos-arm64', os: 'macos-26', arch: 'arm64' }
    ]);
    expect(job['runs-on']).toBe('${{ matrix.os }}');
    expect(steps.find(step => step.uses?.startsWith('actions/checkout@')).with).toMatchObject({
      lfs: true, 'persist-credentials': false
    });
    expect(steps.find(step => step.uses?.startsWith('actions/setup-node@')).with).toMatchObject({
      'node-version': '24', architecture: '${{ matrix.arch }}'
    });
    expect(steps.some(step => /prepare-ffmpeg\.js/.test(step.run || ''))).toBe(false);
  });

  it('passes only the built app to a bounded 45-second synthetic capture', () => {
    const build = steps.find(step => step.id === 'build');
    const capture = steps.find(step => /run-macos-packaged-qualification\.js/.test(step.run || ''));
    expect(build.run).toContain('build-macos-packaged.js --arch ${{ matrix.arch }}');
    expect(capture.env.SUISSE_QUAL_APP).toBe('${{ steps.build.outputs.app }}');
    expect(capture.run).toContain('--app "$SUISSE_QUAL_APP" --arch ${{ matrix.arch }} --seconds 45');
    expect(job['timeout-minutes']).toBeLessThanOrEqual(45);
    expect(build['timeout-minutes']).toBeLessThanOrEqual(17);
    expect(capture['timeout-minutes']).toBeLessThanOrEqual(12);
    expect(job.env.API_BASE_URL).toBe('http://localhost:3000');
    expect(job.env.VITE_API_URL).toBe(job.env.API_BASE_URL);
    expect(job.env.SUISSE_E2E_HOOKS).toBe('1');
    expect(job.env.SUISSE_TEST_NETWORK_ISOLATION).toBe('1');
    expect(job.env.SUISSE_E2E_BUNDLE_SHA).toBe('${{ github.sha }}');
    expect(job.env.SUISSE_E2E_APP_DIR).toBeUndefined();
    expect(job.env.SUISSE_E2E_PACKAGED_EXE).toBeUndefined();
  });

  it('checks the actual built media binaries with one worker before allowing packaged capture', () => {
    const buildIndex = steps.findIndex(step => step.id === 'build');
    const captureIndex = steps.findIndex(step => /run-macos-packaged-qualification\.js/.test(step.run || ''));
    const compatibilityIndex = steps.findIndex(step => /vitest\.mjs/.test(step.run || ''));
    const compatibility = steps[compatibilityIndex];
    expect(compatibilityIndex).toBeGreaterThan(buildIndex);
    expect(compatibilityIndex).toBeLessThan(captureIndex);
    expect(compatibility.env).toEqual({
      SUISSE_TEST_FFMPEG_PATH: '${{ steps.build.outputs.app }}/Contents/Resources/ffmpeg/ffmpeg',
      SUISSE_TEST_FFPROBE_PATH: '${{ steps.build.outputs.app }}/Contents/Resources/ffmpeg/ffprobe'
    });
    expect(compatibility['timeout-minutes']).toBeLessThanOrEqual(8);
    expect(compatibility.shell).toBe('bash');
    expect(compatibility['continue-on-error']).toBeUndefined();
    expect(compatibility.run).toContain('set -o pipefail');
    expect(compatibility.run).toContain('node node_modules/vitest/vitest.mjs run tests/unit/nativeSourceFinalization.test.js');
    expect(compatibility.run).toContain('--maxWorkers=1 --minWorkers=1');
    expect(compatibility.run).toContain('--outputFile=tests/e2e-harness/work/macos-packaged/media-compatibility-result.json');
    expect(compatibility.run).toContain('2>&1 | tee tests/e2e-harness/work/macos-packaged/media-compatibility.log');
    expect(compatibility.run).not.toMatch(/prepare-ffmpeg|ffmpeg-installer|\|\|\s*true/);
    expect(steps[captureIndex].if).toBeUndefined();
  });

  it('has read-only repository access and receives no signing or service credentials', () => {
    expect(packaged.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toBeUndefined();
    expect(packaged.on.workflow_call?.secrets).toBeUndefined();
    expect(JSON.stringify(packaged)).not.toMatch(/secrets\.|github\.token|"secrets":"inherit"/);
    expect(job.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
    for (const name of [
      'CSC_LINK', 'CSC_KEYCHAIN', 'CSC_KEY_PASSWORD', 'CSC_NAME',
      'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY',
      'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH',
      'SENTRY_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'
    ]) expect(job.env[name]).toBe('');
    expect(steps.map(step => step.run || '').join('\n')).not.toMatch(/codesign|notarytool|stapler|npm run release|git push|gh release/);
  });

  it('preserves failure evidence and mode-preserving tar files without duplicating raw apps', () => {
    const upload = steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload.if).toBe('always()');
    expect(upload.with.path.trim().split('\n')).toEqual([
      'tests/e2e-harness/work/',
      '!tests/e2e-harness/work/macos-packaged/**/package/**'
    ]);
    expect(upload.with['include-hidden-files']).toBe(true);
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.with['retention-days']).toBeLessThanOrEqual(7);
    expect(upload.with.name).toContain('synthetic-not-for-release');
  });
});

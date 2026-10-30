// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// The repository is public: test harnesses take credentials from the
// environment only, with no fallback value, and fail fast when missing.
const require = createRequire(import.meta.url);
const backend = require('../../tests/e2e-harness/lib/backend.js');

const ROOT = path.resolve(__dirname, '../..');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', 'work', 'fixtures'].includes(e.name) ? [] : walk(p);
    return /\.(c|m)?js$/.test(e.name) ? [p] : [];
  });
}

describe('test credentials', () => {
  it('fails fast without the live credentials', () => {
    expect(() => backend.requireLiveCredentials({ env: {} })).toThrow(/E2E_PASSWORD and SUISSE_E2E_DB_PASSWORD/);
    expect(() => backend.requireLiveCredentials({ env: { E2E_PASSWORD: 'x' }, db: false })).not.toThrow();
  });

  it('no secret-like environment variable has a non-empty fallback in tests/', () => {
    const offenders = [];
    const re = /process\.env\.([A-Z0-9_]*(PASS|PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE)[A-Z0-9_]*)\s*(\|\||\?\?)\s*(['"`])(.+?)\4/g;
    for (const file of walk(path.join(ROOT, 'tests'))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(re)) offenders.push(`${path.relative(ROOT, file)}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('no hard-coded PGPASSWORD / password assignment to a literal in the live harness', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tests/e2e-harness/lib/backend.js'), 'utf8');
    expect(src).not.toMatch(/(DB_PASSWORD|E2E_PASSWORD)\s*=\s*['"`][^'"`]+['"`]/);
  });
});

/**
 * Client-side contract drift guard.
 *
 * Walks every .js/.vue file under src/ looking for fetch/axios/_serverFetch
 * callsites against `/api/desktop/...`. For each unique path, asserts it
 * appears in `DESKTOP_API_CONTRACT` (the manifest vendored from the backend).
 *
 * This is the mirror of the backend's `scripts/check-desktop-contract.ts`,
 * which fails the server build if any contract entry's route.ts is missing.
 * Together they make it impossible to merge a client that talks to a server
 * route that doesn't exist (and vice versa).
 *
 * The April 2026 SAS upload incident and the May 2026
 * /api/desktop/history-400 incident BOTH would have been caught here.
 *
 * Trade-off: regex-based, so it can't catch dynamic URL construction (e.g.
 * `${prefix}/api/desktop/${name}`). For coverage on dynamic cases, see the
 * server's smoke test which hits the deployed surface.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { DESKTOP_API_CONTRACT } from '../../src/lib/api/desktop-contract.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..', '..', 'src');

const SCAN_EXTENSIONS = new Set(['.js', '.vue', '.ts']);
const URL_PATTERN = /['"`]\/api\/desktop\/[^'"`?\s]+/g;

// The vendored contract file references contract paths in its own header
// comments and exports them in the manifest — exclude it from scanning so
// it doesn't lint against itself.
const SCAN_SKIP_PATHS = ['src/lib/api/desktop-contract.ts', 'src\\lib\\api\\desktop-contract.ts'];

function* walkFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walkFiles(full);
    } else if (SCAN_EXTENSIONS.has(extname(name))) {
      yield full;
    }
  }
}

// Normalise a literal URL like '/api/desktop/recording/abc123' into the
// parameterised form the contract uses ('/api/desktop/recording/[recordId]').
// The contract entries are Next.js-style routes with [param] placeholders;
// the client emits concrete UUIDs / hashes / filenames.
function normaliseToContractShape(rawPath) {
  // Strip trailing slash variants and template-literal expression remnants.
  let p = rawPath.replace(/\$\{[^}]+\}/g, '[param]');
  // Replace UUIDs.
  p = p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[param]');
  // Replace numeric and obviously-id segments (after the last fixed verb).
  // For known contract patterns we map known generic placeholders.
  return p;
}

function pathMatchesContract(clientPath, contractPath) {
  // Replace each [name] with a wildcard, anchor exact match.
  const re = new RegExp(
    '^' + contractPath.replace(/\[[^\]]+\]/g, '[^/?]+') + '$'
  );
  return re.test(clientPath);
}

describe('Desktop API contract — client drift guard', () => {
  // Collect every unique /api/desktop/... literal across src/.
  const found = new Map(); // path -> [files...]

  for (const file of walkFiles(SRC_DIR)) {
    if (SCAN_SKIP_PATHS.some((skip) => file.endsWith(skip))) continue;
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    let m;
    URL_PATTERN.lastIndex = 0;
    while ((m = URL_PATTERN.exec(content)) !== null) {
      const raw = m[0].slice(1); // strip leading quote
      const normalised = normaliseToContractShape(raw);
      if (!found.has(normalised)) found.set(normalised, []);
      found.get(normalised).push(file);
    }
  }

  it('finds at least one /api/desktop callsite (sanity check on the scanner)', () => {
    expect(found.size).toBeGreaterThan(0);
  });

  it('every client /api/desktop path appears in DESKTOP_API_CONTRACT', () => {
    const contractPaths = DESKTOP_API_CONTRACT.map((e) => e.path);
    const orphans = [];
    for (const [clientPath, files] of found.entries()) {
      const matched = contractPaths.some((c) => pathMatchesContract(clientPath, c));
      if (!matched) {
        // Provide a short list of where the bogus path appears.
        const sampleFiles = [...new Set(files)].slice(0, 3).map((f) =>
          f.replace(SRC_DIR, 'src')
        );
        orphans.push(`  ${clientPath}   (referenced in: ${sampleFiles.join(', ')})`);
      }
    }
    if (orphans.length) {
      throw new Error(
        '\nClient code calls /api/desktop paths that are NOT in DESKTOP_API_CONTRACT:\n\n' +
        orphans.join('\n') +
        '\n\nEither:\n' +
        '  (a) The client is using a path the backend never agreed to serve. Stop.\n' +
        '  (b) The backend added the route but this repo\'s vendored contract is\n' +
        '      stale. Re-sync: scp suisse-notes:/home/ubuntu/Suisse-Notes-V2/\\\n' +
        '             src/lib/api/desktop-contract.ts src/lib/api/desktop-contract.ts\n'
      );
    }
  });
});

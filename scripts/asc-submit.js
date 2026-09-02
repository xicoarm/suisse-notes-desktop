#!/usr/bin/env node
/**
 * Create an App Store version, attach an already-uploaded TestFlight build,
 * set the release notes, and submit it for review — via the App Store Connect
 * REST API. No browser, no fastlane `deliver`.
 *
 * Deliberately narrow: it touches ONLY the version, its localizations'
 * `whatsNew`, the build relationship and the review submission. It never
 * uploads metadata, screenshots, pricing or app-level fields, so it cannot
 * blank out the live store listing the way `deliver` with skip_metadata:false
 * would.
 *
 * Env:
 *   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_CONTENT (the .p8 contents)
 * Args:
 *   --app <id> --version <string> --build <cfBundleVersion>
 *   --notes-file <path>  (optional; UTF-8, applied to every locale)
 *   --submit             (without it, everything is prepared but NOT submitted)
 */

const crypto = require('crypto');
const fs = require('fs');

const API = 'https://api.appstoreconnect.apple.com';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** ES256 JWT signed with the .p8 EC key. Apple requires raw R||S, not DER. */
function makeToken(keyId, issuerId, keyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const der = crypto.sign('sha256', Buffer.from(signingInput), {
    key: keyPem,
    dsaEncoding: 'ieee-p1363', // raw R||S
  });
  return `${signingInput}.${b64url(der)}`;
}

let TOKEN = null;

async function api(method, path, body) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    const detail = json && json.errors
      ? json.errors.map((e) => `${e.status} ${e.code}: ${e.title} — ${e.detail}`).join('\n    ')
      : text.slice(0, 500);
    const err = new Error(`${method} ${path} -> ${res.status}\n    ${detail}`);
    err.status = res.status;
    err.errors = json && json.errors;
    throw err;
  }
  return json;
}

async function main() {
  const appId = String(arg('app', ''));
  const version = String(arg('version', ''));
  const build = String(arg('build', ''));
  const notesFile = arg('notes-file', null);
  const doSubmit = arg('submit', false) === true;

  if (!appId || !version || !build) {
    console.error('usage: --app <id> --version <x.y.z> --build <n> [--notes-file f] [--submit]');
    process.exit(2);
  }

  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  let keyContent = process.env.ASC_KEY_CONTENT;
  if (!keyId || !issuerId || !keyContent) {
    console.error('missing ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_CONTENT');
    process.exit(2);
  }
  keyContent = keyContent.replace(/\\n/g, '\n').trim();
  TOKEN = makeToken(keyId, issuerId, keyContent);
  console.log(`authenticated as key ${keyId}`);

  // ---- 1. locate the build already on TestFlight -------------------------
  const builds = await api(
    'GET',
    `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(build)}&limit=5`
  );
  if (!builds.data.length) throw new Error(`build ${build} not found for app ${appId}`);
  const buildId = builds.data[0].id;
  const processing = builds.data[0].attributes.processingState;
  console.log(`build ${build} -> id ${buildId} (processingState=${processing})`);
  if (processing !== 'VALID') {
    throw new Error(`build is ${processing}, not VALID — wait for TestFlight processing to finish`);
  }

  // ---- 2. find or create the version -------------------------------------
  const existing = await api(
    'GET',
    `/v1/apps/${appId}/appStoreVersions?filter[versionString]=${encodeURIComponent(version)}&limit=5`
  );
  let versionId;
  if (existing.data.length) {
    versionId = existing.data[0].id;
    console.log(`version ${version} already exists -> ${versionId} (state=${existing.data[0].attributes.appStoreState})`);
  } else {
    const created = await api('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString: version, releaseType: 'AFTER_APPROVAL' },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    });
    versionId = created.data.id;
    console.log(`created version ${version} -> ${versionId}`);
  }

  // ---- 3. release type: publish automatically after approval -------------
  await api('PATCH', `/v1/appStoreVersions/${versionId}`, {
    data: { type: 'appStoreVersions', id: versionId, attributes: { releaseType: 'AFTER_APPROVAL' } },
  });
  console.log('releaseType = AFTER_APPROVAL');

  // ---- 4. attach the build ----------------------------------------------
  await api('PATCH', `/v1/appStoreVersions/${versionId}/relationships/build`, {
    data: { type: 'builds', id: buildId },
  });
  console.log(`attached build ${build}`);

  // ---- 5. release notes, per locale -------------------------------------
  if (notesFile) {
    const notes = fs.readFileSync(String(notesFile), 'utf8').trim();
    const locs = await api('GET', `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`);
    for (const loc of locs.data) {
      await api('PATCH', `/v1/appStoreVersionLocalizations/${loc.id}`, {
        data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew: notes } },
      });
      console.log(`  whatsNew set for ${loc.attributes.locale}`);
    }
  }

  if (!doSubmit) {
    console.log('\nPREPARED but NOT submitted (pass --submit to send for review).');
    return;
  }

  // ---- 6. submit for review ---------------------------------------------
  let submissionId = null;
  const open = await api('GET', `/v1/apps/${appId}/reviewSubmissions?filter[state]=READY_FOR_REVIEW&limit=5`);
  if (open.data.length) {
    submissionId = open.data[0].id;
    console.log(`reusing open review submission ${submissionId}`);
  } else {
    const sub = await api('POST', '/v1/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    });
    submissionId = sub.data.id;
    console.log(`created review submission ${submissionId}`);
  }

  const items = await api('GET', `/v1/reviewSubmissions/${submissionId}/items?limit=50`);
  const already = items.data.some(
    (it) => it.relationships && it.relationships.appStoreVersion &&
            it.relationships.appStoreVersion.data &&
            it.relationships.appStoreVersion.data.id === versionId
  );
  if (already) {
    console.log('version already attached to the submission');
  } else {
    await api('POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });
    console.log('added version to the submission');
  }

  await api('PATCH', `/v1/reviewSubmissions/${submissionId}`, {
    data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } },
  });
  console.log('\nSUBMITTED FOR REVIEW');

  const final = await api('GET', `/v1/appStoreVersions/${versionId}`);
  console.log(`final appStoreState = ${final.data.attributes.appStoreState}`);
}

main().catch((e) => {
  console.error('\nFAILED: ' + e.message);
  process.exit(1);
});

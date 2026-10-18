#!/usr/bin/env node
/**
 * Replace the iPhone screenshots of one App Store version, in every locale,
 * via the App Store Connect REST API. No browser.
 *
 * The PNG files of a directory (sorted by name) become the screenshots of the
 * largest iPhone slot (APP_IPHONE_67 = 6.7"/6.9", e.g. 1320x2868 or
 * 2868x1320), in that order. The smaller iPhone slots are emptied, so App
 * Store Connect scales the new set down instead of showing old screenshots on
 * smaller iPhones. iPad, Mac and all other slots are not touched.
 *
 * The version must be editable (e.g. PREPARE_FOR_SUBMISSION or
 * DEVELOPER_REJECTED after `asc-submit.js --withdraw`).
 *
 * Env:
 *   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_CONTENT (the .p8 contents)
 * Args:
 *   --app <id> --version <string> --dir <path with the PNG files>
 *   --dry-run   (only print the current slots, change nothing)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API = 'https://api.appstoreconnect.apple.com';
const TARGET = 'APP_IPHONE_67';

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
  const payload = { iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const der = crypto.sign('sha256', Buffer.from(signingInput), { key: keyPem, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(der)}`;
}

let TOKEN = null;

async function api(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    const detail = json && json.errors
      ? json.errors.map((e) => `${e.status} ${e.code}: ${e.title} — ${e.detail}`).join('\n    ')
      : text.slice(0, 500);
    throw new Error(`${method} ${p} -> ${res.status}\n    ${detail}`);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pngSize(file) {
  const head = fs.readFileSync(file).subarray(0, 24);
  if (head.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

async function screenshotsOf(setId) {
  const r = await api('GET', `/v1/appScreenshotSets/${setId}/appScreenshots?limit=50`);
  return r.data || [];
}

async function upload(setId, file) {
  const bytes = fs.readFileSync(file);
  const created = await api('POST', '/v1/appScreenshots', {
    data: {
      type: 'appScreenshots',
      attributes: { fileName: path.basename(file), fileSize: bytes.length },
      relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
    },
  });
  const shot = created.data;
  for (const op of shot.attributes.uploadOperations || []) {
    const headers = {};
    for (const h of op.requestHeaders || []) headers[h.name] = h.value;
    const res = await fetch(op.url, {
      method: op.method,
      headers,
      body: bytes.subarray(op.offset, op.offset + op.length),
    });
    if (!res.ok) throw new Error(`upload part of ${path.basename(file)} -> ${res.status}`);
  }
  await api('PATCH', `/v1/appScreenshots/${shot.id}`, {
    data: {
      type: 'appScreenshots',
      id: shot.id,
      attributes: { uploaded: true, sourceFileChecksum: crypto.createHash('md5').update(bytes).digest('hex') },
    },
  });
  for (let i = 0; i < 60; i += 1) {
    const s = await api('GET', `/v1/appScreenshots/${shot.id}`);
    const state = s.data.attributes.assetDeliveryState && s.data.attributes.assetDeliveryState.state;
    if (state === 'COMPLETE') return shot.id;
    if (state === 'FAILED') {
      const errs = (s.data.attributes.assetDeliveryState.errors || []).map((e) => e.description || e.code).join('; ');
      throw new Error(`${path.basename(file)} was refused: ${errs}`);
    }
    await sleep(3000);
  }
  throw new Error(`${path.basename(file)}: processing did not finish within 3 minutes`);
}

async function main() {
  const appId = String(arg('app', ''));
  const version = String(arg('version', ''));
  const dir = arg('dir', '');
  const dryRun = arg('dry-run', false) === true;
  if (!appId || !version || (!dir && !dryRun)) {
    console.error('usage: --app <id> --version <x.y.z> --dir <png dir> [--dry-run]');
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

  let files = [];
  if (!dryRun) {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort().map((f) => path.join(dir, f));
    if (!files.length || files.length > 10) throw new Error(`need 1-10 PNG files in ${dir}, found ${files.length}`);
    for (const f of files) {
      const { width, height } = pngSize(f);
      const ok = (width === 1320 && height === 2868) || (width === 2868 && height === 1320) ||
        (width === 1290 && height === 2796) || (width === 2796 && height === 1290);
      if (!ok) throw new Error(`${path.basename(f)} is ${width}x${height}, not a 6.7"/6.9" size`);
      console.log(`file ${path.basename(f)} ${width}x${height}`);
    }
  }

  const vs = await api('GET', `/v1/apps/${appId}/appStoreVersions?filter[versionString]=${encodeURIComponent(version)}&limit=5`);
  if (!vs.data.length) throw new Error(`version ${version} does not exist for app ${appId}`);
  const v = vs.data[0];
  console.log(`version ${version} -> ${v.id} (${v.attributes.appStoreState})`);
  const editable = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
  if (!dryRun && !editable.includes(v.attributes.appStoreState)) {
    throw new Error(`version is ${v.attributes.appStoreState}: screenshots cannot be changed (withdraw it first)`);
  }

  const locs = await api('GET', `/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations?limit=50`);
  for (const loc of locs.data || []) {
    const locale = loc.attributes.locale;
    const sets = (await api('GET', `/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=50`)).data || [];
    console.log(`\n[${locale}]`);
    for (const set of sets) {
      const shots = await screenshotsOf(set.id);
      console.log(`  ${set.attributes.screenshotDisplayType}: ${shots.length} screenshot(s)`);
    }
    if (dryRun) continue;

    let target = sets.find((s) => s.attributes.screenshotDisplayType === TARGET);
    if (!target) {
      target = (await api('POST', '/v1/appScreenshotSets', {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: TARGET },
          relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: loc.id } } },
        },
      })).data;
      console.log(`  created ${TARGET} slot`);
    }
    // Upload first, then remove the old ones: a failed upload leaves the old set intact.
    const old = await screenshotsOf(target.id);
    const added = [];
    for (const f of files) {
      added.push(await upload(target.id, f));
      console.log(`  uploaded ${path.basename(f)}`);
    }
    for (const s of old) await api('DELETE', `/v1/appScreenshots/${s.id}`);
    await api('PATCH', `/v1/appScreenshotSets/${target.id}/relationships/appScreenshots`, {
      data: added.map((id) => ({ type: 'appScreenshots', id })),
    });
    console.log(`  ${TARGET}: ${added.length} new screenshot(s) in order, ${old.length} old removed`);

    for (const set of sets) {
      const type = set.attributes.screenshotDisplayType;
      if (!type.startsWith('APP_IPHONE_') || type === TARGET) continue;
      const shots = await screenshotsOf(set.id);
      for (const s of shots) await api('DELETE', `/v1/appScreenshots/${s.id}`);
      if (shots.length) console.log(`  ${type}: ${shots.length} old screenshot(s) removed (scaled from ${TARGET})`);
    }
  }
  console.log(dryRun ? '\nDRY RUN: nothing changed.' : '\nDONE: iPhone screenshots replaced.');
}

main().catch((e) => {
  console.error('\nFAILED: ' + e.message);
  process.exit(1);
});

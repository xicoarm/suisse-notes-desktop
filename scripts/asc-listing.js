#!/usr/bin/env node
/**
 * Set the App Store texts of an editable version per language, via the App
 * Store Connect REST API: subtitle (app info), description, keywords,
 * promotional text and "what's new" (version), and optionally the copyright.
 * Languages missing in App Store Connect are created; the app name, privacy
 * policy, support and marketing URLs of a new language are copied from the
 * primary language. Name, screenshots, pricing and categories stay untouched.
 *
 * Env:
 *   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_CONTENT (the .p8 contents)
 * Args:
 *   --app <id> --version <string> --texts <json file>
 *   --copyright <text>   (optional)
 *   --dry-run            (only print what would change)
 *
 * The JSON file maps App Store locale codes to texts:
 *   { "de-DE": { "subtitle": "…", "promotionalText": "…", "keywords": "…",
 *                "description": "…", "whatsNew": "…" }, "en-US": { … } }
 */

const crypto = require('crypto');
const fs = require('fs');

const API = 'https://api.appstoreconnect.apple.com';
const LIMITS = { subtitle: 30, promotionalText: 170, keywords: 100, description: 4000, whatsNew: 4000 };
const LIVE = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_INFO']);

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  return out;
}

async function main() {
  const appId = String(arg('app', ''));
  const version = String(arg('version', ''));
  const textsFile = arg('texts', '');
  const copyright = arg('copyright', null);
  const dryRun = arg('dry-run', false) === true;
  if (!appId || !version || !textsFile) {
    console.error('usage: --app <id> --version <x.y.z> --texts <json> [--copyright <text>] [--dry-run]');
    process.exit(2);
  }
  const texts = JSON.parse(fs.readFileSync(textsFile, 'utf8'));
  for (const [locale, t] of Object.entries(texts)) {
    for (const [field, max] of Object.entries(LIMITS)) {
      if (t[field] && t[field].length > max) throw new Error(`${locale} ${field}: ${t[field].length} > ${max} characters`);
    }
  }

  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  let keyContent = process.env.ASC_KEY_CONTENT;
  if (!keyId || !issuerId || !keyContent) {
    console.error('missing ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_CONTENT');
    process.exit(2);
  }
  TOKEN = makeToken(keyId, issuerId, keyContent.replace(/\\n/g, '\n').trim());

  const vs = await api('GET', `/v1/apps/${appId}/appStoreVersions?filter[versionString]=${encodeURIComponent(version)}&limit=5`);
  if (!vs.data.length) throw new Error(`version ${version} does not exist for app ${appId}`);
  const v = vs.data[0];
  console.log(`version ${version} -> ${v.id} (${v.attributes.appStoreState}), copyright now "${v.attributes.copyright || ''}"`);
  if (LIVE.has(v.attributes.appStoreState) || ['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(v.attributes.appStoreState)) {
    if (!dryRun) throw new Error(`version is ${v.attributes.appStoreState}: texts cannot be changed (withdraw it first)`);
  }

  const app = await api('GET', `/v1/apps/${appId}`);
  const primary = app.data.attributes.primaryLocale;
  const infos = (await api('GET', `/v1/apps/${appId}/appInfos?limit=10`)).data || [];
  const info = infos.find((i) => !LIVE.has(i.attributes.state || i.attributes.appStoreState)) || infos[0];
  console.log(`primary language ${primary}; app info ${info.id} (${info.attributes.state || info.attributes.appStoreState})`);

  const infoLocs = (await api('GET', `/v1/appInfos/${info.id}/appInfoLocalizations?limit=50`)).data || [];
  const verLocs = (await api('GET', `/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations?limit=50`)).data || [];
  const infoBy = Object.fromEntries(infoLocs.map((l) => [l.attributes.locale, l]));
  const verBy = Object.fromEntries(verLocs.map((l) => [l.attributes.locale, l]));
  const pInfo = infoBy[primary];
  const pVer = verBy[primary];
  console.log(`existing languages: ${Object.keys(verBy).join(', ') || '-'}`);

  if (copyright) {
    console.log(`copyright -> "${copyright}"`);
    if (!dryRun) {
      await api('PATCH', `/v1/appStoreVersions/${v.id}`, { data: { type: 'appStoreVersions', id: v.id, attributes: { copyright } } });
    }
  }

  for (const [locale, t] of Object.entries(texts)) {
    const infoAttrs = pick(t, ['subtitle']);
    const verAttrs = pick(t, ['description', 'keywords', 'promotionalText', 'whatsNew']);
    console.log(`\n[${locale}] ${infoBy[locale] ? 'update' : 'new language'}: subtitle "${t.subtitle || ''}"`);
    if (dryRun) continue;

    if (infoBy[locale]) {
      await api('PATCH', `/v1/appInfoLocalizations/${infoBy[locale].id}`, {
        data: { type: 'appInfoLocalizations', id: infoBy[locale].id, attributes: infoAttrs },
      });
    } else {
      await api('POST', '/v1/appInfoLocalizations', {
        data: {
          type: 'appInfoLocalizations',
          attributes: {
            locale,
            name: (pInfo && pInfo.attributes.name) || app.data.attributes.name,
            ...pick((pInfo && pInfo.attributes) || {}, ['privacyPolicyUrl', 'privacyChoicesUrl']),
            ...infoAttrs,
          },
          relationships: { appInfo: { data: { type: 'appInfos', id: info.id } } },
        },
      });
    }
    console.log('  app info done');

    // Creating the app info language also creates the version language.
    if (!verBy[locale]) {
      const fresh = (await api('GET', `/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations?limit=50`)).data || [];
      const found = fresh.find((l) => l.attributes.locale === locale);
      if (found) verBy[locale] = found;
    }
    if (verBy[locale]) {
      const fill = pick((pVer && pVer.attributes) || {}, ['supportUrl', 'marketingUrl']);
      for (const k of Object.keys(fill)) if (verBy[locale].attributes[k]) delete fill[k];
      await api('PATCH', `/v1/appStoreVersionLocalizations/${verBy[locale].id}`, {
        data: { type: 'appStoreVersionLocalizations', id: verBy[locale].id, attributes: { ...fill, ...verAttrs } },
      });
    } else {
      await api('POST', '/v1/appStoreVersionLocalizations', {
        data: {
          type: 'appStoreVersionLocalizations',
          attributes: {
            locale,
            ...pick((pVer && pVer.attributes) || {}, ['supportUrl', 'marketingUrl']),
            ...verAttrs,
          },
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } } },
        },
      });
    }
    console.log('  version texts done');
  }
  console.log(dryRun ? '\nDRY RUN: nothing changed.' : '\nDONE: texts set.');
}

main().catch((e) => {
  console.error('\nFAILED: ' + e.message);
  process.exit(1);
});

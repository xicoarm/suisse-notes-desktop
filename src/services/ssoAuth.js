/**
 * Platform-aware OAuth/SSO opener.
 *
 * iOS uses a native ASWebAuthenticationSession plugin (SSOAuthPlugin.swift)
 * because SFSafariViewController — what @capacitor/browser uses — does not
 * reliably route custom-scheme redirects (e.g. suissenotes://auth/callback)
 * back to the originating app.
 *
 * Android uses @capacitor/browser (Chrome Custom Tabs) because Custom Tabs
 * DO properly hand custom-scheme redirects back via the AndroidManifest
 * intent-filter on suissenotes://auth — there is no equivalent gap.
 *
 * Both code paths produce the same shape: a parsed { token, user } | { error }
 * dispatched via the 'sso:callback' window event, so downstream handlers
 * (LoginPage.handleSSOPayload) stay platform-agnostic.
 */

import { registerPlugin } from '@capacitor/core';
import { isIOS, isAndroid } from '../utils/platform';
import { captureMessage } from '../boot/sentry';

const SSOAuth = registerPlugin('SSOAuth');

/**
 * Parse a suissenotes://auth/callback URL or https://app.suisse-notes.ch/sso/...
 * Universal Link into { token, user } | { error } | null.
 * Mirrors the implementation in src/boot/lifecycle.js — kept in sync.
 */
export function parseSSOCallbackUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }

  const isCustomScheme = parsed.protocol === 'suissenotes:'
    && parsed.host === 'auth'
    && parsed.pathname.replace(/\/$/, '') === '/callback';
  const isUniversalLink = parsed.protocol === 'https:'
    && parsed.host === 'app.suisse-notes.ch'
    && parsed.pathname.startsWith('/sso/');
  if (!isCustomScheme && !isUniversalLink) return null;

  const error = parsed.searchParams.get('error');
  if (error) return { error };

  const token = parsed.searchParams.get('token');
  const userB64 = parsed.searchParams.get('user');
  if (!token || !userB64) return { error: 'invalid_callback' };

  try {
    const std = userB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
    const user = JSON.parse(atob(padded));
    return { token, user };
  } catch {
    return { error: 'invalid_callback' };
  }
}

/**
 * Open the OAuth URL using the platform-appropriate API and dispatch the
 * result via window 'sso:callback' so the existing LoginPage handler picks
 * it up unchanged.
 *
 * Returns a Promise that resolves when the flow ends (success, error, or
 * user cancel). On iOS it awaits the native plugin's completion handler;
 * on Android it returns immediately because the 'sso:callback' arrives
 * asynchronously via the appUrlOpen → CustomEvent chain.
 */
export async function openSSO({ url, callbackScheme = 'suissenotes' }) {
  try { captureMessage(`sso: openSSO start platform=${isIOS() ? 'ios' : (isAndroid() ? 'android' : 'web')} url=${url.slice(0, 200)}`, 'info'); } catch { /* sentry not loaded */ }

  if (isIOS()) {
    // ASWebAuthenticationSession auto-closes when the redirect URL's scheme
    // matches callbackScheme and delivers the URL directly. No deep-link
    // routing required — this works even when SFSafariViewController would
    // silently drop the redirect.
    try {
      const { url: callbackUrl } = await SSOAuth.startAuth({ url, callbackScheme });
      try { captureMessage(`sso: SSOAuth.startAuth returned url=${(callbackUrl || '').slice(0, 200)}`, 'info'); } catch { /* sentry not loaded */ }
      const payload = parseSSOCallbackUrl(callbackUrl);
      if (payload) {
        window.dispatchEvent(new CustomEvent('sso:callback', { detail: payload }));
      } else {
        window.dispatchEvent(new CustomEvent('sso:callback', { detail: { error: 'invalid_callback' } }));
      }
    } catch (err) {
      const msg = err?.message || String(err);
      try { captureMessage(`sso: SSOAuth.startAuth rejected reason=${msg.slice(0, 200)}`, 'warning'); } catch { /* sentry not loaded */ }
      // Treat user-cancel quietly; everything else surfaces as an error.
      if (msg === 'USER_CANCELED') {
        window.dispatchEvent(new CustomEvent('sso:callback', { detail: { error: 'canceled' } }));
      } else {
        window.dispatchEvent(new CustomEvent('sso:callback', { detail: { error: msg } }));
      }
    }
    return;
  }

  // Android (and any other Capacitor platform): Chrome Custom Tabs +
  // intent-filter deep-link. The result arrives via the appUrlOpen handler
  // in lifecycle.js which dispatches the same 'sso:callback' event.
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url });
}

/**
 * Close any in-flight in-app browser (Android Chrome Custom Tabs). Safe to
 * call repeatedly; no-op on iOS because ASWebAuthenticationSession closes
 * itself.
 */
export async function closeSSO() {
  if (isIOS()) return;
  try {
    const { Browser } = await import('@capacitor/browser');
    await Browser.close();
  } catch { /* already closed */ }
}

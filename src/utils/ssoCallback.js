/**
 * Parse a suissenotes://auth/callback URL (or the https://app.suisse-meets.ch/sso/…
 * Universal/App Link form with the same parameters) into a callback payload:
 *   { authCode, state }          one-time code for the PKCE exchange (preferred)
 *   { token, user, state }       legacy contract (token in the URL)
 *   { error, code?, state }      error/cancel (`code` = machine code, contract 10/2026)
 *   null                         not an SSO callback
 * `state` is '' when the server did not echo one. Whether the payload may be
 * applied is decided by services/ssoFlow.js (consumeSsoFlow), never here.
 * Shared by boot/lifecycle.js (deep links) and services/ssoAuth.js (iOS).
 */
export function parseSSOCallbackUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }

  const isCustomScheme = parsed.protocol === 'suissenotes:'
    && parsed.host === 'auth'
    && parsed.pathname.replace(/\/$/, '') === '/callback';
  const isUniversalLink = parsed.protocol === 'https:'
    && (parsed.host === 'app.suisse-meets.ch' || parsed.host === 'app.suisse-notes.ch')
    && parsed.pathname.startsWith('/sso/');
  if (!isCustomScheme && !isUniversalLink) return null;

  const state = parsed.searchParams.get('state') || '';
  const error = parsed.searchParams.get('error');
  const code = parsed.searchParams.get('code');
  if (code) return { error: error || code, code, state };
  if (error) return { error, state };

  const authCode = parsed.searchParams.get('auth_code');
  if (authCode) return { authCode, state };

  const token = parsed.searchParams.get('token');
  const userB64 = parsed.searchParams.get('user');
  if (!token || !userB64) return { error: 'invalid_callback', state };

  try {
    // base64url -> JSON. Convert URL-safe chars and pad before atob.
    const std = userB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
    const user = JSON.parse(atob(padded));
    if (!user || typeof user !== 'object' || Array.isArray(user)) return { error: 'invalid_callback', state };
    return { token, user, state };
  } catch {
    return { error: 'invalid_callback', state };
  }
}

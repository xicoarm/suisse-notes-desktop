'use strict';

function tokenUserId(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const id = claims.userId || claims.sub;
    return typeof id === 'string' ? id : null;
  } catch (_) { return null; }
}

function canUploadForUser(ownerId, currentUserId) {
  return typeof ownerId === 'string' && ownerId !== 'unknown' && !!ownerId && ownerId === currentUserId;
}

function verifiedUploadResult(accepted, verification) {
  const confirmed = !!accepted?.audioFileId && verification?.persisted === true && verification?.verified === true;
  // The server gave its final answer for this recording (FAILED or CANCELLED,
  // e.g. "no speech recognised"). Asking again returns the same answer, so this
  // is a result, not a check that is still pending: the queue lets go of it and
  // History shows the server's reason. The local audio is retained as always.
  const serverFinal = !confirmed && verification?.terminal === true;
  return {
    ...accepted,
    success: confirmed,
    // The current status route confirms a Meeting row, not the uploaded bytes.
    // Keep status verification compatible with successful-upload callers while
    // retaining every local copy until the backend supports content proof.
    verified: confirmed,
    contentVerified: false,
    canDelete: false,
    pendingVerification: !confirmed && !serverFinal,
    canRetry: !serverFinal,
    ...(serverFinal ? { serverFinal: true } : {}),
    ...(confirmed ? {} : { error: verification?.error || 'Upload received; server storage confirmation is still pending. The local audio is retained.' }),
  };
}

module.exports = { tokenUserId, canUploadForUser, verifiedUploadResult };

'use strict';

// Results of background work stopped by a session change (round 9). Pure.

/** A SessionEndedError of session-scope.js (also after crossing an await). */
const isSessionEnded = (error) => !!error && error.code === 'SESSION_ENDED';

/** Upload work stopped by a session change: nothing is removed, retried in the owner's session. */
const sessionEndedResult = () => ({ success: false, canDelete: false, canRetry: true, sessionEnded: true, error: 'Signed out' });

module.exports = { isSessionEnded, sessionEndedResult };

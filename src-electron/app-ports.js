'use strict';

// The two ports of the app's own infrastructure out of a session context
// (security review 10/2026, round 13, R-S7.5; the third, `authorityPersist`, is
// private in session-authority.js). Both have a fixed destination and take data
// only: no path, no callback of the caller.

const { sealPort } = require('./effect-gate');

/**
 * @param {object} deps
 * @param {object} deps.log - electron-log; its calls run through `appLog` from here on
 * @param {object} deps.Sentry
 */
function createAppPorts({ log, Sentry }) {
  const logData = log.logData;
  // File and console transport of electron-log with its fixed file, rotation
  // and report hook included.
  const appLog = sealPort('appLog', (level, text) => logData(text, { level }));
  log.logData = (data, options = {}) => appLog(options.level, data);
  // Redacted as every event (beforeSend, beforeBreadcrumb of Sentry.init).
  const telemetry = sealPort('telemetry', (event) => (event.exception !== undefined
    ? Sentry.captureException(event.exception, event.context)
    : Sentry.captureMessage(event.message, event.context)));
  return { appLog, telemetry };
}

module.exports = { createAppPorts };

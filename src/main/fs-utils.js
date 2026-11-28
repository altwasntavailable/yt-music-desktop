'use strict';

const fs = require('fs');

// Windows can briefly lock a freshly downloaded executable while antivirus
// scans it, or while a previous copy is shutting down. Node reports that as
// EPERM/EACCES/EBUSY from rename(). These are transient and must be retried
// instead of surfacing a raw filesystem error to the user.
const TRANSIENT_REPLACE_CODES = new Set([
  'EPERM',
  'EACCES',
  'EBUSY',
  'ENOTEMPTY',
  'EMFILE',
  'ENFILE'
]);

const DEFAULT_REPLACE_RETRY_DELAYS_MS = Object.freeze([
  50, 100, 200, 400, 800, 1200, 2000
]);

function isTransientReplaceError(error) {
  return Boolean(error) && TRANSIENT_REPLACE_CODES.has(String(error.code || ''));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * Atomically replaces `target` with `source`, retrying only transient Windows
 * sharing/permission failures. Non-transient errors (missing source, invalid
 * path, cross-device move) fail immediately.
 */
async function replaceFileWithRetry(source, target, options = {}) {
  const rename = typeof options.rename === 'function' ? options.rename : fs.promises.rename;
  const configuredDelays = Array.isArray(options.delaysMs) ? options.delaysMs : null;
  const delays = configuredDelays && configuredDelays.length
    ? configuredDelays.map((value) => Math.max(0, Number(value) || 0))
    : DEFAULT_REPLACE_RETRY_DELAYS_MS;
  const onRetry = typeof options.onRetry === 'function' ? options.onRetry : null;

  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await rename(source, target);
      return { ok: true, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (!isTransientReplaceError(error) || attempt === delays.length) break;
      if (onRetry) {
        try {
          await onRetry({ attempt: attempt + 1, error, delayMs: delays[attempt] });
        } catch {
          // A status callback must never break the retry itself.
        }
      }
      await delay(delays[attempt]);
    }
  }

  throw lastError || new Error('Could not replace the file.');
}

module.exports = {
  DEFAULT_REPLACE_RETRY_DELAYS_MS,
  delay,
  isTransientReplaceError,
  replaceFileWithRetry
};

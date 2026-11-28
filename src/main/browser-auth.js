'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { app, session } = require('electron');

const PARTITION = 'persist:ytmusic';
const AUTH_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;
const CDP_COMMAND_TIMEOUT_MS = 10 * 1000;
const CDP_STARTUP_TIMEOUT_MS = 20 * 1000;
const BROWSER_EXIT_TIMEOUT_MS = 5000;
const PROFILE_DELETE_ATTEMPTS = 10;
const PROFILE_DELETE_RETRY_MS = 250;
const CDP_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const PROFILE_NAME_PATTERN = /^(Default|Profile \d+)$/;
const COOKIE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'];
const PROFILE_BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const IMPORT_TEMP_PREFIX = 'ytmd-auth-';
const BROWSER_CLOSE_TIMEOUT_MS = 3000;
const IMPORT_TIMEOUT_MS = 90 * 1000;

// Chromium-family browsers all keep their profile databases in the same
// layout, so one importer can support every installed browser.
const CHROMIUM_BROWSERS = [
  {
    id: 'chrome',
    name: 'Chrome',
    executablePaths: [
      ['PROGRAMFILES', 'Google', 'Chrome', 'Application', 'chrome.exe'],
      ['PROGRAMFILES(X86)', 'Google', 'Chrome', 'Application', 'chrome.exe'],
      ['LOCALAPPDATA', 'Google', 'Chrome', 'Application', 'chrome.exe']
    ],
    userDataPath: ['Google', 'Chrome', 'User Data'],
    progIdMatchers: ['chrome']
  },
  {
    id: 'edge',
    name: 'Edge',
    executablePaths: [
      ['PROGRAMFILES', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['PROGRAMFILES(X86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['LOCALAPPDATA', 'Microsoft', 'Edge', 'Application', 'msedge.exe']
    ],
    userDataPath: ['Microsoft', 'Edge', 'User Data'],
    progIdMatchers: ['edge', 'msedge']
  },
  {
    id: 'brave',
    name: 'Brave',
    executablePaths: [
      ['PROGRAMFILES', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ['PROGRAMFILES(X86)', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ['LOCALAPPDATA', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']
    ],
    userDataPath: ['BraveSoftware', 'Brave-Browser', 'User Data'],
    progIdMatchers: ['brave']
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    executablePaths: [
      ['PROGRAMFILES', 'Vivaldi', 'Application', 'vivaldi.exe'],
      ['LOCALAPPDATA', 'Vivaldi', 'Application', 'vivaldi.exe']
    ],
    userDataPath: ['Vivaldi', 'User Data'],
    progIdMatchers: ['vivaldi']
  }
];

let active = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDefaultBrowserProgId() {
  try {
    const output = execFileSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
        '/v',
        'ProgId'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 }
    );
    const match = /ProgId\s+REG_SZ\s+([^\r\n]+)/i.exec(output);
    return match ? match[1].trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

function resolveEnvPath(env, parts) {
  const [key, ...rest] = parts;
  const base = env && env[key];
  return base ? path.join(base, ...rest) : '';
}

function findBrowserInstallations(options = {}) {
  const env = options.env || process.env;
  const fileExists = options.fileExists || fs.existsSync;
  const usesExplicitProgId = Object.prototype.hasOwnProperty.call(options, 'progId');
  const progId = String(
    usesExplicitProgId ? options.progId : getDefaultBrowserProgId() || ''
  ).toLowerCase();

  const installations = CHROMIUM_BROWSERS.map((definition, order) => {
    const executable = definition.executablePaths
      .map((parts) => resolveEnvPath(env, parts))
      .find((candidate) => candidate && fileExists(candidate)) || '';
    const userDataDir = resolveEnvPath(env, ['LOCALAPPDATA', ...definition.userDataPath]);
    const hasUserDataDir = Boolean(userDataDir) && fileExists(userDataDir);
    const isDefault = Boolean(progId)
      && definition.progIdMatchers.some((matcher) => progId.includes(matcher));

    return {
      id: definition.id,
      name: definition.name,
      executable,
      userDataDir: hasUserDataDir ? userDataDir : '',
      isDefault,
      order
    };
  }).filter((installation) => installation.executable || installation.userDataDir);

  // Keep the existing default-browser preference, then the historical
  // Chrome → Edge → Brave → Vivaldi fallback order.
  installations.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.order - b.order;
  });

  return installations;
}

function findBrowserExecutable(options = {}) {
  const installation = findBrowserInstallations(options).find((item) => item.executable);
  return installation ? installation.executable : '';
}

/**
 * Finds the active cookie database for a Chromium profile. Modern browsers
 * store it under Network\Cookies; older profiles used Cookies directly.
 */
function findCookieDatabase(profileDir, options = {}) {
  if (!profileDir) return null;
  const fileExists = options.fileExists || fs.existsSync;
  const statSync = options.statSync || fs.statSync;

  for (const relativeCookiePath of [path.join('Network', 'Cookies'), 'Cookies']) {
    const absoluteCookiePath = path.join(profileDir, relativeCookiePath);
    let isFile = false;
    try {
      isFile = fileExists(absoluteCookiePath) && statSync(absoluteCookiePath).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;

    const relativeFiles = [relativeCookiePath];
    for (const suffix of COOKIE_SIDECAR_SUFFIXES) {
      const relative = `${relativeCookiePath}${suffix}`;
      let sidecarExists = false;
      try {
        sidecarExists = fileExists(path.join(profileDir, relative));
      } catch {
        sidecarExists = false;
      }
      if (sidecarExists) relativeFiles.push(relative);
    }

    return {
      relativeCookiePath,
      absoluteCookiePath,
      relativeFiles,
      files: relativeFiles.map((relative) => path.join(profileDir, relative))
    };
  }

  return null;
}

function listChromiumProfileNames(userDataDir, options = {}) {
  const readdirSync = options.readdirSync || fs.readdirSync;
  let entries;
  try {
    entries = readdirSync(userDataDir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];

  const names = [];
  for (const entry of entries) {
    const name = String((entry && entry.name) || '');
    if (!PROFILE_NAME_PATTERN.test(name)) continue;
    if (entry && typeof entry.isDirectory === 'function' && !entry.isDirectory()) continue;
    names.push(name);
  }

  return names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function readLastUsedProfile(userDataDir, options = {}) {
  const readFileSync = options.readFileSync || fs.readFileSync;
  try {
    const raw = readFileSync(path.join(userDataDir, 'Local State'), 'utf8');
    const parsed = JSON.parse(raw);
    const lastUsed = parsed && parsed.profile && parsed.profile.last_used;
    return typeof lastUsed === 'string' ? lastUsed : '';
  } catch {
    return '';
  }
}

/**
 * Selects the profile Chromium itself most likely considers active: the
 * last-used profile when it still has cookies, otherwise the profile whose
 * cookie database was modified most recently.
 */
function selectBrowserProfile(userDataDir, options = {}) {
  if (!userDataDir) return null;
  const profiles = listChromiumProfileNames(userDataDir, options);
  if (!profiles.length) return null;

  const statSync = options.statSync || fs.statSync;
  const lastUsed = readLastUsedProfile(userDataDir, options);
  if (lastUsed && PROFILE_NAME_PATTERN.test(lastUsed) && profiles.includes(lastUsed)) {
    const directory = path.join(userDataDir, lastUsed);
    const database = findCookieDatabase(directory, options);
    if (database) {
      return { name: lastUsed, directory, database, usedLastUsed: true };
    }
  }

  let best = null;
  for (const name of profiles) {
    const directory = path.join(userDataDir, name);
    const database = findCookieDatabase(directory, options);
    if (!database) continue;

    let modifiedAt = 0;
    try {
      modifiedAt = Number(statSync(database.absoluteCookiePath).mtimeMs) || 0;
    } catch {
      continue;
    }

    if (!best || modifiedAt > best.modifiedAt) {
      best = { name, directory, database, usedLastUsed: false, modifiedAt };
    }
  }

  return best;
}

function isProfileBusyError(error) {
  return Boolean(error && PROFILE_BUSY_CODES.has(String(error.code || '')));
}

/**
 * Copies only the files Chromium needs to open the profile read-only: the
 * top-level Local State (cookie encryption key), the selected profile's
 * cookie database and sidecars, and Preferences. The real profile is never
 * written to or modified.
 */
async function copyProfileForImport({
  userDataDir,
  profileName,
  destinationRoot,
  fileExists = fs.existsSync,
  copyFile = fs.promises.copyFile,
  readFile = fs.promises.readFile,
  writeFile = fs.promises.writeFile,
  mkdir = fs.promises.mkdir
} = {}) {
  if (!userDataDir || !destinationRoot) {
    const error = new Error('A source browser profile and destination are required.');
    error.code = 'EINVAL';
    throw error;
  }

  const name = String(profileName || '');
  if (!PROFILE_NAME_PATTERN.test(name)) {
    const error = new Error('Invalid browser profile name.');
    error.code = 'EINVAL';
    throw error;
  }

  const sourceProfileDir = path.join(userDataDir, name);
  const database = findCookieDatabase(sourceProfileDir, { fileExists });
  if (!database) {
    const error = new Error('The browser profile does not contain a cookie database.');
    error.code = 'ENOCOOKIES';
    throw error;
  }

  const destinationProfileDir = path.join(destinationRoot, 'Default');
  await mkdir(destinationProfileDir, { recursive: true });

  const filesToCopy = [];
  const localState = path.join(userDataDir, 'Local State');
  let osCrypt = null;
  if (fileExists(localState)) {
    try {
      const parsed = JSON.parse(await readFile(localState, 'utf8'));
      osCrypt = parsed && parsed.os_crypt && typeof parsed.os_crypt === 'object'
        ? parsed.os_crypt
        : null;
    } catch {
      osCrypt = null;
    }
  }

  // Only the cookie encryption key is needed. Copying the full Local State
  // would also copy unrelated browser profile metadata into the temp folder.
  await writeFile(
    path.join(destinationRoot, 'Local State'),
    JSON.stringify(osCrypt ? { os_crypt: osCrypt } : {}),
    { mode: 0o600 }
  );

  for (const relative of database.relativeFiles) {
    filesToCopy.push({
      source: path.join(sourceProfileDir, relative),
      destination: path.join(destinationProfileDir, relative)
    });
  }

  for (const file of filesToCopy) {
    await mkdir(path.dirname(file.destination), { recursive: true });
    await copyFile(file.source, file.destination);
  }

  return {
    profileDirectory: destinationProfileDir,
    copied: [
      'Local State',
      ...filesToCopy.map((file) => path.relative(destinationRoot, file.destination))
    ]
  };
}

function findImportCandidates(options = {}) {
  const candidates = [];
  const installations = findBrowserInstallations(options);
  const statSync = options.statSync || fs.statSync;

  for (const installation of installations) {
    if (!installation.executable || !installation.userDataDir) continue;
    const lastUsed = readLastUsedProfile(installation.userDataDir, options);
    const profiles = listChromiumProfileNames(installation.userDataDir, options)
      .map((profileName) => {
        const profileDirectory = path.join(installation.userDataDir, profileName);
        const database = findCookieDatabase(profileDirectory, options);
        if (!database) return null;
        let modifiedAt = 0;
        try {
          modifiedAt = Number(statSync(database.absoluteCookiePath).mtimeMs) || 0;
        } catch {
          return null;
        }
        return {
          profileName,
          profileDirectory,
          database,
          modifiedAt,
          isLastUsed: profileName === lastUsed
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.isLastUsed !== b.isLastUsed) return a.isLastUsed ? -1 : 1;
        return b.modifiedAt - a.modifiedAt;
      });

    for (const profile of profiles) {
      candidates.push({
        ...installation,
        profileName: profile.profileName,
        profileDirectory: profile.profileDirectory,
        database: profile.database
      });
    }
  }

  return candidates;
}

function findImportSource(options = {}) {
  return findImportCandidates(options)[0] || null;
}

function getBrowserImportInfo(options = {}) {
  const source = findImportSource(options);
  if (!source) {
    return { available: false, browserName: '', profileName: '' };
  }

  return {
    available: true,
    browserId: source.id,
    browserName: source.name,
    profileName: source.profileName
  };
}

function cookieDomain(cookie) {
  if (!cookie || typeof cookie !== 'object') return '';
  return String(cookie.domain || '').replace(/^\./, '').toLowerCase();
}

function isRelevantCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') return false;
  const domain = cookieDomain(cookie);
  return domain === 'google.com'
    || domain.endsWith('.google.com')
    || domain === 'youtube.com'
    || domain.endsWith('.youtube.com');
}

function isGoogleDomain(cookie) {
  const domain = cookieDomain(cookie);
  return domain === 'google.com' || domain.endsWith('.google.com');
}

function isYouTubeDomain(cookie) {
  const domain = cookieDomain(cookie);
  return domain === 'youtube.com' || domain.endsWith('.youtube.com');
}

function hasGoogleSession(cookies) {
  const list = Array.isArray(cookies) ? cookies.filter((cookie) => cookie && typeof cookie === 'object') : [];
  const googleCookies = list.filter(isGoogleDomain);
  const youtubeCookies = list.filter(isYouTubeDomain);
  const googleNames = new Set(googleCookies.map((cookie) => cookie.name));
  const youtubeNames = new Set(youtubeCookies.map((cookie) => cookie.name));

  const googleSignedIn = (
    googleNames.has('SAPISID')
    || googleNames.has('__Secure-1PAPISID')
    || googleNames.has('__Secure-3PAPISID')
  ) && (
    googleNames.has('SID')
    || googleNames.has('__Secure-1PSID')
    || googleNames.has('__Secure-3PSID')
  );

  const youtubeSignedIn = youtubeNames.has('LOGIN_INFO')
    || youtubeNames.has('SID')
    || youtubeNames.has('__Secure-1PSID')
    || youtubeNames.has('__Secure-3PSID');

  return googleSignedIn && youtubeSignedIn;
}

function cookiePath(cookie) {
  const value = String(cookie.path || '/');
  return value.startsWith('/') ? value : `/${value}`;
}

function buildCookieUrl(cookie) {
  const domain = cookieDomain(cookie);
  return `https://${domain}${cookiePath(cookie)}`;
}

function normalizeSameSite(value) {
  switch (String(value || '').toLowerCase()) {
    case 'no_restriction':
    case 'none':
      return 'no_restriction';
    case 'lax':
      return 'lax';
    case 'strict':
      return 'strict';
    default:
      return 'unspecified';
  }
}

function buildCookieDetails(cookie) {
  const domain = String(cookie.domain || '');
  const details = {
    url: buildCookieUrl(cookie),
    name: String(cookie.name || ''),
    value: String(cookie.value == null ? '' : cookie.value),
    path: cookiePath(cookie),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: normalizeSameSite(cookie.sameSite)
  };

  if (domain.startsWith('.')) details.domain = domain;

  // Chrome's CDP uses -1 (and sometimes 0) for session cookies. Electron
  // treats a missing expirationDate as session-scoped; passing -1 through
  // would create an already-expired cookie.
  const expires = Number(cookie.expires);
  if (Number.isFinite(expires) && expires > 0) {
    details.expirationDate = expires;
  }

  return details;
}

async function importCookies(cookies, options = {}) {
  const ses = session.fromPartition(PARTITION);
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : null;
  let imported = 0;
  const list = Array.isArray(cookies) ? cookies : [];

  for (const cookie of list.filter(isRelevantCookie)) {
    if (isCancelled && isCancelled()) break;
    if (!cookie || !cookie.name) continue;
    const details = buildCookieDetails(cookie);

    try {
      await ses.cookies.set(details);
      imported += 1;
    } catch (error) {
      console.warn('[auth] Could not import a browser cookie:', error.message);
    }
  }

  try {
    await ses.cookies.flushStore();
  } catch {
    // The cookie store will still persist on the next flush.
  }

  return imported;
}

async function verifyImportedSession() {
  try {
    const ses = session.fromPartition(PARTITION);
    const cookies = await ses.cookies.get({});
    return hasGoogleSession(cookies);
  } catch {
    return false;
  }
}

async function clearImportedCookies() {
  try {
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData({ storages: ['cookies'] });
  } catch {
    // The next app launch will use whatever cookies remain.
  }
}

/**
 * Chrome's --remote-debugging-pipe transport. Commands are NUL-terminated
 * JSON written to fd 3; responses arrive as NUL-terminated JSON on fd 4.
 * There is deliberately no localhost HTTP/WebSocket debugging endpoint.
 */
function createCdpPipeTransport(readable, writable, options = {}) {
  if (
    !readable
    || !writable
    || typeof readable.on !== 'function'
    || typeof writable.write !== 'function'
  ) {
    throw new Error('Browser debugging pipe is unavailable.');
  }

  const commandTimeoutMs = Number(options.commandTimeoutMs) || CDP_COMMAND_TIMEOUT_MS;
  const maxBufferBytes = Number(options.maxBufferBytes) || CDP_MAX_BUFFER_BYTES;

  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let closed = false;
  let closeError = null;
  const pending = new Map();

  function cleanup() {
    readable.removeListener('data', onData);
    readable.removeListener('close', onReadableClose);
    writable.removeListener('close', onWritableClose);
    // Keep the error listeners attached: a killed browser can emit a late
    // EPIPE/ERR_STREAM_DESTROYED, and an unhandled stream error would crash
    // the main process. The handlers call close(), which is idempotent.
  }

  function close(reason = 'Browser connection is closed.') {
    if (closed) return;
    closed = true;
    closeError = reason instanceof Error ? reason : new Error(String(reason));
    try {
      cleanup();
    } catch {
      // Pending commands must still be rejected below.
    }
    buffer = Buffer.alloc(0);

    for (const request of pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(closeError);
    }
    pending.clear();
  }

  function onData(chunk) {
    if (closed) return;

    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = buffer.length ? Buffer.concat([buffer, data]) : data;
    if (buffer.length > maxBufferBytes) {
      close(new Error('Browser debugging response was too large.'));
      return;
    }

    let index;
    while ((index = buffer.indexOf(0)) !== -1) {
      const text = buffer.subarray(0, index).toString('utf8');
      buffer = buffer.subarray(index + 1);
      if (!text.trim()) continue;

      let message;
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }

      if (!message || message.id == null) continue;
      const request = pending.get(message.id);
      if (!request) continue;

      pending.delete(message.id);
      if (request.timer) clearTimeout(request.timer);
      if (message.error) {
        request.reject(new Error(message.error.message || 'Browser command failed.'));
      } else {
        request.resolve(message.result);
      }
    }
  }

  function onReadableError(error) {
    close(error instanceof Error ? error : new Error('Browser connection failed.'));
  }

  function onReadableClose() {
    close(new Error('Browser connection closed.'));
  }

  function onWritableError(error) {
    close(error instanceof Error ? error : new Error('Browser connection failed.'));
  }

  function onWritableClose() {
    close(new Error('Browser connection closed.'));
  }

  readable.on('data', onData);
  readable.on('error', onReadableError);
  readable.on('close', onReadableClose);
  writable.on('error', onWritableError);
  writable.on('close', onWritableClose);

  function send(method, params = {}, timeoutMs = commandTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(closeError || new Error('Browser connection is closed.'));
        return;
      }

      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error('Browser command timed out.'));
      }, Math.max(100, Number(timeoutMs) || commandTimeoutMs));

      pending.set(id, { resolve, reject, timer });

      let data;
      try {
        data = Buffer.from(`${JSON.stringify({ id, method, params })}\0`, 'utf8');
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
        return;
      }

      try {
        writable.write(data);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  return {
    send,
    close,
    isClosed: () => closed
  };
}

function terminateBrowser(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  // Kill the whole tree first on Windows; killing only the main process can
  // leave renderer/crashpad children holding files in the temporary profile.
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync(
        'taskkill',
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 4000, stdio: 'ignore' }
      );
      return;
    } catch {
      // Fall back to the process handle below.
    }
  }

  try {
    child.kill();
  } catch {
    // The browser may already be gone.
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, timeoutMs));
    if (timer.unref) timer.unref();
    child.once('exit', finish);
  });
}

async function removeProfileDir(profileDir) {
  if (!profileDir) return false;

  for (let attempt = 1; attempt <= PROFILE_DELETE_ATTEMPTS; attempt += 1) {
    try {
      await fs.promises.rm(profileDir, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (attempt === PROFILE_DELETE_ATTEMPTS) {
        console.warn('[auth] Could not remove the browser sign-in profile:', error.message);
        return false;
      }
      await delay(PROFILE_DELETE_RETRY_MS);
    }
  }

  return false;
}

async function cleanupStaleAuthProfiles() {
  const tempRoot = app.getPath('temp');
  try {
    const entries = await fs.promises.readdir(tempRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry || !entry.isDirectory() || !entry.name.startsWith(IMPORT_TEMP_PREFIX)) continue;
      await removeProfileDir(path.join(tempRoot, entry.name));
    }
  } catch {
    // A missing temp folder is fine; a locked one will be retried next launch.
  }

  await removeProfileDir(path.join(app.getPath('userData'), 'browser-signin'));
}

function emitStatus(auth, payload) {
  try {
    if (auth && typeof auth.onStatus === 'function') auth.onStatus(payload);
  } catch {
    // The renderer may be closing.
  }
}

async function stopBrowserAuth({ closeBrowser = false, status = null } = {}) {
  const current = active;
  active = null;
  if (!current) return;

  if (current.timeout) {
    clearTimeout(current.timeout);
    current.timeout = null;
  }
  if (current.pollTimer) {
    clearInterval(current.pollTimer);
    current.pollTimer = null;
  }

  if (current.transport) {
    try {
      current.transport.close(new Error('Browser sign-in stopped.'));
    } catch {
      // The transport may already be closed.
    }
  }

  // A sign-out can arrive while cookies are being written. Let that write
  // settle before the caller clears the session, otherwise late cookies could
  // recreate a signed-in state after "Signed out".
  if (current.pendingCookieImport) {
    try {
      await current.pendingCookieImport;
    } catch {
      // The import path reports its own failure.
    }
    current.pendingCookieImport = null;
  }

  if (closeBrowser) terminateBrowser(current.child);
  if (status) emitStatus(current, status);
  if (closeBrowser && current.child) {
    await waitForChildExit(current.child, BROWSER_EXIT_TIMEOUT_MS);
  }
  // Every terminal path leaves no reusable Google-session profile behind:
  // success, cancel, timeout, browser exit, and app quit all land here.
  if (current.profileDir) {
    await removeProfileDir(current.profileDir);
  }
}

async function finishSuccessfulImport(auth, imported) {
  const profileDir = auth.profileDir;

  // The browser must be fully gone before its dedicated profile is removed.
  await stopBrowserAuth({ closeBrowser: true });
  await removeProfileDir(profileDir);

  emitStatus(auth, { status: 'success', message: 'Signed in! Loading your YouTube Music library…' });

  if (typeof auth.onImported === 'function') {
    try {
      auth.onImported({ imported });
    } catch (error) {
      console.warn('[auth] Could not finish browser sign-in:', error.message);
    }
  }
}

async function startBrowserAuth({ onStatus, onImported } = {}) {
  const notify = typeof onStatus === 'function' ? onStatus : null;
  const status = (payload) => {
    if (!notify) return;
    try {
      notify(payload);
    } catch {
      // The renderer may be closing.
    }
  };

  if (active) {
    status({ status: 'info', message: 'Browser sign-in is already open.' });
    return { ok: false, error: 'already-open' };
  }

  const executable = findBrowserExecutable();
  if (!executable) {
    const message = 'Could not find Chrome, Edge, Brave, or Vivaldi for browser sign-in. Install one of them and try again.';
    status({ status: 'error', message });
    return { ok: false, error: message };
  }

  const profileDir = path.join(app.getPath('userData'), 'browser-signin');
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch (error) {
    const message = `Could not create the browser sign-in profile: ${error.message}`;
    status({ status: 'error', message });
    return { ok: false, error: message };
  }

  let child;
  try {
    child = spawn(executable, [
      `--user-data-dir=${profileDir}`,
      // Keep CDP entirely on private stdio pipes. No debugging port is
      // opened, so another local process cannot attach while Google cookies
      // are live in the browser profile.
      '--remote-debugging-pipe',
      // Google rejects Chrome when navigator.webdriver is true, which remote
      // debugging alone enables. These switches are required for the sign-in
      // page to behave like a normal browser; the private pipe stays in use.
      '--disable-blink-features=AutomationControlled',
      '--test-type',
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      AUTH_URL
    ], {
      detached: false,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: false
    });
  } catch (error) {
    const message = `Could not open the browser: ${error.message}`;
    status({ status: 'error', message });
    return { ok: false, error: message };
  }

  const auth = {
    child,
    transport: null,
    pollTimer: null,
    timeout: null,
    profileDir,
    onStatus: status,
    onImported: typeof onImported === 'function' ? onImported : null,
    checking: false,
    importing: false,
    imported: false,
    pendingCookieImport: null
  };
  active = auth;

  child.on('error', (error) => {
    if (active === auth && !auth.importing) {
      void stopBrowserAuth({
        closeBrowser: true,
        status: { status: 'error', message: `Browser sign-in failed: ${error.message}` }
      });
    }
  });

  child.on('exit', () => {
    if (active === auth && !auth.importing) {
      void stopBrowserAuth({
        status: { status: 'cancelled', message: 'Browser sign-in was cancelled.' }
      });
    }
  });

  try {
    auth.transport = createCdpPipeTransport(child.stdio[4], child.stdio[3]);
  } catch (error) {
    await stopBrowserAuth({ closeBrowser: true });
    const message = `Could not open the browser debugging channel: ${error.message}`;
    status({ status: 'error', message });
    return { ok: false, error: message };
  }

  if (active !== auth) {
    try {
      auth.transport.close(new Error('Browser sign-in stopped.'));
    } catch {
      // The transport may already be closed.
    }
    return { ok: false, error: 'cancelled' };
  }

  status({ status: 'started', message: 'Opening your browser for Google sign-in…' });

  try {
    await auth.transport.send('Browser.getVersion', {}, CDP_STARTUP_TIMEOUT_MS);
    if (active !== auth) return { ok: false, error: 'cancelled' };
    await auth.transport.send('Storage.getCookies');
  } catch (error) {
    if (active !== auth) return { ok: false, error: 'cancelled' };
    await stopBrowserAuth({ closeBrowser: true });
    const message = `Could not connect to the browser: ${error.message}`;
    status({ status: 'error', message });
    return { ok: false, error: message };
  }

  status({ status: 'info', message: 'Browser connected. Sign in to continue.' });

  const checkCookies = async () => {
    // checking keeps the polls single-flight; importing/imported ensure two
    // late responses from the same sign-in can never import twice.
    if (active !== auth || auth.checking || auth.importing || auth.imported) return;
    auth.checking = true;

    try {
      const result = await auth.transport.send('Storage.getCookies');
      if (active !== auth || auth.importing || auth.imported) return;

      const cookies = result && Array.isArray(result.cookies) ? result.cookies : [];
      if (!hasGoogleSession(cookies)) return;

      auth.importing = true;
      let imported = 0;
      try {
        auth.pendingCookieImport = importCookies(cookies, {
          isCancelled: () => active !== auth
        });
        imported = await auth.pendingCookieImport;
      } catch (error) {
        auth.importing = false;
        if (active !== auth) return;
        await stopBrowserAuth({ closeBrowser: true });
        status({ status: 'error', message: `Could not import the browser session: ${error.message}` });
        return;
      } finally {
        auth.pendingCookieImport = null;
      }

      if (active !== auth) return;

      if (!imported || !(await verifyImportedSession())) {
        auth.importing = false;
        await clearImportedCookies();
        await stopBrowserAuth({ closeBrowser: true });
        status({ status: 'error', message: 'The browser session could not be imported. Try signing in again.' });
        return;
      }

      auth.imported = true;
      await finishSuccessfulImport(auth, imported);
    } catch (error) {
      if (active !== auth || auth.imported) return;
      auth.importing = false;
      await stopBrowserAuth({ closeBrowser: true });
      status({ status: 'error', message: `Could not import the browser session: ${error.message}` });
    } finally {
      auth.checking = false;
    }
  };

  auth.pollTimer = setInterval(() => {
    void checkCookies();
  }, POLL_INTERVAL_MS);
  void checkCookies();

  auth.timeout = setTimeout(() => {
    if (active === auth) {
      void stopBrowserAuth({
        closeBrowser: true,
        status: { status: 'cancelled', message: 'Browser sign-in timed out. Try again.' }
      });
    }
  }, AUTH_TIMEOUT_MS);

  return { ok: true };
}

async function closeHeadlessBrowser(auth) {
  if (!auth) return;
  if (auth.transport && !auth.transport.isClosed()) {
    try {
      await auth.transport.send('Browser.close', {}, BROWSER_CLOSE_TIMEOUT_MS);
    } catch {
      // The browser may close the pipe before replying; force termination
      // is handled by stopBrowserAuth below.
    }
  }
  if (auth.child) {
    await waitForChildExit(auth.child, BROWSER_CLOSE_TIMEOUT_MS);
  }
}

/**
 * Imports the Google/YouTube session already present in one installed
 * Chromium-family browser profile. Only the cookie database is copied to a
 * temporary profile; the real profile is never modified. The imported cookies
 * still go through importCookies(), which keeps only Google/YouTube domains.
 */
async function importBrowserSessionFromSource(source, { onStatus, onImported } = {}) {
  const notify = typeof onStatus === 'function' ? onStatus : null;
  const status = (payload) => {
    if (!notify) return;
    try {
      notify(payload);
    } catch {
      // The renderer may be closing.
    }
  };

  if (active) {
    status({ status: 'info', message: 'Browser sign-in is already open.' });
    return { ok: false, error: 'already-open' };
  }

  if (!source) {
    const message = 'No Chrome, Edge, Brave, or Vivaldi profile with a Google/YouTube session was found. Sign in to YouTube Music in your browser first.';
    status({ status: 'error', message });
    return { ok: false, error: 'no-browser', message };
  }

  let profileRoot;
  try {
    profileRoot = await fs.promises.mkdtemp(path.join(app.getPath('temp'), IMPORT_TEMP_PREFIX));
  } catch {
    const message = 'Could not create a temporary browser profile for the import.';
    status({ status: 'error', message });
    return { ok: false, error: 'import-failed', message };
  }

  const auth = {
    kind: 'import',
    browserName: source.name,
    child: null,
    transport: null,
    timeout: null,
    pendingCookieImport: null,
    profileDir: profileRoot,
    onStatus: status,
    onImported: typeof onImported === 'function' ? onImported : null,
    imported: false
  };
  active = auth;

  auth.timeout = setTimeout(() => {
    if (active !== auth) return;
    status({ status: 'error', message: 'Reading the browser session timed out. Close the browser and try again.' });
    void stopBrowserAuth({ closeBrowser: true });
  }, IMPORT_TIMEOUT_MS);

  status({ status: 'started', message: `Reading the saved Google session from ${source.name}…` });

  try {
    await copyProfileForImport({
      userDataDir: source.userDataDir,
      profileName: source.profileName,
      destinationRoot: profileRoot
    });
  } catch (error) {
    if (active !== auth) {
      await removeProfileDir(profileRoot);
      return { ok: false, error: 'cancelled' };
    }

    await stopBrowserAuth({ closeBrowser: false });
    await removeProfileDir(profileRoot);

    if (isProfileBusyError(error)) {
      const message = `${source.name} is still using its profile. Close all ${source.name} windows, then try again.`;
      status({ status: 'error', message });
      return { ok: false, error: 'browser-busy', message };
    }

    console.warn('[auth] Could not copy the browser profile:', error.code || 'unknown error');
    const message = `Could not read the saved ${source.name} session. Close ${source.name} and try again.`;
    status({ status: 'error', message });
    return { ok: false, error: 'import-failed', message };
  }

  if (active !== auth) {
    await removeProfileDir(profileRoot);
    return { ok: false, error: 'cancelled' };
  }

  status({ status: 'info', message: `Reading the saved Google/YouTube cookies from ${source.name}…` });

  let child;
  try {
    child = spawn(source.executable, [
      `--user-data-dir=${profileRoot}`,
      '--profile-directory=Default',
      '--headless=new',
      '--disable-gpu',
      // Keep the copy off any localhost debugging port. The copied profile is
      // only used to read cookies and is deleted immediately afterwards.
      '--remote-debugging-pipe',
      '--disable-blink-features=AutomationControlled',
      '--test-type',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions',
      'about:blank'
    ], {
      detached: false,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch {
    await stopBrowserAuth({ closeBrowser: false });
    await removeProfileDir(profileRoot);
    const message = `Could not start ${source.name} for the session import.`;
    status({ status: 'error', message });
    return { ok: false, error: 'browser-error', message };
  }

  auth.child = child;
  child.on('error', (error) => {
    // A failed launch can emit 'error' before the pipe transport exists;
    // closing an existing transport makes pending commands fail immediately.
    auth.childError = error;
    if (auth.transport) {
      try {
        auth.transport.close(error);
      } catch {
        // The transport may already be closed.
      }
    }
  });

  try {
    auth.transport = createCdpPipeTransport(child.stdio[4], child.stdio[3]);
  } catch {
    await stopBrowserAuth({ closeBrowser: true });
    const message = `Could not connect to ${source.name} for the session import.`;
    status({ status: 'error', message });
    return { ok: false, error: 'browser-error', message };
  }

  if (active !== auth) return { ok: false, error: 'cancelled' };

  if (auth.childError) {
    await stopBrowserAuth({ closeBrowser: true });
    const message = `Could not start ${source.name} for the session import.`;
    status({ status: 'error', message });
    return { ok: false, error: 'browser-error', message };
  }

  let cookies;
  try {
    await auth.transport.send('Browser.getVersion', {}, CDP_STARTUP_TIMEOUT_MS);
    if (active !== auth) return { ok: false, error: 'cancelled' };
    const result = await auth.transport.send('Storage.getCookies', {}, CDP_COMMAND_TIMEOUT_MS);
    cookies = result && Array.isArray(result.cookies) ? result.cookies : [];
  } catch {
    if (active !== auth) return { ok: false, error: 'cancelled' };
    await closeHeadlessBrowser(auth);
    if (active !== auth) return { ok: false, error: 'cancelled' };
    await stopBrowserAuth({ closeBrowser: true });
    const message = `Could not read the saved session from ${source.name}. Close ${source.name} and try again.`;
    status({ status: 'error', message });
    return { ok: false, error: 'browser-error', message };
  }

  if (active !== auth) return { ok: false, error: 'cancelled' };

  if (!hasGoogleSession(cookies)) {
    await closeHeadlessBrowser(auth);
    if (active !== auth) return { ok: false, error: 'cancelled' };
    await stopBrowserAuth({ closeBrowser: true });
    const message = `No signed-in Google/YouTube session was found in ${source.name}. Sign in to YouTube Music in ${source.name} first, or use the separate browser sign-in.`;
    status({ status: 'error', message });
    return { ok: false, error: 'no-session', message };
  }

  let imported = 0;
  try {
    auth.pendingCookieImport = importCookies(cookies, {
      isCancelled: () => active !== auth
    });
    imported = await auth.pendingCookieImport;
  } catch {
    auth.pendingCookieImport = null;
    await closeHeadlessBrowser(auth);
    if (active !== auth) return { ok: false, error: 'cancelled' };
    await stopBrowserAuth({ closeBrowser: true });
    const message = 'Could not import the browser session into the app.';
    status({ status: 'error', message });
    return { ok: false, error: 'import-failed', message };
  } finally {
    auth.pendingCookieImport = null;
  }

  if (active !== auth) return { ok: false, error: 'cancelled' };

  if (!imported || !(await verifyImportedSession())) {
    await clearImportedCookies();
    await closeHeadlessBrowser(auth);
    if (active !== auth) return { ok: false, error: 'cancelled' };
    await stopBrowserAuth({ closeBrowser: true });
    const message = 'The browser session could not be imported. Try signing in again.';
    status({ status: 'error', message });
    return { ok: false, error: 'import-failed', message };
  }

  auth.imported = true;
  await closeHeadlessBrowser(auth);
  if (active !== auth) return { ok: false, error: 'cancelled' };
  await stopBrowserAuth({ closeBrowser: true });

  emitStatus(auth, { status: 'success', message: 'Signed in! Loading your YouTube Music library…' });

  if (typeof onImported === 'function') {
    try {
      onImported({ imported });
    } catch (error) {
      console.warn('[auth] Could not finish browser sign-in:', error.message);
    }
  }

  return { ok: true, imported };
}

async function importBrowserSession({ onStatus, onImported } = {}) {
  const notify = typeof onStatus === 'function' ? onStatus : null;
  const status = (payload) => {
    if (!notify) return;
    try {
      notify(payload);
    } catch {
      // The renderer may be closing.
    }
  };

  const candidates = findImportCandidates();
  if (!candidates.length) {
    const message = 'No Chrome, Edge, Brave, or Vivaldi profile with a Google/YouTube session was found. Sign in to YouTube Music in your browser first.';
    status({ status: 'error', message });
    return { ok: false, error: 'no-browser', message };
  }

  let firstBusy = null;
  let lastFailure = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const source = candidates[index];
    if (index > 0) {
      status({
        status: 'info',
        message: `Checking ${source.name} (${source.profileName})…`
      });
    }

    const result = await importBrowserSessionFromSource(source, { onStatus, onImported });
    if (result && result.ok) return result;
    if (result && (result.error === 'cancelled' || result.error === 'already-open')) {
      return result;
    }
    if (result && result.error === 'browser-busy' && !firstBusy) {
      firstBusy = result;
    }
    lastFailure = result || lastFailure;
  }

  if (firstBusy) return firstBusy;

  if (lastFailure) return lastFailure;

  const message = 'No signed-in Google/YouTube session was found in your browser profiles.';
  status({ status: 'error', message });
  return { ok: false, error: 'no-session', message };
}

async function clearBrowserSignInProfile() {
  await stopBrowserAuth({ closeBrowser: true });
  const profileDir = path.join(app.getPath('userData'), 'browser-signin');
  await removeProfileDir(profileDir);
}

module.exports = {
  startBrowserAuth,
  importBrowserSession,
  getBrowserImportInfo,
  stopBrowserAuth,
  clearBrowserSignInProfile,
  cleanupStaleAuthProfiles,
  findImportCandidates,
  selectBrowserProfile,
  findCookieDatabase,
  copyProfileForImport,
  isProfileBusyError,
  hasGoogleSession,
  importCookies,
  buildCookieDetails,
  createCdpPipeTransport
};

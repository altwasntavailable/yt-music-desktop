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

function findBrowserExecutable() {
  const candidates = [];
  const add = (base, ...parts) => {
    if (!base) return;
    const candidate = path.join(base, ...parts);
    if (fs.existsSync(candidate)) candidates.push(candidate);
  };

  add(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe');
  add(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe');
  add(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
  add(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  add(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  add(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  add(process.env.PROGRAMFILES, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
  add(process.env['PROGRAMFILES(X86)'], 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
  add(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
  add(process.env.PROGRAMFILES, 'Vivaldi', 'Application', 'vivaldi.exe');
  add(process.env.LOCALAPPDATA, 'Vivaldi', 'Application', 'vivaldi.exe');

  const progId = getDefaultBrowserProgId();
  if (progId) {
    const preferred = candidates.find((candidate) => {
      const name = path.basename(candidate).toLowerCase();
      if (progId.includes('chrome')) return name === 'chrome.exe';
      if (progId.includes('edge')) return name === 'msedge.exe';
      if (progId.includes('brave')) return name === 'brave.exe';
      if (progId.includes('vivaldi')) return name === 'vivaldi.exe';
      return false;
    });
    if (preferred) return preferred;
  }

  return candidates[0] || '';
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

async function importCookies(cookies) {
  const ses = session.fromPartition(PARTITION);
  let imported = 0;
  const list = Array.isArray(cookies) ? cookies : [];

  for (const cookie of list.filter(isRelevantCookie)) {
    if (!cookie || !cookie.name) continue;
    const details = buildCookieDetails(cookie);

    try {
      await ses.cookies.set(details);
      imported += 1;
    } catch (error) {
      console.warn('[auth] Could not import cookie:', cookie.name, error.message);
    }
  }

  try {
    await ses.cookies.flushStore();
  } catch {
    // The cookie store will still persist on the next flush.
  }

  return imported;
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
    const message = 'Could not find Chrome or Edge for browser sign-in. Install Chrome or use Edge.';
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
    imported: false
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
        imported = await importCookies(cookies);
      } catch (error) {
        auth.importing = false;
        if (active !== auth) return;
        await stopBrowserAuth({ closeBrowser: true });
        status({ status: 'error', message: `Could not import the browser session: ${error.message}` });
        return;
      }

      if (!imported) {
        auth.importing = false;
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

async function clearBrowserSignInProfile() {
  await stopBrowserAuth({ closeBrowser: true });
  const profileDir = path.join(app.getPath('userData'), 'browser-signin');
  await removeProfileDir(profileDir);
}

module.exports = {
  startBrowserAuth,
  stopBrowserAuth,
  clearBrowserSignInProfile,
  hasGoogleSession,
  importCookies,
  buildCookieDetails,
  createCdpPipeTransport
};

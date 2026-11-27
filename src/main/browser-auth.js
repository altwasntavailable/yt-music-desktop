'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { app, session } = require('electron');

const PARTITION = 'persist:ytmusic';
const AUTH_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;

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

async function getFreePort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && address.port;
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function cookieDomain(cookie) {
  return String(cookie.domain || '').replace(/^\./, '').toLowerCase();
}

function isRelevantCookie(cookie) {
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
  const googleCookies = cookies.filter(isGoogleDomain);
  const youtubeCookies = cookies.filter(isYouTubeDomain);
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

function buildCookieUrl(cookie) {
  const domain = cookieDomain(cookie);
  const cookiePath = String(cookie.path || '/');
  return `https://${domain}${cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`}`;
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

async function importCookies(cookies) {
  const ses = session.fromPartition(PARTITION);
  let imported = 0;

  for (const cookie of cookies.filter(isRelevantCookie)) {
    const domain = String(cookie.domain || '');
    const details = {
      url: buildCookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || '/',
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: normalizeSameSite(cookie.sameSite)
    };
    if (domain.startsWith('.')) details.domain = domain;
    if (Number.isFinite(Number(cookie.expires)) && Number(cookie.expires) > 0) {
      details.expirationDate = Number(cookie.expires);
    }

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

function stopBrowserAuth({ closeBrowser = false, status = null } = {}) {
  const current = active;
  active = null;
  if (!current) return;

  clearTimeout(current.timeout);
  clearInterval(current.pollTimer);

  try {
    current.ws.close();
  } catch {
    // The socket may already be closed.
  }

  if (closeBrowser) {
    try {
      current.child.kill();
    } catch {
      // The browser may already have exited.
    }
    if (current.child && current.child.pid) {
      try {
        execFileSync(
          'taskkill',
          ['/PID', String(current.child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 4000, stdio: 'ignore' }
        );
      } catch {
        // The browser may already have exited.
      }
    }
  }

  if (status && current.onStatus) current.onStatus(status);
}

async function startBrowserAuth({ onStatus, onImported }) {
  if (active) {
    onStatus({ status: 'info', message: 'Browser sign-in is already open.' });
    return { ok: false, error: 'already-open' };
  }

  const executable = findBrowserExecutable();
  if (!executable) {
    const message = 'Could not find Chrome or Edge for browser sign-in. Install Chrome or use Edge.';
    onStatus({ status: 'error', message });
    return { ok: false, error: message };
  }

  const profileDir = path.join(app.getPath('userData'), 'browser-signin');
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch (error) {
    const message = `Could not create the browser sign-in profile: ${error.message}`;
    onStatus({ status: 'error', message });
    return { ok: false, error: message };
  }

  const port = await getFreePort();
  if (!port) {
    const message = 'Could not find a local port for browser sign-in.';
    onStatus({ status: 'error', message });
    return { ok: false, error: message };
  }

  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    AUTH_URL
  ];

  let child;
  try {
    child = spawn(executable, args, {
      detached: false,
      stdio: 'ignore',
      windowsHide: false
    });
  } catch (error) {
    const message = `Could not open the browser: ${error.message}`;
    onStatus({ status: 'error', message });
    return { ok: false, error: message };
  }

  if (process.argv.includes('--dev')) {
    console.log('[auth] browser:', executable);
    console.log('[auth] cdp port:', port);
  }

  const auth = {
    child,
    port,
    ws: null,
    pollTimer: null,
    timeout: null,
    profileDir,
    onStatus
  };
  active = auth;

  child.on('error', (error) => {
    if (active === auth) {
      stopBrowserAuth({
        closeBrowser: true,
        status: { status: 'error', message: `Browser sign-in failed: ${error.message}` }
      });
    }
  });

  child.on('exit', () => {
    if (active === auth) {
      stopBrowserAuth({
        status: { status: 'cancelled', message: 'Browser sign-in was cancelled.' }
      });
    }
  });

  onStatus({ status: 'started', message: 'Opening your browser for Google sign-in…' });

  let version = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && active === auth) {
    try {
      version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      if (version && version.webSocketDebuggerUrl) break;
    } catch {
      // The browser is still starting.
    }
    await delay(300);
  }

  if (active !== auth) {
    return { ok: false, error: 'cancelled' };
  }

  if (!version || !version.webSocketDebuggerUrl) {
    stopBrowserAuth({ closeBrowser: true });
    const message = 'The browser did not start in time. Try again.';
    onStatus({ status: 'error', message });
    return { ok: false, error: message };
  }

  let ws;
  try {
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to the browser.')), 10000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Could not connect to the browser.'));
      }, { once: true });
    });
  } catch (error) {
    stopBrowserAuth({ closeBrowser: true });
    const message = `Could not connect to the browser: ${error.message}`;
    onStatus({ status: 'error', message });
    return { ok: false, error: message };
  }

  auth.ws = ws;

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || 'Browser command failed.'));
    else request.resolve(message.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Browser connection is closed.'));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  ws.addEventListener('close', () => {
    if (active === auth) {
      stopBrowserAuth({
        status: { status: 'cancelled', message: 'Browser sign-in was cancelled.' }
      });
    }
  });

  try {
    await send('Storage.getCookies');
  } catch (error) {
    stopBrowserAuth({ closeBrowser: true });
    const message = `Could not read browser cookies: ${error.message}`;
    onStatus({ status: 'error', message });
    return { ok: false, error: message };
  }

  onStatus({ status: 'info', message: 'Browser connected. Sign in to continue.' });

  const checkCookies = async () => {
    if (active !== auth) return;
    try {
      const result = await send('Storage.getCookies');
      const cookies = result && Array.isArray(result.cookies) ? result.cookies : [];
      if (!hasGoogleSession(cookies)) return;

      const imported = await importCookies(cookies);
      if (!imported) return;

      stopBrowserAuth({ closeBrowser: true });
      onStatus({ status: 'success', message: 'Signed in! Loading your YouTube Music library…' });
      onImported({ imported });
    } catch (error) {
      if (active === auth) {
        stopBrowserAuth({ closeBrowser: true });
        onStatus({ status: 'error', message: `Could not import the browser session: ${error.message}` });
      }
    }
  };

  auth.pollTimer = setInterval(checkCookies, POLL_INTERVAL_MS);
  checkCookies();

  auth.timeout = setTimeout(() => {
    if (active === auth) {
      stopBrowserAuth({
        closeBrowser: true,
        status: { status: 'cancelled', message: 'Browser sign-in timed out. Try again.' }
      });
    }
  }, AUTH_TIMEOUT_MS);

  return { ok: true };
}

async function clearBrowserSignInProfile() {
  stopBrowserAuth({ closeBrowser: true });
  const profileDir = path.join(app.getPath('userData'), 'browser-signin');
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (error) {
    console.warn('[auth] Could not clear the browser sign-in profile:', error.message);
  }
}

module.exports = {
  startBrowserAuth,
  stopBrowserAuth,
  clearBrowserSignInProfile,
  hasGoogleSession,
  importCookies
};

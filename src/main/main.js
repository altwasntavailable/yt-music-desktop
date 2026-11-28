'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  shell,
  ipcMain
} = require('electron');

const config = require('./config');
const lyrics = require('./lyrics');
const downloads = require('./downloads');
const sponsorblock = require('./sponsorblock');
const updater = require('./updater');
const { DiscordPresence } = require('./discord');
const { TrayController } = require('./tray');
const { createDesktopIntegration } = require('./desktop-integration');
const {
  startBrowserAuth,
  importBrowserSession,
  getBrowserImportInfo,
  stopBrowserAuth,
  clearBrowserSignInProfile,
  cleanupStaleAuthProfiles
} = require('./browser-auth');

const APP_ID = 'com.ytmusicdesktop.app';
const PARTITION = 'persist:ytmusic';
const APP_ENTRY_PATH = path.join(__dirname, '../renderer/index.html');
const APP_ENTRY_URL = pathToFileURL(APP_ENTRY_PATH).href;
const IS_DEV = process.argv.includes('--dev');
const SCREENSHOT_PATH = getArgValue('--screenshot=');
const DUMP_DOM_PATH = getArgValue('--dump-dom=');
const OPEN_DRAWER = getArgValue('--open-drawer=');
const AUTOPLAY_TEST = process.argv.includes('--autoplay-test');
const CLICK_SIGNIN_TEST = process.argv.includes('--click-signin-test');
const BROWSER_AUTH_TEST = process.argv.includes('--browser-auth-test');
const START_HIDDEN = process.argv.includes('--hidden');
const DUMP_DELAY = Math.max(1500, Number(getArgValue('--dump-delay=')) || 4000);
const SCREENSHOT_DELAY = Math.max(3000, Number(getArgValue('--screenshot-delay=')) || 6500);
const WATCHDOG_DISABLED = IS_DEV
  || Boolean(SCREENSHOT_PATH || DUMP_DOM_PATH || AUTOPLAY_TEST || CLICK_SIGNIN_TEST || BROWSER_AUTH_TEST)
  || process.env.YTMD_DISABLE_WATCHDOG === '1';

const CHROME_VERSION = process.versions.chrome || '142.0.0.0';
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

// Chromium aggressively throttles (and sometimes fully wedges) renderers for
// windows that are hidden or covered by other windows. This app intentionally
// keeps playing audio while it sits in the tray, so opt out of that behaviour.
function appendDisabledFeature(feature) {
  const existing = app.commandLine.getSwitchValue('disable-features');
  const features = new Set(
    String(existing || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
  if (features.has(feature)) return;
  features.add(feature);
  app.commandLine.appendSwitch('disable-features', Array.from(features).join(','));
}

if (process.platform === 'win32') {
  // Windows native occlusion tracking occasionally stalls Chromium's task
  // runner for covered windows. It is not useful for an embedded app anyway.
  appendDisabledFeature('CalculateNativeWinOcclusion');
}
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-media-suspend');

// Network-level ad/tracker blocking. The player-level skip in the renderer
// handles first-party YouTube ads that are served from the content domains.
const AD_URL_PATTERNS = [
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googleadservices.com/*',
  '*://*.googletagservices.com/*',
  '*://*.adservice.google.com/*',
  '*://*.ads.youtube.com/*',
  '*://*.youtube.com/api/stats/ads*',
  '*://*.youtube.com/get_midroll_info*',
  '*://*.youtube.com/pagead/*',
  '*://*.google.com/pagead/*',
  '*://*.google.com/ads/*',
  '*://*.google-analytics.com/*',
  '*://*.googletagmanager.com/*',
  '*://*.scorecardresearch.com/*',
  '*://*.moatads.com/*',
  '*://*.adsafeprotected.com/*',
  '*://*.doubleverify.com/*'
];

const RECOVERY_WINDOW_MS = 60 * 1000;
const RECOVERY_LIMIT = 3;
const WATCHDOG_INTERVAL_MS = 10 * 1000;
const HEARTBEAT_STALE_MS = 45 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const RECOVERY_GRACE_MS = 5000;
const WAKE_QUIET_PERIOD_MS = 15 * 1000;

let mainWindow = null;
let guestContents = null;
let tray = null;
let discord = null;
let isQuitting = false;
let powerBlockerId = null;
let downloadPowerBlockerId = null;
let downloadBlockerTimer = null;
let lastPlayerState = null;
let boundsTimer = null;
let debugScheduled = false;
let debugCaptured = false;
let browserAuthStarting = false;
let authQuitCleanupStarted = false;
let authQuitCleanupDone = false;
let lastHeartbeatAt = 0;
let healthCheckTimer = null;
let healthCheckInterval = null;
let healthCheckRunning = false;
let windowReloadPending = false;
let guestReloadPending = false;
let windowReloadedAt = 0;
let guestReloadedAt = 0;
let windowLoadStartedAt = 0;
let guestLoadStartedAt = 0;
let windowUnresponsiveTimer = null;
let awayStartedAt = 0;
let recoveryDialogOpen = false;
let recoveryDialogSnoozeUntil = 0;
const recoveryHistory = new Map();
let watchdogProcess = null;
let watchdogHeartbeatPath = '';
let watchdogHeartbeatTimer = null;
let watchdogHeartbeatWriting = false;
let blockedRequestCount = 0;
let desktopIntegration = null;

app.setName('YT Music Desktop');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ytmd-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

function getArgValue(prefix) {
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

function appExecutablePath() {
  return String(process.env.PORTABLE_EXECUTABLE_FILE || '').trim() || process.execPath;
}

function relaunchArgs() {
  return process.env.PORTABLE_EXECUTABLE_FILE ? [] : process.argv.slice(1);
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (!contents || contents.isDestroyed() || contents.isCrashed()) return;
  try {
    contents.send(channel, payload);
  } catch (error) {
    // The renderer may be navigating or shutting down.
  }
}

function sendCommand(type) {
  sendToRenderer('app:command', { type });
}

/* ---------- Renderer health / recovery ---------- */

function deliverableWindow() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed());
}

function getRecoveryAttempts(key) {
  const now = Date.now();
  const attempts = (recoveryHistory.get(key) || []).filter((time) => now - time < RECOVERY_WINDOW_MS);
  recoveryHistory.set(key, attempts);
  return attempts;
}

function canRecover(key) {
  return getRecoveryAttempts(key).length < RECOVERY_LIMIT;
}

function noteRecovery(key) {
  const attempts = getRecoveryAttempts(key);
  attempts.push(Date.now());
  recoveryHistory.set(key, attempts);
}

function withTimeout(promise, timeoutMs, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

async function probeContents(contents, timeoutMs = PROBE_TIMEOUT_MS) {
  if (!contents || contents.isDestroyed() || contents.isCrashed()) return false;
  try {
    const result = await withTimeout(
      contents.executeJavaScript('true', false),
      timeoutMs,
      false
    );
    return result === true;
  } catch (error) {
    return false;
  }
}

async function probeContentsWithRetry(contents, timeoutMs = PROBE_TIMEOUT_MS) {
  if (await probeContents(contents, timeoutMs)) return true;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return probeContents(contents, timeoutMs);
}

function showRecoveryDialog() {
  if (recoveryDialogOpen || isQuitting) return;
  if (Date.now() < recoveryDialogSnoozeUntil) return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;

  recoveryDialogOpen = true;
  dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'YT Music Desktop',
    message: 'The app stopped responding.',
    detail: 'It could not be recovered automatically. Restart the app to continue.',
    buttons: ['Restart app', 'Keep waiting'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }).then(({ response }) => {
    recoveryDialogOpen = false;
    recoveryDialogSnoozeUntil = Date.now() + 60 * 1000;
    if (response === 0) {
      app.relaunch({ execPath: appExecutablePath(), args: relaunchArgs() });
      quitApp();
    }
  }).catch(() => {
    recoveryDialogOpen = false;
    recoveryDialogSnoozeUntil = Date.now() + 60 * 1000;
  });
}

function beginWindowRecovery(reason) {
  if (isQuitting || !deliverableWindow()) return false;
  if (windowReloadPending) return true;
  if (!canRecover('window')) {
    console.error('[window] Not recovering (%s): recovery limit reached.', reason);
    showRecoveryDialog();
    return false;
  }

  noteRecovery('window');
  windowReloadPending = true;
  lastHeartbeatAt = Date.now();
  console.warn('[window] Recovering renderer: %s', reason);
  return true;
}

function finishWindowRecovery() {
  if (!windowReloadPending) return;
  windowReloadPending = false;
  if (isQuitting || !deliverableWindow()) return;

  windowReloadedAt = Date.now();
  const reloadStartedAt = windowReloadedAt;
  try {
    mainWindow.webContents.reload();
  } catch (error) {
    console.error('[window] Could not reload renderer:', error.message);
  }

  // A crashed renderer occasionally ignores the first reload. Make sure the
  // new page actually starts, instead of waiting for the next heartbeat sweep.
  setTimeout(() => {
    if (isQuitting || !deliverableWindow()) return;
    if (lastHeartbeatAt >= reloadStartedAt) return;
    console.warn('[window] Renderer did not start after reload; restarting again.');
    restartMainRenderer('reload did not recover');
  }, 12000);
}

function reloadMainWindow(reason) {
  if (!beginWindowRecovery(reason)) return;
  setTimeout(finishWindowRecovery, 350);
}

function restartMainRenderer(reason) {
  if (!beginWindowRecovery(reason)) return;

  if (mainWindow.webContents.isCrashed()) {
    setTimeout(finishWindowRecovery, 200);
    return;
  }

  try {
    mainWindow.webContents.forcefullyCrashRenderer();
    // Normally render-process-gone reloads the window. This is a fallback for
    // the rare case where the event never arrives.
    setTimeout(() => {
      if (windowReloadPending) finishWindowRecovery();
    }, 1500);
  } catch (error) {
    console.error('[window] Could not restart renderer:', error.message);
    setTimeout(finishWindowRecovery, 350);
  }
}

function beginGuestRecovery(reason) {
  if (isQuitting || !guestContents || guestContents.isDestroyed()) return false;
  if (guestReloadPending) return true;
  if (!canRecover('guest')) {
    console.error('[guest] Not recovering (%s): recovery limit reached.', reason);
    sendToRenderer('guest:crashed', { reason, recovering: false, fatal: true });
    showRecoveryDialog();
    return false;
  }

  noteRecovery('guest');
  guestReloadPending = true;
  console.warn('[guest] Recovering player renderer: %s', reason);
  return true;
}

function finishGuestRecovery(contents) {
  if (!guestReloadPending) return;
  guestReloadPending = false;
  if (isQuitting || guestContents !== contents || !contents || contents.isDestroyed()) return;

  guestReloadedAt = Date.now();
  try {
    contents.reload();
  } catch (error) {
    console.error('[guest] Could not reload player renderer:', error.message);
    sendToRenderer('guest:crashed', { reason: 'reload-failed', recovering: false, fatal: true });
  }
}

function reloadGuest(reason) {
  const contents = guestContents;
  if (!contents || contents.isDestroyed()) {
    sendCommand('reload-player');
    return;
  }
  if (!beginGuestRecovery(reason)) return;
  setTimeout(() => finishGuestRecovery(contents), 500);
}

function restartGuestRenderer(reason) {
  const contents = guestContents;
  if (!beginGuestRecovery(reason)) return;

  if (contents.isCrashed()) {
    setTimeout(() => finishGuestRecovery(contents), 200);
    return;
  }

  try {
    contents.forcefullyCrashRenderer();
    setTimeout(() => {
      if (guestReloadPending) finishGuestRecovery(contents);
    }, 1500);
  } catch (error) {
    console.error('[guest] Could not restart player renderer:', error.message);
    setTimeout(() => finishGuestRecovery(contents), 350);
  }
}

async function verifyRendererHealth(source, options = {}) {
  if (isQuitting || !deliverableWindow()) return;
  if (IS_DEV && mainWindow.webContents.isDevToolsOpened()) return;
  if (healthCheckRunning) return;

  healthCheckRunning = true;
  try {
    const force = Boolean(options.force);
    const timeout = Number(options.timeout) || PROBE_TIMEOUT_MS;
    const win = mainWindow;
    const heartbeatAge = Date.now() - lastHeartbeatAt;
    const windowLoading = win.webContents.isLoading();
    const windowLoadStuck = windowLoading
      && windowLoadStartedAt
      && Date.now() - windowLoadStartedAt > 30000;

    if ((force || heartbeatAge >= HEARTBEAT_STALE_MS) && (!windowLoading || windowLoadStuck)) {
      const alive = await probeContentsWithRetry(win.webContents, timeout);
      if (alive) {
        lastHeartbeatAt = Date.now();
      } else if (!isQuitting && mainWindow === win && !win.isDestroyed()) {
        console.warn('[health] Window renderer did not answer (%s).', source);
        if (win.webContents.isCrashed()) reloadMainWindow(`health check: crashed (${source})`);
        else restartMainRenderer(`health check: unresponsive (${source})`);
        return;
      }
    }

    const guest = guestContents;
    if (!isQuitting && guest && !guest.isDestroyed()) {
      const guestLoading = guest.isLoading();
      const guestLoadStuck = guestLoading
        && guestLoadStartedAt
        && Date.now() - guestLoadStartedAt > 30000;

      if (guest.isCrashed()) {
        reloadGuest(`health check: crashed (${source})`);
      } else if (!guestLoading || guestLoadStuck) {
        const alive = await probeContentsWithRetry(guest, timeout);
        if (!alive && !isQuitting && guestContents === guest && !guest.isDestroyed()) {
          console.warn('[health] Player renderer did not answer (%s).', source);
          restartGuestRenderer(`health check: unresponsive (${source})`);
        }
      }
    }
  } catch (error) {
    console.error('[health] Check failed:', error.message);
  } finally {
    healthCheckRunning = false;
  }
}

function scheduleHealthCheck(source, delayMs = 800, options = {}) {
  if (isQuitting) return;
  clearTimeout(healthCheckTimer);
  healthCheckTimer = setTimeout(() => {
    healthCheckTimer = null;
    verifyRendererHealth(source, options);
  }, Math.max(0, delayMs));
}

function startHealthWatchdog() {
  if (healthCheckInterval) return;
  lastHeartbeatAt = Date.now();
  healthCheckInterval = setInterval(() => {
    if (isQuitting || !deliverableWindow()) return;
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) return;
    const loading = mainWindow.webContents.isLoading();
    const loadingTooLong = loading
      && windowLoadStartedAt
      && Date.now() - windowLoadStartedAt > 30000;
    if (loading && !loadingTooLong) return;
    if (Date.now() - lastHeartbeatAt < HEARTBEAT_STALE_MS) return;
    if (healthCheckRunning) return;
    scheduleHealthCheck('heartbeat', 0);
  }, WATCHDOG_INTERVAL_MS);
  if (healthCheckInterval.unref) healthCheckInterval.unref();
}

function stopHealthWatchdog() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  if (healthCheckTimer) {
    clearTimeout(healthCheckTimer);
    healthCheckTimer = null;
  }
  if (windowUnresponsiveTimer) {
    clearTimeout(windowUnresponsiveTimer);
    windowUnresponsiveTimer = null;
  }
}

/* ---------- Process watchdog (detects main-process hangs) ---------- */

function writeProcessHeartbeat(stopping = false, sync = false) {
  if (!watchdogHeartbeatPath) return;

  const payload = JSON.stringify({
    pid: process.pid,
    time: Date.now(),
    stopping: Boolean(stopping)
  });

  if (sync) {
    try {
      fs.writeFileSync(watchdogHeartbeatPath, payload, 'utf8');
    } catch (error) {
      console.error('[watchdog] Could not write heartbeat:', error.message);
    }
    return;
  }

  if (watchdogHeartbeatWriting) return;
  watchdogHeartbeatWriting = true;
  fs.writeFile(watchdogHeartbeatPath, payload, 'utf8', (error) => {
    watchdogHeartbeatWriting = false;
    if (error) console.error('[watchdog] Could not write heartbeat:', error.message);
  });
}

function startProcessWatchdog() {
  if (WATCHDOG_DISABLED || watchdogProcess) return;

  try {
    watchdogHeartbeatPath = path.join(app.getPath('userData'), 'watchdog-heartbeat.json');
    const scriptPath = path.join(__dirname, 'watchdog.js');
    const appArgs = process.argv.slice(1);
    const encodedArgs = Buffer.from(JSON.stringify(appArgs), 'utf8').toString('base64');
    const watchdogCwd = process.env.PORTABLE_EXECUTABLE_FILE
      ? path.dirname(appExecutablePath())
      : process.cwd();

    // Write the first beat synchronously so the watchdog does not count app
    // startup time as a hang.
    writeProcessHeartbeat(false, true);

    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(process.execPath, [
      scriptPath,
      String(process.pid),
      appExecutablePath(),
      watchdogHeartbeatPath,
      encodedArgs,
      watchdogCwd
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env
    });

    child.on('error', (error) => {
      console.error('[watchdog] Could not start:', error.message);
    });
    child.unref();
    watchdogProcess = child;

    watchdogHeartbeatTimer = setInterval(() => writeProcessHeartbeat(false, false), 5000);
    if (watchdogHeartbeatTimer.unref) watchdogHeartbeatTimer.unref();
    console.log('[watchdog] Process watchdog started.');
  } catch (error) {
    console.error('[watchdog] Could not start:', error.message);
  }
}

function stopProcessWatchdog() {
  if (watchdogHeartbeatTimer) {
    clearInterval(watchdogHeartbeatTimer);
    watchdogHeartbeatTimer = null;
  }
  writeProcessHeartbeat(true, true);
  watchdogProcess = null;
}

function markAway() {
  if (!awayStartedAt) awayStartedAt = Date.now();
}

function nudgeWindow() {
  if (isQuitting || !deliverableWindow()) return;
  try {
    mainWindow.webContents.invalidate();
  } catch (error) {
    // The window may be closing.
  }
  if (guestContents && !guestContents.isDestroyed()) {
    try {
      guestContents.invalidate();
    } catch (error) {
      // The guest may be navigating or closing.
    }
  }
  sendToRenderer('window:resume', { reason: 'wake' });
}

function checkWake(source) {
  if (isQuitting || !deliverableWindow() || !awayStartedAt) return;
  const awayMs = Date.now() - awayStartedAt;
  awayStartedAt = 0;
  if (awayMs >= WAKE_QUIET_PERIOD_MS) {
    scheduleHealthCheck(source, 800, { force: true });
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (tray) tray.setVisible(true);
  nudgeWindow();
  // A tray click is the user's manual "come back" path. Always probe both
  // renderers so a window that froze while hidden heals immediately.
  scheduleHealthCheck('show-window', 700, { force: true });
}

function hideWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  markAway();
  mainWindow.hide();
  if (tray) tray.setVisible(false);
}

function showWindowAndSend(type) {
  showWindow();
  setTimeout(() => sendCommand(type), 120);
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function isTrustedUrl(url) {
  if (url === 'about:blank') return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'music.youtube.com'
      || host === 'youtube.com'
      || host.endsWith('.youtube.com')
      || host === 'google.com'
      || host.endsWith('.google.com')
      || host.endsWith('.googleusercontent.com')
    );
  } catch {
    return false;
  }
}

function isSignInUrl(url) {
  if (url === 'about:blank') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'accounts.google.com'
      || host.startsWith('accounts.google.')
      || host === 'accounts.youtube.com'
      || host === 'consent.youtube.com'
    );
  } catch {
    return false;
  }
}

function authStatusCallbacks() {
  return {
    onStatus: (payload) => {
      if (IS_DEV) console.log('[auth]', payload.status, payload.message || '');
      sendToRenderer('auth:status', payload);
    },
    onImported: () => {
      if (guestContents && !guestContents.isDestroyed()) {
        guestContents.loadURL('https://music.youtube.com/');
      }
      showWindow();
    }
  };
}

function showAuthDialog(options) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return dialog.showMessageBox(mainWindow, options);
  }
  return dialog.showMessageBox(options);
}

async function runBrowserImport(importInfo) {
  for (;;) {
    const result = await importBrowserSession(authStatusCallbacks());

    if (result && result.error === 'browser-busy') {
      const choice = await showAuthDialog({
        type: 'warning',
        title: 'Sign in to YouTube Music',
        message: `${importInfo.browserName} is still running`,
        detail: result.message,
        buttons: ['Retry now', 'Sign in in a browser', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });

      if (choice.response === 1) return startBrowserAuth(authStatusCallbacks());
      if (choice.response !== 0) {
        sendToRenderer('auth:status', { status: 'cancelled', message: 'Browser sign-in cancelled.' });
        return { ok: false, error: 'cancelled' };
      }
      continue;
    }

    if (result && result.error === 'no-session') {
      const choice = await showAuthDialog({
        type: 'info',
        title: 'Sign in to YouTube Music',
        message: 'No saved YouTube Music session found',
        detail: result.message,
        buttons: ['Retry import', 'Sign in in a browser', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });

      if (choice.response === 0) continue;
      if (choice.response === 1) return startBrowserAuth(authStatusCallbacks());
      sendToRenderer('auth:status', { status: 'cancelled', message: 'Browser sign-in cancelled.' });
      return { ok: false, error: 'cancelled' };
    }

    return result;
  }
}

async function beginBrowserSignIn() {
  if (browserAuthStarting) return { ok: false, error: 'already-starting' };
  browserAuthStarting = true;
  try {
    showWindow();

    const importInfo = getBrowserImportInfo();
    if (!importInfo.available) {
      return await startBrowserAuth(authStatusCallbacks());
    }

    const choice = await showAuthDialog({
      type: 'question',
      title: 'Sign in to YouTube Music',
      message: 'Sign in to YouTube Music',
      detail: `${importInfo.browserName} may already have a Google account signed in. YT Music Desktop can read its local cookie database and import ONLY the Google/YouTube cookies into the app. Close all ${importInfo.browserName} windows while the session is read. A temporary copy is deleted afterwards; nothing is uploaded.`,
      buttons: ['Use browser session', 'Sign in in a browser', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });

    if (choice.response === 2) {
      sendToRenderer('auth:status', { status: 'cancelled', message: 'Browser sign-in cancelled.' });
      return { ok: false, error: 'cancelled' };
    }
    if (choice.response === 1) {
      return await startBrowserAuth(authStatusCallbacks());
    }

    return await runBrowserImport(importInfo);
  } catch (error) {
    const message = error && error.message ? error.message : 'Browser sign-in failed.';
    sendToRenderer('auth:status', { status: 'error', message });
    return { ok: false, error: message };
  } finally {
    browserAuthStarting = false;
  }
}

function openExternal(url) {
  if (/^https?:\/\//i.test(String(url || ''))) {
    shell.openExternal(url).catch(() => {});
  }
}

function getWindowBounds(saved) {
  const width = Math.max(960, Math.min(5000, Math.round(Number(saved.width) || 1280)));
  const height = Math.max(620, Math.min(3500, Math.round(Number(saved.height) || 820)));
  const x = saved.x === null || saved.x === undefined ? Number.NaN : Number(saved.x);
  const y = saved.y === null || saved.y === undefined ? Number.NaN : Number(saved.y);

  if (Number.isFinite(x) && Number.isFinite(y)) {
    const displays = screen.getAllDisplays();
    const visible = displays.some((display) => {
      const area = display.workArea;
      return (
        x < area.x + area.width - 120
        && x + width > area.x + 120
        && y < area.y + area.height - 80
        && y + height > area.y + 60
      );
    });
    if (visible) return { x, y, width, height };
  }

  return { width, height };
}

function scheduleBoundsSave() {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const normal = mainWindow.getNormalBounds();
    config.update({
      window: {
        ...config.get().window,
        x: normal.x,
        y: normal.y,
        width: normal.width,
        height: normal.height,
        maximized: mainWindow.isMaximized()
      }
    });
  }, 500);
}

function setupAdBlock(ses) {
  if (!ses || !ses.webRequest) return;

  ses.webRequest.onBeforeRequest({ urls: AD_URL_PATTERNS }, (details, callback) => {
    if (config.get().blockAds) {
      blockedRequestCount += 1;
      if (IS_DEV) console.log('[adblock] blocked', details.url);
      callback({ cancel: true });
      return;
    }
    callback({});
  });
}

function setupSession() {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(USER_AGENT, 'en-US,en');
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => {
    event.preventDefault();
  });
  setupAdBlock(ses);
}

function setupMediaProtocol() {
  protocol.handle('ytmd-media', (request) => {
    try {
      const url = new URL(request.url);
      const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const resolved = downloads.resolveMedia(id);
      if (!resolved) {
        return new Response('Not found', { status: 404 });
      }
      const file = resolved.file;
      const stat = fs.statSync(file);
      const mime = {
        m4a: 'audio/mp4',
        mp4: 'video/mp4',
        aac: 'audio/aac',
        mp3: 'audio/mpeg',
        webm: 'audio/webm',
        opus: 'audio/ogg',
        ogg: 'audio/ogg',
        wav: 'audio/wav',
        flac: 'audio/flac'
      }[path.extname(file).replace('.', '').toLowerCase()] || 'application/octet-stream';

      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'content-type': mime,
            'content-length': String(stat.size),
            'accept-ranges': 'bytes',
            'cache-control': 'no-store'
          }
        });
      }

      const range = request.headers.get('range');
      if (range) {
        const match = /bytes=(\d*)-(\d*)/i.exec(range);
        if (match) {
          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
            return new Response('Range not satisfiable', {
              status: 416,
              headers: { 'content-range': `bytes */${stat.size}` }
            });
          }
          const stream = fs.createReadStream(file, { start, end });
          return new Response(Readable.toWeb(stream), {
            status: 206,
            headers: {
              'content-type': mime,
              'content-length': String(end - start + 1),
              'content-range': `bytes ${start}-${end}/${stat.size}`,
              'accept-ranges': 'bytes',
              'cache-control': 'no-store'
            }
          });
        }
      }

      return new Response(Readable.toWeb(fs.createReadStream(file)), {
        status: 200,
        headers: {
          'content-type': mime,
          'content-length': String(stat.size),
          'accept-ranges': 'bytes',
          'cache-control': 'no-store'
        }
      });
    } catch (error) {
      if (IS_DEV) console.warn('[media] Could not serve offline file:', error.message);
      return new Response('Not found', { status: 404 });
    }
  });
}

function handleShortcut(event, input, contents) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return;
  const ctrl = input.control || input.meta;
  const key = String(input.key || '').toLowerCase();

  if (input.key === 'Escape') {
    // Let the page keep its own Escape behavior (closing menus), but also tell
    // the chrome to close any drawer/dialog it owns.
    sendCommand('close-overlay');
    return;
  }
  if (ctrl && key === 'l') {
    event.preventDefault();
    sendCommand('toggle-lyrics');
    return;
  }
  if (ctrl && key === 'e') {
    event.preventDefault();
    sendCommand('toggle-equalizer');
    return;
  }
  if (ctrl && input.shift && key === 'd') {
    event.preventDefault();
    sendCommand('download-current');
    return;
  }
  if (ctrl && input.shift && key === 'o') {
    event.preventDefault();
    sendCommand('toggle-downloads');
    return;
  }
  if (ctrl && key === ',') {
    event.preventDefault();
    sendCommand('toggle-settings');
    return;
  }
  if (ctrl && key === 'w') {
    event.preventDefault();
    if (mainWindow) mainWindow.close();
    return;
  }
  if (ctrl && key === 'r') {
    event.preventDefault();
    if (input.shift) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        lastHeartbeatAt = Date.now();
        mainWindow.webContents.reload();
      }
    } else if (guestContents && !guestContents.isDestroyed()) {
      guestContents.reload();
    } else {
      sendCommand('reload-player');
    }
    return;
  }
  if (input.alt && input.key === 'Left' && contents && contents.canGoBack()) {
    event.preventDefault();
    contents.goBack();
    return;
  }
  if (input.key === 'F11') {
    event.preventDefault();
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  }
}

function showGuestContextMenu(contents, params) {
  const template = [];

  if (contents.canGoBack()) {
    template.push({ label: 'Back', click: () => contents.goBack() });
  }
  template.push({ label: 'Reload', click: () => contents.reload() });
  template.push({ type: 'separator' });
  template.push({ role: 'cut', enabled: Boolean(params.editFlags && params.editFlags.canCut) });
  template.push({ role: 'copy', enabled: Boolean(params.editFlags && params.editFlags.canCopy) });
  template.push({ role: 'paste', enabled: Boolean(params.editFlags && params.editFlags.canPaste) });
  template.push({ role: 'selectAll', enabled: Boolean(params.editFlags && params.editFlags.canSelectAll) });

  if (params.linkURL && !isTrustedUrl(params.linkURL)) {
    template.push({ type: 'separator' });
    template.push({ label: 'Open link in browser', click: () => openExternal(params.linkURL) });
  }

  if (IS_DEV) {
    template.push({ type: 'separator' });
    template.push({
      label: 'Inspect element',
      click: () => contents.inspectElement(params.x, params.y)
    });
  }

  Menu.buildFromTemplate(template).popup({ window: mainWindow });
}

function configureAuthWindow(child) {
  child.setMenuBarVisibility(false);
  child.webContents.setUserAgent(USER_AGENT);

  const closeChild = () => {
    try {
      if (!child.isDestroyed()) child.close();
    } catch {
      // The popup may already be gone.
    }
  };

  child.webContents.setWindowOpenHandler(({ url }) => {
    if (isSignInUrl(url)) {
      beginBrowserSignIn();
      closeChild();
      return { action: 'deny' };
    }
    openExternal(url);
    return { action: 'deny' };
  });

  child.webContents.on('will-navigate', (event, url) => {
    if (isSignInUrl(url)) {
      event.preventDefault();
      beginBrowserSignIn();
      closeChild();
      return;
    }
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });

  child.webContents.on('will-redirect', (event, url) => {
    if (isSignInUrl(url)) {
      event.preventDefault();
      beginBrowserSignIn();
      closeChild();
      return;
    }
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });

  setTimeout(() => {
    if (!child.isDestroyed() && child.webContents.getURL() === 'about:blank') {
      closeChild();
    }
  }, 8000);
}

function configureGuest(contents) {
  guestContents = contents;
  let unresponsiveTimer = null;
  contents.session.setUserAgent(USER_AGENT, 'en-US,en');
  contents.setAudioMuted(false);
  try {
    contents.setBackgroundThrottling(false);
  } catch (error) {
    // The guest may not be ready yet; the webview preference already covers it.
  }

  contents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 540,
          height: 760,
          parent: mainWindow,
          autoHideMenuBar: true,
          backgroundColor: '#030303',
          webPreferences: {
            partition: PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      };
    }
    if (isSignInUrl(url)) {
      beginBrowserSignIn();
      return { action: 'deny' };
    }
    openExternal(url);
    return { action: 'deny' };
  });

  contents.on('did-create-window', (child) => configureAuthWindow(child));

  contents.on('will-navigate', (event, url) => {
    if (isSignInUrl(url)) {
      event.preventDefault();
      beginBrowserSignIn();
      return;
    }
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (isSignInUrl(url)) {
      event.preventDefault();
      beginBrowserSignIn();
      return;
    }
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });

  contents.on('console-message', (...args) => {
    const details = args[1];
    const message = details && typeof details === 'object'
      ? details.message
      : args[2];
    if (typeof message === 'string' && message.startsWith('[YTMD]')) {
      console.log('[guest]', message);
    }
  });

  contents.on('before-input-event', (event, input) => handleShortcut(event, input, contents));
  contents.on('context-menu', (event, params) => showGuestContextMenu(contents, params));
  contents.on('unresponsive', () => {
    console.warn('[guest] Player renderer is unresponsive.');
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      if (isQuitting || contents.isDestroyed()) return;
      restartGuestRenderer('unresponsive');
    }, RECOVERY_GRACE_MS);
  });
  contents.on('responsive', () => {
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
    console.log('[guest] Player renderer is responsive again.');
  });
  contents.on('render-process-gone', (event, details) => {
    console.error('[guest] Player renderer gone:', details.reason, details.exitCode);
    guestLoadStartedAt = 0;
    const recovering = guestReloadPending
      || (details.reason !== 'clean-exit' && canRecover('guest'));
    sendToRenderer('guest:crashed', { ...details, recovering });
    if (isQuitting || details.reason === 'clean-exit') return;
    if (Date.now() - guestReloadedAt < 1500) return;

    if (guestReloadPending) {
      setTimeout(() => finishGuestRecovery(contents), 250);
    } else {
      reloadGuest(`renderer ${details.reason}`);
    }
  });
  contents.on('did-finish-load', () => {
    guestLoadStartedAt = 0;
    if (SCREENSHOT_PATH || DUMP_DOM_PATH) scheduleDebugCapture();
  });
  contents.on('did-start-loading', () => {
    guestLoadStartedAt = Date.now();
  });
  contents.on('did-stop-loading', () => {
    guestLoadStartedAt = 0;
  });
  contents.on('destroyed', () => {
    clearTimeout(unresponsiveTimer);
    guestLoadStartedAt = 0;
    if (guestContents === contents) guestContents = null;
  });
}

function createWindow() {
  const saved = config.get().window;
  const bounds = getWindowBounds(saved);

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#030303',
    title: 'YT Music Desktop',
    icon: path.join(__dirname, '../../assets/icon.png'),
    autoHideMenuBar: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/chrome-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setBackgroundThrottling(false);

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.backgroundThrottling = false;
    if (params.src && !/^https:\/\/music\.youtube\.com(?:\/|$)/i.test(params.src)) {
      event.preventDefault();
    }
    if (params.partition && params.partition !== PARTITION) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('did-attach-webview', (event, contents) => {
    configureGuest(contents);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === APP_ENTRY_URL || url.startsWith(`${APP_ENTRY_URL}#`) || url.startsWith(`${APP_ENTRY_URL}?`)) {
      return;
    }
    event.preventDefault();
    if (!url.startsWith('file://')) openExternal(url);
  });
  mainWindow.webContents.on('before-input-event', (event, input) => handleShortcut(event, input, null));
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[window] Chrome renderer process gone:', details.reason, details.exitCode);
    windowLoadStartedAt = 0;
    if (isQuitting || details.reason === 'clean-exit') return;
    if (Date.now() - windowReloadedAt < 1500) return;

    if (windowReloadPending) {
      setTimeout(finishWindowRecovery, 250);
    } else {
      reloadMainWindow(`renderer ${details.reason}`);
    }
  });
  mainWindow.webContents.on('unresponsive', () => {
    if (!deliverableWindow()) return;
    if (IS_DEV && mainWindow.webContents.isDevToolsOpened()) return;
    console.warn('[window] Chrome renderer is unresponsive.');
    clearTimeout(windowUnresponsiveTimer);
    windowUnresponsiveTimer = setTimeout(() => {
      windowUnresponsiveTimer = null;
      if (isQuitting || !deliverableWindow()) return;
      console.warn('[window] Chrome renderer stayed unresponsive; restarting it.');
      restartMainRenderer('unresponsive');
    }, RECOVERY_GRACE_MS);
  });
  mainWindow.webContents.on('responsive', () => {
    clearTimeout(windowUnresponsiveTimer);
    windowUnresponsiveTimer = null;
    lastHeartbeatAt = Date.now();
    console.log('[window] Chrome renderer is responsive again.');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    lastHeartbeatAt = Date.now();
    nudgeWindow();
  });
  mainWindow.webContents.on('did-start-loading', () => {
    windowLoadStartedAt = Date.now();
  });
  mainWindow.webContents.on('did-stop-loading', () => {
    windowLoadStartedAt = 0;
  });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isQuitting || errorCode === -3 || isMainFrame === false) return;
    if (!/^file:/i.test(String(validatedURL || ''))) return;
    reloadMainWindow(`window load failed: ${errorDescription}`);
  });
  mainWindow.on('page-title-updated', (event) => event.preventDefault());

  mainWindow.once('ready-to-show', () => {
    if (saved.maximized) mainWindow.maximize();
    if (START_HIDDEN) {
      if (tray) tray.setVisible(false);
      return;
    }
    mainWindow.show();
    if (tray) tray.setVisible(true);
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && config.get().closeToTray) {
      event.preventDefault();
      hideWindow();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    guestContents = null;
    stopHealthWatchdog();
  });

  mainWindow.on('show', () => {
    if (tray) tray.setVisible(true);
    sendToRenderer('window:state', { maximized: mainWindow.isMaximized() });
    nudgeWindow();
    checkWake('window-show');
  });
  mainWindow.on('hide', () => {
    markAway();
    if (tray) tray.setVisible(false);
  });
  mainWindow.on('focus', () => {
    nudgeWindow();
    checkWake('window-focus');
  });
  mainWindow.on('blur', () => {
    markAway();
  });
  mainWindow.on('minimize', () => {
    markAway();
  });
  mainWindow.on('restore', () => {
    nudgeWindow();
    checkWake('window-restore');
  });
  mainWindow.on('maximize', () => {
    scheduleBoundsSave();
    sendToRenderer('window:state', { maximized: true });
  });
  mainWindow.on('unmaximize', () => {
    scheduleBoundsSave();
    sendToRenderer('window:state', { maximized: false });
  });
  mainWindow.on('resize', scheduleBoundsSave);
  mainWindow.on('move', scheduleBoundsSave);

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  startHealthWatchdog();

  if (SCREENSHOT_PATH) {
    // Fallback for pages that never finish loading (for example, a network error).
    setTimeout(() => {
      if (!debugCaptured) captureScreenshot();
    }, 22000);
  }
}

function handlePlayerState(raw) {
  if (!raw || typeof raw !== 'object') return;

  const state = {
    title: String(raw.title || '').slice(0, 300),
    artist: String(raw.artist || '').slice(0, 300),
    album: String(raw.album || '').slice(0, 300),
    artwork: String(raw.artwork || '').slice(0, 1000),
    currentTime: Number(raw.currentTime) || 0,
    duration: Number(raw.duration) || 0,
    paused: Boolean(raw.paused),
    videoId: String(raw.videoId || '').slice(0, 50),
    url: String(raw.url || '').slice(0, 1000),
    isAd: Boolean(raw.isAd),
    seeked: Boolean(raw.seeked),
    source: raw.source === 'local' ? 'local' : 'remote'
  };

  lastPlayerState = state;
  if (tray) tray.update(state);
  if (discord) discord.setState(state);
  if (desktopIntegration) {
    desktopIntegration.update(state);
    desktopIntegration.notifyTrackChange(state, Boolean(config.get().notifications));
  }
  updatePowerBlocker(state);
}

async function refreshDownloadPowerBlocker() {
  if (!downloads || typeof downloads.getStatus !== 'function') return;
  let status;
  try {
    status = await downloads.getStatus();
  } catch (error) {
    return;
  }
  const active = Boolean(
    status
    && ((Array.isArray(status.active) && status.active.length) || status.batch)
  );
  if (active && downloadPowerBlockerId === null) {
    try {
      downloadPowerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    } catch (error) {}
  } else if (!active && downloadPowerBlockerId !== null) {
    try {
      powerSaveBlocker.stop(downloadPowerBlockerId);
    } catch (error) {}
    downloadPowerBlockerId = null;
  }
}

function scheduleDownloadPowerBlocker() {
  if (downloadBlockerTimer) clearTimeout(downloadBlockerTimer);
  downloadBlockerTimer = setTimeout(() => {
    downloadBlockerTimer = null;
    refreshDownloadPowerBlocker().catch(() => {});
  }, 500);
}

function handleDownloadDesktopEvent(payload) {
  if (!payload || !payload.type) return;
  if (['start', 'batch-start', 'complete', 'batch-complete', 'error', 'batch-error', 'cancelled'].includes(payload.type)) {
    scheduleDownloadPowerBlocker();
  }
  if (!desktopIntegration) return;
  const completeIcon = path.join(__dirname, '../../assets/overlays/complete.png');
  const errorIcon = path.join(__dirname, '../../assets/overlays/error.png');

  switch (payload.type) {
    case 'start':
      if (!payload.batchId) desktopIntegration.setDownloadProgress(0, 'normal');
      break;
    case 'progress':
      if (!payload.batchId) {
        desktopIntegration.setDownloadProgress(Number(payload.percent) || 0, 'normal');
      }
      break;
    case 'batch-start':
      desktopIntegration.setDownloadProgress(0, 'normal');
      break;
    case 'batch-progress': {
      const total = Number(payload.total) || 0;
      const completed = Number(payload.completed) || 0;
      desktopIntegration.setDownloadProgress(total ? (completed / total) * 100 : 0, 'normal');
      break;
    }
    case 'complete':
      if (!payload.batchId) {
        desktopIntegration.setDownloadProgress(100, 'normal');
        desktopIntegration.setOverlayIcon(completeIcon, 'Download complete');
        setTimeout(() => desktopIntegration && desktopIntegration.setOverlayIcon(null, ''), 6000);
        setTimeout(() => desktopIntegration && desktopIntegration.setDownloadProgress(0, 'none'), 2500);
        if (payload.item) {
          desktopIntegration.notifyDownload({
            type: 'complete',
            title: 'Download complete',
            body: [payload.item.artist, payload.item.title].filter(Boolean).join(' — '),
            enabled: Boolean(config.get().notifications)
          });
        }
      }
      desktopIntegration.refresh();
      break;
    case 'batch-complete':
      desktopIntegration.setDownloadProgress(0, 'none');
      desktopIntegration.setOverlayIcon(completeIcon, 'Playlist download complete');
      setTimeout(() => desktopIntegration && desktopIntegration.setOverlayIcon(null, ''), 8000);
      desktopIntegration.notifyDownload({
        type: 'batch-complete',
        title: 'Playlist download complete',
        body: `${payload.saved || 0} of ${payload.total || 0} tracks saved${payload.failed ? `, ${payload.failed} failed` : ''}.`,
        enabled: Boolean(config.get().notifications)
      });
      desktopIntegration.refresh();
      break;
    case 'error':
      if (payload.batchId) break;
      desktopIntegration.setDownloadProgress(100, 'error');
      desktopIntegration.setOverlayIcon(errorIcon, 'Download failed');
      setTimeout(() => desktopIntegration && desktopIntegration.setOverlayIcon(null, ''), 8000);
      setTimeout(() => desktopIntegration && desktopIntegration.setDownloadProgress(0, 'none'), 5000);
      desktopIntegration.notifyDownload({
        type: 'error',
        title: 'Download failed',
        body: payload.message || 'The download could not be completed.',
        enabled: Boolean(config.get().notifications)
      });
      break;
    case 'batch-error':
      desktopIntegration.setDownloadProgress(0, 'none');
      desktopIntegration.setOverlayIcon(errorIcon, 'Playlist download stopped');
      setTimeout(() => desktopIntegration && desktopIntegration.setOverlayIcon(null, ''), 8000);
      desktopIntegration.notifyDownload({
        type: 'error',
        title: 'Playlist download stopped',
        body: payload.message || 'The playlist download could not be completed.',
        enabled: Boolean(config.get().notifications)
      });
      break;
    case 'cancelled':
      if (!payload.batchId) desktopIntegration.setDownloadProgress(0, 'none');
      break;
    case 'removed':
      desktopIntegration.refresh();
      break;
    default:
      break;
  }
}

function applyLaunchAtLogin(enabled) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: appExecutablePath(),
      args: ['--hidden']
    });
  } catch (error) {
    console.error('[startup] Could not update login item:', error.message);
  }
}

function updatePowerBlocker(state) {
  const shouldBlock = Boolean(
    config.get().preventSleep
    && state
    && state.title
    && !state.paused
    && !state.isAd
  );

  if (shouldBlock && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!shouldBlock && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

function isMainSender(event) {
  return Boolean(
    event
    && mainWindow
    && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
  );
}

function handle(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isMainSender(event)) {
      console.warn('[ipc] Rejected unauthorized call to', channel);
      return null;
    }
    return listener(event, ...args);
  });
}

function registerIpc() {
  ipcMain.on('renderer:heartbeat', (event) => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) {
      lastHeartbeatAt = Date.now();
    }
  });

  ipcMain.on('renderer:player-stalled', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    if (isQuitting || !guestContents || guestContents.isDestroyed()) return;
    scheduleHealthCheck('player-stalled', 400, { force: true });
  });

  handle('settings:get', () => config.get());

  handle('settings:update', (event, patch) => {
    const next = config.update(patch || {});
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'discord') && discord) {
      discord.configure(next.discord);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'preventSleep')) {
      updatePowerBlocker(lastPlayerState);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'launchAtLogin')) {
      applyLaunchAtLogin(next.launchAtLogin);
    }
    if (patch && patch.downloads && Object.prototype.hasOwnProperty.call(patch.downloads, 'dir')
      && downloads.setDir) {
      Promise.resolve(downloads.setDir(next.downloads.dir)).catch((error) => {
        console.error('[downloads] Could not apply the download folder:', error.message);
      });
    }
    sendToRenderer('settings:changed', next);
    return next;
  });

  handle('lyrics:fetch', (event, meta, options) => lyrics.fetchLyrics(meta, options || {}));

  handle('sponsorblock:segments', (event, videoId, categories) => (
    sponsorblock.fetchSegments(videoId, categories)
  ));

  handle('downloads:status', () => downloads.getStatus());
  handle('downloads:install-tool', () => downloads.installTool());
  handle('downloads:update-tool', () => downloads.updateTool());
  handle('downloads:start', (event, meta, options) => downloads.start(meta, options || {}));
  handle('downloads:retry', (event, meta, options) => downloads.retry(meta, options || {}));
  handle('downloads:start-many', (event, payload) => downloads.startMany(payload || {}));
  handle('downloads:list', () => downloads.list());
  handle('downloads:cancel', (event, id) => downloads.cancel(id));
  handle('downloads:remove', (event, id) => {
    const removed = downloads.remove(id);
    if (removed && desktopIntegration) desktopIntegration.refresh();
    return removed;
  });
  handle('downloads:open-folder', () => downloads.openFolder());
  handle('downloads:open-log', () => downloads.openLog());
  handle('downloads:reveal', (event, id) => downloads.reveal(id));
  handle('downloads:choose-folder', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, canceled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose download folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: downloads.getDir ? downloads.getDir() : undefined
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    try {
      const requested = path.resolve(result.filePaths[0]);
      const dir = await downloads.setDir(requested);
      const normalized = path.resolve(dir);
      const same = process.platform === 'win32'
        ? normalized.toLowerCase() === requested.toLowerCase()
        : normalized === requested;
      if (!same) {
        return { ok: false, dir, message: 'That folder could not be used. Choose a writable folder and try again.' };
      }
      const current = config.get().downloads || {};
      config.update({ downloads: { ...current, dir } });
      return { ok: true, dir, status: await downloads.getStatus() };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  handle('updater:status', () => updater.getStatus());
  handle('updater:check', () => updater.check(true));
  handle('updater:install', () => updater.quitAndInstall());

  handle('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });
  handle('window:toggle-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  handle('window:close', () => {
    if (mainWindow) mainWindow.close();
  });
  handle('window:is-maximized', () => Boolean(mainWindow && mainWindow.isMaximized()));

  handle('shell:open-external', (event, url) => {
    if (!/^https?:\/\//i.test(String(url || ''))) return false;
    shell.openExternal(url).catch(() => {});
    return true;
  });

  handle('auth:browser-sign-in', () => beginBrowserSignIn());
  handle('auth:browser-cancel', () => {
    Promise.resolve(stopBrowserAuth({ closeBrowser: true })).catch((error) => {
      console.error('[auth] Could not stop browser sign-in:', error.message);
    });
    sendToRenderer('auth:status', { status: 'cancelled', message: 'Browser sign-in cancelled.' });
    return true;
  });

  handle('session:clear', async () => {
    await clearBrowserSignInProfile();
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData();
    await ses.clearCache();
    return true;
  });

  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    userAgent: USER_AGENT,
    isDev: IS_DEV
  }));

  handle('app:copy-diagnostics', async () => {
    const settings = JSON.parse(JSON.stringify(config.get()));
    if (settings.discord) delete settings.discord.clientId;
    const status = await downloads.getStatus().catch((error) => ({ error: error.message }));
    const info = {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      settings,
      downloads: status,
      adBlockBlockedRequests: blockedRequestCount,
      player: lastPlayerState
        ? {
            title: lastPlayerState.title,
            artist: lastPlayerState.artist,
            paused: lastPlayerState.paused,
            isAd: lastPlayerState.isAd
          }
        : null
    };
    let logs = '';
    for (const name of ['downloads.log', 'watchdog.log']) {
      const candidates = [
        status && status.dir ? path.join(status.dir, name) : '',
        path.join(app.getPath('userData'), 'downloads', name),
        path.join(app.getPath('userData'), name)
      ].filter(Boolean);
      const file = candidates.find((candidate) => {
        try { return fs.statSync(candidate).isFile(); } catch { return false; }
      });
      if (!file) continue;
      try {
        const raw = fs.readFileSync(file, 'utf8');
        logs += `\n--- ${name} (last 60 lines) ---\n${raw.split(/\r?\n/).slice(-60).join('\n')}\n`;
      } catch (error) {}
    }
    const text = `${JSON.stringify(info, null, 2)}${logs}`;
    clipboard.writeText(text);
    return text;
  });

  handle('app:open-user-data', () => shell.openPath(app.getPath('userData')));

  handle('sleep-timer:get', () => (
    desktopIntegration ? desktopIntegration.getSleepTimer() : { active: false, endsAt: null, minutes: 0 }
  ));
  handle('sleep-timer:start', (event, minutes) => {
    if (!desktopIntegration) return { active: false, endsAt: null, minutes: 0 };
    const status = desktopIntegration.startSleepTimer(minutes, () => {
      if (guestContents && !guestContents.isDestroyed()) {
        guestContents.executeJavaScript(`(() => {
          const video = document.querySelector('#movie_player video') || document.querySelector('video');
          if (video && !video.paused) video.pause();
          return true;
        })()`, false).catch(() => {});
      }
      sendCommand('sleep-timer-expired');
      sendToRenderer('sleep-timer:status', { active: false, endsAt: null, minutes: 0 });
      if (desktopIntegration) {
        desktopIntegration.notifyDownload({
          type: 'info',
          title: 'Sleep timer finished',
          body: 'Playback was paused.',
          enabled: Boolean(config.get().notifications)
        });
      }
    });
    sendToRenderer('sleep-timer:status', status);
    return status;
  });
  handle('sleep-timer:cancel', () => {
    if (desktopIntegration) desktopIntegration.cancelSleepTimer();
    const status = desktopIntegration
      ? desktopIntegration.getSleepTimer()
      : { active: false, endsAt: null, minutes: 0 };
    sendToRenderer('sleep-timer:status', status);
    return status;
  });

  handle('app:confirm-signout', async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
    try {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Sign out of YouTube Music',
        message: 'Sign out of YouTube Music?',
        detail: 'This clears the app’s YouTube/Google session and reloads the page.',
        buttons: ['Cancel', 'Sign out'],
        defaultId: 1,
        cancelId: 0,
        noLink: true
      });
      return response === 1;
    } catch (error) {
      return false;
    }
  });

  handle('discord:status', () => {
    if (discord) return discord.getStatus();
    return { enabled: false, configured: false, connected: false, error: 'Discord is not initialized.' };
  });
  handle('discord:reconnect', () => {
    if (discord) discord.forceReconnect();
    return discord ? discord.getStatus() : null;
  });

  ipcMain.on('player:state', (event, state) => {
    if (!isMainSender(event)) return;
    handlePlayerState(state);
  });
}

function scheduleDebugCapture() {
  if (debugScheduled) return;
  debugScheduled = true;

  if (OPEN_DRAWER) {
    const command = OPEN_DRAWER === 'eq' ? 'toggle-equalizer' : `toggle-${OPEN_DRAWER}`;
    setTimeout(() => sendCommand(command), 1800);
  }
  if (AUTOPLAY_TEST) {
    setTimeout(() => sendCommand('autoplay-test'), 1900);
  }
  if (CLICK_SIGNIN_TEST) {
    setTimeout(() => sendCommand('click-signin-test'), 2500);
  }

  if (DUMP_DOM_PATH) {
    setTimeout(async () => {
      try {
        const target = guestContents;
        if (!target) throw new Error('No guest webContents');
        const data = await target.executeJavaScript(`(() => {
          const pick = (selector) => {
            const el = document.querySelector(selector);
            return el ? el.outerHTML.slice(0, 30000) : null;
          };
          const md = navigator.mediaSession && navigator.mediaSession.metadata;
          const songVideo = document.querySelector('#song-video');
          const songImage = document.querySelector('#song-image');
          return {
            url: location.href,
            title: document.title,
            bodyClass: document.body.className,
            audioOnlyClass: document.documentElement.classList.contains('ytm-audio-only'),
            songVideoDisplay: songVideo ? getComputedStyle(songVideo).display : null,
            songImageDisplay: songImage ? getComputedStyle(songImage).display : null,
            mediaSession: md ? { title: md.title, artist: md.artist, album: md.album, artwork: md.artwork } : null,
            playerBar: pick('ytmusic-player-bar'),
            songVideo: pick('#song-video'),
            songImage: pick('#song-image'),
            moviePlayer: pick('#movie_player'),
            playerElement: pick('ytmusic-player'),
            playerPage: pick('ytmusic-player-page'),
            mainContent: pick('#content'),
            app: pick('ytmusic-app')
          };
        })()`, true);
        fs.writeFileSync(path.resolve(DUMP_DOM_PATH), JSON.stringify(data, null, 2), 'utf8');
      } catch (error) {
        console.error('[debug] DOM dump failed:', error.message);
      }
      quitApp();
    }, DUMP_DELAY);
  } else if (SCREENSHOT_PATH) {
    setTimeout(() => captureScreenshot(), SCREENSHOT_DELAY);
  }
}

async function captureScreenshot() {
  if (debugCaptured) return;
  debugCaptured = true;
  try {
    if (!mainWindow) throw new Error('No main window');
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const image = await mainWindow.webContents.capturePage();
    fs.writeFileSync(path.resolve(SCREENSHOT_PATH), image.toPNG());
    console.log('[debug] Screenshot saved to', path.resolve(SCREENSHOT_PATH));
  } catch (error) {
    console.error('[debug] Screenshot failed:', error.message);
  }
  setTimeout(() => quitApp(), 300);
}

function createTray() {
  tray = new TrayController({
    iconPath: path.join(__dirname, '../../assets/tray.png'),
    onShowWindow: showWindow,
    onHideWindow: hideWindow,
    onReloadWindow: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      console.warn('[window] Manual reload requested from tray.');
      lastHeartbeatAt = Date.now();
      try {
        mainWindow.webContents.reload();
      } catch (error) {
        console.error('[window] Manual reload failed:', error.message);
      }
    },
    onReloadPlayer: () => {
      if (guestContents && !guestContents.isDestroyed()) {
        console.warn('[guest] Manual player reload requested from tray.');
        try {
          guestContents.reload();
        } catch (error) {
          console.error('[guest] Manual player reload failed:', error.message);
        }
        return;
      }
      sendCommand('reload-player');
    },
    onCommand: (type) => {
      if (type === 'toggle-lyrics' || type === 'toggle-equalizer'
        || type === 'toggle-settings' || type === 'toggle-downloads') {
        showWindowAndSend(type);
      } else {
        sendCommand(type);
      }
    },
    onQuit: quitApp
  });
}

function bootstrap() {
  config.init();
  app.setAppUserModelId(APP_ID);
  nativeTheme.themeSource = 'dark';
  applyLaunchAtLogin(config.get().launchAtLogin);
  void cleanupStaleAuthProfiles().catch(() => {});

  setupSession();
  registerIpc();
  setupMediaProtocol();
  startProcessWatchdog();
  downloads.init((payload) => {
    sendToRenderer('downloads:event', payload);
    handleDownloadDesktopEvent(payload);
  });
  updater.init((payload) => sendToRenderer('update:status', payload));
  createWindow();
  createTray();

  desktopIntegration = createDesktopIntegration({
    getWindow: () => mainWindow,
    getPlayerState: () => lastPlayerState,
    sendCommand,
    showWindow,
    getRecentDownloads: () => downloads.list(),
    getDownloadsStatus: () => downloads.getStatus(),
    notifications: () => Boolean(config.get().notifications),
    onQuit: quitApp,
    onOpenDownload: (videoId) => {
      showWindow();
      const deliver = () => sendToRenderer('app:command', { type: 'open-download', videoId });
      if (mainWindow && mainWindow.webContents.isLoading()) {
        mainWindow.webContents.once('did-finish-load', () => setTimeout(deliver, 150));
      } else {
        setTimeout(deliver, 150);
      }
    }
  });
  desktopIntegration.handleLaunchArgs(process.argv);

  powerMonitor.on('suspend', () => {
    clearTimeout(healthCheckTimer);
    healthCheckTimer = null;
  });
  powerMonitor.on('resume', () => {
    lastHeartbeatAt = Date.now();
    // Give the GPU/audio services a moment to come back before probing. If the
    // window is hidden we defer the check until the user shows it, so playback
    // is not interrupted unnecessarily.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      scheduleHealthCheck('system-resume', 1800, { force: true, timeout: 8000 });
    }
    nudgeWindow();
  });
  powerMonitor.on('unlock-screen', () => {
    lastHeartbeatAt = Date.now();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      scheduleHealthCheck('unlock-screen', 800, { force: true });
    }
  });

  discord = new DiscordPresence((status) => sendToRenderer('discord:status', status));
  discord.configure(config.get().discord);

  updater.startPeriodicChecks();

  if (BROWSER_AUTH_TEST) {
    setTimeout(() => beginBrowserSignIn(), 3000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const handled = desktopIntegration ? desktopIntegration.handleLaunchArgs(argv) : false;
    if (!handled) showWindow();
  });

  app.whenReady().then(bootstrap).catch((error) => {
    console.error('[app] Failed to start:', error);
    app.quit();
  });
}

app.on('before-quit', (event) => {
  if (authQuitCleanupDone) return;
  isQuitting = true;
  stopHealthWatchdog();
  stopProcessWatchdog();
  if (boundsTimer) {
    clearTimeout(boundsTimer);
    boundsTimer = null;
  }

  // Let the temp browser profile (and any in-flight cookie write) finish
  // cleanup before Electron tears down the session. Without this, quitting
  // during sign-in can leave a copied cookie database in %TEMP%.
  event.preventDefault();
  if (authQuitCleanupStarted) return;
  authQuitCleanupStarted = true;

  Promise.resolve(stopBrowserAuth({ closeBrowser: true }))
    .catch(() => {})
    .finally(() => {
      authQuitCleanupDone = true;
      app.quit();
    });

  if (desktopIntegration) desktopIntegration.destroy();
  downloads.shutdown();
  config.flush();
  if (discord) discord.destroy();
  if (tray) tray.destroy();
  if (powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
  if (downloadBlockerTimer) {
    clearTimeout(downloadBlockerTimer);
    downloadBlockerTimer = null;
  }
  if (downloadPowerBlockerId !== null) {
    try { powerSaveBlocker.stop(downloadPowerBlockerId); } catch (error) {}
    downloadPowerBlockerId = null;
  }
});

app.on('child-process-gone', (event, details) => {
  if (isQuitting) return;
  const type = String(details.type || '').toLowerCase();
  console.warn('[app] Child process gone:', details.type, details.reason);
  if (type === 'gpu') {
    // The renderers stay alive when the GPU process dies, but the window can
    // keep showing a stale frame until it is invalidated.
    setTimeout(() => nudgeWindow(), 500);
    scheduleHealthCheck('gpu-process-gone', 1200, { force: true });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (error) => {
  console.error('[app] Uncaught exception:', error);
});
process.on('unhandledRejection', (error) => {
  console.error('[app] Unhandled rejection:', error);
});

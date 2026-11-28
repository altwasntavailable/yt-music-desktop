'use strict';

const { app } = require('electron');

let onStatus = () => {};
let autoUpdater = null;
let loaded = false;
let checking = false;
let downloaded = null;
let updateUrl = '';

function emit(payload) {
  try {
    onStatus(payload);
  } catch (error) {
    // The renderer may be closing.
  }
}

function load() {
  if (loaded) return autoUpdater;
  loaded = true;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    emit({ status: 'error', message: 'Update support is not installed.' });
    return null;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  updateUrl = String(process.env.YTMD_UPDATE_URL || '').trim();
  if (updateUrl) {
    try {
      const parsed = new URL(updateUrl);
      const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
        console.error('[updater] Ignoring YTMD_UPDATE_URL: HTTPS is required.');
        updateUrl = '';
      } else {
        autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
      }
    } catch (error) {
      console.error('[updater] Ignoring invalid YTMD_UPDATE_URL:', error.message);
      updateUrl = '';
    }
  }

  autoUpdater.on('checking-for-update', () => emit({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    emit({ status: 'available', version: info && info.version });
  });
  autoUpdater.on('update-not-available', (info) => {
    emit({ status: 'current', version: info && info.version });
  });
  autoUpdater.on('download-progress', (progress) => {
    emit({
      status: 'downloading',
      percent: Number(progress && progress.percent) || 0
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = info || {};
    emit({ status: 'downloaded', version: info && info.version });
  });
  autoUpdater.on('error', (error) => {
    emit({ status: 'error', message: error && error.message ? error.message : 'Update check failed.' });
  });

  return autoUpdater;
}

function init(handler) {
  onStatus = typeof handler === 'function' ? handler : () => {};
  load();
}

function isPortable() {
  return Boolean(String(process.env.PORTABLE_EXECUTABLE_FILE || '').trim());
}

function getStatus() {
  return {
    supported: app.isPackaged && !isPortable(),
    version: app.getVersion(),
    downloaded: downloaded ? downloaded.version || true : false,
    feed: updateUrl || null,
    portable: isPortable()
  };
}

async function check(manual = true) {
  if (!app.isPackaged) {
    emit({
      status: 'dev',
      message: 'Automatic updates are only available in the installed build.'
    });
    return { ok: false, reason: 'dev' };
  }
  if (isPortable()) {
    emit({
      status: 'dev',
      message: 'Portable builds are updated by downloading a new portable executable from GitHub Releases.'
    });
    return { ok: false, reason: 'portable' };
  }

  const updater = load();
  if (!updater) return { ok: false, reason: 'unavailable' };
  if (checking) return { ok: false, reason: 'busy' };

  checking = true;
  emit({ status: 'checking', manual });
  try {
    await updater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    emit({
      status: 'error',
      message: error && error.message ? error.message : 'Update check failed.'
    });
    return { ok: false, reason: 'error' };
  } finally {
    checking = false;
  }
}

function quitAndInstall() {
  const updater = load();
  if (!updater || !downloaded) return false;
  setImmediate(() => {
    try {
      updater.quitAndInstall(false, true);
    } catch (error) {
      emit({ status: 'error', message: error.message });
    }
  });
  return true;
}

function startPeriodicChecks() {
  if (!app.isPackaged || isPortable()) return;
  setTimeout(() => check(false), 20000);
  const timer = setInterval(() => check(false), 6 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { init, getStatus, check, quitAndInstall, startPeriodicChecks };

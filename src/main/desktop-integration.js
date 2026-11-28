'use strict';

/**
 * Windows desktop integration: taskbar thumbnail toolbar, jump list,
 * taskbar progress/overlay, notifications, sleep timer, and launch-at-login.
 *
 * This module intentionally owns no application state. The main process
 * supplies small getters/callbacks so the module can stay self-contained and
 * never reach into player, download, or config internals directly.
 */

const path = require('path');
const { app, nativeImage, Notification } = require('electron');

const IS_WINDOWS = process.platform === 'win32';

const ASSETS_DIR = path.join(__dirname, '../../assets');
const THUMBAR_DIR = path.join(ASSETS_DIR, 'thumbar');
const APP_ICON_PATH = path.join(ASSETS_DIR, 'icon.png');

const ICON_SIZE = 32;
const TRACK_NOTIFY_INTERVAL_MS = 5 * 1000;
const DOWNLOAD_NOTIFY_INTERVAL_MS = 5 * 1000;
const MIN_SLEEP_MINUTES = 1;
const MAX_SLEEP_MINUTES = 12 * 60;
const SHOW_AND_SEND_DELAY_MS = 120;
const MAX_RECENT_DOWNLOADS = 5;
const MAX_NOTIFICATION_TITLE = 120;
const MAX_NOTIFICATION_BODY = 320;
const MAX_TRACKED_NOTIFICATIONS = 30;

const DOWNLOAD_TYPES = new Set(['complete', 'error', 'info', 'batch-complete']);
const DOWNLOAD_PRIORITY = {
  info: 0,
  complete: 1,
  batch: 2,
  error: 3
};

// Only whitelisted actions are accepted from jump-list launch arguments.
const LAUNCH_ACTIONS = new Set([
  'play-pause',
  'next',
  'previous',
  'toggle-lyrics',
  'toggle-downloads',
  'toggle-settings',
  'download-current',
  'open-download',
  'quit'
]);

const WINDOW_LAUNCH_ACTIONS = new Set([
  'toggle-lyrics',
  'toggle-downloads',
  'toggle-settings',
  'open-download'
]);

/* ---------- Pure helpers (also covered by test/desktop-integration.test.js) ---------- */

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function normalizeProgressState(state) {
  const value = String(state || '').trim().toLowerCase();
  if (value === 'none' || value === 'paused' || value === 'error' || value === 'normal') {
    return value;
  }
  return 'normal';
}

// electron-builder's portable target extracts the real app to a temporary
// directory and deletes it on exit. Registering that temporary path in the
// jump list or Run key would leave a broken entry; the launcher exports this
// environment variable so we can point at the stable outer executable.
function executablePath() {
  const portable = String(process.env.PORTABLE_EXECUTABLE_FILE || '').trim();
  return portable || process.execPath;
}

function truncateText(value, max) {
  const limit = Math.max(1, Math.floor(Number(max) || 1));
  const text = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizeSleepMinutes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.max(MIN_SLEEP_MINUTES, Math.min(MAX_SLEEP_MINUTES, Math.round(number)));
}

function selectRecentDownloads(items, limit = MAX_RECENT_DOWNLOADS) {
  if (!Array.isArray(items)) return [];
  const rawLimit = Number(limit);
  const max = Number.isFinite(rawLimit)
    ? Math.max(0, Math.min(20, Math.floor(rawLimit)))
    : MAX_RECENT_DOWNLOADS;
  return items
    .filter((item) => item && typeof item === 'object')
    .slice()
    .sort((a, b) => {
      const aTime = Number(a.addedAt);
      const bTime = Number(b.addedAt);
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    })
    .slice(0, max);
}

function extractLaunchAction(argv) {
  if (!Array.isArray(argv)) return null;

  let action = '';
  let videoId = '';

  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] == null ? '' : argv[index]);

    if (value.startsWith('--ytmd-action=')) {
      action = value.slice('--ytmd-action='.length);
    } else if (value === '--ytmd-action') {
      const next = argv[index + 1];
      if (next != null) {
        action = String(next);
        index += 1;
      }
    } else if (value.startsWith('--ytmd-video-id=')) {
      videoId = value.slice('--ytmd-video-id='.length);
    } else if (value === '--ytmd-video-id') {
      const next = argv[index + 1];
      if (next != null) {
        videoId = String(next);
        index += 1;
      }
    }
  }

  action = action.trim();
  if (!LAUNCH_ACTIONS.has(action)) return null;

  videoId = videoId.trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) videoId = '';

  return { action, videoId };
}

function actionRequiresWindow(action) {
  return WINDOW_LAUNCH_ACTIONS.has(String(action || '').trim());
}

// Windows command-line quoting (CommandLineToArgvW rules). Jump-list task
// arguments live in a single string, so paths with spaces must be quoted.
function quoteWindowsArgument(value) {
  const text = String(value == null ? '' : value);
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

/* ---------- Desktop integration ---------- */

class DesktopIntegration {
  constructor(options = {}) {
    this.options = options && typeof options === 'object' ? options : {};

    this.playerState = null;
    this._paused = null;
    this._thumbarWindow = null;
    this._destroyed = false;
    this._iconCache = new Map();
    this._iconWarnings = new Set();

    this._notifications = new Set();
    this._notificationIconCache = null;
    this._notificationIconLoaded = false;
    this._lastTrackKey = '';
    this._lastTrackNotifyAt = 0;
    this._lastDownloadNotifyAt = 0;
    this._pendingDownload = null;
    this._downloadFlushTimer = null;

    this._sleepTimer = null;
    this._commandTimers = new Set();
    this._rendererReadyCallbacks = [];
    this._readyContents = null;
    this._readyListener = null;

    this._progressActive = false;
    this._progressValue = 0;
    this._progressMode = 'none';
    this._progressRevision = 0;

    this._beforeQuitHandler = () => this.destroy();
    if (app && typeof app.once === 'function') {
      try {
        app.once('before-quit', this._beforeQuitHandler);
      } catch (error) {
        // The app may already be shutting down.
      }
    }

    // Apply the initial toolbar/jump list. refresh() is still exposed so the
    // caller can re-run this after the window or downloads change.
    this.update();
    this._applyJumpList();
  }

  /* ---------- Window/player state ---------- */

  update(state) {
    if (this._destroyed) return null;

    let next = state && typeof state === 'object' ? state : this._getPlayerState();
    if (!next || typeof next !== 'object') next = this.playerState;
    this.playerState = next || null;

    const paused = !next || next.paused !== false;
    const win = IS_WINDOWS ? this._getWindow() : null;
    if (paused !== this._paused || (win && win !== this._thumbarWindow)) {
      this._paused = paused;
      this._applyThumbar(win);
    }
    return this.playerState;
  }

  updatePlayerState(state) {
    return this.update(state);
  }

  refresh() {
    if (this._destroyed) return false;
    this.update(this.playerState || undefined);
    const applied = this._applyJumpList();
    // If the orchestrator never sent a final 0/'none' progress update, clear a
    // stale taskbar bar once downloads.getStatus() reports no active jobs.
    this._syncDownloadIndicators().catch(() => {});
    return applied;
  }

  /* ---------- Taskbar thumbnail toolbar ---------- */

  _applyThumbar(targetWindow) {
    if (!IS_WINDOWS || this._destroyed) return false;

    const win = targetWindow || this._getWindow();
    if (!win || typeof win.setThumbarButtons !== 'function') return false;

    const paused = this._paused !== false;
    const buttons = [];

    const addButton = (tooltip, iconName, click) => {
      const icon = this._loadThumbarIcon(iconName);
      if (!icon) return;
      buttons.push({ tooltip, icon, click });
    };

    addButton('Previous', 'previous', () => this._command('previous'));
    addButton(paused ? 'Play' : 'Pause', paused ? 'play' : 'pause', () => this._command('play-pause'));
    addButton('Next', 'next', () => this._command('next'));
    addButton('Download current track', 'download', () => this._command('download-current'));
    addButton('Settings', 'settings', () => this._showAndSend('toggle-settings'));

    if (!buttons.length) return false;

    try {
      const applied = Boolean(win.setThumbarButtons(buttons));
      if (applied) this._thumbarWindow = win;
      return applied;
    } catch (error) {
      if (!this._iconWarnings.has('thumbar-error')) {
        this._iconWarnings.add('thumbar-error');
        console.error('[desktop] Could not update taskbar thumbnail buttons:', error.message);
      }
      return false;
    }
  }

  _loadThumbarIcon(name) {
    if (this._iconCache.has(name)) return this._iconCache.get(name);
    if (!nativeImage || typeof nativeImage.createFromPath !== 'function') return null;

    let image = null;
    try {
      image = nativeImage.createFromPath(path.join(THUMBAR_DIR, `${name}.png`));
    } catch (error) {
      image = null;
    }

    if (!image || image.isEmpty()) {
      // Fall back to the app icon rather than leaving a toolbar button without
      // an image (Windows rejects the whole toolbar in that case).
      try {
        image = nativeImage.createFromPath(APP_ICON_PATH);
        if (image && !image.isEmpty()) {
          image = image.resize({ width: ICON_SIZE, height: ICON_SIZE, quality: 'best' });
        }
      } catch (error) {
        image = null;
      }
    }

    if (!image || image.isEmpty()) {
      if (!this._iconWarnings.has(name)) {
        this._iconWarnings.add(name);
        console.warn(`[desktop] Icon missing: assets/thumbar/${name}.png`);
      }
      return null;
    }

    this._iconCache.set(name, image);
    return image;
  }

  /* ---------- Jump list ---------- */

  _applyJumpList() {
    if (!IS_WINDOWS || this._destroyed) return false;
    if (!app || typeof app.setJumpList !== 'function') return false;
    if (typeof app.isReady === 'function' && !app.isReady()) return false;

    const tasks = [
      this._jumpListTask('play-pause', 'Play / Pause', 'Play or pause the current track'),
      this._jumpListTask('toggle-lyrics', 'Lyrics', 'Show lyrics for the current track'),
      this._jumpListTask('toggle-downloads', 'Offline downloads', 'Open the offline downloads panel'),
      this._jumpListTask('toggle-settings', 'Settings', 'Open YT Music Desktop settings'),
      this._jumpListTask('download-current', 'Download current track', 'Save the current track for offline listening')
    ];

    if (typeof this.options.onQuit === 'function') {
      tasks.push(this._jumpListTask('quit', 'Quit YT Music', 'Quit YT Music Desktop'));
    }

    const categories = [{ type: 'tasks', items: tasks }];
    const recent = this._recentDownloadItems();
    if (recent.length) {
      categories.push({ type: 'custom', name: 'Recent downloads', items: recent });
    }

    try {
      const result = app.setJumpList(categories);
      if (result && result !== 'ok' && !this._iconWarnings.has('jump-list-error')) {
        this._iconWarnings.add('jump-list-error');
        console.warn('[desktop] Could not set jump list:', result);
      }
      return result === 'ok';
    } catch (error) {
      if (!this._iconWarnings.has('jump-list-exception')) {
        this._iconWarnings.add('jump-list-exception');
        console.error('[desktop] Could not set jump list:', error.message);
      }
      return false;
    }
  }

  _jumpListTask(action, title, description) {
    return {
      type: 'task',
      program: executablePath(),
      args: this._buildTaskArgs(action),
      title,
      description
    };
  }

  _recentDownloadItems() {
    if (typeof this.options.getRecentDownloads !== 'function') return [];

    let items;
    try {
      items = this.options.getRecentDownloads();
    } catch (error) {
      return [];
    }

    return selectRecentDownloads(items, MAX_RECENT_DOWNLOADS).map((item) => {
      let videoId = String(item.videoId || item.id || '').trim();
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) videoId = '';

      const artist = truncateText(item.artist, 60);
      return {
        type: 'task',
        program: executablePath(),
        args: this._buildTaskArgs('open-download', videoId),
        title: truncateText(item.title, 80) || 'Downloaded track',
        description: artist ? `${artist} · Downloaded` : 'Downloaded track'
      };
    });
  }

  _buildTaskArgs(action, videoId = '') {
    const args = [];

    // In development process.execPath is electron.exe, so it needs the app
    // directory before the action flag. Packaged builds only need the flag.
    if (app && app.isPackaged === false) {
      try {
        args.push(app.getAppPath());
      } catch (error) {
        // Fall through with just the action flag.
      }
    }

    args.push(`--ytmd-action=${action}`);
    if (videoId) args.push(`--ytmd-video-id=${videoId}`);
    return args.map(quoteWindowsArgument).join(' ');
  }

  /* ---------- Taskbar progress / overlay ---------- */

  setDownloadProgress(percent, state) {
    if (!IS_WINDOWS || this._destroyed) return false;

    const win = this._getWindow();
    if (!win || typeof win.setProgressBar !== 'function') return false;

    const mode = normalizeProgressState(state);
    this._progressRevision += 1;

    try {
      if (mode === 'none') {
        win.setProgressBar(-1, { mode: 'none' });
        this._progressActive = false;
        this._progressValue = 0;
        this._progressMode = 'none';
        return true;
      }

      const value = clampPercent(percent) / 100;
      win.setProgressBar(value, { mode });
      this._progressActive = true;
      this._progressValue = value;
      this._progressMode = mode;
      return true;
    } catch (error) {
      if (!this._iconWarnings.has('progress-error')) {
        this._iconWarnings.add('progress-error');
        console.error('[desktop] Could not set taskbar progress:', error.message);
      }
      return false;
    }
  }

  setOverlayIcon(imagePathOrNull, description) {
    if (!IS_WINDOWS || this._destroyed) return false;

    const win = this._getWindow();
    if (!win || typeof win.setOverlayIcon !== 'function') return false;

    let image = null;
    if (imagePathOrNull) {
      if (!nativeImage || typeof nativeImage.createFromPath !== 'function') return false;
      try {
        image = nativeImage.createFromPath(String(imagePathOrNull));
      } catch (error) {
        image = null;
      }
      if (!image || image.isEmpty()) {
        if (!this._iconWarnings.has('overlay-missing')) {
          this._iconWarnings.add('overlay-missing');
          console.warn('[desktop] Overlay icon could not be loaded:', imagePathOrNull);
        }
        return false;
      }
    }

    try {
      win.setOverlayIcon(image, truncateText(description, 100));
      return true;
    } catch (error) {
      if (!this._iconWarnings.has('overlay-error')) {
        this._iconWarnings.add('overlay-error');
        console.error('[desktop] Could not set taskbar overlay:', error.message);
      }
      return false;
    }
  }

  async _syncDownloadIndicators() {
    if (this._destroyed || !this._progressActive) return;
    if (typeof this.options.getDownloadsStatus !== 'function') return;

    const revision = this._progressRevision;
    let status;
    try {
      status = await this.options.getDownloadsStatus();
    } catch (error) {
      return;
    }

    if (this._destroyed || revision !== this._progressRevision || !this._progressActive) return;
    const active = status && Array.isArray(status.active) ? status.active : null;
    if (!active || active.length !== 0) return;

    // Do not stomp the deliberate 100% completion bar. Callers that want the
    // bar cleared (the main process does this on a timer) use 'none'.
    if (this._progressMode === 'normal' && this._progressValue >= 0.999) return;
    this.setDownloadProgress(0, 'none');
  }

  /* ---------- Notifications ---------- */

  notifyTrackChange(state, enabled) {
    if (this._destroyed || !state || typeof state !== 'object') return false;
    if (!state.title || state.paused || state.isAd) return false;
    if (!this._notificationsEnabled(enabled)) return false;

    const key = state.videoId
      ? `id:${String(state.videoId)}`
      : `meta:${String(state.title)}\u0000${String(state.artist || '')}`;

    // Remember the track even when the notification is suppressed, so a later
    // state send for the same track does not notify late.
    if (key === this._lastTrackKey) return false;
    this._lastTrackKey = key;

    if (this._windowIsForeground()) return false;

    const now = Date.now();
    if (now - this._lastTrackNotifyAt < TRACK_NOTIFY_INTERVAL_MS) return false;
    this._lastTrackNotifyAt = now;

    const body = [state.artist, state.album]
      .filter((value) => value && String(value).trim())
      .map((value) => truncateText(value, 100))
      .join(' • ');

    return this._showNotification({
      title: truncateText(state.title, MAX_NOTIFICATION_TITLE) || 'Now playing',
      body: body || 'Now playing'
    });
  }

  notifyDownload(payload) {
    if (this._destroyed) return false;

    const data = payload && typeof payload === 'object' ? payload : {};
    if (data.enabled === false) return false;

    const type = DOWNLOAD_TYPES.has(String(data.type || '').toLowerCase())
      ? String(data.type).toLowerCase()
      : 'info';

    const record = {
      type,
      title: truncateText(data.title, MAX_NOTIFICATION_TITLE) || this._defaultDownloadTitle(type),
      body: truncateText(data.body, MAX_NOTIFICATION_BODY)
    };

    // Informational notifications (for example "Sleep timer finished") are
    // user-initiated and must not wait behind a queued download toast. Show
    // them immediately, then push any pending download notification out so
    // the two do not stack back-to-back.
    if (type === 'info') {
      const shown = this._showDownloadNotification(record);
      if (this._pendingDownload) {
        this._scheduleDownloadFlush(DOWNLOAD_NOTIFY_INTERVAL_MS);
      }
      return shown;
    }

    const now = Date.now();
    const elapsed = now - this._lastDownloadNotifyAt;
    const canShowNow = elapsed >= DOWNLOAD_NOTIFY_INTERVAL_MS;

    if (canShowNow && !this._pendingDownload) {
      return this._showDownloadNotification(record);
    }

    this._queueDownloadNotification(record);
    this._scheduleDownloadFlush(Math.max(0, DOWNLOAD_NOTIFY_INTERVAL_MS - elapsed));
    return false;
  }

  _defaultDownloadTitle(type) {
    if (type === 'error') return 'Download failed';
    if (type === 'batch-complete') return 'Playlist download complete';
    if (type === 'complete') return 'Download complete';
    return 'YT Music Desktop';
  }

  _queueDownloadNotification(record) {
    const kind = record.type === 'batch-complete' ? 'batch' : record.type;
    const existing = this._pendingDownload;

    if (!existing) {
      this._pendingDownload = { kind, payload: record, count: 1 };
      return;
    }

    if (kind === 'complete' && existing.kind === 'complete') {
      existing.count += 1;
      existing.payload = record;
      return;
    }

    if (DOWNLOAD_PRIORITY[kind] >= DOWNLOAD_PRIORITY[existing.kind]) {
      this._pendingDownload = { kind, payload: record, count: 1 };
    }
  }

  _scheduleDownloadFlush(delay) {
    if (this._downloadFlushTimer) {
      clearTimeout(this._downloadFlushTimer);
      this._downloadFlushTimer = null;
    }

    this._downloadFlushTimer = setTimeout(() => {
      this._downloadFlushTimer = null;
      this._flushDownloadNotification();
    }, Math.max(0, delay));

    if (this._downloadFlushTimer.unref) this._downloadFlushTimer.unref();
  }

  _flushDownloadNotification() {
    const pending = this._pendingDownload;
    this._pendingDownload = null;
    if (!pending || this._destroyed) return;

    let record = pending.payload;
    if (pending.kind === 'complete' && pending.count > 1) {
      record = {
        type: 'complete',
        title: 'Downloads complete',
        body: `${pending.count} tracks were saved.`
      };
    }

    this._showDownloadNotification(record);
  }

  _showDownloadNotification(record) {
    this._lastDownloadNotifyAt = Date.now();
    return this._showNotification({
      title: record.title,
      body: record.body
    });
  }

  _notificationsEnabled(enabled) {
    if (typeof enabled === 'boolean') return enabled;
    if (enabled && typeof enabled === 'object' && typeof enabled.enabled === 'boolean') {
      return enabled.enabled;
    }

    const setting = this.options.notifications;
    if (typeof setting === 'boolean') return setting;
    if (typeof setting === 'function') {
      try {
        return Boolean(setting());
      } catch (error) {
        return false;
      }
    }
    if (setting && typeof setting === 'object' && typeof setting.enabled === 'boolean') {
      return setting.enabled;
    }

    // Safe default: track notifications are opt-in. The caller should pass
    // config.notifications (or an explicit enabled value) to turn them on.
    return false;
  }

  _showNotification({ title, body }) {
    if (!this._notificationsSupported()) return false;

    let notification = null;
    try {
      const options = {
        title: truncateText(title, MAX_NOTIFICATION_TITLE) || 'YT Music Desktop',
        body: truncateText(body, MAX_NOTIFICATION_BODY)
      };
      const icon = this._notificationIcon();
      if (icon) options.icon = icon;

      notification = new Notification(options);

      this._notifications.add(notification);
      while (this._notifications.size > MAX_TRACKED_NOTIFICATIONS) {
        // Drop the oldest reference only. Closing it would also remove an
        // older entry from Windows Action Center.
        this._notifications.delete(this._notifications.values().next().value);
      }

      const release = () => {
        this._notifications.delete(notification);
      };

      notification.once('close', release);
      notification.once('failed', release);
      notification.once('click', () => {
        release();
        this._showWindow();
      });

      notification.show();
      return true;
    } catch (error) {
      if (notification) this._notifications.delete(notification);
      if (!this._iconWarnings.has('notification-error')) {
        this._iconWarnings.add('notification-error');
        console.error('[desktop] Could not show notification:', error.message);
      }
      return false;
    }
  }

  _notificationsSupported() {
    try {
      return typeof Notification === 'function' && Notification.isSupported();
    } catch (error) {
      return false;
    }
  }

  _notificationIcon() {
    if (this._notificationIconLoaded) return this._notificationIconCache;
    this._notificationIconLoaded = true;

    if (!nativeImage || typeof nativeImage.createFromPath !== 'function') return null;
    try {
      const image = nativeImage.createFromPath(APP_ICON_PATH);
      this._notificationIconCache = image && !image.isEmpty() ? image : null;
    } catch (error) {
      this._notificationIconCache = null;
    }
    return this._notificationIconCache;
  }

  _windowIsForeground() {
    const win = this._getWindow();
    if (!win) return false;

    try {
      if (typeof win.isMinimized === 'function' && win.isMinimized()) return false;
      if (typeof win.isVisible === 'function' && !win.isVisible()) return false;
      return typeof win.isFocused === 'function' ? Boolean(win.isFocused()) : false;
    } catch (error) {
      return false;
    }
  }

  /* ---------- Sleep timer ---------- */

  startSleepTimer(minutes, onExpire) {
    if (this._destroyed) return { active: false, endsAt: null, minutes: 0 };

    const duration = normalizeSleepMinutes(minutes);
    if (!duration) return { active: false, endsAt: null, minutes: 0 };

    this.cancelSleepTimer();

    const endsAt = Date.now() + duration * 60 * 1000;
    const entry = {
      timer: null,
      endsAt,
      minutes: duration
    };

    entry.timer = setTimeout(() => {
      if (this._sleepTimer !== entry) return;
      this._sleepTimer = null;
      if (this._destroyed) return;
      if (typeof onExpire === 'function') {
        try {
          onExpire({ minutes: duration, endsAt });
        } catch (error) {
          console.error('[desktop] Sleep timer callback failed:', error.message);
        }
      }
    }, duration * 60 * 1000);

    if (entry.timer.unref) entry.timer.unref();
    this._sleepTimer = entry;
    return this.getSleepTimer();
  }

  cancelSleepTimer() {
    if (!this._sleepTimer) return false;
    clearTimeout(this._sleepTimer.timer);
    this._sleepTimer = null;
    return true;
  }

  getSleepTimer() {
    if (!this._sleepTimer) {
      return { active: false, endsAt: null, minutes: 0 };
    }
    return {
      active: true,
      endsAt: this._sleepTimer.endsAt,
      minutes: this._sleepTimer.minutes
    };
  }

  /* ---------- Launch at login ---------- */

  setLaunchAtLogin(enabled) {
    if (!IS_WINDOWS || !app || typeof app.setLoginItemSettings !== 'function') return false;

    try {
      app.setLoginItemSettings({
        openAtLogin: Boolean(enabled),
        path: executablePath(),
        args: this._loginArgs()
      });
      return true;
    } catch (error) {
      console.error('[desktop] Could not update launch-at-login:', error.message);
      return false;
    }
  }

  getLaunchAtLogin() {
    if (!IS_WINDOWS || !app || typeof app.getLoginItemSettings !== 'function') return false;

    try {
      const settings = app.getLoginItemSettings({
        path: executablePath(),
        args: this._loginArgs()
      });
      return Boolean(settings && settings.openAtLogin);
    } catch (error) {
      return false;
    }
  }

  _loginArgs() {
    if (app && app.isPackaged === false) {
      try {
        // Make dev launches work too: electron.exe needs the app directory.
        return [app.getAppPath(), '--hidden'];
      } catch (error) {
        // Fall through to the packaged shape.
      }
    }
    return ['--hidden'];
  }

  /* ---------- Jump-list launch actions ---------- */

  /**
   * Parses a jump-list action without executing it. main.js can use this
   * before deciding whether a second instance should bring the window
   * forward. Playback and quit actions intentionally do not need the window.
   */
  parseLaunchArgs(argv) {
    const parsed = extractLaunchAction(argv);
    if (!parsed) return null;
    return {
      ...parsed,
      requiresWindow: actionRequiresWindow(parsed.action)
    };
  }

  /**
   * Routes a whitelisted jump-list action from process.argv. Returns true when
   * an action was recognized and handled, so a second-instance handler can
   * avoid showing the window for playback/quit actions:
   *
   *   const handled = desktopIntegration.handleLaunchArgs(argv);
   *   if (!handled) showWindow();
   *
   * Call this once after startup too, so tasks opened while the app was not
   * running still work.
   */
  handleLaunchArgs(argv) {
    if (this._destroyed) return false;

    const parsed = this.parseLaunchArgs(argv);
    if (!parsed) return false;

    switch (parsed.action) {
      case 'quit':
        return this.requestQuit();

      case 'toggle-lyrics':
      case 'toggle-downloads':
      case 'toggle-settings':
        this._showAndSend(parsed.action);
        return true;

      case 'open-download':
        if (typeof this.options.onOpenDownload === 'function') {
          this._showWindow();
          this._runLater(() => {
            this._withRendererReady(() => {
              try {
                this.options.onOpenDownload(parsed.videoId);
              } catch (error) {
                console.error('[desktop] Open-download callback failed:', error.message);
              }
            });
          });
        } else {
          this._showAndSend('toggle-downloads');
        }
        return true;

      case 'play-pause':
      case 'next':
      case 'previous':
      case 'download-current':
        this._command(parsed.action);
        return true;

      default:
        return false;
    }
  }

  requestQuit() {
    if (this._destroyed) return false;
    if (typeof this.options.onQuit !== 'function') return false;
    try {
      this.options.onQuit();
      return true;
    } catch (error) {
      console.error('[desktop] Quit callback failed:', error.message);
      return false;
    }
  }

  /* ---------- Callback helpers ---------- */

  _getWindow() {
    if (typeof this.options.getWindow !== 'function') return null;
    try {
      const win = this.options.getWindow();
      return win && !win.isDestroyed() ? win : null;
    } catch (error) {
      return null;
    }
  }

  _getPlayerState() {
    if (typeof this.options.getPlayerState !== 'function') return null;
    try {
      const state = this.options.getPlayerState();
      return state && typeof state === 'object' ? state : null;
    } catch (error) {
      return null;
    }
  }

  _command(type) {
    if (this._destroyed) return;
    if (typeof this.options.sendCommand !== 'function') return;

    // The window exists as soon as createWindow() returns, but the renderer
    // may still be loading. Hold jump-list commands until did-finish-load so
    // an action used to launch the app is not lost.
    this._withRendererReady(() => {
      if (this._destroyed || typeof this.options.sendCommand !== 'function') return;
      try {
        this.options.sendCommand(type);
      } catch (error) {
        // The renderer may be navigating or shutting down.
      }
    });
  }

  _withRendererReady(callback) {
    if (this._destroyed) return;

    const win = this._getWindow();
    const contents = win && win.webContents;
    if (
      !contents
      || contents.isDestroyed()
      || (!this._contentsLoading(contents) && !this._contentsCrashed(contents))
    ) {
      this._invokeReadyCallback(callback);
      return;
    }

    this._rendererReadyCallbacks.push(callback);
    if (this._readyListener && this._readyContents === contents) return;

    if (this._readyContents && this._readyListener) {
      try {
        this._readyContents.removeListener('did-finish-load', this._readyListener);
      } catch (error) {
        // The old renderer may already be gone.
      }
    }

    const listener = () => {
      if (this._readyContents === contents) {
        this._readyContents = null;
        this._readyListener = null;
      }
      this._flushRendererReady();
    };

    this._readyContents = contents;
    this._readyListener = listener;
    try {
      contents.once('did-finish-load', listener);
    } catch (error) {
      // If the emitter is unusable, run every queued command now rather than
      // leaving them stuck forever.
      this._readyContents = null;
      this._readyListener = null;
      const pending = this._rendererReadyCallbacks.splice(0);
      for (const queued of pending) {
        if (this._destroyed) return;
        this._invokeReadyCallback(queued);
      }
    }
  }

  _contentsLoading(contents) {
    try {
      return typeof contents.isLoading === 'function' ? Boolean(contents.isLoading()) : false;
    } catch (error) {
      return false;
    }
  }

  _contentsCrashed(contents) {
    try {
      return typeof contents.isCrashed === 'function' ? Boolean(contents.isCrashed()) : false;
    } catch (error) {
      return false;
    }
  }

  _flushRendererReady() {
    if (this._destroyed) {
      this._rendererReadyCallbacks.length = 0;
      return;
    }

    const callbacks = this._rendererReadyCallbacks.splice(0);
    for (const callback of callbacks) {
      if (this._destroyed) return;
      this._invokeReadyCallback(callback);
    }
  }

  _invokeReadyCallback(callback) {
    try {
      callback();
    } catch (error) {
      console.error('[desktop] Renderer-ready callback failed:', error.message);
    }
  }

  _clearRendererReady() {
    if (this._readyContents && this._readyListener) {
      try {
        this._readyContents.removeListener('did-finish-load', this._readyListener);
      } catch (error) {
        // The renderer may already be gone.
      }
    }
    this._readyContents = null;
    this._readyListener = null;
    this._rendererReadyCallbacks.length = 0;
  }

  _showWindow() {
    if (this._destroyed) return;
    if (typeof this.options.showWindow !== 'function') return;
    try {
      this.options.showWindow();
    } catch (error) {
      // The window may be closing.
    }
  }

  _showAndSend(type) {
    this._showWindow();
    this._runLater(() => this._command(type));
  }

  _runLater(callback) {
    const timer = setTimeout(() => {
      this._commandTimers.delete(timer);
      if (!this._destroyed) callback();
    }, SHOW_AND_SEND_DELAY_MS);

    this._commandTimers.add(timer);
  }

  /* ---------- Teardown ---------- */

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._beforeQuitHandler) {
      if (app && typeof app.removeListener === 'function') {
        try {
          app.removeListener('before-quit', this._beforeQuitHandler);
        } catch (error) {
          // The app may already be gone.
        }
      }
      this._beforeQuitHandler = null;
    }

    this.cancelSleepTimer();
    this._clearRendererReady();

    if (this._downloadFlushTimer) {
      clearTimeout(this._downloadFlushTimer);
      this._downloadFlushTimer = null;
    }
    this._pendingDownload = null;

    for (const timer of this._commandTimers) clearTimeout(timer);
    this._commandTimers.clear();

    for (const notification of this._notifications) {
      try {
        notification.close();
      } catch (error) {
        // The notification may already be gone.
      }
    }
    this._notifications.clear();

    const win = this._getWindow();
    if (IS_WINDOWS && win) {
      try {
        if (typeof win.setThumbarButtons === 'function') win.setThumbarButtons([]);
      } catch (error) {}
      try {
        if (typeof win.setProgressBar === 'function') win.setProgressBar(-1, { mode: 'none' });
      } catch (error) {}
      try {
        if (typeof win.setOverlayIcon === 'function') win.setOverlayIcon(null, '');
      } catch (error) {}
    }

    if (
      IS_WINDOWS
      && app
      && typeof app.setJumpList === 'function'
      && (typeof app.isReady !== 'function' || app.isReady())
    ) {
      try {
        app.setJumpList(null);
      } catch (error) {
        // Windows may already be tearing down the taskbar entry.
      }
    }

    this._iconCache.clear();
    this._iconWarnings.clear();
    this._notificationIconCache = null;
    this._notificationIconLoaded = false;
    this.playerState = null;
    this._paused = null;
    this._thumbarWindow = null;
    this._progressActive = false;
    this._progressValue = 0;
    this._progressMode = 'none';
  }
}

function createDesktopIntegration(options) {
  return new DesktopIntegration(options || {});
}

module.exports = {
  createDesktopIntegration,
  DesktopIntegration,
  executablePath,
  actionRequiresWindow,
  helpers: Object.freeze({
    clampPercent,
    normalizeProgressState,
    executablePath,
    truncateText,
    normalizeSleepMinutes,
    selectRecentDownloads,
    extractLaunchAction,
    actionRequiresWindow,
    quoteWindowsArgument
  })
};

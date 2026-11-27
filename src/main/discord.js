'use strict';

const RPC = require('discord-rpc');

const RETRY_MS = 15_000;

// Shared application ID for the public "YouTube Music" Discord app (registered
// by the open-source Pear Desktop project, github.com/pear-devs/pear-desktop).
// Shipping it means Rich Presence works with one click; Settings → Discord →
// Advanced can still override it with a user-created application.
const DEFAULT_CLIENT_ID = '1177081335727267940';

// Discord activity types: 0 Playing, 1 Streaming, 2 Listening, 3 Watching.
const ACTIVITY_LISTENING = 2;

function truncate(value, max = 128) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function isValidClientId(value) {
  return /^\d{17,20}$/.test(String(value || '').trim());
}

function resolveClientId(settings = {}) {
  const customId = String(settings.clientId || '').trim();
  if (settings.useCustom && isValidClientId(customId)) return customId;
  return DEFAULT_CLIENT_ID;
}

function friendlyError(error) {
  const message = String((error && error.message) || '').toLowerCase();

  if (message === 'rpc_connection_timeout' || message.includes('could not connect')) {
    return 'Discord is not running. Open Discord and the app will connect automatically.';
  }
  if (message.includes('invalid client id') || message.includes('unknown application')) {
    return 'Discord rejected the Application ID. Set a valid custom ID in Advanced.';
  }
  if (message.includes('connection closed') || message.includes('could not find endpoint')) {
    return 'Discord closed the connection. Check that activity sharing is enabled in Discord.';
  }
  return 'Could not connect to Discord. Make sure Discord is running.';
}

class DiscordPresence {
  constructor(onStatus) {
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.client = null;
    this.state = null;
    this.lastSignature = null;
    this.retryTimer = null;
    this.enabled = false;
    this.useCustom = false;
    this.customClientId = '';
    this.clientId = DEFAULT_CLIENT_ID;
    this.connected = false;
    this.starting = false;
    this.username = '';
    this.error = '';
    this.destroyed = false;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      configured: isValidClientId(this.clientId),
      connected: this.connected,
      connecting: this.starting,
      usingDefault: this.clientId === DEFAULT_CLIENT_ID,
      username: this.username,
      error: this.error
    };
  }

  emitStatus() {
    try {
      this.onStatus(this.getStatus());
    } catch (error) {
      console.error('[discord] Status callback failed:', error.message);
    }
  }

  configure(options = {}) {
    const nextEnabled = Boolean(options.enabled);
    const nextUseCustom = Boolean(options.useCustom);
    const nextClientId = String(options.clientId || '').trim();
    const nextEffectiveId = resolveClientId(options);
    const changed = nextEnabled !== this.enabled
      || nextUseCustom !== this.useCustom
      || nextClientId !== this.customClientId
      || nextEffectiveId !== this.clientId;

    this.enabled = nextEnabled;
    this.useCustom = nextUseCustom;
    this.customClientId = nextClientId;
    this.clientId = nextEffectiveId;

    if (!changed) {
      this.emitStatus();
      return;
    }

    this.stop({ keepSettings: true });
    if (this.enabled) this.start();
    else {
      this.error = '';
      this.emitStatus();
    }
  }

  start() {
    if (this.destroyed || this.starting || this.connected) return;
    if (!this.enabled) {
      this.error = '';
      this.emitStatus();
      return;
    }
    if (!isValidClientId(this.clientId)) {
      this.error = 'Add a Discord Application ID in Settings.';
      this.emitStatus();
      return;
    }

    this.clearRetry();
    this.starting = true;
    this.error = '';
    this.emitStatus();

    const client = new RPC.Client({ transport: 'ipc' });
    this.client = client;

    const fail = (message) => {
      if (this.client !== client) return;
      this.client = null;
      this.connected = false;
      this.starting = false;
      this.username = '';
      this.error = message;
      this.emitStatus();
      try {
        client.destroy();
      } catch {
        // Ignore cleanup errors.
      }
      this.scheduleRetry();
    };

    client.on('ready', () => {
      if (this.client !== client) return;
      this.connected = true;
      this.starting = false;
      this.error = '';
      this.username = (client.user && (client.user.global_name || client.user.username)) || '';
      this.lastSignature = null;
      this.emitStatus();
      this.updateActivity();
    });

    client.on('disconnected', () => {
      if (this.client !== client) return;
      this.client = null;
      this.connected = false;
      this.starting = false;
      this.username = '';
      this.error = 'Discord connection closed. Reconnecting…';
      this.lastSignature = null;
      this.emitStatus();
      try {
        client.destroy();
      } catch {
        // Ignore cleanup errors.
      }
      this.scheduleRetry();
    });

    client.on('error', (error) => {
      console.error('[discord] RPC error:', error && error.message ? error.message : error);
    });

    client.login({ clientId: this.clientId }).catch((error) => {
      console.warn('[discord]', error && error.message ? error.message : error);
      fail(friendlyError(error));
    });
  }

  scheduleRetry() {
    this.clearRetry();
    if (!this.enabled || this.destroyed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.enabled && !this.connected && !this.starting && !this.destroyed) {
        this.start();
      }
    }, RETRY_MS);
    if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
  }

  clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  stop(options = {}) {
    this.clearRetry();
    const client = this.client;
    const wasConnected = this.connected;
    this.client = null;
    this.connected = false;
    this.starting = false;
    this.username = '';
    this.lastSignature = null;

    if (client) {
      if (wasConnected) {
        Promise.resolve()
          .then(() => client.clearActivity())
          .catch(() => {})
          .finally(() => {
            try {
              client.destroy();
            } catch {
              // Ignore cleanup errors.
            }
          });
      } else {
        try {
          client.destroy();
        } catch {
          // Ignore cleanup errors.
        }
      }
    }

    if (!options.keepSettings) {
      this.error = '';
      this.emitStatus();
    }
  }

  forceReconnect() {
    if (!this.enabled) {
      this.error = 'Click Connect to Discord first.';
      this.emitStatus();
      return;
    }
    this.stop({ keepSettings: true });
    this.error = '';
    this.start();
  }

  setState(state) {
    this.state = state || null;
    this.updateActivity();
  }

  buildActivity(state) {
    const paused = Boolean(state.paused);
    const artist = truncate(state.artist);
    const activity = {
      type: ACTIVITY_LISTENING,
      details: truncate(state.title),
      state: paused
        ? (artist ? `Paused • ${artist}` : 'Paused')
        : (artist ? `by ${artist}` : 'YouTube Music'),
      instance: false
    };

    if (state.artwork && /^https:\/\//i.test(state.artwork) && state.artwork.length < 300) {
      activity.assets = {
        large_image: state.artwork,
        large_text: truncate(state.album || state.title)
      };
    }

    if (state.videoId && /^[a-zA-Z0-9_-]{6,}$/.test(state.videoId)) {
      activity.buttons = [
        {
          label: 'Listen on YouTube Music',
          url: `https://music.youtube.com/watch?v=${encodeURIComponent(state.videoId)}`
        }
      ];
    }

    const duration = Number(state.duration);
    if (!paused && Number.isFinite(duration) && duration > 0) {
      const currentTime = Math.max(0, Math.min(Number(state.currentTime) || 0, duration));
      const now = Date.now();
      activity.timestamps = {
        start: Math.round(now - currentTime * 1000),
        end: Math.round(now + (duration - currentTime) * 1000)
      };
    }

    return activity;
  }

  updateActivity() {
    if (!this.connected || !this.client) return;

    const state = this.state;
    if (!state || !state.title || state.isAd) {
      if (this.lastSignature !== 'clear') {
        this.lastSignature = 'clear';
        this.client.clearActivity().catch(() => {});
      }
      return;
    }

    const signature = [
      state.title,
      state.artist,
      state.album,
      state.paused ? 'paused' : 'playing',
      state.videoId || '',
      state.artwork || '',
      state.seeked ? 'seek' : ''
    ].join('|');

    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    const activity = this.buildActivity(state);
    try {
      // discord-rpc's setActivity() drops the activity type. Calling the RPC
      // command directly lets Discord show this as "Listening to".
      this.client.request('SET_ACTIVITY', { pid: process.pid, activity }).catch((error) => {
        this.lastSignature = null;
        console.warn('[discord] Could not update activity:', error && error.message ? error.message : error);
      });
    } catch (error) {
      console.warn('[discord] Could not build activity:', error.message);
    }
  }

  destroy() {
    this.destroyed = true;
    this.stop({ keepSettings: true });
    this.client = null;
  }
}

module.exports = {
  DiscordPresence,
  DEFAULT_CLIENT_ID,
  isValidClientId,
  resolveClientId
};

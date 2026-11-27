'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  audioOnly: true,
  blockAds: true,
  skipStillWatching: true,
  playbackSpeed: 1,
  fadeTransitions: false,
  normalizeVolume: false,
  sponsorBlock: {
    enabled: true,
    categories: ['sponsor', 'selfpromo', 'interaction', 'music_offtopic']
  },
  closeToTray: true,
  preventSleep: true,
  lyricsOffset: 0,
  discord: {
    enabled: false,
    useCustom: false,
    clientId: ''
  },
  equalizer: {
    enabled: false,
    preset: 'Flat',
    preamp: 0,
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  window: {
    width: 1280,
    height: 820,
    x: null,
    y: null,
    maximized: false
  }
};

let data = null;
let filePath = null;
let saveTimer = null;
let initialized = false;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitize(input) {
  const merged = deepMerge(DEFAULTS, isPlainObject(input) ? input : {});

  merged.audioOnly = Boolean(merged.audioOnly);
  merged.blockAds = Boolean(merged.blockAds);
  merged.skipStillWatching = Boolean(merged.skipStillWatching);
  merged.playbackSpeed = clampNumber(merged.playbackSpeed, 0.5, 2, 1);
  merged.fadeTransitions = Boolean(merged.fadeTransitions);
  merged.normalizeVolume = Boolean(merged.normalizeVolume);

  const sb = merged.sponsorBlock || {};
  const allowedCategories = [
    'sponsor', 'selfpromo', 'interaction', 'intro', 'outro',
    'preview', 'music_offtopic', 'filler'
  ];
  const categories = Array.isArray(sb.categories)
    ? sb.categories.filter((value) => allowedCategories.includes(value))
    : [];
  merged.sponsorBlock = {
    enabled: Boolean(sb.enabled),
    categories: categories.length
      ? Array.from(new Set(categories))
      : ['sponsor', 'selfpromo', 'interaction', 'music_offtopic']
  };

  merged.closeToTray = Boolean(merged.closeToTray);
  merged.preventSleep = Boolean(merged.preventSleep);
  merged.lyricsOffset = clampNumber(merged.lyricsOffset, -15, 15, 0);

  merged.discord = {
    enabled: Boolean(merged.discord && merged.discord.enabled),
    useCustom: Boolean(merged.discord && merged.discord.useCustom),
    clientId: String((merged.discord && merged.discord.clientId) || '').trim().slice(0, 32)
  };

  const eq = merged.equalizer || {};
  const gains = Array.isArray(eq.gains) ? eq.gains : [];
  merged.equalizer = {
    enabled: Boolean(eq.enabled),
    preset: typeof eq.preset === 'string' && eq.preset ? eq.preset.slice(0, 40) : 'Flat',
    preamp: clampNumber(eq.preamp, -15, 15, 0),
    gains: Array.from({ length: 10 }, (_, i) => clampNumber(gains[i], -15, 15, 0))
  };

  const win = merged.window || {};
  merged.window = {
    width: Math.round(clampNumber(win.width, 960, 5000, DEFAULTS.window.width)),
    height: Math.round(clampNumber(win.height, 620, 3500, DEFAULTS.window.height)),
    x: Number.isFinite(Number(win.x)) ? Math.round(Number(win.x)) : null,
    y: Number.isFinite(Number(win.y)) ? Math.round(Number(win.y)) : null,
    maximized: Boolean(win.maximized)
  };

  return merged;
}

function init() {
  if (initialized) return;
  initialized = true;
  filePath = path.join(app.getPath('userData'), 'config.json');

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    data = sanitize(JSON.parse(raw));
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.error('[config] Could not read config, using defaults:', error.message);
      try {
        fs.renameSync(filePath, `${filePath}.broken-${Date.now()}`);
      } catch {
        // Ignore backup failures.
      }
    }
    data = sanitize(DEFAULTS);
  }
}

function get() {
  if (!data) init();
  return data;
}

function update(patch) {
  if (!data) init();
  data = sanitize(deepMerge(data, patch || {}));
  scheduleSave();
  return data;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!filePath || !data) return;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    console.error('[config] Could not save config:', error.message);
  }
}

function flush() {
  saveNow();
}

module.exports = {
  DEFAULTS,
  init,
  get,
  update,
  flush
};

'use strict';

/* global desktop */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const webview = $('#ytmusic');
const drawer = $('#drawer');
const loading = $('#loading');
const errorPanel = $('#error');
const errorMessage = $('#error-msg');
const progress = $('#progress');
const lyricsScroll = $('#lyrics-scroll');
const lyricsContent = $('#lyrics-content');
const lyricsState = $('#lyrics-state');
const lyricsStateTitle = $('#lyrics-state-title');
const lyricsStateSub = $('#lyrics-state-sub');
const lyricsTitle = $('#lyrics-title');
const lyricsArtist = $('#lyrics-artist');
const lyricsArt = $('#lyrics-art');
const lyricsArtPlaceholder = $('#lyrics-art-placeholder');
const lyricsBadge = $('#lyrics-badge');
const lyricsSource = $('#lyrics-source');
const offsetGroup = $('#offset-group');
const offsetValue = $('#offset-value');
const npTitle = $('#np-title');
const npArtist = $('#np-artist');
const npDot = $('#np-dot');
const nowPlaying = $('#now-playing');
const eqEnabled = $('#eq-enabled');
const eqPreset = $('#eq-preset');
const eqPreamp = $('#eq-preamp');
const eqPreampValue = $('#eq-preamp-value');
const eqBandInputs = $$('input.vertical[data-band]');
const eqBandValues = $$('[data-band-val]');
const discordStatusText = $('#discord-status');
const discordDot = $('#discord-dot');
const discordConnectBtn = $('#btn-discord-connect');
const discordRetryBtn = $('#btn-discord-retry');
const discordCustomInput = $('#set-discord-custom');
const discordIdInput = $('#set-discord-id');
const discordSaveBtn = $('#set-discord-save');
const localPlayer = $('#local-player');
const localAudio = $('#local-audio');
const lpPlay = $('#lp-play');
const lpPlayIcon = $('#lp-play-icon');
const lpSeek = $('#lp-seek');
const lpCurrent = $('#lp-current');
const lpDuration = $('#lp-duration');
const lpTitle = $('#lp-title');
const lpArtist = $('#lp-artist');
const lpArt = $('#lp-art');
const lpArtFallback = $('#lp-art-fallback');
const downloadsList = $('#downloads-list');
const downloadsEmpty = $('#downloads-empty');
const downloadsTool = $('#downloads-tool');
const downloadsToolText = $('#downloads-tool-text');
const downloadsInstallBtn = $('#btn-downloads-install');
const downloadsLastError = $('#downloads-last-error');
const downloadsProgress = $('#downloads-progress');
const downloadsProgressFill = $('#downloads-progress-fill');
const downloadsProgressText = $('#downloads-progress-text');
const downloadsPlaylistBtn = $('#btn-download-playlist');
const downloadMenu = $('#download-menu');
const downloadMenuTrack = $('#menu-download-track');
const downloadMenuPlaylist = $('#menu-download-playlist');
const downloadFormatModal = $('#download-format-modal');
const downloadFormatTitle = $('#download-format-title');
const downloadFormatSub = $('#download-format-sub');
const downloadFormatNote = $('#download-format-note');
const downloadFormatCancel = $('#download-format-cancel');
const updateStatusEl = $('#update-status');
const checkUpdatesBtn = $('#btn-check-updates');
const installUpdateBtn = $('#btn-install-update');

const DEFAULT_SETTINGS = {
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
  discord: { enabled: false, useCustom: false, clientId: '' },
  equalizer: {
    enabled: false,
    preset: 'Flat',
    preamp: 0,
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  }
};

const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass Boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Bass & Treble': [6, 5, 3, 0, 0, 0, 1, 3, 5, 6],
  Vocal: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  Rock: [5, 4, 3, 1, -1, -1, 0, 2, 4, 5],
  Pop: [-1, 0, 2, 4, 4, 2, 0, -1, -1, -1],
  Jazz: [4, 3, 2, 1, 0, 0, 1, 2, 3, 4],
  Classical: [3, 2, 1, 0, 0, 0, -1, -2, -3, -4],
  Electronic: [5, 4, 2, 0, -2, -1, 1, 3, 4, 5],
  'Treble Boost': [0, 0, 0, 0, 0, 1, 3, 5, 6, 7]
};

const AUDIO_ONLY_CSS = `
  ytmusic-menu-service-item-download-renderer,
  ytmusic-menu-navigation-item-renderer[aria-label*="Download" i],
  ytmusic-menu-service-item-renderer[aria-label*="Download" i],
  ytmusic-player-bar [aria-label*="Download" i] {
    display: none !important;
  }
  html.ytm-audio-only #song-video,
  html.ytm-audio-only #song-video video,
  html.ytm-audio-only ytmusic-player #song-video,
  html.ytm-audio-only ytmusic-player-bar #song-video {
    display: none !important;
    visibility: hidden !important;
  }
  html.ytm-audio-only #song-image,
  html.ytm-audio-only ytmusic-player #song-image,
  html.ytm-audio-only ytmusic-player-bar #song-image {
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
  }
  html.ytm-audio-only #song-image img {
    display: block !important;
  }
  html.ytm-audio-only ytmusic-av-toggle {
    display: none !important;
  }
  html.ytm-audio-only ytmusic-player,
  html.ytm-audio-only ytmusic-player-page {
    background-color: #030303 !important;
  }
  html.ytm-audio-only #movie_player video {
    visibility: hidden !important;
  }
  html.ytm-audio-only ytmusic-player-bar [aria-label="Video"],
  html.ytm-audio-only ytmusic-player-bar [aria-label*="video" i] {
    display: none !important;
  }
  html.ytm-audio-only ytmusic-player-bar [aria-label*="caption" i],
  html.ytm-audio-only ytmusic-player-bar [aria-label*="subtitle" i],
  html.ytm-audio-only ytmusic-player-bar [aria-label="CC" i],
  html.ytm-audio-only ytmusic-player-bar [title*="caption" i],
  html.ytm-audio-only ytmusic-player-bar [title*="subtitle" i],
  html.ytm-audio-only ytmusic-player-bar [aria-label*="theater" i] {
    display: none !important;
  }
  html.ytm-block-ads .ytp-ad-module,
  html.ytm-block-ads .ytp-ad-overlay-container,
  html.ytm-block-ads .ytp-ad-image-overlay,
  html.ytm-block-ads .ytp-ad-text-overlay,
  html.ytm-block-ads .ytp-ad-player-overlay,
  html.ytm-block-ads .ytp-ad-progress,
  html.ytm-block-ads .ytp-ad-badge,
  html.ytm-block-ads .ytp-ad-simple-ad-badge,
  html.ytm-block-ads .ytp-ad-duration-remaining,
  html.ytm-block-ads .ytp-ad-info-hover-text-button,
  html.ytm-block-ads .ytp-ad-skip-button-container,
  html.ytm-block-ads .ytp-ad-survey,
  html.ytm-block-ads .ytp-ad-overlay-slot,
  html.ytm-block-ads ytmusic-player-bar .advertisement,
  html.ytm-block-ads ytmusic-player-bar [aria-label*="Sponsored" i],
  html.ytm-block-ads ytmusic-mealbar-promo-renderer,
  html.ytm-block-ads tp-yt-paper-dialog:has(ytmusic-mealbar-promo-renderer),
  html.ytm-block-ads:has(ytmusic-mealbar-promo-renderer) tp-yt-iron-overlay-backdrop {
    display: none !important;
  }
  ::-webkit-scrollbar {
    width: 10px !important;
    height: 10px !important;
  }
  ::-webkit-scrollbar-track {
    background: #030303 !important;
  }
  ::-webkit-scrollbar-thumb {
    background: #3a3a3a !important;
    border: 2px solid #030303 !important;
    border-radius: 8px !important;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: #555555 !important;
  }
`;

const PLAYER_STATE_JS = `
  (() => {
    try {
      const bar = document.querySelector('ytmusic-player-bar');
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      const titleEl = bar && bar.querySelector('yt-formatted-string.title');
      const byline = bar && bar.querySelector('.byline');
      let title = (md && md.title) || (titleEl && titleEl.textContent) || '';
      let artist = (md && md.artist) || '';
      let album = (md && md.album) || '';
      let artwork = '';

      if (md && md.artwork && md.artwork.length) {
        artwork = md.artwork[md.artwork.length - 1].src || '';
      }

      if (byline) {
        const links = Array.from(byline.querySelectorAll('a'))
          .map((link) => (link.textContent || '').trim())
          .filter(Boolean);
        if (!artist && links.length) artist = links[0];
        if (!album && links.length > 1) album = links[1];
        if (!artist) {
          const text = (byline.textContent || '').replace(/\\s+/g, ' ').trim();
          artist = text.split('•')[0].trim();
        }
      }

      const videos = Array.from(document.querySelectorAll('video'));
      const video = videos.find((item) => !item.paused && Number.isFinite(item.duration) && item.duration > 0)
        || videos.find((item) => Number.isFinite(item.duration) && item.duration > 0)
        || videos[0]
        || null;

      let videoId = '';
      try {
        const url = new URL(location.href);
        videoId = url.searchParams.get('v') || '';
      } catch (error) {}

      if (!videoId && bar) {
        const link = bar.querySelector('a[href*="watch?v="]');
        if (link) {
          try {
            videoId = new URL(link.href).searchParams.get('v') || '';
          } catch (error) {}
        }
      }

      if (!artwork) {
        const image = bar && bar.querySelector('#song-image img');
        if (image) artwork = image.currentSrc || image.src || '';
      }

      const player = document.querySelector('#movie_player');
      const isAd = Boolean(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));

      return {
        title: (title || '').trim(),
        artist: (artist || '').trim(),
        album: (album || '').trim(),
        artwork: artwork || '',
        currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration: video && Number.isFinite(video.duration) ? video.duration : 0,
        paused: video ? Boolean(video.paused) : true,
        videoId,
        url: location.href,
        isAd
      };
    } catch (error) {
      return { error: String(error) };
    }
  })()
`;

const PLAYLIST_STATE_JS = `
  (() => {
    try {
      const textOf = (value) => {
        if (!value) return '';
        if (typeof value === 'string') return value.trim();
        if (value.simpleText) return String(value.simpleText).trim();
        if (Array.isArray(value.runs)) return value.runs.map((run) => run.text || '').join('').trim();
        return '';
      };
      const durationOf = (value) => {
        const text = textOf(value);
        if (!text) return 0;
        const parts = text.split(':').map((part) => Number(part) || 0);
        return parts.reduce((total, part) => total * 60 + part, 0);
      };
      const thumbnailOf = (data) => {
        const thumbnails = data && data.thumbnail && data.thumbnail.thumbnails;
        if (!Array.isArray(thumbnails) || !thumbnails.length) return '';
        return thumbnails[thumbnails.length - 1].url || '';
      };
      const cleanArtist = (value) => textOf(value).split('•')[0].replace(/\\s+/g, ' ').trim();
      const items = [];
      const seen = new Set();
      const add = (meta) => {
        const videoId = String((meta && meta.videoId) || '').trim();
        if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId) || seen.has(videoId)) return;
        seen.add(videoId);
        items.push({
          videoId,
          title: String((meta && meta.title) || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
          artist: String((meta && meta.artist) || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
          album: '',
          artwork: String((meta && meta.artwork) || '').slice(0, 1000),
          duration: Number(meta && meta.duration) || 0
        });
      };

      let playlistId = '';
      try {
        playlistId = new URL(location.href).searchParams.get('list') || '';
      } catch (error) {}
      if (!playlistId) {
        try {
          const player = document.querySelector('#movie_player');
          playlistId = (player && player.getPlaylistId && player.getPlaylistId()) || '';
        } catch (error) {}
      }

      const header = document.querySelector('ytmusic-responsive-header-renderer, ytmusic-detail-header-renderer');
      const heading = header
        ? (header.querySelector('h1, yt-formatted-string.title') || document.querySelector('ytmusic-header-renderer h1'))
        : document.querySelector('ytmusic-header-renderer h1');
      const title = heading ? (heading.textContent || '').replace(/\\s+/g, ' ').trim() : '';

      let headerArtists = [];
      let headerArtwork = '';
      if (header) {
        headerArtists = Array.from(header.querySelectorAll('a[href*="channel/"], a[href*="browse/"]'))
          .map((link) => (link.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean);
        headerArtists = Array.from(new Set(headerArtists));
        const headerImage = header.querySelector('img');
        if (headerImage) headerArtwork = headerImage.currentSrc || headerImage.src || '';
      }
      const headerArtist = headerArtists.join(' & ');

      let pagePath = '';
      try {
        pagePath = new URL(location.href).pathname;
      } catch (error) {}

      const shelfSelectors = ['ytmusic-playlist-shelf-renderer'];
      if (pagePath === '/playlist') {
        shelfSelectors.push('ytmusic-section-list-renderer ytmusic-shelf-renderer');
      }

      for (const selector of shelfSelectors) {
        for (const shelf of Array.from(document.querySelectorAll(selector))) {
          for (const element of Array.from(shelf.querySelectorAll(
            'ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer'
          ))) {
            const data = element.data;
            if (!data) continue;
            const videoId = (data.playlistItemData && data.playlistItemData.videoId)
              || data.videoId
              || '';
            if (!videoId) continue;
            const flex = Array.isArray(data.flexColumns) ? data.flexColumns : [];
            const flexText = (index) => {
              const column = flex[index] && flex[index].musicResponsiveListItemFlexColumnRenderer;
              return column && column.text ? textOf(column.text) : '';
            };
            const fixed = Array.isArray(data.fixedColumns) ? data.fixedColumns : [];
            const durationColumn = fixed[0] && fixed[0].musicResponsiveListItemFixedColumnRenderer;
            const image = element.querySelector('img');
            add({
              videoId,
              title: flexText(0),
              artist: cleanArtist(flexText(1)) || headerArtist,
              artwork: thumbnailOf(data)
                || (image ? (image.currentSrc || image.src || '') : '')
                || headerArtwork,
              duration: durationOf(durationColumn && durationColumn.text)
            });
          }
          if (items.length) break;
        }
        if (items.length) break;
      }

      const source = items.length ? 'playlist' : 'queue';
      if (!items.length) {
        for (const element of Array.from(document.querySelectorAll('ytmusic-player-queue-item'))) {
          const data = element.data;
          if (!data) continue;
          add({
            videoId: data.videoId,
            title: textOf(data.title),
            artist: cleanArtist(data.longBylineText) || cleanArtist(data.shortBylineText),
            artwork: thumbnailOf(data),
            duration: durationOf(data.lengthText)
          });
        }
      }

      return {
        url: location.href,
        playlistId,
        title: title || (source === 'queue' ? 'Current queue' : 'Current playlist'),
        source,
        items: items.slice(0, 500)
      };
    } catch (error) {
      return { error: String(error) };
    }
  })()
`;

const ENFORCE_AUDIO_ONLY_JS = `
  (() => {
    if (!document.documentElement.classList.contains('ytm-audio-only')) return false;
    const toggle = document.querySelector('ytmusic-av-toggle');
    if (!toggle) return false;
    if (toggle.getAttribute('is-audio-playback-mode-selected') === 'true') return true;
    const button = toggle.querySelector('button.song-button');
    if (!button || button.getAttribute('aria-pressed') === 'true') return true;
    const now = Date.now();
    if (window.__ytmAudioOnlyClickAt && now - window.__ytmAudioOnlyClickAt < 5000) return false;
    window.__ytmAudioOnlyClickAt = now;
    button.click();
    return true;
  })()
`;

const SKIP_AD_JS = `
  (() => {
    if (!document.documentElement.classList.contains('ytm-block-ads')) return false;
    const player = document.querySelector('#movie_player');
    if (!player) return false;
    const adShowing = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
    const video = player.querySelector('video');

    if (!adShowing) {
      if (video && window.__ytmAdMuted) {
        try { video.muted = Boolean(window.__ytmAdWasMuted); } catch (error) {}
      }
      if (video && window.__ytmAdRate) {
        try { video.playbackRate = Number(window.__ytmAdPrevRate) || 1; } catch (error) {}
      }
      window.__ytmAdMuted = false;
      window.__ytmAdWasMuted = false;
      window.__ytmAdRate = false;
      window.__ytmAdPrevRate = null;
      return false;
    }

    const selectors = [
      '.ytp-ad-skip-button',
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button-modern',
      '.ytp-ad-skip-button-container button',
      'button[aria-label*="Skip" i]',
      'button[title*="Skip" i]'
    ];
    for (const selector of selectors) {
      const button = player.querySelector(selector);
      if (button && button.getClientRects().length) {
        button.click();
        console.log('[YTMD] ad-skip button');
        return 'button';
      }
    }

    try {
      if (typeof player.skipAd === 'function') {
        player.skipAd();
        console.log('[YTMD] ad-skip api');
        return 'api';
      }
    } catch (error) {}

    if (video) {
      try {
        if (!window.__ytmAdMuted) {
          window.__ytmAdWasMuted = Boolean(video.muted);
          window.__ytmAdMuted = true;
        }
        video.muted = true;
      } catch (error) {}
      try {
        if (!window.__ytmAdRate) {
          window.__ytmAdPrevRate = video.playbackRate;
          window.__ytmAdRate = true;
        }
        video.playbackRate = 16;
      } catch (error) {}
      if (Number.isFinite(video.duration) && video.duration > 0) {
        try {
          video.currentTime = Math.max(0, video.duration - 0.1);
          console.log('[YTMD] ad-skip seek');
          return 'seek';
        } catch (error) {}
      }
    }

    return false;
  })()
`;

const DISMISS_PROMO_JS = `
  (() => {
    if (!document.documentElement.classList.contains('ytm-block-ads')) return false;
    const promo = document.querySelector('ytmusic-mealbar-promo-renderer');
    if (!promo) return false;
    if (promo.dataset.ytmdDismissed === '1') return false;
    promo.dataset.ytmdDismissed = '1';
    promo.style.display = 'none';
    const dialog = promo.closest('tp-yt-paper-dialog');
    if (dialog) dialog.style.display = 'none';
    const buttons = Array.from(promo.querySelectorAll('button, tp-yt-paper-button, yt-button-renderer'));
    const dismiss = buttons.find((button) => {
      const text = ((button.textContent || '') + ' '
        + (button.getAttribute('aria-label') || '') + ' '
        + (button.getAttribute('title') || '')).toLowerCase();
      return /no thanks|not now|dismiss|later|close/.test(text);
    });
    if (dismiss) {
      dismiss.click();
      console.log('[YTMD] promo dismissed');
      return true;
    }
    promo.style.display = 'none';
    return true;
  })()
`;

const STILL_WATCHING_JS = `
  (() => {
    if (!document.documentElement.classList.contains('ytm-skip-still-watching')) return false;

    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return element.getClientRects().length > 0;
    };

    const textOf = (element) => (
      ((element && (element.innerText || element.textContent)) || '') + ' '
      + ((element && element.getAttribute && (element.getAttribute('aria-label') || element.getAttribute('title'))) || '')
    ).toLowerCase();

    const looksLikeStillWatching = (element) => {
      if (!element) return false;
      const tag = String(element.tagName || '').toUpperCase();
      if (tag === 'YTMUSIC-YOU-THERE-RENDERER') return true;
      return /still watching|still listening|video paused|continue watching|are you still/.test(textOf(element));
    };

    const confirmOn = (root) => {
      if (!root) return false;
      const direct = [
        root.querySelector('#confirm-button button'),
        root.querySelector('#confirm-button'),
        root.querySelector('yt-button-renderer[dialog-confirm] button'),
        root.querySelector('yt-button-renderer[dialog-confirm]')
      ];
      for (const element of direct) {
        if (element && isVisible(element)) {
          element.click();
          return true;
        }
      }

      const buttons = Array.from(root.querySelectorAll('button, tp-yt-paper-button, a, yt-button-renderer'));
      const confirm = buttons.find((element) => isVisible(element)
        && /continue watching|keep watching|yes|i'm still|still watching|im still/.test(textOf(element)));
      if (confirm) {
        const target = String(confirm.tagName || '').toUpperCase() === 'YT-BUTTON-RENDERER'
          ? (confirm.querySelector('button') || confirm)
          : confirm;
        target.click();
        return true;
      }
      return false;
    };

    const isDialogVisible = (element) => {
      if (isVisible(element)) return true;
      const dialog = element.closest && element.closest('tp-yt-paper-dialog');
      return Boolean(dialog && isVisible(dialog));
    };

    const roots = Array.from(document.querySelectorAll(
      'ytmusic-you-there-renderer, yt-confirm-dialog-renderer, ytmusic-confirm-dialog-renderer'
    )).filter((element) => isDialogVisible(element) && looksLikeStillWatching(element));

    if (!roots.length) {
      const dialogs = Array.from(document.querySelectorAll('tp-yt-paper-dialog'))
        .filter((element) => isVisible(element) && looksLikeStillWatching(element));
      roots.push(...dialogs);
    }

    let handled = false;
    for (const root of roots) {
      const dialog = root.closest('tp-yt-paper-dialog') || root;
      const clicked = confirmOn(dialog);

      if (!clicked) {
        // If the expected button could not be found, hide the prompt so playback
        // is not blocked by an unclickable overlay.
        root.style.display = 'none';
        const backdrop = dialog.querySelector('tp-yt-iron-overlay-backdrop');
        if (backdrop) backdrop.style.display = 'none';
      }

      // YouTube pauses playback when this prompt appears; resume it.
      const video = document.querySelector('#movie_player video') || document.querySelector('video');
      if (video && video.paused) {
        try { video.play(); } catch (error) {}
      }

      console.log('[YTMD] still-watching prompt dismissed');
      handled = true;
    }

    return handled;
  })()
`;

const PLAYBACK_EXTRAS_JS = (speed, fade) => `
  (() => {
    const rate = ${Number(speed) || 1};
    document.documentElement.classList.toggle('ytm-fade-audio', ${Boolean(fade)});
    window.__ytmPlayback = { speed: rate };
    const videos = Array.from(document.querySelectorAll('video'));
    for (const video of videos) {
      try {
        video.preservesPitch = true;
        if (Math.abs((video.playbackRate || 1) - rate) > 0.001) {
          video.playbackRate = rate;
        }
      } catch (error) {}
    }
    return true;
  })()
`;

const SPONSOR_SKIP_JS = (segments) => `
  (() => {
    if (!document.documentElement.classList.contains('ytm-sponsorblock')) return false;
    const segments = ${JSON.stringify(segments || [])};
    if (!segments.length) return false;

    const player = document.querySelector('#movie_player');
    if (player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))) {
      return false;
    }

    const video = document.querySelector('#movie_player video') || document.querySelector('video');
    if (!video || !Number.isFinite(video.currentTime)) return false;

    const time = video.currentTime;
    const active = segments.find((segment) => (
      time >= segment.start - 0.75 && time < segment.end - 0.3
    ));
    if (!active) return false;

    video.currentTime = active.end + 0.15;
    console.log('[YTMD] sponsorblock skipped', active.category);
    return active.category;
  })()
`;

const EQ_SETUP_JS = `
  (() => {
    if (window.__ytmEq && window.__ytmEq.version === 2) {
      try { window.__ytmEq.resume(); } catch (error) {}
      return true;
    }

    try {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return false;

      const ctx = new AudioCtor({ latencyHint: 'playback' });
      const preamp = ctx.createGain();
      const fadeGain = ctx.createGain();
      const normalizeGain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;

      const frequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
      const bands = frequencies.map((frequency) => {
        const filter = ctx.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = frequency;
        filter.Q.value = 1.1;
        filter.gain.value = 0;
        return filter;
      });

      preamp.connect(bands[0]);
      for (let index = 0; index < bands.length - 1; index += 1) {
        bands[index].connect(bands[index + 1]);
      }
      bands[bands.length - 1].connect(fadeGain);
      fadeGain.connect(normalizeGain);
      normalizeGain.connect(analyser);
      analyser.connect(ctx.destination);

      const options = { normalize: false, fade: false };
      const connected = new WeakSet();
      const playingElements = new Set();

      const rampFade = (value, duration) => {
        const now = ctx.currentTime;
        const current = fadeGain.gain.value;
        try {
          fadeGain.gain.cancelScheduledValues(now);
          fadeGain.gain.setValueAtTime(current, now);
          fadeGain.gain.linearRampToValueAtTime(value, now + Math.max(0.02, duration));
        } catch (error) {
          fadeGain.gain.value = value;
        }
      };

      const connect = (element) => {
        if (!element || connected.has(element)) return;
        try {
          const source = ctx.createMediaElementSource(element);
          source.connect(preamp);
          connected.add(element);

          element.addEventListener('play', () => {
            playingElements.add(element);
            if (options.fade) {
              fadeGain.gain.cancelScheduledValues(ctx.currentTime);
              fadeGain.gain.setValueAtTime(0.0001, ctx.currentTime);
              rampFade(1, 0.5);
            } else {
              fadeGain.gain.value = 1;
            }
          });
          element.addEventListener('pause', () => {
            playingElements.delete(element);
            if (options.fade) rampFade(0, 0.22);
            else fadeGain.gain.value = 1;
          });
          element.addEventListener('ended', () => {
            playingElements.delete(element);
            if (options.fade) rampFade(0, 0.2);
          });
          element.addEventListener('timeupdate', () => {
            if (!options.fade || element.paused) return;
            const remaining = element.duration - element.currentTime;
            if (Number.isFinite(remaining) && remaining > 0 && remaining < 0.65) {
              fadeGain.gain.cancelScheduledValues(ctx.currentTime);
              fadeGain.gain.setValueAtTime(fadeGain.gain.value, ctx.currentTime);
              fadeGain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + Math.max(0.12, remaining));
            }
          });
          if (!element.paused) playingElements.add(element);
        } catch (error) {}
      };

      const scan = () => {
        document.querySelectorAll('video, audio').forEach(connect);
      };

      const buffer = new Float32Array(analyser.fftSize);
      setInterval(() => {
        if (!options.normalize) {
          normalizeGain.gain.value += (1 - normalizeGain.gain.value) * 0.25;
          return;
        }
        if (!playingElements.size) return;
        try {
          analyser.getFloatTimeDomainData(buffer);
          let sum = 0;
          for (let index = 0; index < buffer.length; index += 1) {
            sum += buffer[index] * buffer[index];
          }
          const rms = Math.sqrt(sum / buffer.length);
          if (rms < 0.0008) return;
          const desired = Math.max(0.25, Math.min(3, 0.09 / rms));
          normalizeGain.gain.value += (desired - normalizeGain.gain.value) * 0.12;
        } catch (error) {}
      }, 250);

      scan();
      let scanTimer = null;
      const queueScan = () => {
        if (scanTimer) return;
        scanTimer = setTimeout(() => {
          scanTimer = null;
          scan();
        }, 250);
      };
      const observer = new MutationObserver(queueScan);
      observer.observe(document.documentElement, { childList: true, subtree: true });

      const resume = () => {
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
      };

      document.addEventListener('pointerdown', resume, { passive: true });
      document.addEventListener('keydown', resume, { passive: true });

      window.__ytmEq = {
        version: 2,
        ctx,
        preamp,
        bands,
        fadeGain,
        normalizeGain,
        scan,
        resume,
        setOptions(next) {
          const value = next || {};
          options.normalize = Boolean(value.normalize);
          options.fade = Boolean(value.fade);
          if (!options.fade) fadeGain.gain.value = 1;
          if (!options.normalize) normalizeGain.gain.value = 1;
          return true;
        },
        apply(settings) {
          try {
            const gains = settings && Array.isArray(settings.gains) ? settings.gains : [];
            const enabled = Boolean(settings && settings.enabled);
            const pre = Number(settings && settings.preamp);
            preamp.gain.value = enabled && Number.isFinite(pre)
              ? Math.pow(10, Math.max(-15, Math.min(15, pre)) / 20)
              : 1;
            bands.forEach((band, index) => {
              const value = Number(gains[index]);
              band.gain.value = enabled && Number.isFinite(value)
                ? Math.max(-15, Math.min(15, value))
                : 0;
            });
            window.__ytmEq.setOptions({
              normalize: Boolean(settings && settings.normalize),
              fade: Boolean(settings && settings.fade)
            });
            resume();
            return true;
          } catch (error) {
            return false;
          }
        }
      };

      resume();
      return true;
    } catch (error) {
      return false;
    }
  })()
`;

const state = {
  settings: null,
  eq: {
    enabled: false,
    preset: 'Flat',
    preamp: 0,
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  drawer: null,
  guestReady: false,
  hasLoadedOnce: false,
  polling: false,
  pollCooldownUntil: 0,
  pollFailures: 0,
  pollTimer: null,
  wasAd: false,
  trackKey: '',
  lastSentSignature: null,
  player: emptyPlayer(),
  lyrics: {
    key: '',
    status: 'idle',
    mode: null,
    lines: [],
    plain: '',
    activeIndex: -1,
    error: '',
    requestId: 0
  },
  autoScrolling: false,
  autoScrollTimer: null,
  userScrolledUntil: 0,
  lyricsFetchTimer: null,
  appInfo: null,
  discordStatus: null,
  discordBusy: false,
  cssKey: null,
  eqSetupPromise: null,
  eqSaveTimer: null,
  offsetSaveTimer: null,
  sponsor: {
    videoId: '',
    key: '',
    segments: [],
    fetching: false
  },
  playback: {
    speed: 1,
    fade: false,
    normalize: false
  },
  downloads: {
    status: null,
    items: [],
    activeId: null,
    percent: 0,
    phase: '',
    toolPercent: 0,
    batch: null,
    lastFormat: 'mp3'
  },
  local: {
    item: null,
    playing: false,
    seeking: false,
    startedAt: 0
  },
  updateStatus: null,
  downloadsLoaded: false,
  startupTimer: null,
  wakeTimer: null,
  recoveryTimer: null
};

function emptyPlayer() {
  return {
    title: '',
    artist: '',
    album: '',
    artwork: '',
    currentTime: 0,
    duration: 0,
    paused: true,
    videoId: '',
    url: '',
    isAd: false
  };
}

function isMusicUrl(url) {
  try {
    return new URL(url).hostname === 'music.youtube.com';
  } catch (error) {
    return false;
  }
}

function isAuthUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'accounts.google.com'
      || host.startsWith('accounts.google.')
      || host === 'accounts.youtube.com'
      || host === 'consent.youtube.com'
    );
  } catch (error) {
    return false;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function formatDb(value) {
  const number = Number(value) || 0;
  if (number === 0) return '0';
  return `${number > 0 ? '+' : ''}${number.toFixed(1).replace(/\.0$/, '')}`;
}

function formatDbDecimal(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? '+' : ''}${number.toFixed(1)} dB`;
}

function formatOffset(value) {
  const number = Number(value) || 0;
  if (number === 0) return '0.0s';
  return `${number > 0 ? '+' : ''}${number.toFixed(1)}s`;
}

function toast(message, duration = 3200) {
  const container = $('#toasts');
  if (!container) return;
  while (container.children.length >= 3) {
    container.firstElementChild.remove();
  }
  const element = document.createElement('div');
  element.className = 'toast';
  element.textContent = message;
  container.appendChild(element);
  setTimeout(() => {
    element.classList.add('leaving');
    setTimeout(() => element.remove(), 220);
  }, duration);
}

async function init() {
  bindWindowControls();
  bindDrawer();
  bindLyricsControls();
  bindEqControls();
  bindSettingsControls();
  bindWebviewEvents();
  bindCommands();
  bindKeyboard();
  bindDiscordStatus();
  bindAuthStatus();
  bindLifecycleEvents();
  bindDownloads();
  bindUpdater();
  startHeartbeat();

  renderLyrics();
  updateNowPlaying(state.player);

  await loadSettings();
  loadAppInfo();
  loadDiscordStatus();
  loadDownloads(true);
  loadUpdaterStatus();

  startWebview();
  startPolling();
}

/* ---------- Lifecycle / recovery ---------- */

function startHeartbeat() {
  const beat = () => {
    try {
      if (typeof desktop.heartbeat === 'function') desktop.heartbeat();
    } catch (error) {
      // The main process may be shutting down.
    }
  };
  beat();
  setInterval(beat, 10000);
}

function wakeUpPlayer() {
  try {
    if (typeof desktop.heartbeat === 'function') desktop.heartbeat();
  } catch (error) {}

  if (state.guestReady) applyEq();

  clearTimeout(state.wakeTimer);
  state.wakeTimer = setTimeout(() => {
    state.wakeTimer = null;
    try {
      webview.executeJavaScript('window.dispatchEvent(new Event("resize"));', false).catch(() => {});
    } catch (error) {}
    pollPlayer();
  }, 250);
}

function bindLifecycleEvents() {
  if (typeof desktop.onGuestCrashed === 'function') {
    desktop.onGuestCrashed((details) => {
      state.guestReady = false;
      state.polling = false;
      state.pollFailures = 0;
      state.pollCooldownUntil = Date.now() + 4000;
      clearTimeout(state.startupTimer);
      state.startupTimer = null;
      clearTimeout(state.recoveryTimer);
      state.recoveryTimer = null;

      if (details && details.recovering) {
        showLoading();
        const subtitle = document.querySelector('#loading .loading-sub');
        if (subtitle) subtitle.textContent = 'The player stopped responding. Recovering it…';
        toast('The YouTube Music player stopped responding. Reloading it…', 6000);

        state.recoveryTimer = setTimeout(() => {
          state.recoveryTimer = null;
          if (!state.guestReady) {
            showError('The YouTube Music player could not be reloaded. Try reloading it.');
          }
        }, 25000);
      } else {
        showError('The YouTube Music page crashed. Try reloading it.');
      }
    });
  }

  if (typeof desktop.onWindowResume === 'function') {
    desktop.onWindowResume(() => wakeUpPlayer());
  }

  window.addEventListener('focus', wakeUpPlayer);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) wakeUpPlayer();
  });
}

async function loadSettings() {
  try {
    const settings = await desktop.getSettings();
    state.settings = settings;
  } catch (error) {
    console.error('Could not load settings:', error);
    state.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  state.eq = {
    enabled: Boolean(state.settings.equalizer && state.settings.equalizer.enabled),
    preset: (state.settings.equalizer && state.settings.equalizer.preset) || 'Flat',
    preamp: Number(state.settings.equalizer && state.settings.equalizer.preamp) || 0,
    gains: Array.from({ length: 10 }, (_, index) => {
      const value = state.settings.equalizer && state.settings.equalizer.gains
        ? state.settings.equalizer.gains[index]
        : 0;
      return Number(value) || 0;
    })
  };

  state.lyrics.offset = Number(state.settings.lyricsOffset) || 0;
  state.playback = {
    speed: Number(state.settings.playbackSpeed) || 1,
    fade: Boolean(state.settings.fadeTransitions),
    normalize: Boolean(state.settings.normalizeVolume)
  };
  applySettingsToUI();
  updateOffsetUI();
}

async function loadAppInfo() {
  try {
    const info = await desktop.getAppInfo();
    state.appInfo = info;
    const version = $('#app-version');
    if (version) version.textContent = `v${info.version}`;
    const meta = $('#app-meta');
    if (meta) meta.textContent = `Electron ${info.electron} · Chromium ${info.chrome}`;
  } catch (error) {
    console.error('Could not load app info:', error);
  }
}

async function loadDiscordStatus() {
  try {
    const status = await desktop.discord.getStatus();
    updateDiscordStatus(status);
  } catch (error) {
    console.error('Could not load Discord status:', error);
  }
}

function applySettingsToUI() {
  const settings = state.settings || DEFAULT_SETTINGS;
  const audioOnly = $('#set-audio-only');
  const blockAds = $('#set-block-ads');
  const skipStillWatching = $('#set-skip-still-watching');
  const preventSleep = $('#set-prevent-sleep');
  const closeToTray = $('#set-close-to-tray');

  if (audioOnly) audioOnly.checked = Boolean(settings.audioOnly);
  if (blockAds) blockAds.checked = Boolean(settings.blockAds);
  if (skipStillWatching) skipStillWatching.checked = Boolean(settings.skipStillWatching);
  if (preventSleep) preventSleep.checked = Boolean(settings.preventSleep);
  if (closeToTray) closeToTray.checked = Boolean(settings.closeToTray);

  const speedSelect = $('#set-playback-speed');
  if (speedSelect) speedSelect.value = String(Number(settings.playbackSpeed) || 1);
  const fadeToggle = $('#set-fade-transitions');
  if (fadeToggle) fadeToggle.checked = Boolean(settings.fadeTransitions);
  const normalizeToggle = $('#set-normalize-volume');
  if (normalizeToggle) normalizeToggle.checked = Boolean(settings.normalizeVolume);

  const sponsorToggle = $('#set-sponsorblock');
  if (sponsorToggle) sponsorToggle.checked = Boolean(settings.sponsorBlock && settings.sponsorBlock.enabled);
  const categories = (settings.sponsorBlock && settings.sponsorBlock.categories) || [];
  $$('[data-sb-category]').forEach((input) => {
    input.checked = categories.includes(input.dataset.sbCategory);
  });

  const customDiscordId = Boolean(settings.discord && settings.discord.useCustom);
  if (discordCustomInput) discordCustomInput.checked = customDiscordId;
  if (discordIdInput && document.activeElement !== discordIdInput) {
    discordIdInput.value = (settings.discord && settings.discord.clientId) || '';
  }
  updateDiscordAdvancedUI();

  const closeButton = $('#win-close');
  if (closeButton) {
    closeButton.title = settings.closeToTray ? 'Close to tray' : 'Close';
  }

  updateEqUI();
}

function updateEqUI() {
  if (eqEnabled) eqEnabled.checked = Boolean(state.eq.enabled);
  if (eqPreset) {
    const preset = EQ_PRESETS[state.eq.preset] || state.eq.preset === 'Custom' ? state.eq.preset : 'Custom';
    eqPreset.value = preset;
  }
  eqBandInputs.forEach((input) => {
    const index = Number(input.dataset.band);
    const value = Number(state.eq.gains[index]) || 0;
    input.value = String(value);
    const label = eqBandValues.find((item) => Number(item.dataset.bandVal) === index);
    if (label) label.textContent = formatDb(value);
  });
  if (eqPreamp) eqPreamp.value = String(state.eq.preamp);
  if (eqPreampValue) eqPreampValue.textContent = formatDbDecimal(state.eq.preamp);
}

async function saveSettings(patch) {
  try {
    const next = await desktop.updateSettings(patch);
    if (next) state.settings = next;
    return next;
  } catch (error) {
    console.error('Could not save settings:', error);
    toast('Could not save settings.');
    return null;
  }
}

/* ---------- Window controls ---------- */

function bindWindowControls() {
  $('#win-min').addEventListener('click', () => desktop.window.minimize());
  $('#win-max').addEventListener('click', async () => {
    const maximized = await desktop.window.toggleMaximize();
    updateMaximizeIcon(maximized);
  });
  $('#win-close').addEventListener('click', () => desktop.window.close());

  desktop.window.onState(({ maximized }) => updateMaximizeIcon(maximized));
  desktop.window.isMaximized().then(updateMaximizeIcon).catch(() => {});
}

function updateMaximizeIcon(maximized) {
  const icon = $('#win-max-icon use');
  const button = $('#win-max');
  if (icon) icon.setAttribute('href', maximized ? '#i-restore' : '#i-max');
  if (button) {
    button.title = maximized ? 'Restore' : 'Maximize';
    button.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
  }
}

/* ---------- Drawer ---------- */

function bindDrawer() {
  $$('[data-drawer]').forEach((button) => {
    button.addEventListener('click', () => toggleDrawer(button.dataset.drawer));
  });
  $('#drawer-close').addEventListener('click', closeDrawer);
}

function toggleDrawer(name) {
  if (state.drawer === name) closeDrawer();
  else openDrawer(name);
}

function openDrawer(name) {
  if (!['lyrics', 'eq', 'settings', 'downloads'].includes(name)) return;
  state.drawer = name;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');

  $$('.drawer-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.drawer === name));
  $$('#btn-lyrics, #btn-eq, #btn-settings').forEach((button) => {
    button.classList.toggle('active', button.dataset.drawer === name);
  });
  $$('.drawer-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${name}`));

  if (name === 'lyrics') {
    renderLyrics();
    updateOffsetUI();
    if (state.lyrics.mode === 'synced') {
      updateActiveLine(state.player.currentTime + state.lyrics.offset);
    }
  } else if (name === 'eq') {
    updateEqUI();
    if (state.eq.enabled) ensureEq().then(() => applyEq());
  } else if (name === 'settings') {
    loadDiscordStatus();
    loadUpdaterStatus();
  } else if (name === 'downloads') {
    loadDownloads(true);
  }

  // The guest page sometimes needs a nudge to reflow after the drawer changes width.
  setTimeout(() => {
    try {
      webview.executeJavaScript('window.dispatchEvent(new Event("resize"));').catch(() => {});
    } catch (error) {}
  }, 230);
}

function closeDrawer() {
  state.drawer = null;
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  $$('.drawer-tab').forEach((tab) => tab.classList.remove('active'));
  $$('#btn-lyrics, #btn-eq, #btn-settings').forEach((button) => button.classList.remove('active'));
  $$('.drawer-panel').forEach((panel) => panel.classList.remove('active'));
}

/* ---------- Webview ---------- */

function startWebview() {
  try {
    webview.setAttribute('useragent', desktop.userAgent);
    webview.setAttribute('src', 'https://music.youtube.com/');
    armStartupTimeout();
  } catch (error) {
    showError(error.message || 'Could not start the webview.');
  }
}

function armStartupTimeout() {
  clearTimeout(state.startupTimer);
  state.startupTimer = setTimeout(() => {
    if (!state.hasLoadedOnce) {
      showError('YouTube Music is taking too long to load. Check your internet connection and try again.');
    }
  }, 45000);
}

function bindWebviewEvents() {
  webview.addEventListener('dom-ready', () => {
    state.guestReady = true;
    const url = webview.getURL();
    if (isMusicUrl(url)) {
      injectGuestCss().then(() => {
        applyAudioOnly();
        applyAdBlock();
        applyStillWatchingSkip();
        applySponsorBlock();
        applyPlaybackExtras();
        if (needsAudioGraph()) ensureEq().then(() => applyEq());
      });
    }
  });

  webview.addEventListener('did-start-loading', () => {
    if (state.hasLoadedOnce) {
      progress.classList.add('active');
    } else {
      showLoading();
    }
  });

  webview.addEventListener('did-stop-loading', () => {
    progress.classList.remove('active');
  });

  webview.addEventListener('did-finish-load', () => {
    const url = webview.getURL();
    if (!url || !/^https:\/\//i.test(url)) return;

    clearTimeout(state.recoveryTimer);
    state.recoveryTimer = null;

    if (isAuthUrl(url)) {
      clearTimeout(state.startupTimer);
      state.startupTimer = null;
      state.hasLoadedOnce = true;
      hideLoading();
      hideError();
      webview.classList.add('ready');
      desktop.browserSignIn().catch(() => {});
      toast('Google sign-in needs a real browser. Opening it now…', 7000);
      return;
    }

    clearTimeout(state.startupTimer);
    state.startupTimer = null;
    state.hasLoadedOnce = true;
    hideLoading();
    hideError();
    webview.classList.add('ready');

    if (isMusicUrl(url)) {
      state.pollCooldownUntil = 0;
      state.pollFailures = 0;
      injectGuestCss().then(() => {
        applyAudioOnly();
        applyAdBlock();
        applyStillWatchingSkip();
        applySponsorBlock();
        applyPlaybackExtras();
        if (needsAudioGraph()) ensureEq().then(() => applyEq());
      });
      startPolling();
      setTimeout(pollPlayer, 450);
    }
  });

  webview.addEventListener('did-fail-load', (event) => {
    if (event.errorCode === -3) return;
    if (event.isMainFrame === false) return;
    clearTimeout(state.startupTimer);
    state.startupTimer = null;
    showError(event.errorDescription || 'The page could not be loaded.');
  });

  webview.addEventListener('render-process-gone', () => {
    clearTimeout(state.startupTimer);
    state.startupTimer = null;
    state.guestReady = false;
    state.polling = false;
    state.pollFailures = 0;
    state.pollCooldownUntil = Date.now() + 4000;
    showError('The YouTube Music page crashed. Try reloading it.');
  });

  webview.addEventListener('crashed', () => {
    clearTimeout(state.startupTimer);
    state.startupTimer = null;
    state.guestReady = false;
    state.polling = false;
    state.pollFailures = 0;
    state.pollCooldownUntil = Date.now() + 4000;
    showError('The YouTube Music page crashed. Try reloading it.');
  });

  webview.addEventListener('did-navigate', () => {
    progress.classList.remove('active');
  });
}

function showLoading() {
  loading.classList.remove('hidden');
  errorPanel.classList.remove('visible');
  webview.classList.remove('ready');
}

function hideLoading() {
  loading.classList.add('hidden');
}

function showError(message) {
  errorMessage.textContent = message;
  errorPanel.classList.add('visible');
  loading.classList.add('hidden');
  webview.classList.remove('ready');
  progress.classList.remove('active');
}

function hideError() {
  errorPanel.classList.remove('visible');
}

async function injectGuestCss() {
  try {
    if (state.cssKey) {
      try {
        await webview.removeInsertedCSS(state.cssKey);
      } catch (error) {}
      state.cssKey = null;
    }
    state.cssKey = await webview.insertCSS(AUDIO_ONLY_CSS);
  } catch (error) {
    console.error('Could not inject player styles:', error);
  }
}

function applyAudioOnly() {
  if (!state.guestReady) return;
  const enabled = Boolean(state.settings && state.settings.audioOnly);
  webview.executeJavaScript(
    `document.documentElement.classList.toggle('ytm-audio-only', ${enabled});`,
    false
  ).then(() => {
    if (enabled) enforceAudioOnly();
  }).catch(() => {});
}

function applyAdBlock() {
  if (!state.guestReady) return;
  const enabled = Boolean(state.settings && state.settings.blockAds);
  const script = `(() => {
    document.documentElement.classList.toggle('ytm-block-ads', ${enabled});
    if (!${enabled}) {
      const video = document.querySelector('#movie_player video');
      if (video && window.__ytmAdMuted) {
        try { video.muted = Boolean(window.__ytmAdWasMuted); } catch (error) {}
      }
      if (video && window.__ytmAdRate) {
        try { video.playbackRate = Number(window.__ytmAdPrevRate) || 1; } catch (error) {}
      }
      window.__ytmAdMuted = false;
      window.__ytmAdWasMuted = false;
      window.__ytmAdRate = false;
      window.__ytmAdPrevRate = null;
    }
    return true;
  })()`;
  webview.executeJavaScript(script, false).catch(() => {});
}

function applyStillWatchingSkip() {
  if (!state.guestReady) return;
  const enabled = Boolean(state.settings && state.settings.skipStillWatching);
  const script = `(() => {
    document.documentElement.classList.toggle('ytm-skip-still-watching', ${enabled});
    return true;
  })()`;
  webview.executeJavaScript(script, false)
    .then(() => {
      if (enabled) dismissStillWatching();
    })
    .catch(() => {});
}

function dismissStillWatching() {
  if (!state.guestReady) return;
  if (!state.settings || !state.settings.skipStillWatching) return;
  if (!isMusicUrl(webview.getURL())) return;
  webview.executeJavaScript(STILL_WATCHING_JS, false).catch(() => {});
}

function needsAudioGraph() {
  return Boolean(
    state.eq.enabled
    || (state.playback && state.playback.fade)
    || (state.playback && state.playback.normalize)
  );
}

function applyPlaybackExtras() {
  if (!state.guestReady) return;
  const speed = Number(state.playback && state.playback.speed) || 1;
  const fade = Boolean(state.playback && state.playback.fade);
  webview.executeJavaScript(PLAYBACK_EXTRAS_JS(speed, fade), false).catch(() => {});
}

function sponsorCategories() {
  const sb = state.settings && state.settings.sponsorBlock;
  if (!sb || !Array.isArray(sb.categories) || !sb.categories.length) {
    return ['sponsor', 'selfpromo', 'interaction', 'music_offtopic'];
  }
  return sb.categories.slice();
}

async function refreshSponsorSegments(videoId) {
  if (!videoId) return;
  if (!state.settings || !state.settings.sponsorBlock || !state.settings.sponsorBlock.enabled) {
    state.sponsor.segments = [];
    state.sponsor.key = '';
    return;
  }

  const categories = sponsorCategories();
  const key = `${videoId}|${categories.join(',')}`;
  if (state.sponsor.key === key) return;

  state.sponsor.key = key;
  state.sponsor.videoId = videoId;
  state.sponsor.segments = [];
  state.sponsor.fetching = true;

  try {
    const segments = await desktop.sponsorBlock.getSegments(videoId, categories);
    if (state.sponsor.key === key) {
      state.sponsor.segments = Array.isArray(segments) ? segments : [];
    }
  } catch (error) {
    if (state.sponsor.key === key) {
      state.sponsor.segments = [];
      state.sponsor.key = '';
    }
  } finally {
    if (state.sponsor.key === key) state.sponsor.fetching = false;
  }
}

function applySponsorBlock() {
  if (!state.guestReady) return;
  const sb = state.settings && state.settings.sponsorBlock;
  const enabled = Boolean(sb && sb.enabled);
  webview.executeJavaScript(
    `document.documentElement.classList.toggle('ytm-sponsorblock', ${enabled});`,
    false
  ).then(() => {
    if (!enabled) {
      state.sponsor.segments = [];
      state.sponsor.key = '';
      return;
    }
    if (state.player.videoId) refreshSponsorSegments(state.player.videoId);
  }).catch(() => {});
}

function skipSponsorSegments() {
  if (!state.guestReady) return;
  if (!state.settings || !state.settings.sponsorBlock || !state.settings.sponsorBlock.enabled) return;
  if (!state.sponsor.segments.length) return;
  if (!isMusicUrl(webview.getURL())) return;
  webview.executeJavaScript(SPONSOR_SKIP_JS(state.sponsor.segments), false).catch(() => {});
}

function enforceAudioOnly() {
  if (!state.guestReady) return;
  if (!state.settings || !state.settings.audioOnly) return;
  if (!isMusicUrl(webview.getURL())) return;
  webview.executeJavaScript(ENFORCE_AUDIO_ONLY_JS, false).catch(() => {});
}

function skipAd() {
  if (!state.guestReady) return;
  if (!state.settings || !state.settings.blockAds) return;
  if (!isMusicUrl(webview.getURL())) return;
  webview.executeJavaScript(SKIP_AD_JS, true).catch(() => {});
}

function dismissPromo() {
  if (!state.guestReady) return;
  if (!state.settings || !state.settings.blockAds) return;
  if (!isMusicUrl(webview.getURL())) return;
  webview.executeJavaScript(DISMISS_PROMO_JS, false).catch(() => {});
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(pollPlayer, 750);
  setInterval(enforceAudioOnly, 4000);
  setInterval(dismissPromo, 3000);
  setInterval(dismissStillWatching, 3000);
  setInterval(applyPlaybackExtras, 4000);
}

async function pollPlayer() {
  if (!state.guestReady || state.polling) return;
  if (state.pollCooldownUntil && Date.now() < state.pollCooldownUntil) return;
  const url = webview.getURL();
  if (!isMusicUrl(url)) return;

  state.polling = true;
  let timeoutId = null;
  try {
    const player = await Promise.race([
      webview.executeJavaScript(PLAYER_STATE_JS, false),
      new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Player state probe timed out.')), 5000);
      })
    ]);
    state.pollCooldownUntil = 0;
    state.pollFailures = 0;
    if (player && !player.error) {
      handlePlayerState(player);
      skipSponsorSegments();
    }
  } catch (error) {
    // The page may be navigating or its renderer may be stuck. Back off so we
    // do not queue more scripts; the main process watchdog will reload the
    // player if it stays unresponsive.
    state.pollCooldownUntil = Date.now() + 3000;
    state.pollFailures += 1;
    if (state.pollFailures >= 3) {
      state.pollFailures = 0;
      try {
        if (typeof desktop.reportPlayerStalled === 'function') desktop.reportPlayerStalled();
      } catch (reportError) {}
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    state.polling = false;
  }
}

function handlePlayerState(raw) {
  const player = {
    title: String(raw.title || '').replace(/\s+/g, ' ').trim(),
    artist: String(raw.artist || '').replace(/\s+/g, ' ').trim(),
    album: String(raw.album || '').replace(/\s+/g, ' ').trim(),
    artwork: String(raw.artwork || '').trim(),
    currentTime: Number(raw.currentTime) || 0,
    duration: Number(raw.duration) || 0,
    paused: Boolean(raw.paused),
    videoId: String(raw.videoId || '').trim(),
    url: String(raw.url || '').trim(),
    isAd: Boolean(raw.isAd)
  };

  if (!player.title && !player.videoId) {
    player.title = '';
  }

  const previousTime = state.player.currentTime;
  const seeked = Math.abs(player.currentTime - previousTime) > 3;
  state.player = player;

  if (player.videoId && player.videoId !== state.sponsor.videoId) {
    state.sponsor.videoId = player.videoId;
    state.sponsor.key = '';
    state.sponsor.segments = [];
    refreshSponsorSegments(player.videoId);
  }

  if (state.local.item && !player.isAd && !player.paused
    && Date.now() - (state.local.startedAt || 0) > 1500) {
    stopLocalPlayback();
  }

  if (player.isAd) {
    state.wasAd = true;
    skipAd();
  } else if (state.wasAd) {
    state.wasAd = false;
    skipAd();
  }

  const signature = [
    player.title,
    player.artist,
    player.videoId,
    player.paused ? 'paused' : 'playing',
    player.isAd ? 'ad' : 'content'
  ].join('|');

  if (signature !== state.lastSentSignature || seeked) {
    state.lastSentSignature = signature;
    desktop.sendPlayerState({ ...player, seeked });
  }

  if (player.isAd) {
    clearTimeout(state.lyricsFetchTimer);
    state.lyricsFetchTimer = null;
    const adKey = `ad:${player.title}`;
    if (state.trackKey !== adKey) {
      state.trackKey = adKey;
      state.lyrics = {
        ...state.lyrics,
        status: 'ad',
        mode: null,
        lines: [],
        plain: '',
        activeIndex: -1,
        error: '',
        key: adKey
      };
      renderLyrics();
    }
    updateNowPlaying({ ...player, title: 'Advertisement', artist: player.artist || 'YouTube Music' });
    return;
  }

  updateNowPlaying(player);

  if (!player.title) {
    clearTimeout(state.lyricsFetchTimer);
    state.lyricsFetchTimer = null;
    if (state.trackKey) {
      state.trackKey = '';
      state.lyrics = {
        ...state.lyrics,
        status: 'idle',
        mode: null,
        lines: [],
        plain: '',
        activeIndex: -1,
        error: '',
        key: ''
      };
      renderLyrics();
    }
    return;
  }

  const trackKey = [
    player.title,
    player.artist,
    player.videoId,
    Math.round(player.duration)
  ].join('|');

  if (trackKey !== state.trackKey) {
    state.trackKey = trackKey;
    state.userScrolledUntil = 0;
    state.lyrics = {
      ...state.lyrics,
      status: 'loading',
      mode: null,
      lines: [],
      plain: '',
      activeIndex: -1,
      error: '',
      key: trackKey,
      requestId: state.lyrics.requestId + 1
    };
    renderLyrics();
    lyricsScroll.scrollTop = 0;
    enforceAudioOnly();
    scheduleLyricsFetch();
  } else if (state.lyrics.mode === 'synced' && state.lyrics.lines.length) {
    updateActiveLine(player.currentTime + state.lyrics.offset);
  }
}

function scheduleLyricsFetch() {
  clearTimeout(state.lyricsFetchTimer);
  state.lyricsFetchTimer = setTimeout(() => {
    state.lyricsFetchTimer = null;
    fetchLyricsForCurrentTrack();
  }, 600);
}

function updateNowPlaying(player) {
  const title = player && player.title ? player.title : '';
  const artist = player && player.artist ? player.artist : '';

  if (title) {
    npTitle.textContent = title;
    npArtist.textContent = artist;
    npDot.hidden = !artist;
    nowPlaying.title = artist ? `${title} — ${artist}` : title;
    lyricsTitle.textContent = title;
    lyricsArtist.textContent = artist || 'YouTube Music';
  } else {
    npTitle.textContent = 'YouTube Music';
    npArtist.textContent = '';
    npDot.hidden = true;
    nowPlaying.title = 'YT Music Desktop';
    lyricsTitle.textContent = 'Nothing playing';
    lyricsArtist.textContent = 'Play a song to see lyrics';
  }

  let artwork = player && player.artwork ? player.artwork : '';
  if (!artwork && player && player.videoId) {
    artwork = `https://i.ytimg.com/vi/${encodeURIComponent(player.videoId)}/hqdefault.jpg`;
  }
  setLyricsArtwork(artwork);
}

function setLyricsArtwork(url) {
  if (!url) {
    lyricsArt.hidden = true;
    lyricsArtPlaceholder.hidden = false;
    lyricsArt.removeAttribute('src');
    return;
  }

  if (lyricsArt.getAttribute('src') === url) {
    lyricsArt.hidden = false;
    lyricsArtPlaceholder.hidden = true;
    return;
  }

  lyricsArt.hidden = false;
  lyricsArtPlaceholder.hidden = true;
  lyricsArt.onerror = () => {
    lyricsArt.hidden = true;
    lyricsArtPlaceholder.hidden = false;
    lyricsArt.removeAttribute('src');
  };
  lyricsArt.src = url;
}

/* ---------- Lyrics ---------- */

function bindLyricsControls() {
  $('#offset-minus').addEventListener('click', () => setOffset(state.lyrics.offset - 0.5));
  $('#offset-plus').addEventListener('click', () => setOffset(state.lyrics.offset + 0.5));
  $('#btn-ytm-lyrics').addEventListener('click', openNativeLyrics);
  $('#btn-search-lyrics').addEventListener('click', openSearchLyrics);

  lyricsScroll.addEventListener('scroll', () => {
    if (state.autoScrolling) return;
    state.userScrolledUntil = Date.now() + 5000;
  }, { passive: true });
}

async function fetchLyricsForCurrentTrack(force = false) {
  clearTimeout(state.lyricsFetchTimer);
  state.lyricsFetchTimer = null;

  const player = state.player;
  if (!player.title || player.isAd) {
    state.lyrics = {
      ...state.lyrics,
      status: 'idle',
      mode: null,
      lines: [],
      plain: '',
      activeIndex: -1,
      error: '',
      key: ''
    };
    renderLyrics();
    return;
  }

  const requestId = state.lyrics.requestId + 1;
  const key = state.trackKey;
  state.lyrics = {
    ...state.lyrics,
    status: 'loading',
    mode: null,
    lines: [],
    plain: '',
    activeIndex: -1,
    error: '',
    key,
    requestId
  };
  renderLyrics();
  lyricsScroll.scrollTop = 0;

  let result;
  try {
    result = await desktop.fetchLyrics({
      title: player.title,
      artist: player.artist,
      album: player.album,
      duration: player.duration,
      videoId: player.videoId
    }, { force });
  } catch (error) {
    result = { ok: false, error: error && error.message ? error.message : 'Could not reach LRCLIB.' };
  }

  if (requestId !== state.lyrics.requestId || key !== state.trackKey) return;

  if (!result || !result.ok) {
    state.lyrics = {
      ...state.lyrics,
      status: 'error',
      mode: null,
      lines: [],
      plain: '',
      activeIndex: -1,
      error: (result && result.error) || 'Could not load lyrics.'
    };
    renderLyrics();
    return;
  }

  if (!result.found) {
    state.lyrics = {
      ...state.lyrics,
      status: 'notfound',
      mode: null,
      lines: [],
      plain: '',
      activeIndex: -1,
      error: ''
    };
    renderLyrics();
    return;
  }

  if (result.instrumental) {
    state.lyrics = {
      ...state.lyrics,
      status: 'ready',
      mode: 'instrumental',
      lines: [],
      plain: '',
      activeIndex: -1,
      error: ''
    };
    renderLyrics();
    return;
  }

  if (result.syncedLyrics) {
    const lines = parseLrc(result.syncedLyrics);
    if (lines.length) {
      state.lyrics = {
        ...state.lyrics,
        status: 'ready',
        mode: 'synced',
        lines,
        plain: '',
        activeIndex: -1,
        error: ''
      };
      renderLyrics();
      updateActiveLine(state.player.currentTime + state.lyrics.offset);
      return;
    }
  }

  if (result.plainLyrics) {
    state.lyrics = {
      ...state.lyrics,
      status: 'ready',
      mode: 'plain',
      lines: [],
      plain: result.plainLyrics,
      activeIndex: -1,
      error: ''
    };
    renderLyrics();
    return;
  }

  state.lyrics = {
    ...state.lyrics,
    status: 'notfound',
    mode: null,
    lines: [],
    plain: '',
    activeIndex: -1,
    error: ''
  };
  renderLyrics();
}

function renderLyrics() {
  const lyrics = state.lyrics;
  lyricsContent.replaceChildren();
  lyricsState.classList.add('hidden');

  if (lyrics.status === 'loading') {
    setBadge('Searching', 'warn');
    lyricsSource.textContent = 'Searching LRCLIB…';
    showLyricsState('Finding lyrics…', 'Looking for a synced or plain version of this track.');
  } else if (lyrics.status === 'ad') {
    setBadge('Advertisement', 'warn');
    lyricsSource.textContent = 'Lyrics will resume after the ad';
    showLyricsState('Advertisement', 'Your music will be back in a moment.');
  } else if (lyrics.status === 'error') {
    setBadge('Error', 'error');
    lyricsSource.textContent = 'LRCLIB';
    showLyricsState('Couldn’t load lyrics', lyrics.error || 'The lyrics service could not be reached.', [
      {
        label: 'Try again',
        onClick: () => fetchLyricsForCurrentTrack(true)
      },
      {
        label: 'YT Music lyrics',
        onClick: openNativeLyrics
      }
    ]);
  } else if (lyrics.status === 'notfound') {
    setBadge('No match', 'warn');
    lyricsSource.textContent = 'No lyrics found on LRCLIB';
    showLyricsState('No lyrics found', 'LRCLIB doesn’t have this track yet. Try YouTube Music’s lyrics or search the web.', [
      {
        label: 'Retry',
        onClick: () => fetchLyricsForCurrentTrack(true)
      },
      {
        label: 'YT Music lyrics',
        onClick: openNativeLyrics
      },
      {
        label: 'Search web',
        onClick: openSearchLyrics
      }
    ]);
  } else if (lyrics.status === 'ready' && lyrics.mode === 'instrumental') {
    setBadge('Instrumental', 'plain');
    lyricsSource.textContent = 'Instrumental track • LRCLIB';
    showLyricsState('Instrumental track', 'There are no lyrics for this one.');
  } else if (lyrics.status === 'ready' && lyrics.mode === 'plain') {
    setBadge('Plain', 'plain');
    lyricsSource.textContent = 'Lyrics by LRCLIB';
    renderPlainLyrics(lyrics.plain);
  } else if (lyrics.status === 'ready' && lyrics.mode === 'synced') {
    setBadge('Synced', 'synced');
    lyricsSource.textContent = 'Synced lyrics by LRCLIB';
    renderSyncedLyrics(lyrics.lines);
  } else {
    setBadge('LRCLIB');
    lyricsSource.textContent = 'Synced lyrics by LRCLIB';
    showLyricsState('Play a song', 'Lyrics will appear here.');
  }

  updateOffsetUI();
}

function setBadge(text, className) {
  lyricsBadge.textContent = text;
  lyricsBadge.className = `badge${className ? ` ${className}` : ''}`;
}

function showLyricsState(title, subtitle, actions) {
  lyricsState.classList.remove('hidden');
  lyricsStateTitle.textContent = title;
  lyricsStateSub.textContent = subtitle;

  const oldActions = lyricsState.querySelector('.lyrics-state-actions');
  if (oldActions) oldActions.remove();

  if (actions && actions.length) {
    const container = document.createElement('div');
    container.className = 'lyrics-state-actions';
    actions.forEach((action) => {
      const button = document.createElement('button');
      button.className = 'btn ghost small';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      container.appendChild(button);
    });
    lyricsState.appendChild(container);
  }
}

function renderSyncedLyrics(lines) {
  lyricsState.classList.add('hidden');
  const container = document.createElement('div');
  container.className = 'lyrics-lines';

  lines.forEach((line, index) => {
    const element = document.createElement('div');
    element.className = 'lyrics-line';
    element.dataset.index = String(index);
    element.dir = 'auto';
    element.textContent = line.text;
    element.addEventListener('click', () => {
      seekTo(line.time - state.lyrics.offset);
    });
    container.appendChild(element);
  });

  lyricsContent.appendChild(container);
  state.lyrics.activeIndex = -1;
}

function renderPlainLyrics(plain) {
  lyricsState.classList.add('hidden');
  const container = document.createElement('div');
  container.className = 'lyrics-plain';
  const blocks = String(plain || '').replace(/\r\n/g, '\n').split(/\n{2,}/);

  blocks.forEach((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return;
    const paragraph = document.createElement('p');
    paragraph.dir = 'auto';
    lines.forEach((line, index) => {
      if (index) paragraph.appendChild(document.createElement('br'));
      paragraph.appendChild(document.createTextNode(line));
    });
    container.appendChild(paragraph);
  });

  lyricsContent.appendChild(container);
  state.lyrics.activeIndex = -1;
}

function updateActiveLine(time) {
  const lines = state.lyrics.lines;
  if (!lines.length) return;

  let low = 0;
  let high = lines.length - 1;
  let index = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].time <= time) {
      index = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (index === state.lyrics.activeIndex) return;

  const container = lyricsContent.querySelector('.lyrics-lines');
  if (!container) return;

  const previous = container.querySelector('.lyrics-line.active');
  if (previous) previous.classList.remove('active');

  if (index >= 0) {
    const element = container.querySelector(`[data-index="${index}"]`);
    if (element) {
      element.classList.add('active');
      if (Date.now() > state.userScrolledUntil) scrollLineIntoView(element);
    }
  }

  state.lyrics.activeIndex = index;
}

function scrollLineIntoView(element) {
  const container = lyricsScroll;
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const target = container.scrollTop
    + (elementRect.top - containerRect.top)
    - (container.clientHeight - elementRect.height) / 2;

  state.autoScrolling = true;
  container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  clearTimeout(state.autoScrollTimer);
  state.autoScrollTimer = setTimeout(() => {
    state.autoScrolling = false;
  }, 700);
}

function parseLrc(input) {
  const lines = [];
  const text = String(input || '');
  let offsetMs = 0;
  const offsetMatch = /\[offset:([+-]?\d+)\]/i.exec(text);
  if (offsetMatch) offsetMs = Number(offsetMatch[1]) || 0;

  const timeTag = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^\s*\[(ar|ti|al|by|offset|length|re|ve):/i.test(raw)) continue;

    const times = [];
    let match;
    timeTag.lastIndex = 0;
    while ((match = timeTag.exec(raw))) {
      const minutes = Number(match[1]) || 0;
      const seconds = Number(match[2]) || 0;
      let fraction = 0;
      if (match[3]) {
        fraction = Number(match[3].padEnd(3, '0').slice(0, 3)) / 1000;
      }
      times.push(minutes * 60 + seconds + fraction + offsetMs / 1000);
    }

    if (!times.length) continue;
    const lyric = raw.replace(timeTag, '').trim();
    if (!lyric) continue;
    for (const time of times) lines.push({ time, text: lyric });
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}

function updateOffsetUI() {
  const synced = state.lyrics.status === 'ready' && state.lyrics.mode === 'synced';
  offsetGroup.hidden = !synced;
  offsetValue.textContent = formatOffset(state.lyrics.offset);
}

function setOffset(value) {
  const next = clamp(Math.round(value * 2) / 2, -15, 15);
  state.lyrics.offset = next;
  if (state.settings) state.settings.lyricsOffset = next;
  updateOffsetUI();
  if (state.lyrics.mode === 'synced') {
    updateActiveLine(state.player.currentTime + next);
  }
  clearTimeout(state.offsetSaveTimer);
  state.offsetSaveTimer = setTimeout(() => saveSettings({ lyricsOffset: next }), 350);
}

async function seekTo(seconds) {
  const time = Math.max(0, Number(seconds) || 0);
  try {
    await webview.executeJavaScript(`(() => {
      const videos = Array.from(document.querySelectorAll('video'));
      const video = videos.find((item) => !item.paused && Number.isFinite(item.duration) && item.duration > 0)
        || videos.find((item) => Number.isFinite(item.duration) && item.duration > 0)
        || videos[0];
      if (!video) return false;
      video.currentTime = ${time};
      return true;
    })()`, true);
  } catch (error) {
    // Seeking is best-effort.
  }
}

async function openNativeLyrics() {
  if (!state.player.title) {
    toast('Play a song first.');
    return;
  }

  try {
    const clicked = await webview.executeJavaScript(`(async () => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const findLyrics = () => {
        const elements = Array.from(document.querySelectorAll('button, tp-yt-paper-tab, [role="tab"], a, ytmusic-player-bar *'));
        return elements.find((element) => {
          if (!element.getClientRects().length) return false;
          const text = normalize(element.textContent);
          const aria = normalize(element.getAttribute('aria-label'));
          const title = normalize(element.getAttribute('title'));
          return text === 'lyrics' || aria === 'lyrics' || title === 'lyrics';
        }) || document.querySelector('[aria-label="Lyrics"], [aria-label*="Lyrics" i], [title*="Lyrics" i]');
      };

      let target = findLyrics();
      if (!target) {
        const queue = document.querySelector('#queue-button, [aria-label="Queue"], [aria-label*="queue" i]');
        if (queue) {
          queue.click();
          await new Promise((resolve) => setTimeout(resolve, 400));
          target = findLyrics();
        }
      }
      if (!target) return false;
      target.click();
      return true;
    })()`, true);

    if (clicked) {
      closeDrawer();
      toast('Opened YouTube Music lyrics.');
    } else {
      toast('Could not find YouTube Music’s lyrics button.');
    }
  } catch (error) {
    toast('Could not open YouTube Music lyrics.');
  }
}

function openSearchLyrics() {
  if (!state.player.title) {
    toast('Play a song first.');
    return;
  }
  const query = [state.player.title, state.player.artist, 'lyrics'].filter(Boolean).join(' ');
  desktop.openExternal(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
}

/* ---------- Equalizer ---------- */

function bindEqControls() {
  eqEnabled.addEventListener('change', () => {
    state.eq.enabled = eqEnabled.checked;
    updateEqUI();
    if (needsAudioGraph()) {
      ensureEq().then(() => applyEq());
    } else {
      applyEq();
    }
    saveEq();
  });

  eqPreset.addEventListener('change', () => {
    const preset = eqPreset.value;
    state.eq.preset = preset;
    if (preset !== 'Custom' && EQ_PRESETS[preset]) {
      state.eq.gains = EQ_PRESETS[preset].slice();
      updateEqUI();
      applyEq();
      saveEq();
    }
  });

  eqBandInputs.forEach((input) => {
    input.addEventListener('input', () => {
      const index = Number(input.dataset.band);
      const value = Number(input.value) || 0;
      state.eq.gains[index] = value;
      state.eq.preset = 'Custom';
      const label = eqBandValues.find((item) => Number(item.dataset.bandVal) === index);
      if (label) label.textContent = formatDb(value);
      if (eqPreset.value !== 'Custom') eqPreset.value = 'Custom';
      applyEq();
      saveEq();
    });
  });

  eqPreamp.addEventListener('input', () => {
    state.eq.preamp = Number(eqPreamp.value) || 0;
    eqPreampValue.textContent = formatDbDecimal(state.eq.preamp);
    applyEq();
    saveEq();
  });

  $('#eq-reset').addEventListener('click', () => {
    state.eq.preset = 'Flat';
    state.eq.preamp = 0;
    state.eq.gains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    updateEqUI();
    applyEq();
    saveEq();
    toast('Equalizer reset to flat.');
  });

  $('#eq-reload').addEventListener('click', () => {
    try {
      webview.reload();
      toast('Reloading the player…');
    } catch (error) {
      toast('Could not reload the player.');
    }
  });
}

async function ensureEq() {
  if (!state.guestReady || !needsAudioGraph()) return false;
  if (!isMusicUrl(webview.getURL())) return false;

  try {
    if (state.eqSetupPromise) {
      try {
        await state.eqSetupPromise;
      } catch (error) {}
      state.eqSetupPromise = null;
    }

    state.eqSetupPromise = webview.executeJavaScript(EQ_SETUP_JS, true);
    let ok = false;
    try {
      ok = await state.eqSetupPromise;
    } finally {
      state.eqSetupPromise = null;
    }
    if (ok) applyEq();
    return Boolean(ok);
  } catch (error) {
    state.eqSetupPromise = null;
    console.error('Could not start the equalizer:', error);
    return false;
  }
}

function applyEq() {
  if (!state.guestReady) return;
  const payload = {
    enabled: Boolean(state.eq.enabled),
    preamp: Number(state.eq.preamp) || 0,
    gains: state.eq.gains.map((value) => Number(value) || 0),
    normalize: Boolean(state.playback && state.playback.normalize),
    fade: Boolean(state.playback && state.playback.fade)
  };
  webview.executeJavaScript(
    `window.__ytmEq ? window.__ytmEq.apply(${JSON.stringify(payload)}) : false`,
    false
  ).catch(() => {});
}

function saveEq() {
  clearTimeout(state.eqSaveTimer);
  state.eqSaveTimer = setTimeout(() => {
    saveSettings({
      equalizer: {
        enabled: Boolean(state.eq.enabled),
        preset: state.eq.preset,
        preamp: Number(state.eq.preamp) || 0,
        gains: state.eq.gains.map((value) => Number(value) || 0)
      }
    });
  }, 180);
}

/* ---------- Settings ---------- */

function bindSettingsControls() {
  $('#set-audio-only').addEventListener('change', (event) => {
    state.settings.audioOnly = event.target.checked;
    applyAudioOnly();
    saveSettings({ audioOnly: event.target.checked });
  });

  $('#set-block-ads').addEventListener('change', (event) => {
    state.settings.blockAds = event.target.checked;
    applyAdBlock();
    saveSettings({ blockAds: event.target.checked });
    toast(event.target.checked ? 'Ad blocking enabled.' : 'Ad blocking disabled.');
  });

  $('#set-skip-still-watching').addEventListener('change', (event) => {
    state.settings.skipStillWatching = event.target.checked;
    applyStillWatchingSkip();
    saveSettings({ skipStillWatching: event.target.checked });
    toast(event.target.checked
      ? '“Still watching?” prompts will be skipped.'
      : '“Still watching?” prompts are shown again.');
  });

  const speedSelect = $('#set-playback-speed');
  if (speedSelect) {
    speedSelect.addEventListener('change', () => {
      const speed = Math.max(0.5, Math.min(2, Number(speedSelect.value) || 1));
      state.playback.speed = speed;
      applyPlaybackExtras();
      saveSettings({ playbackSpeed: speed });
      toast(`Playback speed ${speed}×.`);
    });
  }

  const fadeToggle = $('#set-fade-transitions');
  if (fadeToggle) {
    fadeToggle.addEventListener('change', (event) => {
      state.playback.fade = event.target.checked;
      if (state.playback.fade) {
        ensureEq().then(() => applyEq());
      } else {
        applyEq();
      }
      saveSettings({ fadeTransitions: event.target.checked });
      toast(event.target.checked ? 'Fade transitions enabled.' : 'Fade transitions disabled.');
    });
  }

  const normalizeToggle = $('#set-normalize-volume');
  if (normalizeToggle) {
    normalizeToggle.addEventListener('change', (event) => {
      state.playback.normalize = event.target.checked;
      if (state.playback.normalize) {
        ensureEq().then(() => applyEq());
      } else {
        applyEq();
      }
      saveSettings({ normalizeVolume: event.target.checked });
      toast(event.target.checked ? 'Volume normalization enabled.' : 'Volume normalization disabled.');
    });
  }

  const sponsorToggle = $('#set-sponsorblock');
  if (sponsorToggle) {
    sponsorToggle.addEventListener('change', (event) => {
      if (!state.settings.sponsorBlock) state.settings.sponsorBlock = { enabled: false, categories: [] };
      state.settings.sponsorBlock.enabled = event.target.checked;
      state.sponsor.key = '';
      state.sponsor.segments = [];
      applySponsorBlock();
      saveSettings({ sponsorBlock: state.settings.sponsorBlock });
      toast(event.target.checked ? 'SponsorBlock enabled.' : 'SponsorBlock disabled.');
    });
  }

  $$('[data-sb-category]').forEach((input) => {
    input.addEventListener('change', () => {
      if (!state.settings.sponsorBlock) state.settings.sponsorBlock = { enabled: true, categories: [] };
      state.settings.sponsorBlock.categories = $$('[data-sb-category]')
        .filter((item) => item.checked)
        .map((item) => item.dataset.sbCategory);
      state.sponsor.key = '';
      state.sponsor.segments = [];
      applySponsorBlock();
      saveSettings({ sponsorBlock: state.settings.sponsorBlock });
    });
  });

  $('#set-prevent-sleep').addEventListener('change', (event) => {
    state.settings.preventSleep = event.target.checked;
    saveSettings({ preventSleep: event.target.checked });
  });

  $('#set-close-to-tray').addEventListener('change', (event) => {
    state.settings.closeToTray = event.target.checked;
    applySettingsToUI();
    saveSettings({ closeToTray: event.target.checked });
    toast(event.target.checked ? 'Close to tray enabled.' : 'Close to tray disabled.');
  });

  discordConnectBtn.addEventListener('click', async () => {
    if (state.discordBusy) return;

    const enabled = Boolean(
      state.discordStatus
        ? state.discordStatus.enabled
        : state.settings && state.settings.discord && state.settings.discord.enabled
    );

    state.discordBusy = true;
    discordConnectBtn.disabled = true;
    discordConnectBtn.textContent = enabled ? 'Disconnecting…' : 'Connecting…';

    try {
      const next = await saveSettings({ discord: { enabled: !enabled } });
      if (next) {
        toast(enabled ? 'Discord Rich Presence disconnected.' : 'Connecting to Discord…');
      }
    } finally {
      state.discordBusy = false;
      updateDiscordStatus(state.discordStatus || {
        enabled: Boolean(state.settings && state.settings.discord.enabled),
        connected: false,
        connecting: false
      });
    }
  });

  discordRetryBtn.addEventListener('click', async () => {
    try {
      const status = await desktop.discord.reconnect();
      if (status) updateDiscordStatus(status);
    } catch (error) {
      toast('Could not reach Discord.');
    }
  });

  discordCustomInput.addEventListener('change', async (event) => {
    const useCustom = event.target.checked;
    updateDiscordAdvancedUI();
    await saveSettings({ discord: { useCustom } });
    if (useCustom && discordIdInput) discordIdInput.focus();
  });

  const saveDiscordId = async () => {
    const value = String(discordIdInput.value || '').trim();
    if (!/^\d{17,20}$/.test(value)) {
      toast('Discord Application ID should be 17–20 digits.');
      return;
    }
    if (discordCustomInput) discordCustomInput.checked = true;
    updateDiscordAdvancedUI();
    await saveSettings({ discord: { clientId: value, useCustom: true } });
    toast('Custom Discord Application ID saved.');
  };

  discordSaveBtn.addEventListener('click', saveDiscordId);
  discordIdInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveDiscordId();
    }
  });

  $('#btn-discord-portal').addEventListener('click', () => {
    desktop.openExternal('https://discord.com/developers/applications');
  });

  $('#btn-browser-signin').addEventListener('click', () => {
    desktop.browserSignIn().catch(() => {});
  });

  $('#btn-signout').addEventListener('click', async () => {
    const confirmed = await desktop.confirmSignOut();
    if (!confirmed) return;

    try {
      await desktop.clearSession();
      resetForSignOut();
      showLoading();
      webview.loadURL('https://music.youtube.com/');
      closeDrawer();
      toast('Signed out.');
    } catch (error) {
      toast('Could not clear the session.');
    }
  });

  $('#btn-open-ytm').addEventListener('click', () => {
    desktop.openExternal('https://music.youtube.com');
  });

  $('#btn-retry').addEventListener('click', () => {
    showLoading();
    hideError();
    try {
      webview.loadURL('https://music.youtube.com/');
    } catch (error) {
      showError('Could not reload YouTube Music.');
    }
  });

  $('#btn-open-browser').addEventListener('click', () => {
    desktop.openExternal('https://music.youtube.com');
  });
}

function resetForSignOut() {
  clearTimeout(state.lyricsFetchTimer);
  state.lyricsFetchTimer = null;
  clearTimeout(state.recoveryTimer);
  state.recoveryTimer = null;
  clearTimeout(state.startupTimer);
  state.startupTimer = null;
  state.guestReady = false;
  state.hasLoadedOnce = false;
  state.wasAd = false;
  state.trackKey = '';
  state.lastSentSignature = null;
  state.player = emptyPlayer();
  state.lyrics = {
    ...state.lyrics,
    status: 'idle',
    mode: null,
    lines: [],
    plain: '',
    activeIndex: -1,
    error: '',
    key: ''
  };
  updateNowPlaying(state.player);
  renderLyrics();
  desktop.sendPlayerState(state.player);
}

/* ---------- Browser sign-in ---------- */

function bindAuthStatus() {
  desktop.onAuthStatus((payload) => {
    if (!payload) return;
    const message = payload.message || '';

    switch (payload.status) {
      case 'started':
        toast(message || 'Opening your browser for Google sign-in…', 6000);
        break;
      case 'success':
        toast(message || 'Signed in!', 8000);
        break;
      case 'error':
        toast(message || 'Browser sign-in failed.', 9000);
        break;
      case 'cancelled':
        toast(message || 'Browser sign-in cancelled.');
        break;
      case 'info':
        if (message) toast(message, 5000);
        break;
      default:
        break;
    }
  });
}

/* ---------- Discord ---------- */

function bindDiscordStatus() {
  desktop.discord.onStatus((status) => updateDiscordStatus(status));
}

function updateDiscordAdvancedUI() {
  const custom = Boolean(discordCustomInput && discordCustomInput.checked);
  if (discordIdInput) discordIdInput.disabled = !custom;
  if (discordSaveBtn) discordSaveBtn.disabled = !custom;
}

function updateDiscordStatus(status) {
  if (!status) return;
  state.discordStatus = status;

  let text = 'Not connected';
  let className = '';

  if (!status.enabled) {
    text = 'Not connected';
  } else if (status.connected) {
    text = status.username ? `Connected as ${status.username}` : 'Connected to Discord';
    className = 'good';
  } else if (status.connecting) {
    text = 'Connecting to Discord…';
    className = 'warn';
  } else if (status.error) {
    text = status.error;
    className = 'bad';
  } else {
    text = 'Waiting for Discord…';
    className = 'warn';
  }

  discordStatusText.textContent = text;
  discordDot.className = `status-dot${className ? ` ${className}` : ''}`;

  if (discordConnectBtn) {
    discordConnectBtn.disabled = Boolean(state.discordBusy);
    if (!state.discordBusy) {
      discordConnectBtn.textContent = status.enabled ? 'Disconnect' : 'Connect to Discord';
    }
  }

  if (discordRetryBtn) {
    discordRetryBtn.hidden = !(status.enabled && !status.connected && !status.connecting);
  }
}

/* ---------- Offline downloads / local player ---------- */

function formatClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function setDownloadProgress(percent, text) {
  if (!downloadsProgress) return;
  const visible = percent >= 0;
  downloadsProgress.hidden = !visible;
  if (!visible) {
    downloadsProgressFill.style.width = '0%';
    downloadsProgressText.textContent = '';
    return;
  }
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  downloadsProgressFill.style.width = `${safe}%`;
  downloadsProgressText.textContent = text || `${safe.toFixed(0)}%`;
}

function renderDownloads() {
  const status = state.downloads.status;
  if (status && downloadsToolText) {
    if (status.ready) {
      const formatStatus = status.ffmpeg ? 'MP3 + MP4' : 'MP4 only';
      downloadsToolText.textContent = `yt-dlp ${status.version ? `v${status.version}` : ''} ready · ${formatStatus} · ${status.count || 0} saved`;
      if (downloadsInstallBtn) downloadsInstallBtn.hidden = true;
    } else {
      downloadsToolText.textContent = status.installing
        ? 'Downloading yt-dlp…'
        : 'yt-dlp is required to save tracks offline.';
      if (downloadsInstallBtn) {
        downloadsInstallBtn.hidden = Boolean(status.installing);
        downloadsInstallBtn.textContent = status.installing ? 'Installing…' : 'Install yt-dlp';
        downloadsInstallBtn.disabled = Boolean(status.installing);
      }
    }
  }

  if (downloadsLastError) {
    const lastError = status && status.lastError;
    downloadsLastError.hidden = !lastError;
    downloadsLastError.textContent = lastError ? `Last error: ${lastError.message}` : '';
  }

  if (!downloadsList) return;
  downloadsList.textContent = '';

  const items = state.downloads.items || [];
  if (downloadsEmpty) downloadsEmpty.hidden = items.length > 0;

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'download-item';
    if (state.local.item && state.local.item.id === item.id) row.classList.add('playing');

    let art = null;
    if (item.artwork && /^https:/i.test(item.artwork)) {
      art = document.createElement('img');
      art.className = 'download-art';
      art.alt = '';
      art.src = item.artwork;
      art.addEventListener('error', () => {
        if (!art.parentNode) return;
        const fallback = document.createElement('div');
        fallback.className = 'download-art-fallback';
        fallback.innerHTML = '<svg class="icon"><use href="#i-music"></use></svg>';
        art.replaceWith(fallback);
      });
    } else {
      art = document.createElement('div');
      art.className = 'download-art-fallback';
      art.innerHTML = '<svg class="icon"><use href="#i-music"></use></svg>';
    }

    const meta = document.createElement('div');
    meta.className = 'download-meta';
    const title = document.createElement('div');
    title.className = 'download-title';
    title.dir = 'auto';
    title.textContent = item.title || 'Unknown title';
    const artist = document.createElement('div');
    artist.className = 'download-artist';
    artist.dir = 'auto';
    artist.textContent = item.artist || 'Unknown artist';
    const size = document.createElement('div');
    size.className = 'download-size';
    size.textContent = [formatSize(item.size), (item.ext || '').toUpperCase()].filter(Boolean).join(' · ');
    meta.append(title, artist, size);

    const actions = document.createElement('div');
    actions.className = 'download-actions';

    const playBtn = document.createElement('button');
    playBtn.className = 'icon-btn';
    playBtn.title = 'Play offline';
    playBtn.setAttribute('aria-label', 'Play offline');
    playBtn.innerHTML = '<svg class="icon"><use href="#i-play"></use></svg>';
    playBtn.addEventListener('click', () => playDownloaded(item));

    const revealBtn = document.createElement('button');
    revealBtn.className = 'icon-btn';
    revealBtn.title = 'Show in folder';
    revealBtn.setAttribute('aria-label', 'Show in folder');
    revealBtn.innerHTML = '<svg class="icon"><use href="#i-folder"></use></svg>';
    revealBtn.addEventListener('click', () => desktop.downloads.reveal(item.id).catch(() => {}));

    const removeBtn = document.createElement('button');
    removeBtn.className = 'icon-btn';
    removeBtn.title = 'Delete download';
    removeBtn.setAttribute('aria-label', 'Delete download');
    removeBtn.innerHTML = '<svg class="icon"><use href="#i-trash"></use></svg>';
    removeBtn.addEventListener('click', async () => {
      if (state.local.item && state.local.item.id === item.id) stopLocalPlayback(true);
      try {
        await desktop.downloads.remove(item.id);
        await loadDownloads(true);
        toast('Download removed.');
      } catch (error) {
        toast('Could not remove the download.');
      }
    });

    actions.append(playBtn, revealBtn, removeBtn);
    row.append(art, meta, actions);
    downloadsList.appendChild(row);
  });
}

async function loadDownloads(refreshStatus) {
  try {
    if (refreshStatus || !state.downloads.status) {
      state.downloads.status = await desktop.downloads.getStatus();
    }
    state.downloads.items = await desktop.downloads.list();
    state.downloadsLoaded = true;
    renderDownloads();
  } catch (error) {
    console.error('Could not load downloads:', error);
  }
}

let downloadFormatResolver = null;

function closeDownloadMenu() {
  if (!downloadMenu || downloadMenu.hidden) return;
  downloadMenu.hidden = true;
  const button = $('#btn-download-track');
  if (button) button.setAttribute('aria-expanded', 'false');
}

function toggleDownloadMenu() {
  if (!downloadMenu) return;
  const opening = downloadMenu.hidden;
  downloadMenu.hidden = !opening;
  const button = $('#btn-download-track');
  if (button) button.setAttribute('aria-expanded', String(opening));
  if (opening) {
    const first = downloadMenu.querySelector('button');
    if (first) first.focus();
  }
}

function formatLabel(format) {
  return format === 'mp4' ? 'MP4' : 'MP3';
}

async function ensureDownloadStatus() {
  if (state.downloads.status) return state.downloads.status;
  try {
    state.downloads.status = await desktop.downloads.getStatus();
  } catch (error) {
    state.downloads.status = null;
  }
  return state.downloads.status;
}

function resolveDownloadFormat(value) {
  if (!downloadFormatResolver) return;
  const resolve = downloadFormatResolver;
  downloadFormatResolver = null;
  if (downloadFormatModal) downloadFormatModal.hidden = true;
  if (value === 'mp3' || value === 'mp4') {
    state.downloads.lastFormat = value;
  }
  resolve(value);
}

async function chooseDownloadFormat(options = {}) {
  if (!downloadFormatModal) return state.downloads.lastFormat || 'mp3';

  await ensureDownloadStatus();
  if (downloadFormatResolver) resolveDownloadFormat(null);

  return new Promise((resolve) => {
    downloadFormatResolver = resolve;
    const kind = options.kind === 'playlist' ? 'playlist' : 'track';
    const title = String(options.title || '').trim() || (kind === 'playlist' ? 'Current playlist' : 'Current track');
    const count = Number(options.count) || 0;

    if (downloadFormatTitle) {
      downloadFormatTitle.textContent = kind === 'playlist' ? 'Download playlist' : 'Download track';
    }
    if (downloadFormatSub) {
      downloadFormatSub.textContent = kind === 'playlist' && count
        ? `${title} · ${count} track${count === 1 ? '' : 's'}`
        : title;
    }

    const ffmpegReady = Boolean(state.downloads.status && state.downloads.status.ffmpeg);
    const mp3Button = downloadFormatModal.querySelector('[data-format="mp3"]');
    const mp4Button = downloadFormatModal.querySelector('[data-format="mp4"]');
    if (mp3Button) {
      mp3Button.disabled = !ffmpegReady;
      mp3Button.title = ffmpegReady ? '' : 'FFmpeg is required for MP3 conversion';
    }
    if (mp4Button) mp4Button.disabled = false;

    if (downloadFormatNote) {
      downloadFormatNote.hidden = ffmpegReady;
      downloadFormatNote.textContent = 'FFmpeg was not found. MP3 is unavailable, and MP4 will use a lower-quality progressive stream.';
    }

    downloadFormatModal.hidden = false;
    const preferred = state.downloads.lastFormat === 'mp4' ? mp4Button : mp3Button;
    const focusTarget = preferred && !preferred.disabled ? preferred : (mp4Button || mp3Button);
    if (focusTarget) setTimeout(() => focusTarget.focus(), 0);
  });
}

async function readPlaylistState() {
  if (!state.guestReady) return null;
  let timeoutId = null;
  try {
    return await Promise.race([
      webview.executeJavaScript(PLAYLIST_STATE_JS, false),
      new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Playlist lookup timed out.')), 8000);
      })
    ]);
  } catch (error) {
    console.error('Could not read the current playlist:', error);
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function downloadCurrentPlaylist() {
  closeDownloadMenu();
  if (!state.guestReady) {
    toast('Open YouTube Music first.');
    return;
  }

  const context = await readPlaylistState();
  if (!context || context.error) {
    toast('Could not read the current playlist. Try opening the playlist or queue first.', 7000);
    return;
  }

  const items = Array.isArray(context.items) ? context.items : [];
  if (!items.length) {
    toast(context.playlistId
      ? 'The playlist has not loaded yet. Open it and try again.'
      : 'Play a playlist or add tracks to the queue first.', 7000);
    return;
  }

  const title = String(context.title || '').trim()
    || (context.source === 'queue' ? 'Current queue' : 'Current playlist');
  const format = await chooseDownloadFormat({
    kind: 'playlist',
    title,
    count: items.length
  });
  if (!format) return;

  const result = await desktop.downloads.startMany({
    items,
    title,
    format
  }).catch((error) => ({ ok: false, error: 'ipc', message: error.message }));

  if (!result || !result.ok) {
    if (result && result.error === 'batch-running') {
      toast('A playlist download is already running.', 7000);
    } else if (result && result.error === 'tool-missing') {
      openDrawer('downloads');
      toast('Install yt-dlp first to save tracks offline.', 7000);
    } else {
      toast(result && result.message ? result.message : 'Could not start the playlist download.', 9000);
    }
    return;
  }

  if (result.empty) {
    toast(`All ${items.length} track${items.length === 1 ? '' : 's'} are already saved offline.`, 7000);
    return;
  }

  openDrawer('downloads');
  const skipped = Number(result.skipped) || 0;
  toast(
    `Queued ${result.total} track${result.total === 1 ? '' : 's'} as ${formatLabel(format)}`
      + (skipped ? ` · skipped ${skipped} already saved` : '') + '…',
    8000
  );
  loadDownloads(true);
}

async function downloadCurrentTrack() {
  closeDownloadMenu();
  const player = state.player;
  if (!player.videoId) {
    toast('Play a song first.');
    return;
  }
  if (!player.title) {
    toast('Waiting for the track information…');
    return;
  }

  const format = await chooseDownloadFormat({
    kind: 'track',
    title: player.artist ? `${player.artist} — ${player.title}` : player.title
  });
  if (!format) return;

  const result = await desktop.downloads.start({
    videoId: player.videoId,
    title: player.title,
    artist: player.artist,
    album: player.album,
    artwork: player.artwork,
    duration: player.duration
  }, { format }).catch((error) => ({ ok: false, error: 'ipc', message: error.message }));

  if (!result || !result.ok) {
    if (result && result.error === 'tool-missing') {
      openDrawer('downloads');
      toast('Install yt-dlp first to save tracks offline.', 7000);
    } else if (result && result.error === 'ffmpeg-missing') {
      toast(result.message || 'MP3 downloads require FFmpeg.', 9000);
    } else if (result && result.error === 'duplicate') {
      toast('This track is already saved offline.');
    } else if (result && result.error === 'already-running') {
      toast('This track is already downloading.');
    } else {
      toast(result && result.message ? result.message : 'Could not start the download.');
    }
    return;
  }

  state.downloads.activeId = result.id;
  setDownloadProgress(0, `Starting ${formatLabel(format)} download: ${player.title}`);
  toast(`Downloading ${formatLabel(format)} · “${player.title}”…`, 6000);
  loadDownloads(true);
}

async function installYtDlp() {
  if (downloadsInstallBtn) {
    downloadsInstallBtn.disabled = true;
    downloadsInstallBtn.textContent = 'Installing…';
  }
  toast('Downloading yt-dlp…', 6000);
  const result = await desktop.downloads.installTool().catch((error) => ({ ok: false, message: error.message }));
  if (!result || !result.ok) {
    toast(result && result.message ? result.message : 'Could not install yt-dlp.', 9000);
  }
  if (downloadsInstallBtn) downloadsInstallBtn.disabled = false;
  loadDownloads(true);
}

function pauseYouTubeForLocal() {
  try {
    webview.executeJavaScript(`(() => {
      const video = document.querySelector('#movie_player video') || document.querySelector('video');
      if (video && !video.paused) {
        video.pause();
        return true;
      }
      return false;
    })()`, false).catch(() => {});
  } catch (error) {}
}

function updateLocalPlayIcon() {
  if (!lpPlayIcon) return;
  lpPlayIcon.querySelector('use').setAttribute('href', state.local.playing ? '#i-pause' : '#i-play');
}

function playDownloaded(item) {
  if (!item) return;
  state.local.item = item;
  state.local.startedAt = Date.now();
  state.local.playing = false;
  localPlayer.hidden = false;
  lpTitle.textContent = item.title || 'Offline track';
  lpArtist.textContent = item.artist || 'Playing from downloads';
  lpCurrent.textContent = '0:00';
  lpDuration.textContent = item.duration ? formatClock(item.duration) : '0:00';
  lpSeek.value = '0';

  if (item.artwork && /^https:/i.test(item.artwork)) {
    lpArt.src = item.artwork;
    lpArt.hidden = false;
    if (lpArtFallback) lpArtFallback.hidden = true;
  } else {
    lpArt.removeAttribute('src');
    lpArt.hidden = true;
    if (lpArtFallback) lpArtFallback.hidden = false;
  }

  localAudio.src = `ytmd-media://media/${encodeURIComponent(item.id)}`;
  pauseYouTubeForLocal();
  localAudio.play().catch(() => {
    toast('Could not play the offline file.');
  });
  updateLocalPlayIcon();
  renderDownloads();
}

function stopLocalPlayback(silent) {
  if (!state.local.item) return;
  state.local.item = null;
  state.local.playing = false;
  state.local.startedAt = 0;
  try {
    localAudio.pause();
    localAudio.removeAttribute('src');
    localAudio.load();
  } catch (error) {}
  if (localPlayer) localPlayer.hidden = true;
  updateLocalPlayIcon();
  renderDownloads();
  if (!silent) toast('Offline playback stopped.');
}

function toggleLocalPlayback() {
  if (!state.local.item) return;
  if (localAudio.paused) {
    localAudio.play().catch(() => toast('Could not resume the offline file.'));
  } else {
    localAudio.pause();
  }
}

function bindDownloads() {
  const trackBtn = $('#btn-download-track');
  if (trackBtn) {
    trackBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleDownloadMenu();
    });
  }
  if (downloadMenuTrack) {
    downloadMenuTrack.addEventListener('click', () => {
      closeDownloadMenu();
      downloadCurrentTrack();
    });
  }
  if (downloadMenuPlaylist) {
    downloadMenuPlaylist.addEventListener('click', () => {
      closeDownloadMenu();
      downloadCurrentPlaylist();
    });
  }
  const currentBtn = $('#btn-download-current');
  if (currentBtn) currentBtn.addEventListener('click', () => downloadCurrentTrack());
  if (downloadsPlaylistBtn) downloadsPlaylistBtn.addEventListener('click', () => downloadCurrentPlaylist());
  if (downloadsInstallBtn) downloadsInstallBtn.addEventListener('click', () => installYtDlp());
  const folderBtn = $('#btn-downloads-folder');
  if (folderBtn) folderBtn.addEventListener('click', () => desktop.downloads.openFolder().catch(() => {}));

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.download-menu-wrap')) closeDownloadMenu();
  });

  if (downloadFormatModal) {
    downloadFormatModal.addEventListener('click', (event) => {
      const option = event.target.closest('.download-format-option');
      if (option && !option.disabled) {
        resolveDownloadFormat(option.dataset.format);
        return;
      }
      if (event.target === downloadFormatCancel || event.target.id === 'download-format-backdrop') {
        resolveDownloadFormat(null);
      }
    });
  }

  desktop.downloads.onEvent((event) => {
    if (!event) return;

    if (event.type === 'batch-start') {
      state.downloads.batch = {
        id: event.id,
        title: event.title,
        total: event.total,
        completed: 0,
        saved: 0,
        failed: 0,
        skipped: event.skipped || 0,
        currentTitle: ''
      };
      setDownloadProgress(0, `Starting playlist: ${event.title}`);
      return;
    }

    if (event.type === 'batch-progress') {
      state.downloads.batch = { ...event };
      const total = Number(event.total) || 0;
      const completed = Number(event.completed) || 0;
      const current = event.currentTitle ? ` · ${event.currentTitle}` : '';
      const percent = total ? Math.min(99, (completed / total) * 100) : 0;
      setDownloadProgress(percent, `${event.title}: ${completed}/${total} tracks${current}`);
      return;
    }

    if (event.type === 'batch-complete') {
      state.downloads.batch = null;
      state.downloads.activeId = null;
      setDownloadProgress(-1);
      const details = [`Saved ${event.saved} of ${event.total}`];
      if (event.failed) details.push(`${event.failed} failed`);
      if (event.skipped) details.push(`${event.skipped} skipped`);
      toast(`${details.join(' · ')} from “${event.title}”.`, 8000);
      loadDownloads(true);
      return;
    }

    if (event.type === 'batch-error') {
      state.downloads.batch = null;
      state.downloads.activeId = null;
      setDownloadProgress(-1);
      toast(event.message || 'The playlist download stopped.', 9000);
      loadDownloads(true);
      return;
    }

    if (event.type === 'start') {
      state.downloads.activeId = event.id;
      if (!event.batchId) {
        setDownloadProgress(0, `Downloading ${event.title || 'track'}…`);
      }
    } else if (event.type === 'progress') {
      if (event.batchId) {
        const currentBatch = state.downloads.batch;
        if (currentBatch && currentBatch.id === event.batchId) {
          const total = Number(currentBatch.total) || 0;
          const completed = Number(currentBatch.completed) || 0;
          const percent = total
            ? Math.min(99, ((completed + (Number(event.percent) || 0) / 100) / total) * 100)
            : 0;
          const current = currentBatch.currentTitle ? ` · ${currentBatch.currentTitle}` : '';
          setDownloadProgress(percent, `${currentBatch.title}: ${completed}/${total} tracks${current}`);
        }
      } else if (event.id === state.downloads.activeId) {
        setDownloadProgress(event.percent, event.phase || `Downloading… ${Math.round(event.percent)}%`);
      }
    } else if (event.type === 'complete') {
      if (event.batchId) return;
      state.downloads.activeId = null;
      setDownloadProgress(-1);
      toast(`Saved “${event.item && event.item.title ? event.item.title : 'track'}” offline.`, 6000);
      loadDownloads(true);
    } else if (event.type === 'error') {
      if (event.batchId) return;
      state.downloads.activeId = null;
      setDownloadProgress(-1);
      toast(event.message || 'Download failed.', 9000);
      loadDownloads(true);
    } else if (event.type === 'cancelled') {
      if (event.batchId) return;
      state.downloads.activeId = null;
      setDownloadProgress(-1);
    } else if (event.type === 'tool-progress') {
      if (downloadsInstallBtn) downloadsInstallBtn.textContent = `Installing… ${Math.round(event.percent || 0)}%`;
    } else if (event.type === 'tool-ready') {
      toast(`yt-dlp ${event.version ? `v${event.version}` : ''} installed.`, 6000);
      loadDownloads(true);
    } else if (event.type === 'tool-error') {
      toast(event.message || 'Could not install yt-dlp.', 9000);
      loadDownloads(true);
    }
  });

  localAudio.addEventListener('play', () => {
    state.local.playing = true;
    updateLocalPlayIcon();
  });
  localAudio.addEventListener('pause', () => {
    state.local.playing = false;
    updateLocalPlayIcon();
  });
  localAudio.addEventListener('ended', () => {
    state.local.playing = false;
    updateLocalPlayIcon();
  });
  localAudio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(localAudio.duration)) {
      lpDuration.textContent = formatClock(localAudio.duration);
    }
  });
  localAudio.addEventListener('timeupdate', () => {
    if (state.local.seeking) return;
    const duration = Number(localAudio.duration) || 0;
    const current = Number(localAudio.currentTime) || 0;
    lpCurrent.textContent = formatClock(current);
    if (duration > 0) lpSeek.value = String(Math.round((current / duration) * 1000));
  });
  localAudio.addEventListener('error', () => {
    if (state.local.item) toast('Could not read the offline file.');
  });

  lpPlay.addEventListener('click', toggleLocalPlayback);
  $('#lp-close').addEventListener('click', () => stopLocalPlayback(false));
  lpSeek.addEventListener('input', () => {
    state.local.seeking = true;
  });
  lpSeek.addEventListener('change', () => {
    const duration = Number(localAudio.duration) || 0;
    if (duration > 0) {
      localAudio.currentTime = (Number(lpSeek.value) / 1000) * duration;
    }
    state.local.seeking = false;
  });
}

/* ---------- Auto updater ---------- */

function setUpdaterText(text) {
  if (updateStatusEl) updateStatusEl.textContent = text;
}

async function loadUpdaterStatus() {
  try {
    const status = await desktop.updater.getStatus();
    state.updateStatus = status;
    if (!status.supported) {
      setUpdaterText('Automatic updates are only available in the installed build.');
    } else {
      setUpdaterText('Check for a newer version.');
    }
    if (installUpdateBtn) installUpdateBtn.hidden = true;
  } catch (error) {
    setUpdaterText('Could not read update status.');
  }
}

function applyUpdaterStatus(event) {
  if (!event || !event.status) return;
  state.updateStatus = { ...(state.updateStatus || {}), ...event };
  if (checkUpdatesBtn) checkUpdatesBtn.disabled = false;

  switch (event.status) {
    case 'checking':
      setUpdaterText('Checking for updates…');
      if (checkUpdatesBtn) checkUpdatesBtn.disabled = true;
      break;
    case 'available':
      setUpdaterText(`Update ${event.version ? `v${event.version}` : ''} found. Downloading…`);
      break;
    case 'downloading':
      setUpdaterText(`Downloading update… ${Math.round(event.percent || 0)}%`);
      break;
    case 'downloaded':
      setUpdaterText(`Update ${event.version ? `v${event.version}` : ''} ready. Restart to install.`);
      if (installUpdateBtn) installUpdateBtn.hidden = false;
      toast('Update ready to install.', 8000);
      break;
    case 'current':
      setUpdaterText(`You're up to date${event.version ? ` (v${event.version})` : ''}.`);
      break;
    case 'error':
      setUpdaterText(event.message || 'Update check failed.');
      break;
    case 'dev':
      setUpdaterText(event.message || 'Updates are only available in the installed build.');
      break;
    default:
      break;
  }
}

function bindUpdater() {
  desktop.updater.onStatus((event) => applyUpdaterStatus(event));
  if (checkUpdatesBtn) {
    checkUpdatesBtn.addEventListener('click', async () => {
      checkUpdatesBtn.disabled = true;
      setUpdaterText('Checking for updates…');
      await desktop.updater.check().catch(() => {});
      checkUpdatesBtn.disabled = false;
    });
  }
  if (installUpdateBtn) {
    installUpdateBtn.addEventListener('click', () => {
      desktop.updater.install().catch(() => {});
    });
  }
}

/* ---------- Commands / keyboard ---------- */

function bindCommands() {
  desktop.onCommand(({ type }) => {
    switch (type) {
      case 'toggle-lyrics':
        toggleDrawer('lyrics');
        break;
      case 'toggle-equalizer':
        toggleDrawer('eq');
        break;
      case 'toggle-settings':
        toggleDrawer('settings');
        break;
      case 'toggle-downloads':
        toggleDrawer('downloads');
        break;
      case 'play-pause':
        clickPlayerButton('play-pause');
        break;
      case 'next':
        clickPlayerButton('next');
        break;
      case 'previous':
        clickPlayerButton('previous');
        break;
      case 'reload-player':
        try {
          webview.reload();
        } catch (error) {
          // The webview may already be gone.
        }
        break;
      case 'download-current':
        downloadCurrentTrack();
        break;
      case 'autoplay-test':
        runAutoplayTest();
        break;
      case 'click-signin-test':
        runSignInTest();
        break;
      default:
        break;
    }
  });
}

function runSignInTest() {
  const script = `(() => {
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const candidates = Array.from(document.querySelectorAll(
      'button, a, tp-yt-paper-button, yt-button-renderer, ytmusic-nav-bar button'
    ));
    const target = candidates.find((element) => {
      if (!element.getClientRects().length) return false;
      const text = normalize(element.textContent);
      const aria = normalize(element.getAttribute('aria-label'));
      return text === 'sign in' || aria === 'sign in';
    });
    if (!target) return false;
    target.click();
    return true;
  })()`;

  webview.executeJavaScript(script, true).then((result) => {
    toast(result ? 'Sign-in test: clicked Sign in.' : 'Sign-in test: no Sign in button.');
  }).catch(() => {});
}

function runAutoplayTest() {
  const script = `(async () => {
    const visible = (element) => element && element.getClientRects().length > 0;
    const click = (element) => {
      if (!element) return false;
      element.click();
      return true;
    };

    let target = Array.from(document.querySelectorAll(
      'ytmusic-responsive-list-item-renderer ytmusic-play-button-renderer button, ytmusic-responsive-list-item-renderer button[aria-label*="Play" i]'
    )).find(visible);
    if (target) {
      target.click();
      return 'song';
    }

    const card = Array.from(document.querySelectorAll(
      'ytmusic-card-shelf-renderer a, ytmusic-two-row-item-renderer a, ytmusic-grid-renderer a'
    )).find(visible);
    if (card) {
      card.click();
      await new Promise((resolve) => setTimeout(resolve, 2600));
    }

    target = Array.from(document.querySelectorAll(
      'ytmusic-play-button-renderer button, ytmusic-play-button-renderer, button[aria-label="Play" i]'
    )).find(visible);
    if (click(target)) return 'playlist';
    return false;
  })()`;

  webview.executeJavaScript(script, true).then((result) => {
    if (result) toast(`Autoplay test: ${result}`);
    else toast('Autoplay test: no play button found.');
    setTimeout(pollPlayer, 800);
  }).catch(() => {});
}

function clickPlayerButton(action) {
  const selectors = {
    'play-pause': ['#play-pause-button button', '#play-pause-button'],
    next: ['.next-button button', 'ytmusic-player-bar .next-button button', 'ytmusic-player-bar .next-button', '[aria-label="Next"]'],
    previous: ['.previous-button button', 'ytmusic-player-bar .previous-button button', 'ytmusic-player-bar .previous-button', '[aria-label="Previous"]']
  };
  const labels = {
    'play-pause': ['play', 'pause'],
    next: ['next'],
    previous: ['previous']
  };

  const script = `(() => {
    const selectors = ${JSON.stringify(selectors[action] || [])};
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        element.click();
        return true;
      }
    }
    const labels = ${JSON.stringify(labels[action] || [])};
    const element = Array.from(document.querySelectorAll('button, tp-yt-paper-icon-button, yt-icon-button')).find((node) => {
      const label = ((node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('title') || '')).toLowerCase();
      return labels.some((value) => label.includes(value));
    });
    if (!element) return false;
    element.click();
    return true;
  })()`;

  webview.executeJavaScript(script, true).catch(() => {});
  setTimeout(pollPlayer, 350);
}

function bindKeyboard() {
  window.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');

    if (event.key === 'Escape') {
      if (downloadFormatResolver) {
        event.preventDefault();
        resolveDownloadFormat(null);
        return;
      }
      if (downloadMenu && !downloadMenu.hidden) {
        event.preventDefault();
        closeDownloadMenu();
        return;
      }
      if (state.drawer) {
        event.preventDefault();
        closeDrawer();
        return;
      }
    }

    if (event.ctrlKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'l') {
        event.preventDefault();
        toggleDrawer('lyrics');
      } else if (key === 'e') {
        event.preventDefault();
        toggleDrawer('eq');
      } else if (key === 'd' && event.shiftKey) {
        event.preventDefault();
        downloadCurrentTrack();
      } else if (key === 'o' && event.shiftKey) {
        event.preventDefault();
        toggleDrawer('downloads');
      } else if (key === ',' && !typing) {
        event.preventDefault();
        toggleDrawer('settings');
      }
    }
  });
}

/* ---------- Start ---------- */

init().catch((error) => {
  console.error('Renderer failed to start:', error);
  showError(error && error.message ? error.message : 'The app failed to start.');
});

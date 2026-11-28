'use strict';

// Pure download helpers. This module intentionally does not require Electron
// (or anything else) so filename/format behavior can be unit-tested with
// `node --test` on Linux CI.

const FORMATS = Object.freeze(['mp3', 'm4a', 'mp4']);
const AUDIO_FORMATS = Object.freeze(['mp3', 'm4a']);
const QUALITY_VALUES = Object.freeze(['128', '192', '256', '320', 'best']);
const VIDEO_QUALITY_VALUES = Object.freeze(['480', '720', '1080', 'best']);
const SPONSORBLOCK_API = 'https://sponsor.ajay.app';

const RETRYABLE_FAILURE_RE = new RegExp([
  'HTTP Error (?:429|5\\d\\d)',
  'timed? ?out',
  'Temporary failure',
  'Connection (?:reset|aborted|refused|closed)',
  'EOF occurred',
  'IncompleteRead',
  'Unable to connect',
  'network is unreachable',
  'Read timed out',
  'Remote end closed',
  'fragment \\d+ not found',
  'No space left',
  'unable to download video data'
].join('|'), 'i');

const TAGGING_FAILURE_RE = new RegExp([
  'embed(?:ding)? thumbnail',
  'embed(?:ding)? metadata',
  'EmbedThumbnail',
  'ThumbnailsConvertor',
  'AtomicParsley',
  'mutagen',
  'Unable to embed',
  'cover art'
].join('|'), 'i');

const MP3_QUALITY_ARGS = Object.freeze({
  '128': '128K',
  '192': '192K',
  '256': '256K',
  '320': '320K',
  'best': '0'
});

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function sanitizeFilenamePart(value, fallback = '') {
  let name = String(value || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/g, '')
    .trim();
  if (!name) name = fallback;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  name = name.slice(0, 110).replace(/[.\s]+$/g, '');
  return name || fallback;
}

function buildBaseName(meta) {
  const source = meta && typeof meta === 'object' ? meta : {};
  const artist = sanitizeFilenamePart(source.artist, '');
  // Never use the bare video id as the filename. Missing titles become a
  // readable placeholder; uniqueBaseName appends the id only on collision.
  const title = sanitizeFilenamePart(source.title, '') || 'Unknown title';
  const base = artist ? `${artist} - ${title}` : title;
  return (base.slice(0, 140).replace(/[.\s]+$/g, '') || 'Unknown title');
}

function normalizeFormat(value) {
  const format = String(value || '').trim().toLowerCase();
  return FORMATS.includes(format) ? format : 'mp3';
}

function normalizeQuality(value) {
  const quality = String(value == null ? '' : value).trim().toLowerCase();
  return QUALITY_VALUES.includes(quality) ? quality : 'best';
}

function normalizeVideoQuality(value) {
  const quality = String(value == null ? '' : value).trim().toLowerCase();
  return VIDEO_QUALITY_VALUES.includes(quality) ? quality : '1080';
}

function audioQualityArg(value) {
  return MP3_QUALITY_ARGS[normalizeQuality(value)] || MP3_QUALITY_ARGS.best;
}

function sanitizeMeta(meta) {
  const videoId = String((meta && meta.videoId) || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return null;
  const duration = Number(meta && meta.duration);
  return {
    videoId,
    title: String((meta && meta.title) || 'Unknown title').slice(0, 300),
    artist: String((meta && meta.artist) || '').slice(0, 300),
    album: String((meta && meta.album) || '').slice(0, 300),
    artwork: String((meta && meta.artwork) || '').slice(0, 1000),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    url: `https://music.youtube.com/watch?v=${videoId}`
  };
}

// Transient/network failures are worth resuming with yt-dlp --continue. A
// permanent failure (video unavailable, bad format) should be cleaned up.
function isRetryableFailure(value) {
  return RETRYABLE_FAILURE_RE.test(String(value || ''));
}

// Optional metadata/thumbnail embedding can fail after the media itself has
// been written. Callers keep the download in that case.
function isTaggingFailure(value) {
  return TAGGING_FAILURE_RE.test(String(value || ''));
}

// SHA2-256SUMS lines look like "<64 hex chars>  yt-dlp.exe".
function parseYtdlpChecksum(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .find((entry) => /\byt-dlp\.exe\s*$/i.test(entry.trim()));
  const expected = line ? line.trim().split(/\s+/)[0].toLowerCase() : '';
  return /^[a-f0-9]{64}$/.test(expected) ? expected : '';
}

function sanitizeSponsorBlockCategories(categories) {
  if (!Array.isArray(categories)) return [];
  const clean = [];
  for (const value of categories) {
    const category = String(value || '').trim().toLowerCase();
    if (!/^[a-z][a-z_]{1,31}$/.test(category)) continue;
    if (!clean.includes(category)) clean.push(category);
  }
  return clean;
}

function buildVideoFormatSelector(videoQuality, hasFfmpeg) {
  const quality = normalizeVideoQuality(videoQuality);
  const cap = quality === 'best' ? '' : `[height<=${quality}]`;
  const parts = hasFfmpeg
    ? [
        `bestvideo${cap}[ext=mp4]+bestaudio[ext=m4a]`,
        `bestvideo${cap}+bestaudio`,
        `best${cap}[ext=mp4]`,
        `best${cap}`
      ]
    : [
        `best${cap}[ext=mp4]`,
        `best${cap}`
      ];
  if (!hasFfmpeg && cap) parts.push('best[ext=mp4]');
  parts.push('best');
  return Array.from(new Set(parts)).join('/');
}

function buildDownloadArgs(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const format = normalizeFormat(opts.format);
  const hasFfmpeg = Boolean(opts.hasFfmpeg);

  const args = [
    '--ignore-config',
    '--no-playlist',
    '--continue',
    '--newline',
    '--no-warnings',
    '--progress',
    '--no-simulate',
    '--print',
    'after_move:YTMD_FILE:%(filepath)s'
  ];

  if (format === 'mp3') {
    args.push(
      '-f', 'bestaudio/best',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', audioQualityArg(opts.quality)
    );
  } else if (format === 'm4a') {
    // Keep the original audio container when it is M4A. If the track is only
    // offered as WebM/Opus, yt-dlp falls back and the real extension is
    // recorded from the downloaded file.
    args.push('-f', 'bestaudio[ext=m4a]/bestaudio/best');
  } else {
    args.push('-f', buildVideoFormatSelector(opts.videoQuality, hasFfmpeg));
    if (hasFfmpeg) args.push('--merge-output-format', 'mp4');
  }

  // Tagging and SponsorBlock removal need FFmpeg. Callers resolve the defaults
  // and only pass these flags when the tools exist, so a missing FFmpeg never
  // turns into a failed download.
  if (hasFfmpeg && opts.embedMetadata) {
    args.push('--embed-metadata');
  }
  if (hasFfmpeg && opts.embedThumbnail) {
    args.push('--convert-thumbnails', 'jpg', '--embed-thumbnail');
  }
  if (hasFfmpeg && opts.sponsorblock) {
    const categories = sanitizeSponsorBlockCategories(opts.sponsorBlockCategories);
    if (categories.length) {
      args.push(
        '--sponsorblock-remove', categories.join(','),
        '--sponsorblock-api', SPONSORBLOCK_API
      );
    }
  }

  return args;
}

const _internal = {
  FORMATS,
  AUDIO_FORMATS,
  QUALITY_VALUES,
  VIDEO_QUALITY_VALUES,
  SPONSORBLOCK_API,
  MP3_QUALITY_ARGS,
  sanitizeFilenamePart,
  buildBaseName,
  normalizeFormat,
  normalizeQuality,
  normalizeVideoQuality,
  audioQualityArg,
  sanitizeMeta,
  isRetryableFailure,
  isTaggingFailure,
  parseYtdlpChecksum,
  sanitizeSponsorBlockCategories,
  buildVideoFormatSelector,
  buildDownloadArgs
};

module.exports = {
  ..._internal,
  _internal
};

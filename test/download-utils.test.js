'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../src/main/download-utils');

test('sanitizeFilenamePart removes filesystem-hostile characters', () => {
  assert.equal(sanitizeFilenamePart('AC/DC: Back in Black?'), 'AC DC Back in Black');
  assert.equal(sanitizeFilenamePart('  trailing dots...  '), 'trailing dots');
  assert.equal(sanitizeFilenamePart('a\tb\nc'), 'a b c');
  assert.equal(sanitizeFilenamePart('', 'fallback'), 'fallback');
  assert.equal(sanitizeFilenamePart('   ', 'fallback'), 'fallback');
});

test('sanitizeFilenamePart escapes Windows reserved device names', () => {
  assert.equal(sanitizeFilenamePart('CON'), '_CON');
  assert.equal(sanitizeFilenamePart('nul.txt'), '_nul.txt');
  assert.equal(sanitizeFilenamePart('COM7'), '_COM7');
});

test('sanitizeFilenamePart caps length and trims trailing dots', () => {
  const result = sanitizeFilenamePart('x'.repeat(500));
  assert.equal(result.length, 110);
  assert.equal(sanitizeFilenamePart(`${'title'}`.padEnd(105, '.')), 'title');
});

test('buildBaseName prefers Artist - Title and never falls back to a bare video id', () => {
  assert.equal(
    buildBaseName({ videoId: 'dQw4w9WgXcQ', artist: 'Rick Astley', title: 'Never Gonna Give You Up' }),
    'Rick Astley - Never Gonna Give You Up'
  );
  assert.equal(
    buildBaseName({ videoId: 'dQw4w9WgXcQ', artist: '', title: 'Solo Track' }),
    'Solo Track'
  );
  assert.equal(
    buildBaseName({ videoId: 'dQw4w9WgXcQ', artist: '', title: '' }),
    'Unknown title'
  );
  assert.equal(
    buildBaseName({ videoId: 'dQw4w9WgXcQ', artist: 'Artist', title: '' }),
    'Artist - Unknown title'
  );
});

test('buildBaseName sanitizes both halves and tolerates missing metadata', () => {
  assert.equal(
    buildBaseName({ videoId: 'abc123', artist: 'A/B', title: 'C:D?' }),
    'A B - C D'
  );
  assert.equal(buildBaseName({}), 'Unknown title');
  assert.equal(buildBaseName(null), 'Unknown title');
});

test('normalizeFormat accepts mp3, m4a, mp4 and falls back to mp3', () => {
  assert.equal(normalizeFormat('mp3'), 'mp3');
  assert.equal(normalizeFormat('M4A'), 'm4a');
  assert.equal(normalizeFormat(' mp4 '), 'mp4');
  assert.equal(normalizeFormat('webm'), 'mp3');
  assert.equal(normalizeFormat(''), 'mp3');
});

test('normalizeQuality and normalizeVideoQuality clamp to supported values', () => {
  for (const value of ['128', '192', '256', '320', 'best']) {
    assert.equal(normalizeQuality(value), value);
  }
  assert.equal(normalizeQuality('999'), 'best');
  assert.equal(normalizeQuality(undefined), 'best');

  for (const value of ['480', '720', '1080', 'best']) {
    assert.equal(normalizeVideoQuality(value), value);
  }
  assert.equal(normalizeVideoQuality('4k'), '1080');
  assert.equal(normalizeVideoQuality(null), '1080');
});

test('audioQualityArg maps bitrates and best to yt-dlp values', () => {
  assert.equal(audioQualityArg('128'), '128K');
  assert.equal(audioQualityArg('192'), '192K');
  assert.equal(audioQualityArg('256'), '256K');
  assert.equal(audioQualityArg('320'), '320K');
  assert.equal(audioQualityArg('best'), '0');
  assert.equal(audioQualityArg('nope'), '0');
});

test('sanitizeMeta validates video ids and builds the watch URL', () => {
  const meta = sanitizeMeta({
    videoId: 'dQw4w9WgXcQ',
    title: 'Title',
    artist: 'Artist',
    album: 'Album',
    artwork: 'https://example.test/art.jpg',
    duration: '213'
  });
  assert.deepEqual(meta, {
    videoId: 'dQw4w9WgXcQ',
    title: 'Title',
    artist: 'Artist',
    album: 'Album',
    artwork: 'https://example.test/art.jpg',
    duration: 213,
    url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ'
  });

  assert.equal(sanitizeMeta({ videoId: 'short' }), null);
  assert.equal(sanitizeMeta({ videoId: '../etc/passwd' }), null);
  assert.equal(sanitizeMeta({ videoId: '' }), null);
  assert.equal(sanitizeMeta(null), null);
});

test('sanitizeMeta clamps strings and rejects non-finite durations', () => {
  const meta = sanitizeMeta({
    videoId: 'abcDEF12345',
    title: 't'.repeat(500),
    artist: 'a'.repeat(500),
    album: 'b'.repeat(500),
    artwork: 'https://example.test/x.jpg',
    duration: Infinity
  });
  assert.equal(meta.title.length, 300);
  assert.equal(meta.artist.length, 300);
  assert.equal(meta.album.length, 300);
  assert.equal(meta.duration, 0);
});

test('isRetryableFailure keeps partials only for transient failures', () => {
  assert.equal(isRetryableFailure('ERROR: unable to download video data: HTTP Error 503'), true);
  assert.equal(isRetryableFailure('ERROR: Read timed out.'), true);
  assert.equal(isRetryableFailure('ERROR: Connection reset by peer'), true);
  assert.equal(isRetryableFailure('ERROR: Temporary failure in name resolution'), true);
  assert.equal(isRetryableFailure('ERROR: [youtube] x: Video unavailable'), false);
  assert.equal(isRetryableFailure('ERROR: Private video. Sign in if you have access'), false);
  assert.equal(isRetryableFailure(''), false);
});

test('isTaggingFailure recognizes optional post-processing failures', () => {
  assert.equal(isTaggingFailure('ERROR: Postprocessing: Unable to embed thumbnail'), true);
  assert.equal(isTaggingFailure('[EmbedThumbnail] Adding thumbnail to "x.m4a"'), true);
  assert.equal(isTaggingFailure('ERROR: Postprocessing: Unable to embed metadata'), true);
  assert.equal(isTaggingFailure('ERROR: AtomicParsley exited with code 1'), true);
  assert.equal(isTaggingFailure('ERROR: [youtube] x: Video unavailable'), false);
  assert.equal(isTaggingFailure('ERROR: unable to download video data: HTTP Error 403'), false);
  assert.equal(isTaggingFailure(''), false);
});

test('parseYtdlpChecksum reads the official SHA2-256SUMS line', () => {
  const hash = 'a'.repeat(64);
  const list = [
    `${'b'.repeat(64)}  yt-dlp`,
    `${hash.toUpperCase()}  yt-dlp.exe`,
    `${'c'.repeat(64)}  yt-dlp_linux`
  ].join('\n');
  assert.equal(parseYtdlpChecksum(list), hash);
  assert.equal(parseYtdlpChecksum('nope'), '');
  assert.equal(parseYtdlpChecksum(''), '');
  assert.equal(parseYtdlpChecksum(`${'d'.repeat(63)}  yt-dlp.exe`), '');
});

test('sanitizeSponsorBlockCategories keeps unique safe categories', () => {
  assert.deepEqual(
    sanitizeSponsorBlockCategories(['sponsor', 'sponsor', 'selfpromo', 'bogus category', '', 'intro']),
    ['sponsor', 'selfpromo', 'intro']
  );
  assert.deepEqual(sanitizeSponsorBlockCategories('sponsor'), []);
  assert.deepEqual(sanitizeSponsorBlockCategories(null), []);
});

test('buildVideoFormatSelector caps MP4 height and keeps FFmpeg fallbacks', () => {
  const selector = buildVideoFormatSelector('720', true);
  assert.match(selector, /bestvideo\[height<=720\]\[ext=mp4\]\+bestaudio\[ext=m4a\]/);
  assert.match(selector, /best\[height<=720\]\[ext=mp4\]/);
  assert.ok(selector.endsWith('/best'));

  const best = buildVideoFormatSelector('best', true);
  assert.match(best, /^bestvideo\[ext=mp4\]\+bestaudio\[ext=m4a\]/);
  assert.doesNotMatch(best, /height<=/);

  const progressive = buildVideoFormatSelector('1080', false);
  assert.match(progressive, /^best\[height<=1080\]\[ext=mp4\]\/best\[height<=1080\]/);
  assert.doesNotMatch(progressive, /bestvideo/);
});

test('buildDownloadArgs keeps argument-array safety and shared flags', () => {
  const args = buildDownloadArgs({ format: 'mp3', hasFfmpeg: true });
  assert.ok(args.every((value) => typeof value === 'string'));
  assert.ok(args.includes('--ignore-config'));
  assert.ok(args.includes('--no-playlist'));
  assert.ok(args.includes('--continue'));
  assert.ok(!args.includes('--no-part'));
  assert.ok(args.includes('--no-simulate'));
  assert.deepEqual(args.slice(args.indexOf('--print'), args.indexOf('--print') + 2), [
    '--print',
    'after_move:YTMD_FILE:%(filepath)s'
  ]);
});

test('buildDownloadArgs adds MP3 conversion and quality flags', () => {
  const args = buildDownloadArgs({
    format: 'mp3',
    quality: '320',
    hasFfmpeg: true,
    embedMetadata: true,
    embedThumbnail: true,
    sponsorblock: true,
    sponsorBlockCategories: ['sponsor', 'selfpromo']
  });
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2), ['-f', 'bestaudio/best']);
  assert.ok(args.includes('--extract-audio'));
  assert.deepEqual(args.slice(args.indexOf('--audio-format'), args.indexOf('--audio-format') + 2), ['--audio-format', 'mp3']);
  assert.deepEqual(args.slice(args.indexOf('--audio-quality'), args.indexOf('--audio-quality') + 2), ['--audio-quality', '320K']);
  assert.ok(args.includes('--embed-metadata'));
  assert.deepEqual(args.slice(args.indexOf('--convert-thumbnails'), args.indexOf('--convert-thumbnails') + 2), ['--convert-thumbnails', 'jpg']);
  assert.ok(args.includes('--embed-thumbnail'));
  assert.deepEqual(
    args.slice(args.indexOf('--sponsorblock-remove'), args.indexOf('--sponsorblock-remove') + 2),
    ['--sponsorblock-remove', 'sponsor,selfpromo']
  );
  assert.deepEqual(
    args.slice(args.indexOf('--sponsorblock-api'), args.indexOf('--sponsorblock-api') + 2),
    ['--sponsorblock-api', 'https://sponsor.ajay.app']
  );
});

test('buildDownloadArgs uses VBR quality 0 for best MP3', () => {
  const args = buildDownloadArgs({ format: 'mp3', quality: 'best', hasFfmpeg: true });
  assert.equal(args[args.indexOf('--audio-quality') + 1], '0');
});

test('buildDownloadArgs downloads M4A without FFmpeg post-processing', () => {
  const args = buildDownloadArgs({
    format: 'm4a',
    hasFfmpeg: true,
    embedMetadata: true,
    embedThumbnail: true
  });
  assert.deepEqual(
    args.slice(args.indexOf('-f'), args.indexOf('-f') + 2),
    ['-f', 'bestaudio[ext=m4a]/bestaudio/best']
  );
  assert.ok(!args.includes('--extract-audio'));
  assert.ok(!args.includes('--audio-format'));
  assert.ok(args.includes('--embed-metadata'));
  assert.ok(args.includes('--embed-thumbnail'));
});

test('buildDownloadArgs skips FFmpeg-only flags when FFmpeg is missing', () => {
  const args = buildDownloadArgs({
    format: 'm4a',
    hasFfmpeg: false,
    embedMetadata: true,
    embedThumbnail: true,
    sponsorblock: true,
    sponsorBlockCategories: ['sponsor']
  });
  assert.ok(!args.includes('--embed-metadata'));
  assert.ok(!args.includes('--embed-thumbnail'));
  assert.ok(!args.includes('--convert-thumbnails'));
  assert.ok(!args.includes('--sponsorblock-remove'));
  assert.ok(!args.includes('--sponsorblock-api'));
});

test('buildDownloadArgs caps MP4 resolution and merges with FFmpeg', () => {
  const args = buildDownloadArgs({
    format: 'mp4',
    videoQuality: '720',
    hasFfmpeg: true
  });
  const selector = args[args.indexOf('-f') + 1];
  assert.match(selector, /height<=720/);
  assert.deepEqual(
    args.slice(args.indexOf('--merge-output-format'), args.indexOf('--merge-output-format') + 2),
    ['--merge-output-format', 'mp4']
  );
  assert.ok(!args.includes('--embed-thumbnail'));
});

test('buildDownloadArgs uses a progressive MP4 selector without FFmpeg', () => {
  const args = buildDownloadArgs({
    format: 'mp4',
    videoQuality: '1080',
    hasFfmpeg: false
  });
  assert.match(args[args.indexOf('-f') + 1], /^best\[height<=1080\]\[ext=mp4\]/);
  assert.ok(!args.includes('--merge-output-format'));
  assert.ok(!args.includes('--ffmpeg-location'));
});

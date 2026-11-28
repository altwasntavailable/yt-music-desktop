'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  createDesktopIntegration,
  executablePath,
  helpers
} = require('../src/main/desktop-integration');

const {
  buildCookieDetails,
  createCdpPipeTransport,
  hasGoogleSession
} = require('../src/main/browser-auth');

const {
  clampPercent,
  normalizeProgressState,
  truncateText,
  normalizeSleepMinutes,
  selectRecentDownloads,
  extractLaunchAction,
  actionRequiresWindow,
  quoteWindowsArgument
} = helpers;

test('clampPercent clamps and coerces taskbar progress values', () => {
  assert.equal(clampPercent(0), 0);
  assert.equal(clampPercent('42.5'), 42.5);
  assert.equal(clampPercent(100), 100);
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(-10), 0);
  assert.equal(clampPercent(Number.NaN), 0);
  assert.equal(clampPercent(undefined), 0);
});

test('normalizeProgressState only accepts documented modes', () => {
  assert.equal(normalizeProgressState('normal'), 'normal');
  assert.equal(normalizeProgressState('PAUSED'), 'paused');
  assert.equal(normalizeProgressState('error'), 'error');
  assert.equal(normalizeProgressState('none'), 'none');
  assert.equal(normalizeProgressState('indeterminate'), 'normal');
  assert.equal(normalizeProgressState(undefined), 'normal');
});

test('truncateText collapses whitespace and truncates with an ellipsis', () => {
  assert.equal(truncateText('  a\n b\tc  ', 20), 'a b c');
  assert.equal(truncateText('abcdef', 4), 'abc…');
  assert.equal(truncateText('', 10), '');
  assert.equal(truncateText(null, 10), '');
});

test('normalizeSleepMinutes clamps to 1..720 whole minutes', () => {
  assert.equal(normalizeSleepMinutes(30), 30);
  assert.equal(normalizeSleepMinutes('45'), 45);
  assert.equal(normalizeSleepMinutes(0), 0);
  assert.equal(normalizeSleepMinutes(-5), 0);
  assert.equal(normalizeSleepMinutes(10000), 720);
  assert.equal(normalizeSleepMinutes(Number.NaN), 0);
});

test('selectRecentDownloads keeps the five newest entries', () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    id: `track-${index}`,
    title: `Track ${index}`,
    addedAt: index
  }));

  const result = selectRecentDownloads(items, 5);
  assert.deepEqual(result.map((item) => item.id), [
    'track-7',
    'track-6',
    'track-5',
    'track-4',
    'track-3'
  ]);
  assert.equal(items[0].id, 'track-0', 'input array must not be mutated');
  assert.deepEqual(selectRecentDownloads(items, 0), []);
  assert.deepEqual(selectRecentDownloads(null), []);
  assert.deepEqual(selectRecentDownloads([null, undefined, 3]), []);
});

test('extractLaunchAction accepts only whitelisted jump-list actions', () => {
  assert.deepEqual(
    extractLaunchAction(['electron.exe', '.', '--ytmd-action=toggle-lyrics']),
    { action: 'toggle-lyrics', videoId: '' }
  );
  assert.deepEqual(
    extractLaunchAction(['app.exe', '--ytmd-action', 'play-pause']),
    { action: 'play-pause', videoId: '' }
  );
  assert.deepEqual(
    extractLaunchAction(['app.exe', '--ytmd-action=open-download', '--ytmd-video-id=dQw4w9WgXcQ']),
    { action: 'open-download', videoId: 'dQw4w9WgXcQ' }
  );
  assert.deepEqual(
    extractLaunchAction(['app.exe', '--ytmd-action=open-download', '--ytmd-video-id=bad id']),
    { action: 'open-download', videoId: '' }
  );
  assert.equal(extractLaunchAction(['app.exe', '--ytmd-action=rm -rf']), null);
  assert.equal(extractLaunchAction(null), null);
});

test('quoteWindowsArgument quotes paths for jump-list task arguments', () => {
  assert.equal(quoteWindowsArgument('--ytmd-action=play-pause'), '--ytmd-action=play-pause');
  assert.equal(
    quoteWindowsArgument('C:\\Program Files\\YT Music'),
    '"C:\\Program Files\\YT Music"'
  );
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(
    quoteWindowsArgument('C:\\Program Files\\'),
    '"C:\\Program Files\\\\"'
  );
});

test('executablePath prefers the portable launcher over the extracted executable', () => {
  const previous = process.env.PORTABLE_EXECUTABLE_FILE;
  try {
    delete process.env.PORTABLE_EXECUTABLE_FILE;
    assert.equal(executablePath(), process.execPath);

    process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\Apps\\YT Music Portable.exe';
    assert.equal(executablePath(), 'C:\\Apps\\YT Music Portable.exe');

    process.env.PORTABLE_EXECUTABLE_FILE = '   ';
    assert.equal(executablePath(), process.execPath);
  } finally {
    if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = previous;
  }
});

test('launch actions can be parsed before deciding to show the window', () => {
  assert.equal(actionRequiresWindow('toggle-settings'), true);
  assert.equal(actionRequiresWindow('open-download'), true);
  assert.equal(actionRequiresWindow('play-pause'), false);
  assert.equal(actionRequiresWindow('quit'), false);

  const integration = createDesktopIntegration({});
  assert.deepEqual(
    integration.parseLaunchArgs(['app.exe', '--ytmd-action=toggle-settings']),
    { action: 'toggle-settings', videoId: '', requiresWindow: true }
  );
  assert.deepEqual(
    integration.parseLaunchArgs(['app.exe', '--ytmd-action=play-pause']),
    { action: 'play-pause', videoId: '', requiresWindow: false }
  );
  assert.equal(integration.parseLaunchArgs(['app.exe', '--ytmd-action=nope']), null);
  integration.destroy();
});

test('browser cookies keep session cookies session-scoped', () => {
  const sessionCookie = buildCookieDetails({
    name: 'SID',
    value: 'token',
    domain: '.google.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'None',
    expires: -1
  });

  assert.equal(sessionCookie.expirationDate, undefined);
  assert.equal(sessionCookie.url, 'https://google.com/');
  assert.equal(sessionCookie.path, '/');
  assert.equal(sessionCookie.domain, '.google.com');
  assert.equal(sessionCookie.sameSite, 'no_restriction');

  const persistentCookie = buildCookieDetails({
    name: 'SAPISID',
    value: 'token',
    domain: '.google.com',
    path: 'foo',
    expires: 1893456000
  });
  assert.equal(persistentCookie.expirationDate, 1893456000);
  assert.equal(persistentCookie.path, '/foo');
  assert.equal(persistentCookie.url, 'https://google.com/foo');
});

test('hasGoogleSession requires both Google and YouTube session cookies', () => {
  assert.equal(hasGoogleSession([
    { name: 'SID', domain: '.google.com' },
    { name: 'SAPISID', domain: '.google.com' },
    { name: 'LOGIN_INFO', domain: '.youtube.com' }
  ]), true);

  assert.equal(hasGoogleSession([
    { name: 'SID', domain: '.google.com' },
    { name: 'SAPISID', domain: '.google.com' }
  ]), false);
});

test('CDP pipe transport resolves, rejects on close, and times out', async () => {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const transport = createCdpPipeTransport(fromChrome, toChrome, { commandTimeoutMs: 200 });

  const requests = [];
  toChrome.on('data', (chunk) => {
    for (const part of chunk.toString('utf8').split('\0')) {
      if (!part) continue;
      requests.push(JSON.parse(part));
    }
  });

  const response = transport.send('Test.echo', { value: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'Test.echo');
  assert.deepEqual(requests[0].params, { value: 1 });

  fromChrome.write(Buffer.from(
    `${JSON.stringify({ id: requests[0].id, result: { ok: true } })}\0`
  ));
  assert.deepEqual(await response, { ok: true });

  const pending = transport.send('Test.never');
  transport.close(new Error('pipe closed'));
  await assert.rejects(pending, /pipe closed/);

  const timed = createCdpPipeTransport(new PassThrough(), new PassThrough(), {
    commandTimeoutMs: 30
  });
  await assert.rejects(timed.send('Test.timeout'), /timed out/);
  timed.close();
});

test('info notifications bypass the download coalescing queue', () => {
  const integration = createDesktopIntegration({});
  const shown = [];
  const queued = [];

  integration._showDownloadNotification = (record) => {
    shown.push(record);
    return true;
  };
  integration._queueDownloadNotification = (record) => {
    queued.push(record);
  };
  integration._lastDownloadNotifyAt = Date.now();

  const result = integration.notifyDownload({
    type: 'info',
    title: 'Sleep timer finished',
    body: 'Playback was paused.'
  });

  assert.equal(result, true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Sleep timer finished');
  assert.equal(queued.length, 0);

  integration.destroy();
});

test('jump-list commands wait for did-finish-load on a fresh window', () => {
  const contents = new EventEmitter();
  let loading = true;
  contents.isLoading = () => loading;
  contents.isDestroyed = () => false;

  const win = {
    webContents: contents,
    isDestroyed: () => false
  };

  const commands = [];
  const integration = createDesktopIntegration({
    getWindow: () => win,
    sendCommand: (type) => commands.push(type)
  });

  assert.equal(integration.handleLaunchArgs(['--ytmd-action=play-pause']), true);
  assert.deepEqual(commands, [], 'command must wait while the renderer loads');

  loading = false;
  contents.emit('did-finish-load');
  assert.deepEqual(commands, ['play-pause']);

  integration.destroy();
});

test('destroyed-window operations are safe no-ops', () => {
  const destroyedWindow = { isDestroyed: () => true };
  const integration = createDesktopIntegration({
    getWindow: () => destroyedWindow,
    sendCommand: () => {
      throw new Error('sendCommand must not run');
    }
  });

  assert.doesNotThrow(() => integration.update({ paused: false }));
  assert.equal(integration.setDownloadProgress(50, 'normal'), false);
  assert.equal(integration.setOverlayIcon('missing.png', 'Download complete'), false);
  assert.doesNotThrow(() => integration.destroy());
});

test('integration constructs and tears down safely without Electron APIs', () => {
  const integration = createDesktopIntegration({});

  assert.deepEqual(
    integration.startSleepTimer(0),
    { active: false, endsAt: null, minutes: 0 }
  );
  assert.deepEqual(integration.getSleepTimer(), { active: false, endsAt: null, minutes: 0 });

  const timer = integration.startSleepTimer(5, () => {});
  assert.equal(timer.active, true);
  assert.equal(timer.minutes, 5);
  assert.equal(typeof timer.endsAt, 'number');
  assert.equal(integration.getSleepTimer().active, true);
  assert.equal(integration.cancelSleepTimer(), true);
  assert.deepEqual(integration.getSleepTimer(), { active: false, endsAt: null, minutes: 0 });

  assert.equal(integration.handleLaunchArgs(['--ytmd-action=play-pause']), true);
  assert.equal(integration.handleLaunchArgs(['--ytmd-action=not-allowed']), false);

  integration.destroy();
  integration.destroy();
});

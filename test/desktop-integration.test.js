'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createDesktopIntegration,
  executablePath,
  helpers
} = require('../src/main/desktop-integration');

const {
  buildCookieDetails,
  createCdpPipeTransport,
  hasGoogleSession,
  selectBrowserProfile,
  findCookieDatabase,
  copyProfileForImport,
  findImportCandidates,
  isProfileBusyError,
  getBrowserImportInfo
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

  assert.equal(hasGoogleSession([
    { name: 'SID', domain: '.google.com' },
    { name: 'SAPISID', domain: '.example.com' },
    { name: 'LOGIN_INFO', domain: '.youtube.com' }
  ]), false, 'cookies from unrelated domains must not count');
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

test('browser import profile selection prefers a valid last-used profile', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-profile-last-used-'));
  try {
    const defaultCookies = path.join(userDataDir, 'Default', 'Network', 'Cookies');
    const profileCookies = path.join(userDataDir, 'Profile 1', 'Network', 'Cookies');
    fs.mkdirSync(path.dirname(defaultCookies), { recursive: true });
    fs.mkdirSync(path.dirname(profileCookies), { recursive: true });
    fs.writeFileSync(defaultCookies, 'default');
    fs.writeFileSync(profileCookies, 'profile');
    fs.writeFileSync(path.join(userDataDir, 'Local State'), JSON.stringify({
      profile: { last_used: 'Default' }
    }));

    fs.utimesSync(defaultCookies, new Date(1000), new Date(1000));
    fs.utimesSync(profileCookies, new Date(9000), new Date(9000));

    const selected = selectBrowserProfile(userDataDir);
    assert.equal(selected.name, 'Default');
    assert.equal(selected.usedLastUsed, true);
    assert.equal(selected.database.relativeCookiePath, path.join('Network', 'Cookies'));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('browser import profile selection falls back to the newest cookie database', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-profile-newest-'));
  try {
    const defaultCookies = path.join(userDataDir, 'Default', 'Network', 'Cookies');
    const profileOneCookies = path.join(userDataDir, 'Profile 1', 'Network', 'Cookies');
    fs.mkdirSync(path.dirname(defaultCookies), { recursive: true });
    fs.mkdirSync(path.dirname(profileOneCookies), { recursive: true });
    fs.mkdirSync(path.join(userDataDir, 'Profile 2'), { recursive: true });
    fs.writeFileSync(defaultCookies, 'default');
    fs.writeFileSync(profileOneCookies, 'profile one');
    fs.utimesSync(defaultCookies, new Date(1000), new Date(1000));
    fs.utimesSync(profileOneCookies, new Date(5000), new Date(5000));

    fs.writeFileSync(path.join(userDataDir, 'Local State'), JSON.stringify({
      profile: { last_used: 'Profile 9' }
    }));
    let selected = selectBrowserProfile(userDataDir);
    assert.equal(selected.name, 'Profile 1');
    assert.equal(selected.usedLastUsed, false);

    // A last-used profile that exists but has no cookie database must not win.
    fs.writeFileSync(path.join(userDataDir, 'Local State'), JSON.stringify({
      profile: { last_used: 'Profile 2' }
    }));
    selected = selectBrowserProfile(userDataDir);
    assert.equal(selected.name, 'Profile 1');
    assert.equal(selected.usedLastUsed, false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('cookie database discovery supports Network and legacy paths with sidecars', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-cookies-'));
  try {
    const modernProfile = path.join(root, 'modern');
    const modernDir = path.join(modernProfile, 'Network');
    fs.mkdirSync(modernDir, { recursive: true });
    fs.writeFileSync(path.join(modernDir, 'Cookies'), 'db');
    fs.writeFileSync(path.join(modernDir, 'Cookies-wal'), 'wal');
    fs.writeFileSync(path.join(modernDir, 'Cookies-shm'), 'shm');

    const modern = findCookieDatabase(modernProfile);
    assert.equal(modern.relativeCookiePath, path.join('Network', 'Cookies'));
    assert.deepEqual(modern.relativeFiles, [
      path.join('Network', 'Cookies'),
      path.join('Network', 'Cookies-wal'),
      path.join('Network', 'Cookies-shm')
    ]);

    const legacyProfile = path.join(root, 'legacy');
    fs.mkdirSync(legacyProfile, { recursive: true });
    fs.writeFileSync(path.join(legacyProfile, 'Cookies'), 'db');
    fs.writeFileSync(path.join(legacyProfile, 'Cookies-journal'), 'journal');

    const legacy = findCookieDatabase(legacyProfile);
    assert.equal(legacy.relativeCookiePath, 'Cookies');
    assert.deepEqual(legacy.relativeFiles, ['Cookies', 'Cookies-journal']);

    const emptyProfile = path.join(root, 'empty');
    fs.mkdirSync(emptyProfile, { recursive: true });
    assert.equal(findCookieDatabase(emptyProfile), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('copyProfileForImport copies only the cookie key, Cookies, and Preferences', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-copy-source-'));
  const destinationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-copy-target-'));
  try {
    const sourceProfile = path.join(userDataDir, 'Profile 1');
    const sourceNetwork = path.join(sourceProfile, 'Network');
    fs.mkdirSync(sourceNetwork, { recursive: true });
    fs.mkdirSync(path.join(userDataDir, 'Default', 'Network'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'Default', 'Network', 'Cookies'), 'other profile');
    fs.writeFileSync(path.join(userDataDir, 'Local State'), JSON.stringify({
      profile: { last_used: 'Profile 1' },
      os_crypt: { encrypted_key: 'fake-key' },
      unrelated: 'private'
    }));
    fs.writeFileSync(path.join(userDataDir, 'SingletonLock'), 'unrelated');
    fs.writeFileSync(path.join(sourceProfile, 'Preferences'), '{"account_info":[]}');
    fs.writeFileSync(path.join(sourceNetwork, 'Cookies'), 'cookie-db');
    fs.writeFileSync(path.join(sourceNetwork, 'Cookies-wal'), 'wal');
    fs.writeFileSync(path.join(sourceProfile, 'History'), 'private history');

    const result = await copyProfileForImport({
      userDataDir,
      profileName: 'Profile 1',
      destinationRoot
    });

    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(destinationRoot, 'Local State'), 'utf8')),
      { os_crypt: { encrypted_key: 'fake-key' } }
    );
    assert.equal(fs.existsSync(path.join(destinationRoot, 'Default', 'Preferences')), false);
    assert.equal(
      fs.readFileSync(path.join(destinationRoot, 'Default', 'Network', 'Cookies'), 'utf8'),
      'cookie-db'
    );
    assert.equal(
      fs.readFileSync(path.join(destinationRoot, 'Default', 'Network', 'Cookies-wal'), 'utf8'),
      'wal'
    );

    assert.equal(fs.existsSync(path.join(destinationRoot, 'Default', 'History')), false);
    assert.equal(fs.existsSync(path.join(destinationRoot, 'SingletonLock')), false);
    assert.equal(
      fs.existsSync(path.join(destinationRoot, 'Default', 'Network', 'Cookies-shm')),
      false
    );
    assert.deepEqual(result.copied.slice().sort(), [
      path.join('Default', 'Network', 'Cookies'),
      path.join('Default', 'Network', 'Cookies-wal'),
      'Local State'
    ].sort());
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(destinationRoot, { recursive: true, force: true });
  }
});

test('copyProfileForImport keeps legacy cookie files at the profile root', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-copy-legacy-source-'));
  const destinationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-copy-legacy-target-'));
  try {
    const sourceProfile = path.join(userDataDir, 'Default');
    fs.mkdirSync(sourceProfile, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'Local State'), '{}');
    fs.writeFileSync(path.join(sourceProfile, 'Cookies'), 'legacy-db');
    fs.writeFileSync(path.join(sourceProfile, 'Cookies-journal'), 'journal');

    await copyProfileForImport({
      userDataDir,
      profileName: 'Default',
      destinationRoot
    });

    assert.equal(
      fs.readFileSync(path.join(destinationRoot, 'Default', 'Cookies'), 'utf8'),
      'legacy-db'
    );
    assert.equal(
      fs.readFileSync(path.join(destinationRoot, 'Default', 'Cookies-journal'), 'utf8'),
      'journal'
    );
    assert.equal(fs.existsSync(path.join(destinationRoot, 'Default', 'Network')), false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(destinationRoot, { recursive: true, force: true });
  }
});

test('browser import discovery reports only display names and profile labels', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-import-info-'));
  try {
    const localAppData = path.join(root, 'LocalAppData');
    const executable = path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    const userDataDir = path.join(localAppData, 'Microsoft', 'Edge', 'User Data');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.mkdirSync(path.join(userDataDir, 'Default', 'Network'), { recursive: true });
    fs.writeFileSync(executable, '');
    fs.writeFileSync(path.join(userDataDir, 'Default', 'Network', 'Cookies'), 'db');
    fs.writeFileSync(path.join(userDataDir, 'Local State'), JSON.stringify({
      profile: { last_used: 'Default' }
    }));

    const info = getBrowserImportInfo({
      env: { LOCALAPPDATA: localAppData },
      progId: 'MSEdgeHTM'
    });
    assert.deepEqual(info, {
      available: true,
      browserId: 'edge',
      browserName: 'Edge',
      profileName: 'Default'
    });
    assert.equal(JSON.stringify(info).includes(root), false);

    const none = getBrowserImportInfo({
      env: { LOCALAPPDATA: path.join(root, 'empty') },
      progId: ''
    });
    assert.deepEqual(none, { available: false, browserName: '', profileName: '' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('locked profile copy errors stay recognizable for the retry dialog', async () => {
  assert.equal(isProfileBusyError({ code: 'EBUSY' }), true);
  assert.equal(isProfileBusyError({ code: 'EPERM' }), true);
  assert.equal(isProfileBusyError({ code: 'EACCES' }), true);
  assert.equal(isProfileBusyError({ code: 'ENOENT' }), false);
  assert.equal(isProfileBusyError(null), false);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-copy-busy-source-'));
  const destinationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-copy-busy-target-'));
  try {
    fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'Default', 'Cookies'), 'db');

    await assert.rejects(
      copyProfileForImport({
        userDataDir,
        profileName: 'Default',
        destinationRoot,
        copyFile: async () => {
          const error = new Error('The process cannot access the file.');
          error.code = 'EBUSY';
          throw error;
        }
      }),
      (error) => isProfileBusyError(error)
    );
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(destinationRoot, { recursive: true, force: true });
  }
});

test('copyProfileForImport rejects profile names outside the browser profile folders', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-copy-invalid-source-'));
  const destinationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-copy-invalid-target-'));
  try {
    fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'Default', 'Cookies'), 'db');

    for (const profileName of ['../Default', 'Profile 1/../../x', '']) {
      await assert.rejects(
        copyProfileForImport({ userDataDir, profileName, destinationRoot }),
        /Invalid browser profile name/
      );
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(destinationRoot, { recursive: true, force: true });
  }
});

test('browser import candidates include every installed profile, default browser first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmd-import-candidates-'));
  try {
    const localAppData = path.join(root, 'LocalAppData');
    const edgeExe = path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    const chromeExe = path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe');
    const edgeData = path.join(localAppData, 'Microsoft', 'Edge', 'User Data');
    const chromeData = path.join(localAppData, 'Google', 'Chrome', 'User Data');
    fs.mkdirSync(path.dirname(edgeExe), { recursive: true });
    fs.mkdirSync(path.dirname(chromeExe), { recursive: true });
    fs.writeFileSync(edgeExe, '');
    fs.writeFileSync(chromeExe, '');
    for (const [dataDir, profiles] of [
      [edgeData, ['Default']],
      [chromeData, ['Default', 'Profile 1']]
    ]) {
      for (const profile of profiles) {
        const cookieFile = path.join(dataDir, profile, 'Network', 'Cookies');
        fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
        fs.writeFileSync(cookieFile, profile);
      }
    }
    fs.writeFileSync(path.join(edgeData, 'Local State'), JSON.stringify({
      profile: { last_used: 'Default' }
    }));
    fs.writeFileSync(path.join(chromeData, 'Local State'), JSON.stringify({
      profile: { last_used: 'Profile 1' }
    }));
    fs.utimesSync(path.join(chromeData, 'Default', 'Network', 'Cookies'), new Date(1000), new Date(1000));
    fs.utimesSync(path.join(chromeData, 'Profile 1', 'Network', 'Cookies'), new Date(2000), new Date(2000));

    const candidates = findImportCandidates({
      env: { LOCALAPPDATA: localAppData },
      progId: 'MSEdgeHTM'
    });
    assert.deepEqual(
      candidates.map((candidate) => `${candidate.id}:${candidate.profileName}`),
      ['edge:Default', 'chrome:Profile 1', 'chrome:Default']
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

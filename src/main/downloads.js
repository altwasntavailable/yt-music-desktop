'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { finished } = require('stream/promises');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { app, net, shell } = require('electron');

const execFileAsync = promisify(execFile);

const YTDLP_WIN_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const YTDLP_SUMS_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS';
const PROBE_CACHE_MS = 30 * 1000;
const MAX_PLAYLIST_ITEMS = 500;
const FORMATS = new Set(['mp3', 'mp4']);

let onEvent = () => {};
let jobs = new Map();
let index = [];
let initialized = false;
let probeCache = { at: 0, tool: null };
let probePromise = null;
let ffmpegCache = { at: 0, tool: null };
let ffmpegPromise = null;
let installing = false;
let batch = null;
let batchCounter = 0;

function emit(payload) {
  try {
    onEvent(payload);
  } catch (error) {
    // The renderer may be closing.
  }
}

function downloadDir() {
  return path.join(app.getPath('userData'), 'downloads');
}

function indexPath() {
  return path.join(downloadDir(), 'downloads.json');
}

function toolsDir() {
  return path.join(app.getPath('userData'), 'tools');
}

function bundledToolPath() {
  return path.join(toolsDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

function readIndex() {
  try {
    const raw = fs.readFileSync(indexPath(), 'utf8');
    const parsed = JSON.parse(raw);
    index = Array.isArray(parsed) ? parsed.filter((item) => item && item.id) : [];
  } catch (error) {
    index = [];
  }

  // Drop entries whose file vanished from disk and migrate older
  // video-ID filenames to readable Artist - Title names.
  const dir = downloadDir();
  const kept = [];
  let migrated = false;

  for (const item of index) {
    const file = path.join(dir, path.basename(String(item.file || '')));
    if (!item.file || !fs.existsSync(file)) continue;

    let migratedFile = file;
    try {
      const currentName = path.basename(file);
      const ext = path.extname(currentName);
      const stem = currentName.slice(0, -ext.length);
      if (ext && stem.toLowerCase() === String(item.videoId || '').toLowerCase()) {
        const base = buildBaseName(item);
        let candidate = `${base}${ext}`;
        let number = 2;
        while (fs.existsSync(path.join(dir, candidate))) {
          candidate = number === 2
            ? `${base} [${item.videoId}]${ext}`
            : `${base} [${item.videoId}] (${number - 1})${ext}`;
          number += 1;
        }
        const target = path.join(dir, candidate);
        fs.renameSync(file, target);
        migratedFile = target;
        migrated = true;
      }
    } catch (error) {
      // If a file is locked or cannot be renamed, keep its existing name.
    }

    kept.push({ ...item, file: migratedFile });
  }

  index = kept;
  if (migrated) writeIndex();
}

function writeIndex() {
  try {
    const dir = downloadDir();
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${indexPath()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(index, null, 2), 'utf8');
    fs.renameSync(temp, indexPath());
  } catch (error) {
    console.error('[downloads] Could not save index:', error.message);
  }
}

function init(handler) {
  onEvent = typeof handler === 'function' ? handler : () => {};
  if (initialized) return;
  initialized = true;
  fs.mkdirSync(downloadDir(), { recursive: true });
  readIndex();
}

async function probeTool(force = false) {
  if (!force && probeCache.at && Date.now() - probeCache.at < PROBE_CACHE_MS) {
    return probeCache.tool;
  }
  if (probePromise) {
    if (!force) return probePromise;
    try {
      await probePromise;
    } catch (error) {}
    probePromise = null;
  }

  probePromise = (async () => {
    const candidates = [];
    if (process.env.YTMD_YTDLP_PATH) candidates.push(process.env.YTMD_YTDLP_PATH);
    candidates.push(bundledToolPath());
    candidates.push('yt-dlp');

    let tool = null;
    for (const candidate of candidates) {
      try {
        const { stdout } = await execFileAsync(candidate, ['--version'], {
          windowsHide: true,
          timeout: 5000,
          encoding: 'utf8'
        });
        const version = String(stdout || '').trim().split(/\r?\n/)[0];
        if (version) {
          tool = { path: candidate, version };
          break;
        }
      } catch (error) {
        // Try the next candidate.
      }
    }

    probeCache = { at: Date.now(), tool };
    return tool;
  })();

  try {
    return await probePromise;
  } finally {
    probePromise = null;
  }
}

async function probeFfmpeg(force = false) {
  if (!force && ffmpegCache.at && Date.now() - ffmpegCache.at < PROBE_CACHE_MS) {
    return ffmpegCache.tool;
  }
  if (ffmpegPromise) {
    if (!force) return ffmpegPromise;
    try {
      await ffmpegPromise;
    } catch (error) {}
    ffmpegPromise = null;
  }

  ffmpegPromise = (async () => {
    const candidates = [];
    if (process.env.YTMD_FFMPEG_PATH) candidates.push(process.env.YTMD_FFMPEG_PATH);
    candidates.push(path.join(toolsDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
    candidates.push('ffmpeg');

    let tool = null;
    for (const candidate of candidates) {
      try {
        const { stdout } = await execFileAsync(candidate, ['-version'], {
          windowsHide: true,
          timeout: 5000,
          encoding: 'utf8'
        });
        const version = String(stdout || '').trim().split(/\r?\n/)[0];
        if (version) {
          tool = { path: candidate, version };
          break;
        }
      } catch (error) {
        // Try the next candidate.
      }
    }

    ffmpegCache = { at: Date.now(), tool };
    return tool;
  })();

  try {
    return await ffmpegPromise;
  } finally {
    ffmpegPromise = null;
  }
}

async function getStatus() {
  const [tool, ffmpeg] = await Promise.all([probeTool(), probeFfmpeg()]);
  return {
    ready: Boolean(tool),
    version: tool ? tool.version : null,
    toolPath: tool ? tool.path : null,
    ffmpeg: Boolean(ffmpeg),
    ffmpegPath: ffmpeg ? ffmpeg.path : null,
    installing,
    dir: downloadDir(),
    count: index.length,
    active: Array.from(jobs.keys()),
    batch: batch ? {
      id: batch.id,
      title: batch.title,
      total: batch.total,
      completed: batch.completed,
      saved: batch.saved,
      failed: batch.failed,
      skipped: batch.skipped
    } : null
  };
}

function list() {
  return index.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

function findItem(id) {
  return index.find((item) => item.id === id) || null;
}

function resolveMedia(id) {
  const item = findItem(String(id || ''));
  if (!item) return null;
  const dir = downloadDir();
  const file = path.join(dir, path.basename(item.file));
  const relative = path.relative(dir, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (!fs.existsSync(file)) return null;
  return { item, file };
}

function sanitizeMeta(meta) {
  const videoId = String((meta && meta.videoId) || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return null;
  return {
    videoId,
    title: String((meta && meta.title) || 'Unknown title').slice(0, 300),
    artist: String((meta && meta.artist) || '').slice(0, 300),
    album: String((meta && meta.album) || '').slice(0, 300),
    artwork: String((meta && meta.artwork) || '').slice(0, 1000),
    duration: Number(meta && meta.duration) || 0,
    url: `https://music.youtube.com/watch?v=${videoId}`
  };
}

function normalizeFormat(value) {
  const format = String(value || '').trim().toLowerCase();
  return FORMATS.has(format) ? format : 'mp3';
}

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
  const artist = sanitizeFilenamePart(meta.artist, '');
  const title = sanitizeFilenamePart(meta.title, '') || sanitizeFilenamePart(meta.videoId, 'track');
  const base = artist ? `${artist} - ${title}` : title;
  return (base.slice(0, 140).replace(/[.\s]+$/g, '') || `track-${meta.videoId}`);
}

function fileNamesForBase(base) {
  try {
    const dir = downloadDir();
    const prefix = `${base}.`.toLowerCase();
    return fs.readdirSync(dir).filter((name) => (
      name.toLowerCase().startsWith(prefix)
      && !/\.(part|ytdl|temp)$/i.test(name)
    ));
  } catch (error) {
    return [];
  }
}

function findFileForBase(base) {
  const names = fileNamesForBase(base);
  if (!names.length) return '';
  const dir = downloadDir();
  const candidates = names
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch (error) {
        return false;
      }
    });
  if (!candidates.length) return '';
  candidates.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch (error) {
      return 0;
    }
  });
  return candidates[0];
}

function uniqueBaseName(meta) {
  const base = buildBaseName(meta);
  const activeBases = new Set(
    Array.from(jobs.values())
      .map((job) => String(job.baseName || '').toLowerCase())
      .filter(Boolean)
  );

  if (!fileNamesForBase(base).length && !activeBases.has(base.toLowerCase())) return base;

  let candidate = `${base} [${meta.videoId}]`;
  let number = 2;
  while (fileNamesForBase(candidate).length || activeBases.has(candidate.toLowerCase())) {
    candidate = `${base} [${meta.videoId}] (${number})`;
    number += 1;
  }
  return candidate;
}

function outputTemplate(base) {
  return path.join(downloadDir(), `${base.replace(/%/g, '%%')}.%(ext)s`);
}

function removeFilesForJob(job) {
  const dir = downloadDir();
  const bases = new Set();
  if (job.baseName) bases.add(`${job.baseName}.`.toLowerCase());
  if (job.meta && job.meta.videoId) bases.add(`${job.meta.videoId}.`.toLowerCase());
  try {
    for (const name of fs.readdirSync(dir)) {
      const lower = name.toLowerCase();
      for (const prefix of bases) {
        if (!lower.startsWith(prefix)) continue;
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch (error) {}
        break;
      }
    }
  } catch (error) {}
}

async function installTool() {
  if (installing) return { ok: false, error: 'already-installing' };
  if (process.platform !== 'win32') {
    return { ok: false, error: 'manual', message: 'Install yt-dlp and make sure it is on your PATH.' };
  }

  installing = true;
  emit({ type: 'tool-progress', percent: 0, phase: 'Starting download…' });

  try {
    fs.mkdirSync(toolsDir(), { recursive: true });
    const target = bundledToolPath();
    const temp = `${target}.download`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    let response;
    try {
      response = await net.fetch(YTDLP_WIN_URL, {
        redirect: 'follow',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok || !response.body) {
      throw new Error(`Download failed (HTTP ${response.status}).`);
    }

    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    let lastEmit = 0;
    const reader = response.body.getReader();
    const file = fs.createWriteStream(temp);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (!file.write(Buffer.from(value))) {
          await new Promise((resolve) => file.once('drain', resolve));
        }
        if (Date.now() - lastEmit > 250) {
          lastEmit = Date.now();
          emit({
            type: 'tool-progress',
            percent: total ? Math.min(99, (received / total) * 100) : 0,
            received,
            total
          });
        }
      }
    } finally {
      file.end();
      await finished(file);
    }

    // Verify the downloaded binary against yt-dlp's published SHA-256 list
    // before it is ever executed.
    const sumsResponse = await net.fetch(YTDLP_SUMS_URL, { redirect: 'follow' });
    if (!sumsResponse.ok) {
      throw new Error(`Could not verify yt-dlp (checksum list HTTP ${sumsResponse.status}).`);
    }
    const sums = await sumsResponse.text();
    const checksumLine = sums.split(/\r?\n/).find((line) => /\byt-dlp\.exe\s*$/i.test(line.trim()));
    const expected = checksumLine ? checksumLine.trim().split(/\s+/)[0].toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error('Could not find the yt-dlp.exe checksum.');
    }

    const digest = crypto
      .createHash('sha256')
      .update(await fs.promises.readFile(temp))
      .digest('hex');
    if (digest !== expected) {
      throw new Error('yt-dlp checksum verification failed. The download may be corrupted.');
    }

    fs.renameSync(temp, target);
    try {
      if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
    } catch (error) {}

    probeCache = { at: 0, tool: null };
    const tool = await probeTool(true);
    if (!tool) throw new Error('yt-dlp was downloaded but could not be started.');

    emit({ type: 'tool-ready', version: tool.version });
    return { ok: true, version: tool.version };
  } catch (error) {
    try {
      fs.unlinkSync(`${bundledToolPath()}.download`);
    } catch (cleanupError) {}
    emit({ type: 'tool-error', message: error.message });
    return { ok: false, error: 'download-failed', message: error.message };
  } finally {
    installing = false;
  }
}

function emitBatchProgress(current) {
  if (!current) return;
  emit({
    type: 'batch-progress',
    id: current.id,
    title: current.title,
    total: current.total,
    completed: current.completed,
    saved: current.saved,
    failed: current.failed,
    skipped: current.skipped,
    currentId: current.currentId || '',
    currentTitle: current.currentTitle || ''
  });
}

function completeBatch(current) {
  if (!current || batch !== current) return;
  batch = null;
  emit({
    type: 'batch-complete',
    id: current.id,
    title: current.title,
    total: current.total,
    completed: current.completed,
    saved: current.saved,
    failed: current.failed,
    skipped: current.skipped
  });
}

function failBatch(current, message) {
  if (!current || batch !== current) return;
  batch = null;
  emit({
    type: 'batch-error',
    id: current.id,
    title: current.title,
    total: current.total,
    completed: current.completed,
    saved: current.saved,
    failed: current.failed,
    skipped: current.skipped,
    message: message || 'The playlist download stopped.'
  });
}

function finishBatchItem(job, saved) {
  if (!batch || !job.batchId || batch.id !== job.batchId) return;
  batch.completed += 1;
  if (saved) batch.saved += 1;
  else batch.failed += 1;
  emitBatchProgress(batch);
  setTimeout(() => {
    pumpBatch().catch(() => {});
  }, 200);
}

async function pumpBatch() {
  const current = batch;
  if (!current || current.pumping) return;
  current.pumping = true;

  try {
    while (batch === current && current.cursor < current.items.length) {
      const meta = current.items[current.cursor];
      current.cursor += 1;

      if (findItem(meta.videoId) || jobs.has(meta.videoId)) {
        current.skipped += 1;
        emitBatchProgress(current);
        continue;
      }

      current.currentTitle = meta.title;
      current.currentId = meta.videoId;
      emitBatchProgress(current);

      const result = await start(meta, { format: current.format, batchId: current.id });
      if (batch !== current) return;

      if (!result || !result.ok) {
        if (result && (result.error === 'duplicate' || result.error === 'already-running')) {
          current.skipped += 1;
        } else {
          current.failed += 1;
        }
        current.completed += 1;
        current.currentId = '';
        current.currentTitle = '';

        if (result && ['tool-missing', 'ffmpeg-missing', 'spawn-failed'].includes(result.error)) {
          failBatch(current, result.message || result.error);
          return;
        }

        emitBatchProgress(current);
        continue;
      }

      emitBatchProgress(current);
      return;
    }

    if (batch === current) completeBatch(current);
  } finally {
    if (batch === current) current.pumping = false;
  }
}

async function startMany(payload) {
  const options = payload && typeof payload === 'object' ? payload : {};
  if (batch) return { ok: false, error: 'batch-running' };

  const list = Array.isArray(options.items) ? options.items : [];
  if (!list.length) return { ok: false, error: 'empty' };

  const format = normalizeFormat(options.format);
  const [tool, ffmpeg] = await Promise.all([probeTool(), probeFfmpeg()]);
  if (!tool) return { ok: false, error: 'tool-missing' };
  if (format === 'mp3' && !ffmpeg) {
    return {
      ok: false,
      error: 'ffmpeg-missing',
      message: 'MP3 downloads require FFmpeg. Install FFmpeg and try again.'
    };
  }

  const seen = new Set();
  const items = [];
  let skipped = 0;

  for (const raw of list) {
    const clean = sanitizeMeta(raw);
    if (!clean || seen.has(clean.videoId)) {
      skipped += 1;
      continue;
    }
    seen.add(clean.videoId);
    if (findItem(clean.videoId) || jobs.has(clean.videoId)) {
      skipped += 1;
      continue;
    }
    if (items.length >= MAX_PLAYLIST_ITEMS) {
      skipped += 1;
      continue;
    }
    items.push(clean);
  }

  if (!items.length) {
    return { ok: true, id: null, total: 0, skipped, empty: true };
  }

  const title = String(options.title || 'Current playlist').replace(/\s+/g, ' ').trim().slice(0, 150)
    || 'Current playlist';
  const id = `playlist-${Date.now().toString(36)}-${batchCounter += 1}`;
  const current = {
    id,
    title,
    format,
    items,
    cursor: 0,
    total: items.length,
    completed: 0,
    saved: 0,
    failed: 0,
    skipped,
    pumping: false,
    currentId: '',
    currentTitle: ''
  };

  batch = current;
  emit({
    type: 'batch-start',
    id,
    title,
    format,
    total: items.length,
    skipped
  });
  pumpBatch().catch((error) => failBatch(current, error.message));

  return {
    ok: true,
    id,
    total: items.length,
    skipped,
    title,
    format
  };
}

function finishJob(job, code, signal, stderr) {
  if (job.finished) return;
  job.finished = true;
  jobs.delete(job.id);

  if (job.cancelled) {
    removeFilesForJob(job);
    emit({ type: 'cancelled', id: job.id, videoId: job.meta.videoId, batchId: job.batchId || '' });
    finishBatchItem(job, false);
    return;
  }

  if (code !== 0) {
    removeFilesForJob(job);
    const message = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]
      || `yt-dlp exited with code ${code}${signal ? ` (${signal})` : ''}.`;
    job.lastError = message;
    emit({ type: 'error', id: job.id, videoId: job.meta.videoId, batchId: job.batchId || '', message });
    finishBatchItem(job, false);
    return;
  }

  const dir = path.resolve(downloadDir());
  let file = '';

  if (job.filePath) {
    const resolved = path.resolve(job.filePath);
    const relative = path.relative(dir, resolved);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(resolved)) {
      file = resolved;
    }
  }

  if (!file && job.baseName) file = findFileForBase(job.baseName);

  if (!file) {
    let match = '';
    try {
      match = fs.readdirSync(dir).find((name) => (
        name.startsWith(`${job.meta.videoId}.`)
        && !/\.(part|ytdl|temp)$/i.test(name)
      )) || '';
    } catch (error) {}
    if (match) file = path.join(dir, match);
  }

  if (!file) {
    removeFilesForJob(job);
    emit({
      type: 'error',
      id: job.id,
      videoId: job.meta.videoId,
      batchId: job.batchId || '',
      message: 'The downloaded file could not be found.'
    });
    finishBatchItem(job, false);
    return;
  }

  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (error) {}

  const item = {
    id: job.meta.videoId,
    videoId: job.meta.videoId,
    title: job.meta.title,
    artist: job.meta.artist,
    album: job.meta.album,
    artwork: job.meta.artwork,
    duration: job.meta.duration,
    url: job.meta.url,
    file,
    ext: path.extname(file).replace('.', '').toLowerCase(),
    format: job.format,
    size,
    addedAt: Date.now()
  };

  index = index.filter((entry) => entry.id !== item.id);
  index.push(item);
  writeIndex();
  emit({ type: 'complete', item, batchId: job.batchId || '' });
  finishBatchItem(job, true);
}

async function start(meta, options = {}) {
  const clean = sanitizeMeta(meta);
  if (!clean) return { ok: false, error: 'invalid' };

  const format = normalizeFormat(options.format);
  const [tool, ffmpeg] = await Promise.all([probeTool(), probeFfmpeg()]);
  if (!tool) return { ok: false, error: 'tool-missing' };
  if (format === 'mp3' && !ffmpeg) {
    return {
      ok: false,
      error: 'ffmpeg-missing',
      message: 'MP3 downloads require FFmpeg. Install FFmpeg and try again.'
    };
  }
  if (jobs.has(clean.videoId)) return { ok: false, error: 'already-running' };
  if (findItem(clean.videoId)) return { ok: false, error: 'duplicate' };

  const dir = downloadDir();
  fs.mkdirSync(dir, { recursive: true });
  const baseName = uniqueBaseName(clean);
  const output = outputTemplate(baseName);

  const args = [
    '--no-playlist',
    '--no-part',
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
      '--audio-quality', '0'
    );
    if (ffmpeg) args.push('--ffmpeg-location', ffmpeg.path);
  } else if (ffmpeg) {
    args.push(
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', ffmpeg.path
    );
  } else {
    // A progressive MP4 is the best we can guarantee without FFmpeg.
    args.push('-f', 'best[ext=mp4]');
  }

  args.push('-o', output, clean.url);

  let child;
  try {
    child = spawn(tool.path, args, { windowsHide: true });
  } catch (error) {
    return { ok: false, error: 'spawn-failed', message: error.message };
  }

  const job = {
    id: clean.videoId,
    meta: clean,
    child,
    cancelled: false,
    finished: false,
    baseName,
    format,
    batchId: String(options.batchId || ''),
    filePath: '',
    lastError: ''
  };
  jobs.set(job.id, job);
  emit({
    type: 'start',
    id: job.id,
    videoId: clean.videoId,
    title: clean.title,
    format,
    batchId: job.batchId
  });

  let stderr = '';
  let pending = '';

  const handleLine = (line) => {
    const fileMatch = line.match(/^YTMD_FILE:(.+)$/);
    if (fileMatch) {
      job.filePath = fileMatch[1].trim().replace(/^"(.*)"$/, '$1');
      return;
    }
    const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
      emit({
        type: 'progress',
        id: job.id,
        videoId: job.meta.videoId,
        batchId: job.batchId,
        percent: Number(match[1])
      });
    }
    if (/\[ExtractAudio\]|\[Merger\]|\[Metadata\]|\[ThumbnailsConvertor\]/.test(line)) {
      emit({
        type: 'progress',
        id: job.id,
        videoId: job.meta.videoId,
        batchId: job.batchId,
        percent: 100,
        phase: format === 'mp3' ? 'Converting to MP3…' : 'Finishing MP4…'
      });
    }
  };

  child.stdout.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) handleLine(line);
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000);
  });

  child.on('error', (error) => {
    if (job.finished) return;
    job.finished = true;
    jobs.delete(job.id);
    removeFilesForJob(job);
    job.lastError = error.message;
    emit({
      type: 'error',
      id: job.id,
      videoId: job.meta.videoId,
      batchId: job.batchId,
      message: error.message
    });
    finishBatchItem(job, false);
  });
  child.on('close', (code, signal) => finishJob(job, code, signal, stderr));

  return { ok: true, id: job.id, baseName, format };
}

function cancel(id) {
  const key = String(id || '');

  if (batch && batch.id === key) {
    const job = jobs.get(batch.currentId || '');
    if (job) {
      job.cancelled = true;
      try {
        job.child.kill();
      } catch (error) {}
    }
    failBatch(batch, 'Playlist download cancelled.');
    return true;
  }

  const job = jobs.get(key);
  if (!job) return false;
  job.cancelled = true;
  try {
    job.child.kill();
  } catch (error) {}
  return true;
}

function remove(id) {
  const key = String(id || '');
  cancel(key);
  const item = findItem(key);
  if (!item) return false;
  const dir = downloadDir();
  try {
    fs.unlinkSync(path.join(dir, path.basename(item.file)));
  } catch (error) {}
  index = index.filter((entry) => entry.id !== key);
  writeIndex();
  return true;
}

async function openFolder() {
  const dir = downloadDir();
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
}

function reveal(id) {
  const resolved = resolveMedia(id);
  if (!resolved) return false;
  shell.showItemInFolder(resolved.file);
  return true;
}

function shutdown() {
  batch = null;
  for (const job of jobs.values()) {
    job.cancelled = true;
    try {
      job.child.kill();
    } catch (error) {}
  }
  jobs = new Map();
}

module.exports = {
  init,
  getStatus,
  list,
  start,
  startMany,
  cancel,
  remove,
  resolveMedia,
  installTool,
  openFolder,
  reveal,
  shutdown
};

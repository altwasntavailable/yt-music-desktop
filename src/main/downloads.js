'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { finished } = require('stream/promises');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { app, net, shell } = require('electron');

const config = require('./config');
const {
  FORMATS,
  AUDIO_FORMATS,
  QUALITY_VALUES,
  VIDEO_QUALITY_VALUES,
  sanitizeMeta,
  normalizeFormat,
  normalizeQuality,
  normalizeVideoQuality,
  buildBaseName,
  isRetryableFailure,
  isTaggingFailure,
  parseYtdlpChecksum,
  sanitizeSponsorBlockCategories,
  buildDownloadArgs
} = require('./download-utils');

const execFileAsync = promisify(execFile);

const YTDLP_WIN_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const YTDLP_SUMS_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS';
const PROBE_CACHE_MS = 30 * 1000;
const MAX_PLAYLIST_ITEMS = 500;
const INDEX_FILE = 'downloads-index.json';
const LEGACY_INDEX_FILE = 'downloads.json';

const TEMP_FILE_RE = /\.(part|ytdl|temp)(?:$|[.-])|\.frag\d+$/i;
const INTERMEDIATE_STREAM_RE = /\.f\d+[a-z0-9_-]*\./i;
const MEDIA_EXTENSIONS = new Set([
  'mp3', 'm4a', 'mp4', 'm4v', 'webm', 'opus', 'ogg', 'oga',
  'aac', 'flac', 'wav', 'mkv', 'mov', '3gp', 'avi'
]);

const TOOL_INSTALL_TIMEOUT_MS = 3 * 60 * 1000;
const TOOL_VERIFY_TIMEOUT_MS = 60 * 1000;

let onEvent = () => {};
let jobs = new Map();
let index = [];
let initialized = false;
let downloadDirValue = '';
let probeCache = { at: 0, tool: null };
let probePromise = null;
let ffmpegCache = { at: 0, tool: null };
let ffmpegPromise = null;
let installing = false;
let updating = false;
let shuttingDown = false;
let batch = null;
let batchCounter = 0;
let lastError = null;

function emit(payload) {
  try {
    onEvent(payload);
  } catch (error) {
    // The renderer may be closing.
  }
}

function samePath(left, right) {
  if (!left || !right) return false;
  const a = path.resolve(String(left));
  const b = path.resolve(String(right));
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function defaultDownloadDir() {
  return path.join(app.getPath('userData'), 'downloads');
}

function indexPath() {
  return path.join(app.getPath('userData'), INDEX_FILE);
}

function toolsDir() {
  return path.join(app.getPath('userData'), 'tools');
}

function bundledToolPath() {
  return path.join(toolsDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

function normalizeDirCandidate(value) {
  const raw = String(value == null ? '' : value).trim().replace(/^"(.*)"$/, '$1').trim();
  if (!raw) return defaultDownloadDir();
  if (!path.isAbsolute(raw)) return '';
  return path.normalize(raw);
}

function ensureUsableDir(dir) {
  if (!dir || !path.isAbsolute(dir)) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.statSync(dir).isDirectory()) return false;
    const probe = path.join(dir, `.ytmd-write-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch (error) {
    return false;
  }
}

function downloadSettings() {
  try {
    const settings = config.get() || {};
    const nested = settings.downloads;
    return nested && typeof nested === 'object' ? nested : {};
  } catch (error) {
    return {};
  }
}

function configuredDownloadDir() {
  try {
    const settings = config.get() || {};
    // The settings UI stores the folder under downloads.dir; downloadDir is
    // the older/flat key. Support both so neither writer wins by accident.
    const nested = settings.downloads;
    const nestedDir = nested && typeof nested.dir === 'string' ? nested.dir : '';
    if (nestedDir) {
      const resolved = normalizeDirCandidate(nestedDir);
      if (resolved) return resolved;
    }
    return normalizeDirCandidate(settings.downloadDir);
  } catch (error) {
    return defaultDownloadDir();
  }
}

function resolveDownloadOptions(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const settings = downloadSettings();
  const qualityValue = opts.quality !== undefined
    ? opts.quality
    : (opts.audioQuality !== undefined ? opts.audioQuality : settings.audioQuality);
  const videoQualityValue = opts.videoQuality !== undefined
    ? opts.videoQuality
    : settings.videoQuality;
  const embedMetadataValue = opts.embedMetadata !== undefined
    ? opts.embedMetadata
    : settings.embedMetadata;
  const embedThumbnailValue = opts.embedThumbnail !== undefined
    ? opts.embedThumbnail
    : settings.embedThumbnail;
  const sponsorValue = opts.sponsorblock !== undefined
    ? opts.sponsorblock
    : (opts.cutSponsorBlock !== undefined ? opts.cutSponsorBlock : settings.cutSponsorBlock);

  return {
    quality: normalizeQuality(qualityValue),
    videoQuality: normalizeVideoQuality(videoQualityValue),
    embedMetadata: embedMetadataValue !== false,
    embedThumbnail: embedThumbnailValue !== false,
    sponsorblock: Boolean(sponsorValue)
  };
}

function resolveInitialDir() {
  const desired = configuredDownloadDir();
  if (desired && ensureUsableDir(desired)) {
    return { dir: desired, desired, fellBack: false };
  }
  const fallback = defaultDownloadDir();
  if (ensureUsableDir(fallback)) {
    return { dir: fallback, desired, fellBack: Boolean(desired) && !samePath(desired, fallback) };
  }
  return { dir: fallback, desired, fellBack: Boolean(desired) };
}

function getDir() {
  if (downloadDirValue) return downloadDirValue;
  const resolved = resolveInitialDir();
  downloadDirValue = resolved.dir;
  if (resolved.fellBack) {
    console.error(`[downloads] Could not use download folder "${resolved.desired}"; using ${downloadDirValue}.`);
  }
  return downloadDirValue;
}

function setDir(dir) {
  const raw = String(dir == null ? '' : dir).trim().replace(/^"(.*)"$/, '$1').trim();
  const candidate = raw
    ? (path.isAbsolute(raw) ? path.normalize(raw) : '')
    : defaultDownloadDir();

  if (candidate && ensureUsableDir(candidate)) {
    downloadDirValue = candidate;
    try {
      config.update({
        downloadDir: candidate,
        downloads: { dir: candidate }
      });
    } catch (error) {
      appendLog(`could not persist download folder: ${error.message}`);
    }
    appendLog(`download folder set to ${candidate}`);
    return candidate;
  }

  const current = getDir();
  appendLog(`download folder rejected "${raw}"; keeping ${current}`);
  return current;
}

function parseIndexFile(file, fallbackDir, allowRelative = false) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item) => item && item.id)
    .map((item) => {
      const copy = { ...item };
      const stored = String(copy.file || '').trim();
      if (allowRelative && stored && !path.isAbsolute(stored)) {
        copy.file = path.join(fallbackDir, path.basename(stored));
      }
      return copy;
    });
}

function writeIndex() {
  try {
    fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
    const temp = `${indexPath()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(index, null, 2), 'utf8');
    fs.renameSync(temp, indexPath());
  } catch (error) {
    console.error('[downloads] Could not save index:', error.message);
  }
}

function migrateLegacyIndex() {
  try {
    if (fs.existsSync(indexPath())) return;

    const dirs = [];
    const seen = new Set();
    for (const dir of [defaultDownloadDir(), getDir()]) {
      const key = process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      dirs.push(dir);
    }

    for (const dir of dirs) {
      const legacy = path.join(dir, LEGACY_INDEX_FILE);
      if (!fs.existsSync(legacy)) continue;
      const items = parseIndexFile(legacy, dir, true);
      if (!items.length) continue;
      index = items;
      writeIndex();
      appendLog(`migrated downloads index from ${legacy}`);
      return;
    }
  } catch (error) {
    // A broken legacy index must not prevent the app from starting.
  }
}

function migrateVideoIdFilename(item) {
  const file = path.resolve(String(item.file || ''));
  const dir = path.dirname(file);
  const currentName = path.basename(file);
  const ext = path.extname(currentName);
  if (!ext) return '';

  const stem = currentName.slice(0, -ext.length);
  const videoId = String(item.videoId || item.id || '');
  if (stem.toLowerCase() !== videoId.toLowerCase()) return '';

  try {
    const base = buildBaseName(item);
    let candidate = `${base}${ext}`;
    let number = 2;
    while (fs.existsSync(path.join(dir, candidate))) {
      candidate = number === 2
        ? `${base} [${videoId}]${ext}`
        : `${base} [${videoId}] (${number - 1})${ext}`;
      number += 1;
    }
    const target = path.join(dir, candidate);
    fs.renameSync(file, target);
    return target;
  } catch (error) {
    // If a file is locked or cannot be renamed, keep its existing name.
    return '';
  }
}

function readIndex() {
  // The stable index must only contain absolute paths. Relative paths are
  // accepted solely while migrating the legacy downloads.json.
  const source = parseIndexFile(indexPath(), getDir(), false);
  const kept = [];
  let migrated = false;

  for (const entry of source) {
    const id = String(entry.id || entry.videoId || '').trim();
    if (!id) continue;

    let file = String(entry.file || '').trim();
    // Index entries always store absolute paths. A relative path is a legacy
    // artifact and cannot be trusted.
    if (!file || !path.isAbsolute(file)) continue;
    file = path.resolve(file);

    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch (error) {
      // Only forget a file that is definitely gone. A disconnected network
      // folder or transient permission/AV error must not erase the library.
      if (isDefinitelyMissing(file)) continue;
    }

    const item = {
      ...entry,
      id,
      videoId: String(entry.videoId || id),
      file
    };

    const renamed = migrateVideoIdFilename(item);
    if (renamed) {
      item.file = renamed;
      migrated = true;
    }

    if (!Number.isFinite(Number(item.addedAt)) || Number(item.addedAt) <= 0) {
      try {
        item.addedAt = Math.round(fs.statSync(item.file).mtimeMs);
      } catch (error) {
        item.addedAt = Date.now();
      }
    }
    if (typeof item.playlistTitle !== 'string') item.playlistTitle = '';
    kept.push(item);
  }

  index = kept;
  if (migrated) writeIndex();
}

function backupCorruptIndex() {
  const file = indexPath();
  try {
    if (!fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('index is not an array');
  } catch (error) {
    try {
      const backup = `${file}.broken-${Date.now()}`;
      fs.renameSync(file, backup);
      appendLog(`moved corrupt download index to ${backup}: ${error.message}`);
    } catch (renameError) {
      appendLog(`could not back up corrupt download index: ${renameError.message}`);
    }
  }
}

function isTempArtifact(name) {
  return TEMP_FILE_RE.test(String(name || ''));
}

function isIntermediateStreamFile(name) {
  return INTERMEDIATE_STREAM_RE.test(String(name || ''));
}

function isMediaFilename(name) {
  const ext = path.extname(String(name || '')).replace('.', '').toLowerCase();
  return MEDIA_EXTENSIONS.has(ext);
}

function isIntermediateStreamForBase(name, base) {
  if (!base) return false;
  const pattern = new RegExp(`^${escapeRegExp(base)}\\.f\\d+[a-z0-9_-]*\\.`, 'i');
  return pattern.test(String(name || ''));
}

function init(handler) {
  onEvent = typeof handler === 'function' ? handler : () => {};
  if (initialized) return;
  initialized = true;

  const resolved = resolveInitialDir();
  downloadDirValue = resolved.dir;
  try {
    fs.mkdirSync(downloadDirValue, { recursive: true });
  } catch (error) {
    // The folder may become available later.
  }
  if (resolved.fellBack) {
    appendLog(`configured download folder "${resolved.desired}" is not usable; using ${downloadDirValue}`);
  }

  backupCorruptIndex();
  migrateLegacyIndex();
  readIndex();
}

function logPath() {
  return path.join(getDir(), 'downloads.log');
}

function appendLog(line) {
  try {
    const dir = getDir();
    const file = logPath();
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (fs.statSync(file).size > 1024 * 1024) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch (error) {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch (error) {}
}

function recordError(message, meta = {}) {
  const text = String(message || '').trim() || 'Unknown download error.';
  const title = String(meta.title || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  lastError = { message: text, title, videoId: meta.videoId || '', at: Date.now() };
  appendLog(`${title ? `[${title}] ` : ''}${text}`);
  return lastError;
}

function getLastError() {
  return lastError;
}

function resolveOnPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];

  for (const dir of dirs) {
    const clean = String(dir || '').trim().replace(/^"(.*)"$/, '$1');
    if (!clean) continue;
    for (const extension of extensions) {
      const file = path.join(clean, `${name}${path.extname(name) ? '' : extension}`);
      try {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return path.resolve(file);
      } catch (error) {}
    }
  }
  return '';
}

function resolveToolCandidate(candidate) {
  if (!candidate) return '';
  const value = String(candidate);
  if (path.isAbsolute(value)) return path.resolve(value);
  if (value.includes('/') || value.includes('\\')) return path.resolve(value);
  return resolveOnPath(value);
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
      const resolved = resolveToolCandidate(candidate);
      if (!resolved) continue;
      try {
        const { stdout } = await execFileAsync(resolved, ['--ignore-config', '--version'], {
          windowsHide: true,
          timeout: 5000,
          encoding: 'utf8'
        });
        const version = String(stdout || '').trim().split(/\r?\n/)[0];
        if (version) {
          tool = { path: path.resolve(resolved), version };
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
      const resolved = resolveToolCandidate(candidate);
      if (!resolved) continue;
      try {
        const { stdout } = await execFileAsync(resolved, ['-version'], {
          windowsHide: true,
          timeout: 5000,
          encoding: 'utf8'
        });
        const version = String(stdout || '').trim().split(/\r?\n/)[0];
        if (version) {
          tool = { path: path.resolve(resolved), version };
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
  const bundled = Boolean(tool && samePath(tool.path, bundledToolPath()));
  const activeJobs = Array.from(jobs.values());
  const singleJob = activeJobs.length === 1 ? activeJobs[0] : null;
  return {
    ready: Boolean(tool),
    version: tool ? tool.version : null,
    toolPath: tool ? tool.path : null,
    canUpdate: bundled,
    ffmpeg: Boolean(ffmpeg),
    ffmpegPath: ffmpeg ? ffmpeg.path : null,
    ffmpegVersion: ffmpeg ? ffmpeg.version : null,
    installing,
    updating,
    dir: getDir(),
    defaultDir: defaultDownloadDir(),
    formats: FORMATS.slice(),
    qualities: QUALITY_VALUES.slice(),
    videoQualities: VIDEO_QUALITY_VALUES.slice(),
    count: index.length,
    active: activeJobs.map((job) => job.id),
    percent: singleJob
      ? Math.max(0, Math.min(100, Number(singleJob.percent) || 0))
      : null,
    lastError,
    batch: batch ? {
      id: batch.id,
      title: batch.title,
      total: batch.total,
      completed: batch.completed,
      saved: batch.saved,
      failed: batch.failed,
      skipped: batch.skipped,
      format: batch.format,
      quality: batch.quality,
      videoQuality: batch.videoQuality,
      currentId: batch.currentId || '',
      currentTitle: batch.currentTitle || ''
    } : null
  };
}

function list() {
  pruneMissingItems();
  return index.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

function safeItemFile(item) {
  if (!item || !item.file) return '';
  const stored = String(item.file);
  if (!path.isAbsolute(stored)) return '';
  try {
    const file = path.resolve(stored);
    if (!fs.statSync(file).isFile()) return '';
    return file;
  } catch (error) {
    return '';
  }
}

function isDefinitelyMissing(file) {
  if (!file || !path.isAbsolute(String(file))) return true;
  try {
    fs.statSync(String(file));
    return false;
  } catch (error) {
    return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
  }
}

function dropIndexItem(id, options = {}) {
  const key = String(id || '');
  const before = index.length;
  index = index.filter((item) => item.id !== key);
  if (index.length === before) return false;
  if (options.persist !== false) writeIndex();
  if (options.notify !== false) emit({ type: 'removed', id: key });
  return true;
}

// A file can disappear outside the app (Explorer, disk cleanup, moved folder).
// Drop those entries lazily instead of trusting a stale index forever.
function pruneMissingItems() {
  const removed = [];
  const kept = [];
  for (const item of index) {
    if (safeItemFile(item)) {
      kept.push(item);
    } else if (isDefinitelyMissing(item.file)) {
      removed.push(String(item.id));
    } else {
      // A locked/disconnected file may come back. Do not erase the entry.
      kept.push(item);
    }
  }
  if (!removed.length) return removed;
  index = kept;
  writeIndex();
  for (const id of removed) emit({ type: 'removed', id });
  return removed;
}

function findItem(id) {
  const key = String(id || '');
  const item = index.find((entry) => entry.id === key) || null;
  if (!item) return null;
  if (safeItemFile(item)) return item;
  if (!isDefinitelyMissing(item.file)) return item;
  dropIndexItem(key);
  return null;
}

function resolveMedia(id) {
  const item = findItem(String(id || ''));
  if (!item) return null;
  const file = safeItemFile(item);
  if (!file) return null;
  return { item, file };
}

function fileNamesForBase(base, dir = getDir()) {
  try {
    const prefix = `${base}.`.toLowerCase();
    return fs.readdirSync(dir).filter((name) => (
      name.toLowerCase().startsWith(prefix)
      && !isTempArtifact(name)
    ));
  } catch (error) {
    return [];
  }
}

function findFileForBase(base, dir = getDir()) {
  const names = fileNamesForBase(base, dir)
    .filter((name) => !isIntermediateStreamForBase(name, base) && isMediaFilename(name));
  if (!names.length) return '';
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

function baseHasFinishedFile(base, dir) {
  return fileNamesForBase(base, dir)
    .some((name) => !isIntermediateStreamForBase(name, base) && isMediaFilename(name));
}

function uniqueBaseName(meta, dir = getDir()) {
  const base = buildBaseName(meta);
  const activeBases = new Set(
    Array.from(jobs.values())
      .filter((job) => !job.dir || samePath(job.dir, dir))
      .map((job) => String(job.baseName || '').toLowerCase())
      .filter(Boolean)
  );

  // Interrupted runs leave .part files and completed stream fragments behind.
  // Reusing the same base lets yt-dlp --continue resume them instead of
  // starting a second, suffixed download.
  if (!baseHasFinishedFile(base, dir) && !activeBases.has(base.toLowerCase())) return base;

  let candidate = `${base} [${meta.videoId}]`;
  let number = 2;
  while (baseHasFinishedFile(candidate, dir) || activeBases.has(candidate.toLowerCase())) {
    candidate = `${base} [${meta.videoId}] (${number})`;
    number += 1;
  }
  return candidate;
}

function outputTemplate(base, dir = getDir()) {
  const escapedDir = String(dir).replace(/%/g, '%%');
  return path.join(escapedDir, `${base.replace(/%/g, '%%')}.%(ext)s`);
}

function isResumableArtifact(name) {
  const value = String(name || '');
  return /\.part(?:-frag\d+)?$/i.test(value)
    || /\.ytdl$/i.test(value)
    || isIntermediateStreamFile(value);
}

function jobFilePrefixes(job) {
  const prefixes = new Set();
  if (job.baseName) {
    // Match only this job's own stem. A broader `base + " ["` prefix can
    // match another job whose base was suffixed for a duplicate title.
    prefixes.add(`${job.baseName}.`.toLowerCase());
  }
  if (job.meta && job.meta.videoId) {
    prefixes.add(`${job.meta.videoId}.`.toLowerCase());
  }
  return Array.from(prefixes);
}

function listJobFiles(job) {
  const dir = job.dir || getDir();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    return { temp: [], final: [] };
  }

  const prefixes = jobFilePrefixes(job);
  const temp = [];
  const final = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (!prefixes.some((prefix) => lower.startsWith(prefix))) continue;
    const file = path.join(dir, name);
    if (isTempArtifact(name)) temp.push(file);
    else final.push(file);
  }
  return { temp, final };
}

function unlinkQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {}
}

// mode 'cancel'/'fail': remove everything this job wrote.
// mode 'fail-keep-partial': keep resumable .part/.ytdl and completed stream
// fragments, but remove scratch/conversion files. Cancelled jobs are treated
// as intentional stops and are fully cleaned up.
function cleanupJobFiles(job, mode) {
  const { temp, final } = listJobFiles(job);

  if (mode === 'fail-keep-partial') {
    for (const file of temp) {
      if (!isResumableArtifact(path.basename(file))) unlinkQuiet(file);
    }
    for (const file of final) {
      if (!isResumableArtifact(path.basename(file))) unlinkQuiet(file);
    }
    return { kept: temp.length + final.length, removed: 0 };
  }

  let removed = 0;
  for (const file of temp.concat(final)) {
    try {
      fs.unlinkSync(file);
      removed += 1;
    } catch (error) {}
  }
  return { kept: 0, removed };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanupForRetry(meta, dir = getDir()) {
  const base = buildBaseName(meta);
  const videoId = String(meta.videoId || '');
  const baseLower = base.toLowerCase();
  const videoIdLower = videoId.toLowerCase();
  const ownedStem = new RegExp(`^${escapeRegExp(baseLower)} \\[${escapeRegExp(videoIdLower)}\\](?: \\(\\d+\\))?$`, 'i');

  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    return removed;
  }

  for (const name of names) {
    const lower = name.toLowerCase();
    const temp = isTempArtifact(name);
    const intermediate = isIntermediateStreamFile(name);
    const ext = path.extname(name);
    const stem = ext ? lower.slice(0, -ext.length) : lower;
    const ownsTemp = (temp || intermediate)
      && (lower.startsWith(`${baseLower}.`) || lower.startsWith(`${videoIdLower}.`));
    // Delete files clearly tied to this video id or to the suffixed base.
    // Do not guess that a plain `Artist - Title.ext` file belongs to this job;
    // it may be a user's file from another app.
    const ownsFinal = stem === videoIdLower || ownedStem.test(stem);

    if (!ownsTemp && !ownsFinal) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch (error) {}
  }

  if (removed) appendLog(`removed ${removed} stale file(s) before retrying "${meta.title}"`);
  return removed;
}

function isUsableFile(file, dir) {
  if (!file) return '';
  const raw = String(file).trim().replace(/^"(.*)"$/, '$1');
  if (!raw || !path.isAbsolute(raw)) return '';
  try {
    const resolved = path.resolve(raw);
    if (dir) {
      const relative = path.relative(path.resolve(dir), resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size <= 0) return '';
    return resolved;
  } catch (error) {
    return '';
  }
}

function validJobFile(job) {
  return isUsableFile(job.filePath, job.dir)
    || isUsableFile(job.finalDestination, job.dir)
    || isUsableFile(job.existingDestination, job.dir);
}

function findCompletedFile(job) {
  let file = findFileForBase(job.baseName, job.dir);
  if (file) return file;

  try {
    const match = fs.readdirSync(job.dir).find((name) => (
      name.toLowerCase().startsWith(`${job.meta.videoId.toLowerCase()}.`)
      && !isTempArtifact(name)
      && !isIntermediateStreamForBase(name, job.meta.videoId)
      && isMediaFilename(name)
    )) || '';
    if (match) return path.join(job.dir, match);
  } catch (error) {}
  return '';
}

function lastMeaningfulError(stderr, code, signal) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = lines.slice().reverse().find((line) => /^(ERROR|WARNING):/i.test(line));
  return errorLine
    || lines.slice(-1)[0]
    || `yt-dlp exited with code ${code}${signal ? ` (${signal})` : ''}.`;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function fetchYtdlpChecksum(signal) {
  const response = await net.fetch(YTDLP_SUMS_URL, { redirect: 'follow', signal });
  if (!response.ok) {
    throw new Error(`Could not verify yt-dlp (checksum list HTTP ${response.status}).`);
  }
  const expected = parseYtdlpChecksum(await response.text());
  if (!expected) {
    throw new Error('Could not find the yt-dlp.exe checksum.');
  }
  return expected;
}

async function verifyYtdlpBinary(file, signal) {
  const expected = await fetchYtdlpChecksum(signal);
  const digest = await sha256File(file);
  if (signal && signal.aborted) {
    throw new Error('yt-dlp verification timed out.');
  }
  if (digest !== expected) {
    throw new Error('yt-dlp checksum verification failed.');
  }
  return { expected, digest };
}

async function installTool() {
  if (shuttingDown) return { ok: false, error: 'shutting-down' };
  if (installing) return { ok: false, error: 'already-installing' };
  if (updating) return { ok: false, error: 'busy', message: 'yt-dlp is being updated. Try again in a moment.' };
  if (batch || jobs.size > 0) {
    return { ok: false, error: 'busy', message: 'Finish or cancel active downloads before installing yt-dlp.' };
  }
  if (process.platform !== 'win32') {
    return { ok: false, error: 'manual', message: 'Install yt-dlp and make sure it is on your PATH.' };
  }

  installing = true;
  emit({ type: 'tool-progress', percent: 0, phase: 'Starting download…' });

  try {
    fs.mkdirSync(toolsDir(), { recursive: true });
    const target = bundledToolPath();
    const temp = `${target}.download`;

    // One deadline covers headers, the streamed body, checksum fetch, and
    // hashing. A stalled body must not leave `installing` stuck forever.
    const controller = new AbortController();
    let rejectDeadline = null;
    const deadline = new Promise((_, reject) => {
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      controller.abort();
      const error = new Error('yt-dlp download timed out.');
      error.name = 'TimeoutError';
      if (rejectDeadline) rejectDeadline(error);
    }, TOOL_INSTALL_TIMEOUT_MS);

    try {
      const response = await Promise.race([
        net.fetch(YTDLP_WIN_URL, {
          redirect: 'follow',
          signal: controller.signal
        }),
        deadline
      ]);

      if (!response.ok || !response.body) {
        throw new Error(`Download failed (HTTP ${response.status}).`);
      }

      const total = Number(response.headers.get('content-length')) || 0;
      let received = 0;
      let lastEmit = 0;
      const reader = response.body.getReader();
      const file = fs.createWriteStream(temp);
      const hasher = crypto.createHash('sha256');
      let writeError = null;
      file.on('error', (error) => {
        writeError = error;
      });

      try {
        while (true) {
          // Race a stalled read against the overall deadline so a dead
          // connection cannot keep `installing` true forever.
          const { done, value } = await Promise.race([reader.read(), deadline]);
          if (done) break;
          const chunk = Buffer.from(value);
          // Hash while writing so verification does not need a second full
          // read of the downloaded executable.
          hasher.update(chunk);
          received += chunk.length;
          if (!file.write(chunk)) {
            await new Promise((resolve, reject) => {
              if (writeError) {
                reject(writeError);
                return;
              }
              const onDrain = () => {
                cleanup();
                resolve();
              };
              const onError = (error) => {
                cleanup();
                reject(error);
              };
              const cleanup = () => {
                file.off('drain', onDrain);
                file.off('error', onError);
              };
              file.once('drain', onDrain);
              file.once('error', onError);
            });
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
        await Promise.race([finished(file), deadline]);
      }

      // Verify the downloaded binary against yt-dlp's published SHA-256 list
      // before it is ever executed.
      const digest = hasher.digest('hex');
      const expected = await Promise.race([
        fetchYtdlpChecksum(controller.signal),
        deadline
      ]);
      if (digest !== expected) {
        throw new Error('yt-dlp checksum verification failed. The download may be corrupted.');
      }
    } finally {
      clearTimeout(timer);
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
    const aborted = Boolean(error) && (
      error.name === 'AbortError'
      || error.name === 'TimeoutError'
      || /aborted|timed out|timeout/i.test(String(error.message || ''))
    );
    const message = aborted
      ? 'yt-dlp download timed out. Check your connection and try again.'
      : (error && error.message) || 'Could not download yt-dlp.';
    emit({ type: 'tool-error', message });
    return { ok: false, error: 'download-failed', message };
  } finally {
    installing = false;
  }
}

function summarizeUpdateFailure(error, stderr) {
  if (error && error.killed) {
    return 'yt-dlp did not finish updating within 120 seconds.';
  }
  const lines = String(stderr || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errorLine = lines.slice().reverse().find((line) => /^ERROR:/i.test(line));
  return errorLine
    || lines.slice(-1)[0]
    || (error && error.message)
    || 'Could not update yt-dlp.';
}

async function updateTool() {
  if (shuttingDown) return { ok: false, error: 'shutting-down' };
  if (batch || jobs.size > 0) {
    return { ok: false, error: 'busy', message: 'Finish or cancel active downloads before updating yt-dlp.' };
  }
  if (updating) {
    return { ok: false, error: 'busy', message: 'yt-dlp is already being updated.' };
  }
  if (installing) {
    return { ok: false, error: 'busy', message: 'yt-dlp is still being installed.' };
  }
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: 'unsupported',
      message: 'Self-update is only available for the app-managed yt-dlp.exe on Windows. Update yt-dlp with your package manager.'
    };
  }

  // Lock out installTool (and any future caller) while probing/updating, so a
  // concurrent install cannot replace the executable under -U.
  updating = true;
  let tool = null;
  try {
    tool = await probeTool();
  } catch (error) {
    updating = false;
    throw error;
  }
  if (!tool) {
    updating = false;
    const info = recordError('yt-dlp was not found.');
    return { ok: false, error: 'tool-missing', message: info.message, version: null };
  }
  if (!samePath(tool.path, bundledToolPath())) {
    updating = false;
    return {
      ok: false,
      error: 'managed',
      message: 'This yt-dlp is managed outside the app. Update it with its package manager or the tool that installed it.',
      version: tool.version
    };
  }

  try {
    let stdout = '';
    let stderr = '';
    try {
      const result = await execFileAsync(tool.path, ['--ignore-config', '-U'], {
        windowsHide: true,
        timeout: 120000,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
      });
      stdout = String(result.stdout || '');
      stderr = String(result.stderr || '');
    } catch (error) {
      stderr = String((error && error.stderr) || '') || error.message;
      probeCache = { at: 0, tool: null };
      let fresh = null;
      try {
        fresh = await probeTool(true);
      } catch (probeError) {}
      const message = summarizeUpdateFailure(error, stderr);
      recordError(message, { title: 'yt-dlp update' });
      emit({
        type: 'tool-update-error',
        message,
        version: fresh ? fresh.version : null
      });
      return { ok: false, error: 'update-failed', message, version: fresh ? fresh.version : null };
    }

    probeCache = { at: 0, tool: null };
    const fresh = await probeTool(true);
    const version = fresh && fresh.version ? fresh.version : null;

    const failVerification = (reason) => {
      // Never leave an unverified executable in the active tool path. Move it
      // aside so later downloads fail closed until a verified copy is installed.
      try {
        const target = bundledToolPath();
        if (fs.existsSync(target)) {
          const quarantine = `${target}.unverified-${Date.now()}`;
          fs.renameSync(target, quarantine);
          appendLog(`quarantined unverified yt-dlp as ${quarantine}`);
        }
      } catch (error) {
        appendLog(`could not quarantine unverified yt-dlp: ${error.message}`);
      }
      probeCache = { at: 0, tool: null };
      const message = `${reason} Reinstall yt-dlp from the Offline panel if downloads keep failing.`;
      recordError(message, { title: 'yt-dlp update' });
      emit({ type: 'tool-update-error', message, version });
      return { ok: false, error: 'verify-failed', message, version };
    };

    if (!fresh) {
      return failVerification('yt-dlp did not start after updating.');
    }
    if (!version) {
      return failVerification('yt-dlp did not report a version after updating.');
    }
    if (!samePath(fresh.path, bundledToolPath())) {
      return failVerification('yt-dlp no longer resolves to the app-managed tool after updating.');
    }

    // Do not trust a self-updated executable just because it starts. Verify
    // the bytes against yt-dlp's published SHA-256 list. A failed check keeps
    // the binary in place; the user can reinstall from the Offline panel.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOOL_VERIFY_TIMEOUT_MS);
    try {
      await verifyYtdlpBinary(fresh.path, controller.signal);
    } catch (error) {
      const reason = (error && error.message) || 'yt-dlp checksum verification failed.';
      return failVerification(reason);
    } finally {
      clearTimeout(timer);
    }

    const alreadyCurrent = /up to date|already (?:the )?(?:latest|current)/i.test(`${stdout}\n${stderr}`);
    const message = alreadyCurrent
      ? `yt-dlp is up to date (v${version}, checksum verified).`
      : `yt-dlp updated to v${version} (checksum verified).`;

    appendLog(message);
    emit({ type: 'tool-updated', version, message });
    return { ok: true, version, message };
  } finally {
    updating = false;
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
  // A clean batch resolves older download errors; a batch with failures keeps
  // the most recent one visible in the Offline panel.
  if (!current.failed) lastError = null;
  appendLog(`playlist finished "${current.title}" (${current.saved} saved, ${current.failed} failed, ${current.skipped} skipped)`);
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
  recordError(message || 'The playlist download stopped.', { title: current.title });
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
  if (!current || current.pumping || current.cancelRequested) return;
  current.pumping = true;

  try {
    while (batch === current && !current.cancelRequested && current.cursor < current.items.length) {
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

      // A cancel can arrive while start() is probing the tools. The batch
      // token lets start() refuse to spawn, and the checks below stop this
      // loop even if start() returns after the batch was failed.
      if (batch !== current || current.cancelRequested || shuttingDown) return;

      const result = await start(meta, {
        format: current.format,
        quality: current.quality,
        videoQuality: current.videoQuality,
        embedMetadata: current.embedMetadata,
        embedThumbnail: current.embedThumbnail,
        sponsorblock: current.sponsorblock,
        batchId: current.id,
        playlistTitle: current.title,
        __batch: current
      });
      if (batch !== current || current.cancelRequested || shuttingDown) return;

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

    if (batch === current && !current.cancelRequested && !shuttingDown) completeBatch(current);
  } finally {
    if (batch === current) current.pumping = false;
  }
}

async function startMany(payload) {
  const options = payload && typeof payload === 'object' ? payload : {};
  if (shuttingDown) return { ok: false, error: 'shutting-down' };
  if (updating) return { ok: false, error: 'tool-updating', message: 'Wait for the yt-dlp update to finish.' };
  if (batch) return { ok: false, error: 'batch-running' };

  const list = Array.isArray(options.items) ? options.items : [];
  if (!list.length) return { ok: false, error: 'empty' };

  const resolved = resolveDownloadOptions(options);
  const format = normalizeFormat(options.format);
  const quality = resolved.quality;
  const videoQuality = resolved.videoQuality;
  const [tool, ffmpeg] = await Promise.all([probeTool(), probeFfmpeg()]);

  // Another startMany()/start() may have created a batch while these probes
  // were resolving. Never overwrite it and orphan the running pump.
  if (shuttingDown) return { ok: false, error: 'shutting-down' };
  if (updating) return { ok: false, error: 'tool-updating', message: 'Wait for the yt-dlp update to finish.' };
  if (batch) return { ok: false, error: 'batch-running' };

  if (!tool) {
    recordError('yt-dlp was not found.', { title: options.title });
    return { ok: false, error: 'tool-missing' };
  }
  if (format === 'mp3' && !ffmpeg) {
    const lastErrorInfo = recordError('MP3 downloads require FFmpeg. Install FFmpeg and try again.', {
      title: options.title
    });
    return {
      ok: false,
      error: 'ffmpeg-missing',
      message: lastErrorInfo.message
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

  const title = String(options.title || options.playlistTitle || 'Current playlist')
    .replace(/\s+/g, ' ').trim().slice(0, 150) || 'Current playlist';
  const id = `playlist-${Date.now().toString(36)}-${batchCounter += 1}`;
  const current = {
    id,
    title,
    format,
    quality,
    videoQuality,
    embedMetadata: resolved.embedMetadata,
    embedThumbnail: resolved.embedThumbnail,
    sponsorblock: resolved.sponsorblock,
    cancelRequested: false,
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
  appendLog(`playlist queued "${title}" (${items.length} tracks, ${format}, ${skipped} skipped)`);
  emit({
    type: 'batch-start',
    id,
    title,
    format,
    quality,
    videoQuality,
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
    format,
    quality,
    videoQuality
  };
}

function finishJob(job, code, signal, stderr) {
  if (job.finished) return;
  job.finished = true;
  jobs.delete(job.id);

  if (job.cancelled) {
    cleanupJobFiles(job, 'cancel');
    emit({ type: 'cancelled', id: job.id, videoId: job.meta.videoId, batchId: job.batchId || '' });
    finishBatchItem(job, false);
    return;
  }

  const combinedOutput = `${job.tail || ''}\n${stderr || ''}`;
  let file = validJobFile(job);
  // M4A with only a failed thumbnail/metadata step has no [Merger] or
  // [ExtractAudio] line, so look for the completed media before deciding the
  // job failed. This keeps a good download when optional tagging fails.
  if (!file) file = findCompletedFile(job);
  let warning = '';

  if (code !== 0) {
    if (file && isTaggingFailure(combinedOutput)) {
      // The media finished and was post-processed; only an optional metadata or
      // thumbnail step failed. Keep the download instead of discarding it.
      warning = 'Saved without complete metadata or cover art.';
      appendLog(`[${job.meta.title}] ${warning}`);
    } else {
      const message = lastMeaningfulError(stderr, code, signal);
      job.lastError = message;
      recordError(message, job.meta);

      // Cancelled and permanent failures remove their partial output. A
      // transient (network/HTTP/timeout) failure intentionally keeps .part
      // and completed stream files so yt-dlp --continue can resume on retry.
      if (isRetryableFailure(combinedOutput)) {
        cleanupJobFiles(job, 'fail-keep-partial');
        appendLog(`[${job.meta.title}] kept partial files so a retry can resume`);
      } else {
        cleanupJobFiles(job, 'fail');
      }

      if (job.batchId && batch && batch.id === job.batchId
        && /ffmpeg not found|ffprobe and ffmpeg|ffmpeg-location/i.test(message)) {
        failBatch(batch, 'FFmpeg could not be used. Install FFmpeg or set YTMD_FFMPEG_PATH, then retry.');
        return;
      }

      emit({
        type: 'error',
        id: job.id,
        videoId: job.meta.videoId,
        batchId: job.batchId || '',
        message,
        retryable: isRetryableFailure(combinedOutput)
      });
      finishBatchItem(job, false);
      return;
    }
  }

  if (file) file = isUsableFile(file, job.dir);

  if (!file) {
    cleanupJobFiles(job, 'fail');
    const message = 'The downloaded file could not be found.';
    recordError(message, job.meta);
    emit({
      type: 'error',
      id: job.id,
      videoId: job.meta.videoId,
      batchId: job.batchId || '',
      message,
      retryable: false
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
    quality: job.quality,
    videoQuality: job.videoQuality,
    size,
    playlistTitle: job.playlistTitle || '',
    addedAt: Date.now()
  };
  if (warning) item.warning = warning;

  index = index.filter((entry) => entry.id !== item.id);
  index.push(item);
  writeIndex();
  // A successful single save resolves older failures so the Offline panel
  // does not keep showing a months-old error. For a batch, completeBatch()
  // decides: keep the error if any item failed.
  if (!job.batchId) lastError = null;
  emit({ type: 'complete', item, batchId: job.batchId || '', warning });
  finishBatchItem(job, true);
}

function phaseForFormat(format) {
  if (format === 'mp3') return 'Converting to MP3…';
  if (format === 'm4a') return 'Finishing M4A…';
  return 'Finishing MP4…';
}

function captureDestination(job, line) {
  const merger = line.match(/^\[Merger\] Merging formats into "(.+)"\s*$/);
  if (merger) {
    job.finalDestination = merger[1];
    return true;
  }
  const extracted = line.match(/^\[ExtractAudio\] Destination: "?(.+?)"?\s*$/);
  if (extracted) {
    job.finalDestination = extracted[1];
    return true;
  }
  const already = line.match(/^\[download\] (.+) has already been downloaded\s*$/);
  if (already) {
    job.existingDestination = already[1];
    return true;
  }
  return false;
}

async function start(meta, options = {}) {
  const clean = sanitizeMeta(meta);
  if (!clean) return { ok: false, error: 'invalid' };
  if (shuttingDown) return { ok: false, error: 'shutting-down', message: 'The app is shutting down.' };
  if (updating) return { ok: false, error: 'tool-updating', message: 'Wait for the yt-dlp update to finish.' };

  const opts = options && typeof options === 'object' ? options : {};
  const batchOwner = opts.__batch && typeof opts.__batch === 'object' ? opts.__batch : null;
  const resolved = resolveDownloadOptions(opts);
  const format = normalizeFormat(opts.format);
  const quality = resolved.quality;
  const videoQuality = resolved.videoQuality;
  const [tool, ffmpeg] = await Promise.all([probeTool(), probeFfmpeg()]);

  // Cancellation/shutdown can happen during the probe await. Check the batch
  // token before doing any work that could spawn yt-dlp.
  if (shuttingDown) return { ok: false, error: 'shutting-down' };
  if (batchOwner && (batchOwner.cancelRequested || batch !== batchOwner)) {
    return { ok: false, error: 'cancelled' };
  }

  if (!tool) {
    recordError('yt-dlp was not found.', clean);
    return { ok: false, error: 'tool-missing' };
  }
  if (format === 'mp3' && !ffmpeg) {
    const lastErrorInfo = recordError('MP3 downloads require FFmpeg. Install FFmpeg and try again.', clean);
    return {
      ok: false,
      error: 'ffmpeg-missing',
      message: lastErrorInfo.message
    };
  }
  if (jobs.has(clean.videoId)) return { ok: false, error: 'already-running' };
  if (findItem(clean.videoId)) return { ok: false, error: 'duplicate' };

  const dir = getDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {}

  const audio = AUDIO_FORMATS.includes(format);
  const embedMetadata = Boolean(ffmpeg) && resolved.embedMetadata;
  const embedThumbnail = Boolean(ffmpeg) && audio && resolved.embedThumbnail;
  const sponsorblock = Boolean(ffmpeg) && resolved.sponsorblock;

  let sponsorBlockCategories = [];
  if (sponsorblock) {
    try {
      sponsorBlockCategories = sanitizeSponsorBlockCategories(config.get().sponsorBlock.categories);
    } catch (error) {
      sponsorBlockCategories = [];
    }
  }

  const args = buildDownloadArgs({
    format,
    quality,
    videoQuality,
    hasFfmpeg: Boolean(ffmpeg),
    embedMetadata,
    embedThumbnail,
    sponsorblock,
    sponsorBlockCategories
  });

  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg.path);

  const baseName = uniqueBaseName(clean, dir);
  args.push('-o', outputTemplate(baseName, dir), clean.url);

  // Final guard immediately before spawning: a batch cancel or app shutdown
  // during any earlier step must never start another yt-dlp process.
  if (shuttingDown) return { ok: false, error: 'shutting-down' };
  if (batchOwner && (batchOwner.cancelRequested || batch !== batchOwner)) {
    return { ok: false, error: 'cancelled' };
  }

  let child;
  try {
    child = spawn(tool.path, args, {
      windowsHide: true,
      cwd: dir,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
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
    dir,
    format,
    quality,
    videoQuality,
    embedMetadata,
    embedThumbnail,
    sponsorblock,
    batchId: String(opts.batchId || ''),
    playlistTitle: String(opts.playlistTitle || opts.playlist || '').replace(/\s+/g, ' ').trim().slice(0, 150),
    filePath: '',
    finalDestination: '',
    existingDestination: '',
    tail: '',
    percent: 0,
    phase: '',
    lastError: ''
  };
  jobs.set(job.id, job);
  emit({
    type: 'start',
    id: job.id,
    videoId: clean.videoId,
    title: clean.title,
    format,
    quality,
    videoQuality,
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
    captureDestination(job, line);

    const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
      job.percent = Math.max(0, Math.min(100, Number(match[1]) || 0));
      job.phase = '';
      emit({
        type: 'progress',
        id: job.id,
        videoId: job.meta.videoId,
        batchId: job.batchId,
        percent: job.percent
      });
    }
    if (/\[ExtractAudio\]|\[Merger\]|\[Metadata\]|\[ThumbnailsConvertor\]|\[EmbedThumbnail\]|\[SponsorBlock\]|\[VideoRemuxer\]|\[VideoConvertor\]|\[FixupM3u8\]/.test(line)) {
      job.percent = 100;
      job.phase = phaseForFormat(format);
      emit({
        type: 'progress',
        id: job.id,
        videoId: job.meta.videoId,
        batchId: job.batchId,
        percent: 100,
        phase: job.phase
      });
    }
  };

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    pending += text;
    job.tail = `${job.tail}${text}`.slice(-12000);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) handleLine(line);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderr = `${stderr}${text}`.slice(-6000);
    job.tail = `${job.tail}${text}`.slice(-12000);
  });

  child.on('error', (error) => {
    if (job.finished) return;
    job.finished = true;
    jobs.delete(job.id);
    if (!job.cancelled) {
      cleanupJobFiles(job, 'fail');
      job.lastError = error.message;
      recordError(error.message, job.meta);
    }
    emit({
      type: 'error',
      id: job.id,
      videoId: job.meta.videoId,
      batchId: job.batchId,
      message: error.message,
      retryable: false
    });
    finishBatchItem(job, false);
  });
  child.on('close', (code, signal) => finishJob(job, code, signal, stderr));

  return { ok: true, id: job.id, baseName, format, dir };
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    // yt-dlp spawns FFmpeg as a child; taskkill /T prevents orphaned encoders.
    const taskkill = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe')
      : 'taskkill';
    try {
      execFile(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } catch (error) {}
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      try {
        child.kill('SIGKILL');
      } catch (killError) {}
    }
  }

  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch (error) {}
  }, 5000);
  if (timer.unref) timer.unref();
}

function cancel(id) {
  const key = String(id || '');

  if (batch && batch.id === key) {
    const current = batch;
    // Mark the token first: pumpBatch may be inside start()'s probe await and
    // must be able to see the cancellation before it spawns yt-dlp.
    current.cancelRequested = true;
    const job = jobs.get(current.currentId || '');
    if (job) {
      job.cancelled = true;
      killProcessTree(job.child);
    }
    failBatch(current, 'Playlist download cancelled.');
    return true;
  }

  const job = jobs.get(key);
  if (!job) return false;
  job.cancelled = true;
  killProcessTree(job.child);
  return true;
}

function remove(id) {
  const key = String(id || '');
  cancel(key);
  const item = index.find((entry) => entry.id === key) || null;
  if (!item) return false;

  const file = safeItemFile(item);
  if (file) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      // Keep the entry if Windows still has the file locked; reporting success
      // here would make the file disappear from the library while staying on
      // disk.
      return false;
    }
  } else if (!isDefinitelyMissing(item.file)) {
    // A temporarily unavailable network folder is not permission to forget
    // the item (and later let a new download overwrite it).
    return false;
  }

  // Explicit removal is already acknowledged by the caller; only stale
  // entries discovered elsewhere emit the 'removed' refresh event.
  dropIndexItem(key, { notify: false });
  return true;
}

async function retry(meta, options = {}) {
  const clean = sanitizeMeta(meta);
  if (!clean) return { ok: false, error: 'invalid' };
  if (shuttingDown) return { ok: false, error: 'shutting-down' };
  if (updating) return { ok: false, error: 'tool-updating', message: 'Wait for the yt-dlp update to finish.' };
  if (jobs.has(clean.videoId)) return { ok: false, error: 'already-running' };

  // findItem() drops a stale entry whose file no longer exists, so a retry can
  // legitimately re-download it.
  if (findItem(clean.videoId)) return { ok: false, error: 'duplicate' };

  cleanupForRetry(clean, getDir());
  appendLog(`[${clean.title}] retrying download`);
  return start(clean, options);
}

async function openFolder() {
  const dir = getDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {}
  await shell.openPath(dir);
}

async function openLog() {
  const file = logPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.closeSync(fs.openSync(file, 'a'));
  } catch (error) {}
  try {
    const error = await shell.openPath(file);
    return !error;
  } catch (error) {
    return false;
  }
}

function reveal(id) {
  const resolved = resolveMedia(id);
  if (!resolved) return false;
  shell.showItemInFolder(resolved.file);
  return true;
}

function shutdown() {
  shuttingDown = true;
  if (batch) {
    batch.cancelRequested = true;
    batch = null;
  }
  for (const job of jobs.values()) {
    job.cancelled = true;
    killProcessTree(job.child);
  }
  jobs = new Map();
  updating = false;
}

module.exports = {
  init,
  getStatus,
  list,
  start,
  startMany,
  retry,
  cancel,
  remove,
  resolveMedia,
  installTool,
  updateTool,
  openFolder,
  openLog,
  reveal,
  getDir,
  setDir,
  getLastError,
  shutdown,
  _internal: require('./download-utils')._internal
};

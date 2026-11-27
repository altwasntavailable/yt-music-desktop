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

let onEvent = () => {};
let jobs = new Map();
let index = [];
let initialized = false;
let probeCache = { at: 0, tool: null };
let probePromise = null;
let installing = false;

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

  // Drop entries whose file vanished from disk.
  const dir = downloadDir();
  const kept = [];
  for (const item of index) {
    const file = path.join(dir, path.basename(String(item.file || '')));
    if (item.file && fs.existsSync(file)) {
      kept.push({ ...item, file });
    }
  }
  index = kept;
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

async function getStatus() {
  const tool = await probeTool();
  return {
    ready: Boolean(tool),
    version: tool ? tool.version : null,
    toolPath: tool ? tool.path : null,
    installing,
    dir: downloadDir(),
    count: index.length,
    active: Array.from(jobs.keys())
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
  if (!file.startsWith(dir)) return null;
  if (!fs.existsSync(file)) return null;
  return { item, file };
}

function removeFilesFor(videoId) {
  try {
    const dir = downloadDir();
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(`${videoId}.`)) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch (error) {}
      }
    }
  } catch (error) {}
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

function finishJob(job, code, signal, stderr) {
  jobs.delete(job.id);

  if (job.cancelled) {
    removeFilesFor(job.meta.videoId);
    emit({ type: 'cancelled', id: job.id });
    return;
  }

  if (code !== 0) {
    removeFilesFor(job.meta.videoId);
    const message = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]
      || `yt-dlp exited with code ${code}${signal ? ` (${signal})` : ''}.`;
    emit({ type: 'error', id: job.id, videoId: job.meta.videoId, message });
    return;
  }

  const dir = downloadDir();
  let file = '';
  try {
    const match = fs.readdirSync(dir).find((name) => name.startsWith(`${job.meta.videoId}.`));
    if (match) file = path.join(dir, match);
  } catch (error) {}

  if (!file) {
    emit({ type: 'error', id: job.id, videoId: job.meta.videoId, message: 'The downloaded file could not be found.' });
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
    size,
    addedAt: Date.now()
  };

  index = index.filter((entry) => entry.id !== item.id);
  index.push(item);
  writeIndex();
  emit({ type: 'complete', item });
}

async function start(meta) {
  const clean = sanitizeMeta(meta);
  if (!clean) return { ok: false, error: 'invalid' };

  const tool = await probeTool();
  if (!tool) return { ok: false, error: 'tool-missing' };
  if (jobs.has(clean.videoId)) return { ok: false, error: 'already-running' };
  if (findItem(clean.videoId)) return { ok: false, error: 'duplicate' };

  const dir = downloadDir();
  fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, '%(id)s.%(ext)s');

  const args = [
    '--no-playlist',
    '--no-part',
    '--newline',
    '--no-warnings',
    '-f',
    'bestaudio[ext=m4a]/bestaudio/best',
    '-o',
    output,
    clean.url
  ];

  let child;
  try {
    child = spawn(tool.path, args, { windowsHide: true });
  } catch (error) {
    return { ok: false, error: 'spawn-failed', message: error.message };
  }

  const job = { id: clean.videoId, meta: clean, child, cancelled: false };
  jobs.set(job.id, job);
  emit({ type: 'start', id: job.id, videoId: clean.videoId, title: clean.title });

  let stderr = '';
  let pending = '';

  const handleLine = (line) => {
    const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
      emit({ type: 'progress', id: job.id, videoId: job.meta.videoId, percent: Number(match[1]) });
    }
    if (/\[ExtractAudio\]|\[Metadata\]|\[ThumbnailsConvertor\]/.test(line)) {
      emit({ type: 'progress', id: job.id, videoId: job.meta.videoId, percent: 100, phase: 'Processing…' });
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
    jobs.delete(job.id);
    emit({ type: 'error', id: job.id, videoId: job.meta.videoId, message: error.message });
  });
  child.on('close', (code, signal) => finishJob(job, code, signal, stderr));

  return { ok: true, id: job.id };
}

function cancel(id) {
  const job = jobs.get(String(id || ''));
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
  cancel,
  remove,
  resolveMedia,
  installTool,
  openFolder,
  reveal,
  shutdown
};

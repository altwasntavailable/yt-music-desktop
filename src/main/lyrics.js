'use strict';

/**
 * LRCLIB lyrics lookup.
 *
 * The official YouTube Music player does not expose its lyrics through a public
 * API, so we use LRCLIB (https://lrclib.net) for synced and plain lyrics. The
 * renderer also offers a button that opens YouTube Music's own lyrics panel as
 * a fallback.
 */

const BASE_URL = 'https://lrclib.net';
const USER_AGENT = 'YT Music Desktop v1.0.0 (https://github.com/local/yt-music-desktop)';
const REQUEST_GAP_MS = 260;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;

const cache = new Map();
let lastRequestAt = 0;
let requestChain = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function netFetch() {
  if (process.versions.electron) {
    try {
      const { net } = require('electron');
      if (net && typeof net.fetch === 'function') return net.fetch.bind(net);
    } catch {
      // Fall through to the global fetch implementation.
    }
  }
  return globalThis.fetch.bind(globalThis);
}

async function fetchJson(path, params) {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return scheduleRequest(async () => {
    const wait = Math.max(0, REQUEST_GAP_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await netFetch()(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'X-User-Agent': USER_AGENT,
          'Lrclib-Client': USER_AGENT
        },
        signal: controller.signal
      });

      if (response.status === 404) {
        return { ok: false, notFound: true, status: 404 };
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after')) || 30;
        return {
          ok: false,
          status: 429,
          error: `Lyrics service is rate limited. Try again in ${Math.ceil(retryAfter)} seconds.`,
          retryAfter
        };
      }

      if (!response.ok) {
        let message = `Lyrics service returned HTTP ${response.status}.`;
        try {
          const body = await response.json();
          if (body && body.message) message = body.message;
        } catch {
          // Ignore non-JSON error bodies.
        }
        return { ok: false, status: response.status, error: message };
      }

      const data = await response.json();
      return { ok: true, data };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        return { ok: false, error: 'Lyrics request timed out.' };
      }
      return { ok: false, error: error && error.message ? error.message : 'Could not reach LRCLIB.' };
    } finally {
      clearTimeout(timer);
    }
  });
}

function scheduleRequest(fn) {
  const next = requestChain.then(fn, fn);
  requestChain = next.catch(() => {});
  return next;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(feat|ft|featuring)\b[\s\S]*$/i, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NOISE_WORDS = /(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?|visuali[sz]er|audio|video|hd|hq|4k|8k|remaster(?:ed)?|explicit|clean|m\/v|mv|performance)/i;

function cleanTitle(title) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';

  let cleaned = raw
    .replace(/\s*[([{][^)\]}]*[)\]}]/g, (match) => (NOISE_WORDS.test(match) ? ' ' : match))
    .replace(/\s*[-–—]\s*(official|lyric|audio|video|visuali[sz]er|hd|hq|4k|remaster).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Don't throw away a title that consists entirely of something like "(Live)".
  return cleaned || raw;
}

function cleanArtist(artist) {
  return String(artist || '')
    .replace(/\s*-\s*topic\s*$/i, '')
    .replace(/\s*\bVEVO\b\s*$/i, '')
    .replace(/\s*•.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function primaryArtist(artist) {
  const cleaned = cleanArtist(artist);
  return cleaned
    .split(/\s*(?:,|;|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i)[0]
    .replace(/\s+/g, ' ')
    .trim() || cleaned;
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = String(value || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokenSimilarity(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length > 2 && nb.length > 2 && (na.includes(nb) || nb.includes(na))) return 0.9;

  const aTokens = new Set(na.split(' ').filter(Boolean));
  const bTokens = new Set(nb.split(' ').filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  const dice = (2 * intersection) / (aTokens.size + bTokens.size);
  return Math.max(0, Math.min(1, dice));
}

function durationSimilarity(a, b) {
  const da = Number(a);
  const db = Number(b);
  if (!Number.isFinite(da) || !Number.isFinite(db) || da <= 0 || db <= 0) return 0.5;
  return Math.max(0, 1 - Math.abs(da - db) / 20);
}

function scoreCandidate(meta, candidate) {
  const titleScore = tokenSimilarity(meta.title, candidate.trackName);
  const artistScore = meta.artist ? tokenSimilarity(meta.artist, candidate.artistName) : 0.5;
  const durationScore = durationSimilarity(meta.duration, candidate.duration);

  let score = titleScore * 0.55 + artistScore * 0.3 + durationScore * 0.15;
  if (candidate.syncedLyrics) score += 0.035;
  if (candidate.instrumental) score -= 0.01;
  if (meta.duration && candidate.duration) {
    const diff = Math.abs(Number(meta.duration) - Number(candidate.duration));
    if (diff > 25) score -= 0.12;
    if (diff <= 2) score += 0.03;
  }
  return Math.max(0, Math.min(1, score));
}

function hasLyrics(candidate) {
  return Boolean(candidate && (candidate.instrumental || candidate.syncedLyrics || candidate.plainLyrics));
}

function cacheKey(meta) {
  return [
    normalizeText(meta.title),
    normalizeText(meta.artist),
    Math.round(Number(meta.duration) || 0)
  ].join('|');
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  const ttl = entry.result && entry.result.found ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function setCached(key, result) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), result });
}

function buildExactAttempts(meta) {
  const titles = unique([meta.title, cleanTitle(meta.title)]);
  const artists = unique([cleanArtist(meta.artist), primaryArtist(meta.artist)]);
  const attempts = [];

  for (const title of titles) {
    for (const artist of artists) {
      if (!title || !artist) continue;
      attempts.push({
        track_name: title,
        artist_name: artist,
        album_name: meta.album || undefined,
        duration: Number(meta.duration) > 1 && Number(meta.duration) < 3600
          ? Math.round(Number(meta.duration))
          : undefined
      });
    }
  }

  // Cap exact lookups; the search endpoint is the better fallback for noisy titles.
  return attempts.slice(0, 2);
}

function buildSearchAttempts(meta) {
  const title = cleanTitle(meta.title);
  const artist = primaryArtist(meta.artist);
  const fullArtist = cleanArtist(meta.artist);
  const attempts = [];

  if (title) {
    attempts.push({
      track_name: title,
      artist_name: fullArtist || undefined
    });
    if (artist && normalizeText(artist) !== normalizeText(fullArtist)) {
      attempts.push({
        track_name: title,
        artist_name: artist
      });
    }
  }
  if (title && (fullArtist || artist)) {
    attempts.push({ q: `${title} ${fullArtist || artist}` });
  }
  if (meta.title && normalizeText(meta.title) !== normalizeText(title)) {
    attempts.push({ q: meta.title });
  }

  return attempts.slice(0, 4);
}

function pickBest(meta, candidates) {
  const seen = new Set();
  const scored = [];

  for (const candidate of candidates) {
    if (!candidate || !hasLyrics(candidate)) continue;
    const key = candidate.id != null
      ? `id:${candidate.id}`
      : `${candidate.trackName}|${candidate.artistName}|${candidate.duration}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({ candidate, score: scoreCandidate(meta, candidate) });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best.score < 0.42) return null;

  // Prefer a synced record if it is nearly as good as the best match.
  if (!best.candidate.syncedLyrics) {
    const synced = scored.find((entry) => entry.candidate.syncedLyrics && entry.score >= best.score - 0.08);
    if (synced) return synced;
  }

  return best;
}

function toResult(match) {
  const candidate = match.candidate;
  return {
    ok: true,
    found: true,
    source: 'LRCLIB',
    score: Number(match.score.toFixed(3)),
    instrumental: Boolean(candidate.instrumental),
    syncedLyrics: candidate.syncedLyrics || null,
    plainLyrics: candidate.plainLyrics || null,
    matched: {
      id: candidate.id,
      trackName: candidate.trackName || '',
      artistName: candidate.artistName || '',
      albumName: candidate.albumName || '',
      duration: candidate.duration || 0
    }
  };
}

async function fetchLyrics(metaInput, options = {}) {
  const meta = {
    title: String((metaInput && metaInput.title) || '').replace(/\s+/g, ' ').trim(),
    artist: String((metaInput && metaInput.artist) || '').replace(/\s+/g, ' ').trim(),
    album: String((metaInput && metaInput.album) || '').replace(/\s+/g, ' ').trim(),
    duration: Number(metaInput && metaInput.duration) || 0,
    videoId: String((metaInput && metaInput.videoId) || '').trim()
  };

  if (!meta.title) {
    return { ok: true, found: false, source: 'LRCLIB', reason: 'no-track' };
  }

  const key = cacheKey(meta);
  if (!options.force) {
    const cached = getCached(key);
    if (cached) return cached;
  }

  const candidates = [];
  let lastError = null;

  for (const params of buildExactAttempts(meta)) {
    const response = await fetchJson('/api/get', params);
    if (response.ok && response.data && hasLyrics(response.data)) {
      candidates.push(response.data);
      if (response.data.syncedLyrics) break;
    } else if (response.status === 429) {
      lastError = response.error;
      break;
    } else if (!response.ok && response.status !== 404) {
      lastError = response.error || 'Could not reach LRCLIB.';
    }
  }

  if (!candidates.some((candidate) => candidate.syncedLyrics)) {
    for (const params of buildSearchAttempts(meta)) {
      const response = await fetchJson('/api/search', params);
      if (response.ok && Array.isArray(response.data)) {
        candidates.push(...response.data);
      } else if (response.status === 429) {
        lastError = response.error;
        break;
      } else if (!response.ok && response.status !== 404) {
        lastError = response.error || 'Could not reach LRCLIB.';
      }
    }
  }

  const match = pickBest(meta, candidates);
  if (match) {
    const result = toResult(match);
    setCached(key, result);
    return result;
  }

  if (lastError) {
    return { ok: false, found: false, source: 'LRCLIB', error: lastError };
  }

  const result = { ok: true, found: false, source: 'LRCLIB' };
  setCached(key, result);
  return result;
}

module.exports = {
  fetchLyrics,
  // Exported for tests.
  _internal: {
    normalizeText,
    cleanTitle,
    cleanArtist,
    primaryArtist,
    tokenSimilarity,
    scoreCandidate
  }
};

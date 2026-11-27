'use strict';

const { net } = require('electron');

const API_BASE = 'https://sponsor.ajay.app/api/skipSegments';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const cache = new Map();

function normalizeVideoId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : '';
}

function cacheKey(videoId, categories) {
  return `${videoId}|${categories.slice().sort().join(',')}`;
}

async function fetchSegments(videoId, categories) {
  const id = normalizeVideoId(videoId);
  if (!id) return [];
  const cats = Array.isArray(categories) && categories.length
    ? categories.slice().sort()
    : ['sponsor'];

  const key = cacheKey(id, cats);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.segments;

  const url = `${API_BASE}?videoID=${encodeURIComponent(id)}`
    + `&categories=${encodeURIComponent(JSON.stringify(cats))}`;

  let segments = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await net.fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data)) {
        segments = data
          .map((entry) => ({
            category: String(entry.category || ''),
            start: Number(entry.segment && entry.segment[0]),
            end: Number(entry.segment && entry.segment[1]),
            uuid: String(entry.UUID || '')
          }))
          .filter((entry) => Number.isFinite(entry.start)
            && Number.isFinite(entry.end)
            && entry.end > entry.start);
      }
    }
  } catch (error) {
    // Offline or blocked: an empty list simply means nothing is skipped.
  }

  cache.set(key, { at: Date.now(), segments });
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return segments;
}

module.exports = { fetchSegments };

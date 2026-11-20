const log = require('../../utils/logger');

const BASE_URL = process.env.REALDEBRID_API_URL || 'https://api.real-debrid.com/rest/1.0';
const LIST_CACHE_MS = 60 * 1000;
const LINK_CACHE_MS = 30 * 60 * 1000;
const PACKS_TO_INSPECT = 25;

const listCache = new Map();
const linkCache = new Map();

async function request(token, path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 204) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`Real-Debrid answered HTTP ${response.status} for ${path.split('?')[0]}`);
  }
  return response.json();
}

async function cachedList(token, path) {
  const cacheKey = `${token.slice(-6)}:${path}`;
  const cached = listCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < LIST_CACHE_MS) {
    return cached.items;
  }
  const items = await request(token, path);
  listCache.set(cacheKey, { items, loadedAt: Date.now() });
  return items;
}

async function unrestrict(token, link) {
  const body = new URLSearchParams({ link });
  const result = await request(token, '/unrestrict/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  return result.download || null;
}

async function searchTorrents(token, size) {
  const torrents = await cachedList(token, '/torrents?limit=100');
  const exact = torrents.filter((torrent) => Number(torrent.bytes) === size);
  const packs = torrents.filter((torrent) => Number(torrent.bytes) > size).slice(0, PACKS_TO_INSPECT);
  for (const torrent of [...exact, ...packs]) {
    try {
      const info = await request(token, `/torrents/info/${encodeURIComponent(torrent.id)}`);
      const selectedFiles = (info.files || []).filter((file) => file.selected === 1);
      const fileIndex = selectedFiles.findIndex((file) => Number(file.bytes) === size);
      if (fileIndex === -1) {
        continue;
      }
      const link = (info.links || [])[fileIndex] || ((info.links || []).length === 1 ? info.links[0] : null);
      if (link) {
        return { url: await unrestrict(token, link), filename: selectedFiles[fileIndex].path.split('/').pop() };
      }
    } catch (error) {
      log.debug(() => `[AudioSync] Real-Debrid torrent ${torrent.id}: ${error.message}`);
    }
  }
  return null;
}

/** Direct download link of the account file with exactly this size, or null. */
async function findStreamBySize(token, size) {
  const numericSize = Number(size);
  if (!token || !Number.isFinite(numericSize) || numericSize <= 0) {
    return null;
  }
  const cacheKey = `${token.slice(-6)}:${numericSize}`;
  const cached = linkCache.get(cacheKey);
  if (cached && Date.now() - cached.foundAt < LINK_CACHE_MS) {
    return cached.stream;
  }
  const downloads = await cachedList(token, '/downloads?limit=100');
  const download = downloads.find((item) => Number(item.filesize) === numericSize && item.download);
  const stream = download
    ? { url: download.download, filename: download.filename }
    : await searchTorrents(token, numericSize);
  if (stream && stream.url) {
    linkCache.set(cacheKey, { stream, foundAt: Date.now() });
    return stream;
  }
  return null;
}

module.exports = {
  findStreamBySize
};

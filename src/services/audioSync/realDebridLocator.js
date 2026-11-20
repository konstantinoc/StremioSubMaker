const log = require('../../utils/logger');

const BASE_URL = process.env.REALDEBRID_API_URL || 'https://api.real-debrid.com/rest/1.0';
const LIST_CACHE_MS = 60 * 1000;
const LINK_CACHE_MS = 30 * 60 * 1000;
const RECENT_DOWNLOAD_MS = (Number(process.env.AUDIO_SYNC_RECENT_MINUTES) || 15) * 60 * 1000;
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

async function cachedList(token, path, maxAgeMs = LIST_CACHE_MS) {
  const cacheKey = `${token.slice(-6)}:${path}`;
  const cached = listCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < maxAgeMs) {
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

function baseName(path) {
  return String(path || '').split('/').pop().trim().toLowerCase();
}

function normalizeTarget({ size, filename }) {
  const numericSize = Number(size);
  return {
    size: Number.isFinite(numericSize) && numericSize > 0 ? numericSize : null,
    filename: baseName(filename) || null
  };
}

function matchesFile(target, fileSize, filePath) {
  if (target.size !== null) {
    return Number(fileSize) === target.size;
  }
  return target.filename !== null && baseName(filePath) === target.filename;
}

async function searchTorrents(token, target) {
  const torrents = await cachedList(token, '/torrents?limit=100');
  const candidates = target.size !== null
    ? [
      ...torrents.filter((torrent) => Number(torrent.bytes) === target.size),
      ...torrents.filter((torrent) => Number(torrent.bytes) > target.size).slice(0, PACKS_TO_INSPECT)
    ]
    : torrents.slice(0, PACKS_TO_INSPECT);
  for (const torrent of candidates) {
    try {
      const info = await request(token, `/torrents/info/${encodeURIComponent(torrent.id)}`);
      const selectedFiles = (info.files || []).filter((file) => file.selected === 1);
      const fileIndex = selectedFiles.findIndex((file) => matchesFile(target, file.bytes, file.path));
      if (fileIndex === -1) {
        continue;
      }
      const links = info.links || [];
      const link = links[fileIndex] || (links.length === 1 ? links[0] : null);
      if (link) {
        return { url: await unrestrict(token, link), filename: selectedFiles[fileIndex].path.split('/').pop() };
      }
    } catch (error) {
      log.debug(() => `[AudioSync] Real-Debrid torrent ${torrent.id}: ${error.message}`);
    }
  }
  return null;
}

/*
 * Torrentio and similar addons unrestrict the link on Real-Debrid when play is
 * pressed, so with no size or name to go by, the newest download generated in
 * the last few minutes is the file being played.
 */
async function mostRecentDownload(token) {
  const downloads = await cachedList(token, '/downloads?limit=20', 5000);
  const newest = downloads
    .filter((item) => item.download && Date.now() - Date.parse(item.generated) < RECENT_DOWNLOAD_MS)
    .sort((first, second) => Date.parse(second.generated) - Date.parse(first.generated))[0];
  return newest ? { url: newest.download, filename: newest.filename } : null;
}

/** Direct link of the playing file: by exact size, else by file name, else the newest recent download. */
async function findStream(token, video) {
  if (!token) {
    return null;
  }
  const target = normalizeTarget(video || {});
  if (target.size === null && target.filename === null) {
    const recent = await mostRecentDownload(token);
    return recent ? { ...recent, matchedBy: 'most recent download' } : null;
  }
  const matchedBy = target.size !== null ? 'size' : 'file name';
  const cacheKey = `${token.slice(-6)}:${target.size ?? target.filename}`;
  const cached = linkCache.get(cacheKey);
  if (cached && Date.now() - cached.foundAt < LINK_CACHE_MS) {
    return cached.stream;
  }
  const downloads = await cachedList(token, '/downloads?limit=100');
  const download = downloads.find((item) => item.download && matchesFile(target, item.filesize, item.filename));
  let stream = download
    ? { url: download.download, filename: download.filename, matchedBy }
    : await searchTorrents(token, target);
  if (stream && !stream.matchedBy) {
    stream = { ...stream, matchedBy };
  }
  if (!stream || !stream.url) {
    const recent = await mostRecentDownload(token);
    return recent ? { ...recent, matchedBy: `most recent download (no ${matchedBy} match)` } : null;
  }
  linkCache.set(cacheKey, { stream, foundAt: Date.now() });
  return stream;
}

module.exports = {
  findStream
};

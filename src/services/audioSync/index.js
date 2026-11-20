const { LRUCache } = require('lru-cache');
const log = require('../../utils/logger');
const { parseCues, shiftSubtitleContent } = require('./subtitleTiming');
const { MIN_OPENING_CUES, selectOpeningDialogue, audioWindowMs, findOffset } = require('./alignment');
const { extractSpeechScores } = require('./speechDetector');
const { findStream } = require('./realDebridLocator');

const MAX_SHIFT_MS = (Number(process.env.AUDIO_SYNC_MAX_SHIFT_SECONDS) || 60) * 1000;
const MAX_AUDIO_MS = (Number(process.env.AUDIO_SYNC_MAX_AUDIO_SECONDS) || 900) * 1000;
const FINAL_WAIT_MS = Number(process.env.AUDIO_SYNC_WAIT_MS) || 45000;
const MIN_APPLIED_OFFSET_MS = 100;

const offsetsByKey = new LRUCache({ max: 1000, ttl: 24 * 60 * 60 * 1000 });
const pendingByKey = new Map();
const reportedSkips = new LRUCache({ max: 500, ttl: 10 * 60 * 1000 });

function realDebridToken() {
  return String(process.env.REALDEBRID_API_KEY || '').trim();
}

function describeVideo(videoSize, filename) {
  const numericSize = Number(videoSize);
  return {
    size: Number.isFinite(numericSize) && numericSize > 0 ? numericSize : null,
    filename: String(filename || '').trim() || null
  };
}

function isActive(config, sourceFileId) {
  if (config?.audioAutoSyncMode !== true) {
    return false;
  }
  if (realDebridToken()) {
    return true;
  }
  const skipKey = `no-token|${sourceFileId}`;
  if (!reportedSkips.has(skipKey)) {
    reportedSkips.set(skipKey, true);
    log.warn(() => `[AudioSync] Skipped for ${sourceFileId || 'subtitle'}: REALDEBRID_API_KEY is not set on the server`);
  }
  return false;
}

function buildKey(video, sourceFileId) {
  const identity = video.size !== null ? `s:${video.size}` : (video.filename ? `f:${video.filename.toLowerCase()}` : 'recent');
  return `${identity}|${sourceFileId}`;
}

async function computeOffset(video, subtitleContent) {
  const openingCues = selectOpeningDialogue(parseCues(subtitleContent));
  if (openingCues.length < MIN_OPENING_CUES) {
    return { offsetMs: 0, reason: `only ${openingCues.length} dialogue lines in subtitle`, retry: true };
  }
  const stream = await findStream(realDebridToken(), video);
  if (!stream) {
    const wanted = video.size !== null ? `size ${video.size}` : (video.filename ? `name ${video.filename}` : 'recent download');
    return { offsetMs: 0, reason: `no Real-Debrid file found (${wanted})`, retry: true };
  }
  const window = audioWindowMs(openingCues, MAX_SHIFT_MS);
  const durationMs = Math.min(MAX_AUDIO_MS, window.durationMs);
  const startedAt = Date.now();
  log.warn(() => `[AudioSync] Reading ${Math.round(durationMs / 1000)}s of audio from ${(window.startMs / 1000).toFixed(0)}s in ` +
    `${stream.filename || 'Real-Debrid stream'} (found by ${stream.matchedBy})`);
  const speech = await extractSpeechScores(stream.url, window.startMs, durationMs);
  const result = findOffset(openingCues, speech, MAX_SHIFT_MS);
  log.warn(() => `[AudioSync] ${stream.filename || 'stream'}: first dialogue at ${(openingCues[0].start / 1000).toFixed(2)}s, ` +
    `offset ${result.offsetMs === null ? 'none' : `${result.offsetMs}ms`} (${result.reason || 'matched'}, ` +
    `score ${result.scorePerFrame}, margin ${result.marginPerFrame}, ${result.cues} lines, ${Date.now() - startedAt}ms)`);
  return { ...result, offsetMs: result.offsetMs ?? 0 };
}

/** Starts (once per video and source subtitle) measuring the subtitle offset against the stream audio. */
function prepare({ config, videoSize, filename, sourceFileId, subtitleContent }) {
  if (!sourceFileId || typeof subtitleContent !== 'string' || !isActive(config, sourceFileId)) {
    return null;
  }
  const video = describeVideo(videoSize, filename);
  const key = buildKey(video, sourceFileId);
  if (offsetsByKey.has(key)) {
    return Promise.resolve(offsetsByKey.get(key));
  }
  if (pendingByKey.has(key)) {
    return pendingByKey.get(key);
  }
  const pending = computeOffset(video, subtitleContent)
    .catch((error) => {
      log.warn(() => `[AudioSync] Could not sync ${sourceFileId}: ${error.message}`);
      return { offsetMs: 0, reason: error.message };
    })
    .then((result) => {
      if (!result.retry) {
        offsetsByKey.set(key, result);
      } else if (!reportedSkips.has(`${result.reason}|${key}`)) {
        reportedSkips.set(`${result.reason}|${key}`, true);
        log.warn(() => `[AudioSync] Skipped for ${sourceFileId}: ${result.reason}`);
      }
      pendingByKey.delete(key);
      return result;
    });
  pendingByKey.set(key, pending);
  return pending;
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
}

/*
 * Shifts subtitle content by the measured offset. Final content waits for a
 * running measurement (bounded by FINAL_WAIT_MS) because players cache it;
 * partial content is sent right away, shifted only if the offset is known.
 */
async function applyToContent(content, { config, videoSize, filename, sourceFileId, isFinal }) {
  if (!sourceFileId || typeof content !== 'string' || content.length === 0 || !isActive(config, sourceFileId)) {
    return content;
  }
  const key = buildKey(describeVideo(videoSize, filename), sourceFileId);
  let result = offsetsByKey.get(key);
  if (!result && isFinal) {
    const pending = pendingByKey.get(key) || prepare({ config, videoSize, filename, sourceFileId, subtitleContent: content });
    result = pending ? await withTimeout(pending, FINAL_WAIT_MS) : null;
    if (!result) {
      log.warn(() => `[AudioSync] Offset for ${sourceFileId} not ready after ${FINAL_WAIT_MS}ms, serving unsynced subtitle`);
    }
  }
  if (!result || Math.abs(result.offsetMs) < MIN_APPLIED_OFFSET_MS) {
    return content;
  }
  return shiftSubtitleContent(content, result.offsetMs);
}

module.exports = {
  isActive,
  prepare,
  applyToContent
};

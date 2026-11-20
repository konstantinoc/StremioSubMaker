const { LRUCache } = require('lru-cache');
const log = require('../../utils/logger');
const { parseCues, shiftSubtitleContent } = require('./subtitleTiming');
const { MIN_OPENING_CUES, selectOpeningDialogue, audioDurationNeededMs, findOffset } = require('./alignment');
const { extractSpeechScores } = require('./speechDetector');
const { findStreamBySize } = require('./realDebridLocator');

const MAX_SHIFT_MS = (Number(process.env.AUDIO_SYNC_MAX_SHIFT_SECONDS) || 90) * 1000;
const MAX_AUDIO_MS = (Number(process.env.AUDIO_SYNC_MAX_AUDIO_SECONDS) || 900) * 1000;
const FINAL_WAIT_MS = Number(process.env.AUDIO_SYNC_WAIT_MS) || 45000;
const MIN_APPLIED_OFFSET_MS = 100;

const offsetsByKey = new LRUCache({ max: 1000, ttl: 24 * 60 * 60 * 1000 });
const pendingByKey = new Map();

function realDebridToken() {
  return String(process.env.REALDEBRID_API_KEY || '').trim();
}

function normalizeVideoSize(videoSize) {
  const numericSize = Number(videoSize);
  return Number.isFinite(numericSize) && numericSize > 0 ? numericSize : null;
}

function isActive(config, videoSize) {
  return config?.audioAutoSyncMode === true && Boolean(realDebridToken()) && normalizeVideoSize(videoSize) !== null;
}

function buildKey(videoSize, sourceFileId) {
  return `${normalizeVideoSize(videoSize)}|${sourceFileId}`;
}

async function computeOffset(videoSize, subtitleContent) {
  const openingCues = selectOpeningDialogue(parseCues(subtitleContent));
  if (openingCues.length < MIN_OPENING_CUES) {
    return { offsetMs: 0, reason: `only ${openingCues.length} dialogue lines in subtitle`, retry: true };
  }
  const stream = await findStreamBySize(realDebridToken(), videoSize);
  if (!stream) {
    return { offsetMs: 0, reason: `no Real-Debrid file with size ${videoSize}`, retry: true };
  }
  const durationMs = Math.min(MAX_AUDIO_MS, audioDurationNeededMs(openingCues, MAX_SHIFT_MS));
  const startedAt = Date.now();
  const speech = await extractSpeechScores(stream.url, durationMs / 1000);
  const result = findOffset(openingCues, speech, MAX_SHIFT_MS);
  log.info(() => `[AudioSync] ${stream.filename || 'stream'}: first dialogue at ${(openingCues[0].start / 1000).toFixed(2)}s, ` +
    `offset ${result.offsetMs === null ? 'none' : `${result.offsetMs}ms`} (${result.reason || 'matched'}, ` +
    `score ${result.scorePerFrame}, margin ${result.marginPerFrame}, ${result.cues} lines, ${Date.now() - startedAt}ms)`);
  return { ...result, offsetMs: result.offsetMs ?? 0 };
}

/** Starts (once per video and source subtitle) measuring the subtitle offset against the stream audio. */
function prepare({ config, videoSize, sourceFileId, subtitleContent }) {
  if (!isActive(config, videoSize) || !sourceFileId || typeof subtitleContent !== 'string') {
    return null;
  }
  const key = buildKey(videoSize, sourceFileId);
  if (offsetsByKey.has(key)) {
    return Promise.resolve(offsetsByKey.get(key));
  }
  if (pendingByKey.has(key)) {
    return pendingByKey.get(key);
  }
  const pending = computeOffset(normalizeVideoSize(videoSize), subtitleContent)
    .catch((error) => {
      log.warn(() => `[AudioSync] Could not sync ${sourceFileId}: ${error.message}`);
      return { offsetMs: 0, reason: error.message };
    })
    .then((result) => {
      if (!result.retry) {
        offsetsByKey.set(key, result);
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
async function applyToContent(content, { config, videoSize, sourceFileId, isFinal }) {
  if (!isActive(config, videoSize) || !sourceFileId || typeof content !== 'string' || content.length === 0) {
    return content;
  }
  const key = buildKey(videoSize, sourceFileId);
  let result = offsetsByKey.get(key);
  if (!result && isFinal) {
    const pending = pendingByKey.get(key) || prepare({ config, videoSize, sourceFileId, subtitleContent: content });
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

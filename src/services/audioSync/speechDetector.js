const { spawn } = require('child_process');
const log = require('../../utils/logger');
const { createVadStream } = require('./vadScorer');

const SAMPLE_RATE = 16000;
const ENERGY_FRAME_MS = 20;
const ENERGY_FRAME_SAMPLES = (SAMPLE_RATE * ENERGY_FRAME_MS) / 1000;
const CHECK_EVERY_MS = 5000;
const EXTRACTION_TIMEOUT_MS = Number(process.env.AUDIO_SYNC_EXTRACTION_TIMEOUT_MS) || 240000;
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(fraction * (sortedValues.length - 1))));
  return sortedValues[index];
}

function smooth(values, radius) {
  const prefix = new Float64Array(values.length + 1);
  for (let index = 0; index < values.length; index++) {
    prefix[index + 1] = prefix[index] + values[index];
  }
  const result = new Float32Array(values.length);
  for (let index = 0; index < values.length; index++) {
    const from = Math.max(0, index - radius);
    const to = Math.min(values.length, index + radius + 1);
    result[index] = (prefix[to] - prefix[from]) / (to - from);
  }
  return result;
}

/*
 * Fallback when Silero VAD cannot load: per-frame log energy of the voice band,
 * centred on its median and clamped, so loud frames count as speech. It cannot
 * tell a voice from music.
 */
function energyScores(logEnergies) {
  const sorted = Float64Array.from(logEnergies).sort();
  const median = percentile(sorted, 0.5);
  const spread = Math.max(percentile(sorted, 0.9) - percentile(sorted, 0.2), 1e-3);
  const scores = new Float32Array(logEnergies.length);
  for (let index = 0; index < logEnergies.length; index++) {
    const centred = (logEnergies[index] - median) / spread;
    scores[index] = Math.max(-1.5, Math.min(1.5, centred * 2));
  }
  return smooth(scores, 5);
}

function createEnergyDetector() {
  const logEnergies = [];
  return {
    name: 'loudness',
    chunkSamples: ENERGY_FRAME_SAMPLES,
    frameMs: ENERGY_FRAME_MS,
    async addChunk(chunk) {
      let sumOfSquares = 0;
      for (let sample = 0; sample < chunk.length; sample++) {
        const value = chunk[sample] * 32768;
        sumOfSquares += value * value;
      }
      logEnergies.push(Math.log10(sumOfSquares / chunk.length + 1));
    },
    frameCount: () => logEnergies.length,
    scores: () => energyScores(logEnergies)
  };
}

async function createVoiceDetector() {
  const vad = await createVadStream();
  if (!vad) {
    return null;
  }
  const scores = [];
  return {
    name: 'Silero VAD',
    chunkSamples: vad.chunkSamples,
    frameMs: vad.frameMs,
    async addChunk(chunk) {
      scores.push((await vad.probability(chunk) - 0.5) * 3);
    },
    frameCount: () => scores.length,
    scores: () => Float32Array.from(scores)
  };
}

/*
 * Streams the audio window through ffmpeg into the voice detector and hands
 * the speech scores so far to checkProgress every five seconds of audio. When
 * checkProgress returns a value, ffmpeg is stopped so the rest of the window
 * is never downloaded.
 */
async function streamSpeech(mediaUrl, startMs, maxDurationMs, checkProgress) {
  const voiceDetector = process.env.AUDIO_SYNC_DETECTOR === 'loudness' ? null : await createVoiceDetector();
  const detector = voiceDetector || createEnergyDetector();
  const filterOptions = voiceDetector ? [] : ['-af', 'highpass=f=250,lowpass=f=3500'];
  const httpOptions = /^https?:\/\//i.test(mediaUrl)
    ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '20000000']
    : [];
  const seekOptions = startMs > 0 ? ['-ss', (startMs / 1000).toFixed(3)] : [];
  const args = [
    '-nostdin', '-hide_banner', '-nostats', '-loglevel', 'info',
    ...httpOptions,
    ...seekOptions,
    '-i', mediaUrl,
    '-t', (maxDurationMs / 1000).toFixed(3),
    '-map', '0:a:0?', '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', String(SAMPLE_RATE),
    ...filterOptions,
    '-f', 's16le', 'pipe:1'
  ];
  const checkEveryFrames = Math.round(CHECK_EVERY_MS / detector.frameMs);
  const speechSoFar = () => ({ frameMs: detector.frameMs, startMs, scores: detector.scores() });

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const spawnedAt = Date.now();
    const pendingBuffers = [];
    let carry = Buffer.alloc(0);
    let stderrText = '';
    let framesAtLastCheck = 0;
    let earlyResult = null;
    let firstAudioMs = null;
    let openedMs = null;
    let reconnects = 0;
    let pumping = null;
    let failure = null;

    const timer = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
    }, EXTRACTION_TIMEOUT_MS);

    const pump = async () => {
      const chunkBytes = detector.chunkSamples * 2;
      while (pendingBuffers.length && !earlyResult) {
        const buffer = Buffer.concat([carry, ...pendingBuffers.splice(0)]);
        const chunkCount = Math.floor(buffer.length / chunkBytes);
        for (let chunkIndex = 0; chunkIndex < chunkCount && !earlyResult; chunkIndex++) {
          const chunk = new Float32Array(detector.chunkSamples);
          const base = chunkIndex * chunkBytes;
          for (let sample = 0; sample < detector.chunkSamples; sample++) {
            chunk[sample] = buffer.readInt16LE(base + sample * 2) / 32768;
          }
          await detector.addChunk(chunk);
          if (checkProgress && detector.frameCount() - framesAtLastCheck >= checkEveryFrames) {
            framesAtLastCheck = detector.frameCount();
            earlyResult = checkProgress(speechSoFar()) || null;
            if (earlyResult) {
              ffmpeg.kill('SIGKILL');
            }
          }
        }
        carry = buffer.subarray(chunkCount * chunkBytes);
      }
    };
    const schedulePump = () => {
      if (!pumping) {
        pumping = pump()
          .catch((error) => {
            failure = error;
            ffmpeg.kill('SIGKILL');
          })
          .finally(() => {
            pumping = null;
            if (pendingBuffers.length && !earlyResult && !failure) {
              schedulePump();
            }
          });
      }
      return pumping;
    };

    ffmpeg.stdout.on('data', (chunk) => {
      if (earlyResult) {
        return;
      }
      if (firstAudioMs === null) {
        firstAudioMs = Date.now() - spawnedAt;
      }
      pendingBuffers.push(chunk);
      schedulePump();
    });
    ffmpeg.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (openedMs === null && text.includes('Input #0')) {
        openedMs = Date.now() - spawnedAt;
      }
      reconnects += (text.match(/reconnect/gi) || []).length;
      stderrText = (stderrText + text).slice(-2000);
    });
    ffmpeg.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg could not start (${FFMPEG_PATH}): ${error.message}`));
    });
    ffmpeg.on('close', async (code, signal) => {
      clearTimeout(timer);
      while (pumping) {
        await pumping;
      }
      const readMs = detector.frameCount() * detector.frameMs;
      const details = { readMs, openedMs, firstAudioMs, reconnects, detector: detector.name };
      if (failure) {
        reject(new Error(`voice detection failed: ${failure.message}`));
        return;
      }
      if (earlyResult) {
        resolve({ earlyResult, ...details });
        return;
      }
      if (readMs < maxDurationMs * 0.5) {
        reject(new Error(`ffmpeg returned only ${(readMs / 1000).toFixed(1)}s of audio (code ${code}, signal ${signal}): ${stderrText.trim().slice(-300)}`));
        return;
      }
      if (code !== 0) {
        log.debug(() => `[AudioSync] ffmpeg ended with code ${code} after ${(readMs / 1000).toFixed(1)}s of audio, using what was read`);
      }
      resolve({ speech: speechSoFar(), ...details });
    });
  });
}

module.exports = {
  streamSpeech
};

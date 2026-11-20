const { spawn } = require('child_process');
const log = require('../../utils/logger');

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;
const EXTRACTION_TIMEOUT_MS = Number(process.env.AUDIO_SYNC_EXTRACTION_TIMEOUT_MS) || 240000;
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const CHECK_EVERY_FRAMES = 250;

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(fraction * (sortedValues.length - 1))));
  return sortedValues[index];
}

/*
 * Turns per-frame log energy of the voice band into a centred speech score:
 * positive where the frame is louder than the typical level, negative where it
 * is quieter, clamped so a single explosion cannot dominate the alignment.
 */
function toSpeechScores(logEnergies) {
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
 * Streams the audio window through ffmpeg and hands the speech scores read so
 * far to checkProgress every few seconds of audio. When checkProgress returns
 * a value, ffmpeg is stopped so the rest of the window is never downloaded.
 */
function streamSpeech(mediaUrl, startMs, maxDurationMs, checkProgress) {
  return new Promise((resolve, reject) => {
    const httpOptions = /^https?:\/\//i.test(mediaUrl)
      ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '20000000']
      : [];
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      ...httpOptions,
      '-ss', (startMs / 1000).toFixed(3),
      '-i', mediaUrl,
      '-t', (maxDurationMs / 1000).toFixed(3),
      '-map', '0:a:0?', '-vn', '-sn', '-dn',
      '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-af', 'highpass=f=250,lowpass=f=3500',
      '-f', 's16le', 'pipe:1'
    ];
    const ffmpeg = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const logEnergies = [];
    let carry = Buffer.alloc(0);
    let stderrText = '';
    let framesAtLastCheck = 0;
    let earlyResult = null;

    const timer = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
    }, EXTRACTION_TIMEOUT_MS);

    const speechSoFar = () => ({ frameMs: FRAME_MS, startMs, scores: toSpeechScores(logEnergies) });

    ffmpeg.stdout.on('data', (chunk) => {
      if (earlyResult) {
        return;
      }
      const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const frameBytes = SAMPLES_PER_FRAME * 2;
      const frameCount = Math.floor(buffer.length / frameBytes);
      for (let frame = 0; frame < frameCount; frame++) {
        let sumOfSquares = 0;
        const base = frame * frameBytes;
        for (let sample = 0; sample < SAMPLES_PER_FRAME; sample++) {
          const value = buffer.readInt16LE(base + sample * 2);
          sumOfSquares += value * value;
        }
        logEnergies.push(Math.log10(sumOfSquares / SAMPLES_PER_FRAME + 1));
      }
      carry = buffer.subarray(frameCount * frameBytes);
      if (checkProgress && logEnergies.length - framesAtLastCheck >= CHECK_EVERY_FRAMES) {
        framesAtLastCheck = logEnergies.length;
        earlyResult = checkProgress(speechSoFar()) || null;
        if (earlyResult) {
          ffmpeg.kill('SIGKILL');
        }
      }
    });
    ffmpeg.stderr.on('data', (chunk) => {
      if (stderrText.length < 2000) {
        stderrText += chunk.toString();
      }
    });
    ffmpeg.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg could not start (${FFMPEG_PATH}): ${error.message}`));
    });
    ffmpeg.on('close', (code, signal) => {
      clearTimeout(timer);
      const readMs = logEnergies.length * FRAME_MS;
      if (earlyResult) {
        resolve({ earlyResult, readMs });
        return;
      }
      if (logEnergies.length < (maxDurationMs / FRAME_MS) * 0.5) {
        reject(new Error(`ffmpeg returned only ${(readMs / 1000).toFixed(1)}s of audio (code ${code}, signal ${signal}): ${stderrText.trim().slice(0, 300)}`));
        return;
      }
      if (code !== 0) {
        log.debug(() => `[AudioSync] ffmpeg ended with code ${code} after ${(readMs / 1000).toFixed(1)}s of audio, using what was read`);
      }
      resolve({ speech: speechSoFar(), readMs });
    });
  });
}

module.exports = {
  FRAME_MS,
  streamSpeech
};

const path = require('path');
const log = require('../../utils/logger');

const MODEL_PATH = path.join(__dirname, 'models', 'silero_vad_v5.onnx');
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 512;
const CONTEXT_SAMPLES = 64;

let sessionPromise = null;

function loadSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = require('onnxruntime-node');
      const session = await ort.InferenceSession.create(MODEL_PATH, { intraOpNumThreads: 1, interOpNumThreads: 1 });
      return { ort, session };
    })().catch((error) => {
      log.warn(() => `[AudioSync] Silero VAD unavailable, falling back to the loudness detector: ${error.message}`);
      return null;
    });
  }
  return sessionPromise;
}

/*
 * One Silero VAD stream: feed it 512-sample chunks of 16 kHz mono audio in
 * order and it returns the probability that each 32 ms chunk holds a voice.
 * The model is recurrent, so its state and the last 64 samples of context
 * carry over from one chunk to the next.
 */
async function createVadStream() {
  const loaded = await loadSession();
  if (!loaded) {
    return null;
  }
  const { ort, session } = loaded;
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  const sampleRate = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  let context = new Float32Array(CONTEXT_SAMPLES);
  return {
    chunkSamples: CHUNK_SAMPLES,
    frameMs: (CHUNK_SAMPLES * 1000) / SAMPLE_RATE,
    async probability(chunk) {
      const input = new Float32Array(CONTEXT_SAMPLES + CHUNK_SAMPLES);
      input.set(context, 0);
      input.set(chunk, CONTEXT_SAMPLES);
      const outputs = await session.run({
        input: new ort.Tensor('float32', input, [1, input.length]),
        state,
        sr: sampleRate
      });
      state = outputs.stateN;
      context = chunk.slice(CHUNK_SAMPLES - CONTEXT_SAMPLES);
      return outputs.output.data[0];
    }
  };
}

module.exports = {
  createVadStream
};

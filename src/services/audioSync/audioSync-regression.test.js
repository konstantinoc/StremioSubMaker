const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCues, isDialogueCue, shiftSubtitleContent } = require('./subtitleTiming');
const { selectOpeningDialogue, findOffset, findEarlyOffset, audioWindowMs } = require('./alignment');

const SRT = [
  '1', '00:00:01,000 --> 00:00:03,000', 'Subtitles by OpenSubtitles.org', '',
  '2', '00:01:00,500 --> 00:01:02,000', 'Where were you?', '',
  '3', '00:01:03,250 --> 00:01:05,000', '[door slams]', ''
].join('\n');

function buildCues(count) {
  const cues = [];
  let start = 20000;
  for (let index = 0; index < count; index++) {
    const length = 1200 + ((index * 733) % 2000);
    cues.push({ start, end: start + length, text: `Line ${index}` });
    start += length + 800 + ((index * 1291) % 3500);
  }
  return cues;
}

function buildSpeech(cues, offsetMs, frameMs, totalMs) {
  const scores = new Float32Array(Math.ceil(totalMs / frameMs)).fill(-1);
  for (const cue of cues) {
    for (let time = cue.start + offsetMs; time < cue.end + offsetMs; time += frameMs) {
      const frame = Math.floor(time / frameMs);
      if (frame >= 0 && frame < scores.length) {
        scores[frame] = 1;
      }
    }
  }
  for (let index = 0; index < scores.length; index++) {
    scores[index] += Math.sin(index * 12.9898) * 0.6;
  }
  return { frameMs, scores };
}

test('parses SRT cues and keeps only dialogue', () => {
  const cues = parseCues(SRT);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map(isDialogueCue), [false, true, false]);
});

test('shifts SRT, VTT and ASS timestamps and clamps at zero', () => {
  assert.match(shiftSubtitleContent(SRT, 1500), /00:01:02,000 --> 00:01:03,500/);
  assert.match(shiftSubtitleContent(SRT, -2000), /00:00:00,000 --> 00:00:01,000/);
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.500 align:start\nHello\n';
  assert.match(shiftSubtitleContent(vtt, 250), /00:00:01\.250 --> 00:00:02\.750 align:start/);
  const ass = '[Script Info]\nTitle: x\n\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Hi, there\n';
  assert.match(shiftSubtitleContent(ass, 1230), /Dialogue: 0,0:00:02\.23,0:00:03\.73,Default,,0,0,0,,Hi, there/);
});

test('finds the shift that puts the opening dialogue on speech', () => {
  const cues = buildCues(40);
  for (const offsetMs of [3200, -7400, 0]) {
    const speech = buildSpeech(cues, offsetMs, 20, 400000);
    const result = findOffset(selectOpeningDialogue(cues), speech, 30000);
    assert.ok(Math.abs(result.offsetMs - offsetMs) <= 40, `expected ${offsetMs}, got ${result.offsetMs}`);
  }
});

test('finds the shift when the audio starts at a seek position', () => {
  const cues = buildCues(40);
  const full = buildSpeech(cues, -2600, 20, 400000);
  const startMs = 9000;
  const speech = { frameMs: 20, startMs, scores: full.scores.slice(startMs / 20) };
  const result = findOffset(selectOpeningDialogue(cues), speech, 30000);
  assert.ok(Math.abs(result.offsetMs + 2600) <= 40, `expected -2600, got ${result.offsetMs}`);
});

test('refuses to shift when the audio has no speech pattern', () => {
  const cues = buildCues(40);
  const scores = new Float32Array(20000);
  for (let index = 0; index < scores.length; index++) {
    scores[index] = Math.sin(index * 78.233) * 0.5;
  }
  const result = findOffset(selectOpeningDialogue(cues), { frameMs: 20, scores }, 30000);
  assert.equal(result.offsetMs, null);
});

function streamUntilStable(cues, fullScores, startMs, maxShiftMs) {
  let previous = null;
  for (let frames = 250; frames <= fullScores.length; frames += 250) {
    const speech = { frameMs: 20, startMs, scores: fullScores.slice(0, frames) };
    const candidate = findEarlyOffset(cues, speech, maxShiftMs);
    if (candidate && previous && Math.abs(candidate.offsetMs - previous.offsetMs) <= 60) {
      return { ...candidate, readMs: frames * 20 };
    }
    previous = candidate;
  }
  return null;
}

function windowScores(cues, offsetMs, maxShiftMs, addNoise) {
  const opening = selectOpeningDialogue(cues);
  const window = audioWindowMs(opening, maxShiftMs);
  const full = buildSpeech(cues, offsetMs, 20, window.startMs + window.durationMs);
  const scores = full.scores.slice(window.startMs / 20);
  if (addNoise) {
    addNoise(scores, window.startMs);
  }
  return { opening, window, scores };
}

test('stops streaming early once the opening lines agree on a shift', () => {
  const cues = buildCues(60);
  for (const offsetMs of [3200, -16400, 47000]) {
    const { opening, window, scores } = windowScores(cues, offsetMs, 60000);
    const result = streamUntilStable(opening, scores, window.startMs, 60000);
    assert.ok(result, `no early result for ${offsetMs}`);
    assert.ok(Math.abs(result.offsetMs - offsetMs) <= 40, `expected ${offsetMs}, got ${result.offsetMs}`);
    assert.ok(result.readMs < window.durationMs * 0.75, `read ${result.readMs} of ${window.durationMs}`);
  }
});

test('loud music before the first dialogue does not end the stream on a wrong shift', () => {
  const cues = buildCues(60);
  const { opening, window, scores } = windowScores(cues, 5000, 60000, (values, startMs) => {
    for (let time = cues[0].start - 45000; time < cues[0].start + 4000; time += 20) {
      const frame = Math.floor((time - startMs) / 20);
      if (frame >= 0 && frame < values.length) {
        values[frame] = 1.4;
      }
    }
  });
  const result = streamUntilStable(opening, scores, window.startMs, 60000);
  if (result) {
    assert.ok(Math.abs(result.offsetMs - 5000) <= 40, `stopped on ${result.offsetMs}`);
  }
});

test('keeps streaming when the audio has no speech pattern', () => {
  const cues = buildCues(60);
  const scores = new Float32Array(15000);
  for (let index = 0; index < scores.length; index++) {
    scores[index] = Math.sin(index * 78.233) * 0.5;
  }
  const opening = selectOpeningDialogue(cues);
  assert.equal(streamUntilStable(opening, scores, audioWindowMs(opening, 60000).startMs, 60000), null);
});

function mockRealDebrid({ downloads = [], torrents = [], infos = {} }) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const path = url.replace(/^https:\/\/api\.real-debrid\.com\/rest\/1\.0/, '');
    calls.push(`${options.method || 'GET'} ${path.split('?')[0]}`);
    let body;
    if (path.startsWith('/downloads')) {
      body = downloads;
    } else if (path.startsWith('/torrents/info/')) {
      body = infos[path.split('/').pop()];
    } else if (path.startsWith('/torrents')) {
      body = torrents;
    } else if (path === '/unrestrict/link') {
      body = { download: `https://direct.example/${encodeURIComponent(new URLSearchParams(options.body).get('link'))}` };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

test('finds the Real-Debrid file by size, by name in a torrent, or as the newest download', async () => {
  const { findStream } = require('./realDebridLocator');
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  mockRealDebrid({
    downloads: [
      { filename: 'Old.Movie.mkv', filesize: 111, download: 'https://dl/old', generated: old },
      { filename: 'Just.Played.mkv', filesize: 222, download: 'https://dl/new', generated: now }
    ],
    torrents: [{ id: 'T1', bytes: 9999 }],
    infos: { T1: { files: [{ path: '/Show/Show.S01E01.mkv', bytes: 500, selected: 1 }, { path: '/Show/Show.S01E02.mkv', bytes: 600, selected: 1 }], links: ['https://rd/1', 'https://rd/2'] } }
  });

  const bySize = await findStream('token-size', { size: 111 });
  assert.equal(bySize.url, 'https://dl/old');
  assert.equal(bySize.matchedBy, 'size');

  const byName = await findStream('token-name', { filename: 'show.s01e02.mkv' });
  assert.equal(byName.url, `https://direct.example/${encodeURIComponent('https://rd/2')}`);
  assert.equal(byName.matchedBy, 'file name');

  const recent = await findStream('token-recent', {});
  assert.equal(recent.url, 'https://dl/new');
  assert.equal(recent.matchedBy, 'most recent download');

  const fallback = await findStream('token-miss', { filename: 'Not.In.Account.mkv' });
  assert.equal(fallback.url, 'https://dl/new');
  assert.match(fallback.matchedBy, /no file name match/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCues, isDialogueCue, shiftSubtitleContent } = require('./subtitleTiming');
const { selectOpeningDialogue, findOffset } = require('./alignment');

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

test('refuses to shift when the audio has no speech pattern', () => {
  const cues = buildCues(40);
  const scores = new Float32Array(20000);
  for (let index = 0; index < scores.length; index++) {
    scores[index] = Math.sin(index * 78.233) * 0.5;
  }
  const result = findOffset(selectOpeningDialogue(cues), { frameMs: 20, scores }, 30000);
  assert.equal(result.offsetMs, null);
});

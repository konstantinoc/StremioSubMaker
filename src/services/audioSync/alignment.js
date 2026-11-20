const { isDialogueCue } = require('./subtitleTiming');

const OPENING_WINDOW_MS = (Number(process.env.AUDIO_SYNC_OPENING_SECONDS) || 120) * 1000;
const MAX_OPENING_CUES = 80;
const MIN_OPENING_CUES = 6;
const OUT_OF_AUDIO_SCORE = -1;
const RIVAL_EXCLUSION_MS = 2000;
const MIN_MARGIN_PER_FRAME = 0.04;
const MIN_SCORE_PER_FRAME = 0.1;
const EARLY_CUES = Number(process.env.AUDIO_SYNC_EARLY_LINES) || 10;
const GAP_LIMIT_MS = 3000;
const EARLY_MIN_SCORE_PER_FRAME = 0.25;
const EARLY_MIN_MARGIN_PER_FRAME = 0.15;
const EARLY_SETTLE_MS = 3000;
const SMALL_SHIFT_RANGE_MS = 20000;

/** Dialogue cues from the first spoken line up to the end of the opening window. */
function selectOpeningDialogue(cues) {
  const dialogue = cues.filter(isDialogueCue);
  if (dialogue.length === 0) {
    return [];
  }
  const windowEnd = dialogue[0].start + OPENING_WINDOW_MS;
  return dialogue.filter((cue) => cue.start < windowEnd).slice(0, MAX_OPENING_CUES);
}

/** The stretch of audio that covers the opening dialogue at every shift searched. */
function audioWindowMs(openingCues, maxShiftMs) {
  if (openingCues.length === 0) {
    return { startMs: 0, durationMs: 0 };
  }
  const startMs = Math.max(0, openingCues[0].start - maxShiftMs - 2000);
  const endMs = openingCues[openingCues.length - 1].end + maxShiftMs + 2000;
  return { startMs, durationMs: endMs - startMs };
}

/*
 * Slides the opening dialogue cues across the speech score track and keeps the
 * shift where the cues sit on the most speech. The winner must clearly beat the
 * best shift more than two seconds away from it, otherwise the audio is too
 * ambiguous (music, no voice track) and no shift is returned.
 */
function findOffset(openingCues, speech, maxShiftMs) {
  if (openingCues.length < MIN_OPENING_CUES) {
    return { offsetMs: null, reason: `only ${openingCues.length} opening dialogue lines`, tooFewLines: true };
  }
  const { frameMs, scores } = speech;
  const audioStartMs = speech.startMs || 0;
  const prefix = new Float64Array(scores.length + 1);
  for (let index = 0; index < scores.length; index++) {
    prefix[index + 1] = prefix[index] + scores[index];
  }
  const cueFrames = openingCues.map((cue) => [Math.round((cue.start - audioStartMs) / frameMs), Math.round((cue.end - audioStartMs) / frameMs)]);
  const totalCueFrames = cueFrames.reduce((sum, [start, end]) => sum + (end - start), 0);
  const maxShiftFrames = Math.round(maxShiftMs / frameMs);
  const shiftCount = maxShiftFrames * 2 + 1;
  const scoreByShift = new Float64Array(shiftCount);

  for (let shiftIndex = 0; shiftIndex < shiftCount; shiftIndex++) {
    const shift = shiftIndex - maxShiftFrames;
    let total = 0;
    for (const [cueStart, cueEnd] of cueFrames) {
      const from = cueStart + shift;
      const to = cueEnd + shift;
      const clampedFrom = Math.max(0, Math.min(scores.length, from));
      const clampedTo = Math.max(0, Math.min(scores.length, to));
      total += prefix[clampedTo] - prefix[clampedFrom];
      total += OUT_OF_AUDIO_SCORE * ((to - from) - (clampedTo - clampedFrom));
    }
    scoreByShift[shiftIndex] = total;
  }

  let bestIndex = 0;
  for (let shiftIndex = 1; shiftIndex < shiftCount; shiftIndex++) {
    if (scoreByShift[shiftIndex] > scoreByShift[bestIndex]) {
      bestIndex = shiftIndex;
    }
  }
  const exclusionFrames = Math.round(RIVAL_EXCLUSION_MS / frameMs);
  let rivalScore = -Infinity;
  for (let shiftIndex = 0; shiftIndex < shiftCount; shiftIndex++) {
    if (Math.abs(shiftIndex - bestIndex) > exclusionFrames && scoreByShift[shiftIndex] > rivalScore) {
      rivalScore = scoreByShift[shiftIndex];
    }
  }

  const bestScore = scoreByShift[bestIndex];
  const scorePerFrame = bestScore / totalCueFrames;
  const marginPerFrame = (bestScore - rivalScore) / totalCueFrames;
  const offsetMs = (bestIndex - maxShiftFrames) * frameMs;
  const stats = { scorePerFrame: Number(scorePerFrame.toFixed(3)), marginPerFrame: Number(marginPerFrame.toFixed(3)), cues: openingCues.length };

  if (scorePerFrame < MIN_SCORE_PER_FRAME || marginPerFrame < MIN_MARGIN_PER_FRAME) {
    return { offsetMs: null, reason: 'no clear match between dialogue and speech', candidateMs: offsetMs, ...stats };
  }
  return { offsetMs, ...stats };
}

/*
 * Decides while the audio is still streaming. Only shifts whose first ten
 * dialogue lines already fall inside the audio read so far are compared, and
 * speech in the short gaps between those lines counts against a shift. The
 * best one is accepted when it clearly beats every other compared shift and
 * at least three seconds of later shifts were compared too, so the winner is
 * not merely the last shift the audio reaches. Returns null to keep reading.
 */
function findEarlyOffset(openingCues, speech, maxShiftMs) {
  if (openingCues.length < EARLY_CUES) {
    return null;
  }
  const { frameMs, scores } = speech;
  const audioStartMs = speech.startMs || 0;
  const cueFrames = openingCues.slice(0, EARLY_CUES)
    .map((cue) => [Math.round((cue.start - audioStartMs) / frameMs), Math.round((cue.end - audioStartMs) / frameMs)]);
  const gapLimitFrames = Math.round(GAP_LIMIT_MS / frameMs);
  const gapFrames = [];
  for (let index = 1; index < cueFrames.length; index++) {
    const gapStart = cueFrames[index - 1][1];
    const gapEnd = Math.min(cueFrames[index][0], gapStart + gapLimitFrames);
    if (gapEnd - gapStart >= 10) {
      gapFrames.push([gapStart, gapEnd]);
    }
  }
  const totalCueFrames = cueFrames.reduce((sum, [start, end]) => sum + (end - start), 0) +
    gapFrames.reduce((sum, [start, end]) => sum + (end - start), 0);
  const firstStart = cueFrames[0][0];
  const lastEnd = cueFrames[cueFrames.length - 1][1];
  const maxShiftFrames = Math.round(maxShiftMs / frameMs);
  const lowestShift = Math.max(-firstStart, -maxShiftFrames);
  const highestShift = Math.min(scores.length - lastEnd, maxShiftFrames);
  const reachedMaxShift = highestShift === maxShiftFrames;
  if (highestShift - lowestShift < Math.round(EARLY_SETTLE_MS / frameMs) * 2) {
    return null;
  }
  const prefix = new Float64Array(scores.length + 1);
  for (let index = 0; index < scores.length; index++) {
    prefix[index + 1] = prefix[index] + scores[index];
  }
  const scoreByShift = new Float64Array(highestShift - lowestShift + 1);
  for (let shift = lowestShift; shift <= highestShift; shift++) {
    let total = 0;
    for (const [cueStart, cueEnd] of cueFrames) {
      total += prefix[cueEnd + shift] - prefix[cueStart + shift];
    }
    for (const [gapStart, gapEnd] of gapFrames) {
      total -= prefix[gapEnd + shift] - prefix[gapStart + shift];
    }
    scoreByShift[shift - lowestShift] = total;
  }
  let bestIndex = 0;
  for (let index = 1; index < scoreByShift.length; index++) {
    if (scoreByShift[index] > scoreByShift[bestIndex]) {
      bestIndex = index;
    }
  }
  // In a small search range a wrong early peak is too close to the true shift, so every shift must be compared first
  const settleFrames = maxShiftMs <= SMALL_SHIFT_RANGE_MS ? Infinity : Math.round(EARLY_SETTLE_MS / frameMs);
  if (!reachedMaxShift && scoreByShift.length - 1 - bestIndex < settleFrames) {
    return null;
  }
  const exclusionFrames = Math.round(RIVAL_EXCLUSION_MS / frameMs);
  let rivalScore = -Infinity;
  for (let index = 0; index < scoreByShift.length; index++) {
    if (Math.abs(index - bestIndex) > exclusionFrames && scoreByShift[index] > rivalScore) {
      rivalScore = scoreByShift[index];
    }
  }
  const scorePerFrame = scoreByShift[bestIndex] / totalCueFrames;
  const marginPerFrame = (scoreByShift[bestIndex] - rivalScore) / totalCueFrames;
  if (scorePerFrame < EARLY_MIN_SCORE_PER_FRAME || marginPerFrame < EARLY_MIN_MARGIN_PER_FRAME) {
    return null;
  }
  return {
    offsetMs: (bestIndex + lowestShift) * frameMs,
    scorePerFrame: Number(scorePerFrame.toFixed(3)),
    marginPerFrame: Number(marginPerFrame.toFixed(3)),
    cues: EARLY_CUES
  };
}

module.exports = {
  MIN_OPENING_CUES,
  findEarlyOffset,
  selectOpeningDialogue,
  audioWindowMs,
  findOffset
};

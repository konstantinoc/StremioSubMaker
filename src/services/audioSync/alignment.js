const { isDialogueCue } = require('./subtitleTiming');

const OPENING_WINDOW_MS = 6 * 60 * 1000;
const MAX_OPENING_CUES = 80;
const MIN_OPENING_CUES = 6;
const OUT_OF_AUDIO_SCORE = -1;
const RIVAL_EXCLUSION_MS = 2000;
const MIN_MARGIN_PER_FRAME = 0.04;
const MIN_SCORE_PER_FRAME = 0.1;

/** Dialogue cues from the first spoken line up to the end of the opening window. */
function selectOpeningDialogue(cues) {
  const dialogue = cues.filter(isDialogueCue);
  if (dialogue.length === 0) {
    return [];
  }
  const windowEnd = dialogue[0].start + OPENING_WINDOW_MS;
  return dialogue.filter((cue) => cue.start < windowEnd).slice(0, MAX_OPENING_CUES);
}

function audioDurationNeededMs(openingCues, maxShiftMs) {
  if (openingCues.length === 0) {
    return 0;
  }
  return openingCues[openingCues.length - 1].end + maxShiftMs + 5000;
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
  const prefix = new Float64Array(scores.length + 1);
  for (let index = 0; index < scores.length; index++) {
    prefix[index + 1] = prefix[index] + scores[index];
  }
  const cueFrames = openingCues.map((cue) => [Math.round(cue.start / frameMs), Math.round(cue.end / frameMs)]);
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

module.exports = {
  MIN_OPENING_CUES,
  selectOpeningDialogue,
  audioDurationNeededMs,
  findOffset
};

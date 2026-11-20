const SRT_VTT_TIME = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})/g;
const ASS_TIME = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/;

const NON_DIALOGUE_PATTERNS = [
  /subtitles?\s+(by|from|ripped|downloaded)/i,
  /(synced|sync|corrected|translated|ripped|encoded|captioned|transcript)\s+(by|and)/i,
  /opensubtitles|subscene|addic7ed|podnapisi|yify|yts\b|subdl|subsource/i,
  /www\.|https?:\/\/|\.(com|org|net|gr|tv)\b/i,
  /TRANSLATION IN PROGRESS/i,
  /μετάφραση|υπότιτλ/i
];

function formatSrtTime(totalMs, separator) {
  const clamped = Math.max(0, Math.round(totalMs));
  const hours = Math.floor(clamped / 3600000);
  const minutes = Math.floor((clamped % 3600000) / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(millis, 3)}`;
}

function formatAssTime(totalMs) {
  const clamped = Math.max(0, Math.round(totalMs / 10) * 10);
  const hours = Math.floor(clamped / 3600000);
  const minutes = Math.floor((clamped % 3600000) / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const centis = Math.floor((clamped % 1000) / 10);
  const pad = (value) => String(value).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`;
}

function srtTimeToMs(hours, minutes, seconds, millis) {
  return ((Number(hours || 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(millis);
}

function assTimeToMs(value) {
  const match = ASS_TIME.exec(String(value).trim());
  if (!match) {
    return null;
  }
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]) * 10;
}

function isAssContent(content) {
  return /^\s*\[Script Info\]/im.test(content) && /^Dialogue:/m.test(content);
}

function splitAssDialogue(line) {
  const body = line.slice(line.indexOf(':') + 1);
  const fields = [];
  let rest = body;
  for (let index = 0; index < 9; index++) {
    const commaIndex = rest.indexOf(',');
    if (commaIndex === -1) {
      return null;
    }
    fields.push(rest.slice(0, commaIndex));
    rest = rest.slice(commaIndex + 1);
  }
  fields.push(rest);
  return fields;
}

function parseCues(content) {
  const text = String(content || '').replace(/\r\n?/g, '\n');
  const cues = [];
  if (isAssContent(text)) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('Dialogue:')) {
        continue;
      }
      const fields = splitAssDialogue(line);
      if (!fields) {
        continue;
      }
      const start = assTimeToMs(fields[1]);
      const end = assTimeToMs(fields[2]);
      if (start !== null && end !== null && end > start) {
        cues.push({ start, end, text: fields[9].replace(/\{[^}]*\}/g, '').replace(/\\N/gi, ' ') });
      }
    }
    return cues.sort((first, second) => first.start - second.start);
  }
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) {
      continue;
    }
    const times = [...lines[timingIndex].matchAll(SRT_VTT_TIME)];
    if (times.length < 2) {
      continue;
    }
    const start = srtTimeToMs(times[0][1], times[0][2], times[0][3], times[0][4]);
    const end = srtTimeToMs(times[1][1], times[1][2], times[1][3], times[1][4]);
    if (end > start) {
      cues.push({ start, end, text: lines.slice(timingIndex + 1).join(' ') });
    }
  }
  return cues.sort((first, second) => first.start - second.start);
}

function isDialogueCue(cue) {
  const plain = String(cue.text || '').replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').trim();
  if (!plain) {
    return false;
  }
  if (/^[[(].*[\])]$/.test(plain) || /[♪♫#]/.test(plain)) {
    return false;
  }
  if (!/\p{L}/u.test(plain)) {
    return false;
  }
  return !NON_DIALOGUE_PATTERNS.some((pattern) => pattern.test(plain));
}

function shiftSubtitleContent(content, offsetMs) {
  const text = String(content || '');
  if (!offsetMs) {
    return text;
  }
  if (isAssContent(text)) {
    return text.replace(/^Dialogue:[^\n]*/gm, (line) => {
      const fields = splitAssDialogue(line);
      if (!fields) {
        return line;
      }
      const start = assTimeToMs(fields[1]);
      const end = assTimeToMs(fields[2]);
      if (start === null || end === null) {
        return line;
      }
      fields[1] = formatAssTime(start + offsetMs);
      fields[2] = formatAssTime(end + offsetMs);
      return `Dialogue:${fields.join(',')}`;
    });
  }
  return text.replace(/^[^\n]*-->[^\n]*$/gm, (line) => line.replace(SRT_VTT_TIME, (match, hours, minutes, seconds, millis) => {
    const separator = match.includes(',') ? ',' : '.';
    return formatSrtTime(srtTimeToMs(hours, minutes, seconds, millis) + offsetMs, separator);
  }));
}

module.exports = {
  parseCues,
  isDialogueCue,
  shiftSubtitleContent
};

const DEGREE_USAGES = [0x1d, 0x1b, 0x06, 0x19, 0x05, 0x11, 0x10];
const PHYSICAL_KEY_USAGES = [...DEGREE_USAGES, 0x36];
const DEGREE_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const HIGH_ONE_USAGE = 0x36;
const MOUSE_LEFT = 0x01;
const MOUSE_RIGHT = 0x02;
const MOUSE_MIDDLE = 0x04;
const MUSIC_MAGIC = 0x3153554d;
const HEADER_SIZE = 32;
const EVENT_SIZE = 4;
const MAX_EVENTS = (4096 - HEADER_SIZE) / EVENT_SIZE;
const PREVIEW_SAMPLE_RATE = 44100;

let audioContext = null;
let activePreview = null;
let physicalBankPromise = null;
/**
 * 试听「代」计数：每次开始或停止都推进一代。
 *
 * 渲染是异步的（要读音色库、铺 PCM），期间可能已经被停止、或被另一首歌的试听取代。
 * 那一次渲染回到主流程时如果照样 start()，就会出现「点了停止音乐还响」
 * —— 而且此时界面已经回到「试听」，用户根本没有停止入口。
 */
let previewGeneration = 0;

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(array, offset, value) {
  array[offset] = value & 0xff;
  array[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(array, offset, value) {
  array[offset] = value & 0xff;
  array[offset + 1] = (value >>> 8) & 0xff;
  array[offset + 2] = (value >>> 16) & 0xff;
  array[offset + 3] = (value >>> 24) & 0xff;
}

function hidToSemitone(keyUsage, mouseButtons) {
  if (keyUsage === 0) {
    if (mouseButtons) throw new Error("休止事件不能包含鼠标修饰键");
    return null;
  }
  if (mouseButtons & ~0x07) throw new Error("未知鼠标修饰位");
  if ((mouseButtons & MOUSE_LEFT) && (mouseButtons & MOUSE_RIGHT)) throw new Error("降调和升调不能同时按下");
  const octave = mouseButtons & MOUSE_LEFT ? -1 : mouseButtons & MOUSE_RIGHT ? 1 : 0;
  const sharp = mouseButtons & MOUSE_MIDDLE ? 1 : 0;
  if (keyUsage === HIGH_ONE_USAGE) return octave * 12 + 12 + sharp;
  const degreeIndex = DEGREE_USAGES.indexOf(keyUsage);
  if (degreeIndex < 0) throw new Error(`未知键盘 HID usage 0x${keyUsage.toString(16).toUpperCase().padStart(2, "0")}`);
  return octave * 12 + DEGREE_SEMITONES[degreeIndex] + sharp;
}

function parseScore(text, rhythm) {
  const notes = [];
  const source = String(text || "");
  let octave = 0;
  let closing = "";
  let opening = -1;
  let sharpAt = -1;
  let modifierAllowed = false;
  let dotted = false;
  let extended = false;
  let reductions = 0;
  let explicitDuration = false;
  let skipUntil = 0;
  const fail = (index, message) => { throw new Error(`第 ${index + 1} 个字符：${message}`); };

  for (let index = 0; index < source.length; index += 1) {
    if (index < skipUntil) continue;
    const char = source[index];
    if (/\s/.test(char) || char === "\ufeff") continue;
    if (char === "|" || char === "｜") {
      modifierAllowed = false;
      continue;
    }
    if (rhythm && char === ":") {
      if (!modifierAllowed || !notes.length || sharpAt >= 0) fail(index, "指定拍数位置无效");
      if (explicitDuration || dotted || extended || reductions) fail(index, "指定拍数不能与其他时值符号混用");
      const match = source.slice(index + 1).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if (!match) fail(index, "冒号后面缺少拍数");
      const beats = Number(match[0]);
      if (!(beats > 0 && beats <= 64)) fail(index, "指定拍数须大于 0 且不超过 64 拍");
      notes.at(-1).beats = beats;
      explicitDuration = true;
      skipUntil = index + 1 + match[0].length;
      continue;
    }
    if (rhythm && "-—_.".includes(char)) {
      if (!modifierAllowed || !notes.length || sharpAt >= 0) fail(index, "时值符号位置无效");
      if (explicitDuration) fail(index, "指定拍数不能与其他时值符号混用");
      const previous = notes.at(-1);
      if (char === "_") {
        if (dotted || extended || reductions >= 2) fail(index, "减时符最多两条");
        reductions += 1;
        previous.beats /= 2;
      } else if (char === ".") {
        if (dotted || extended) fail(index, "仅支持一个附点");
        dotted = true;
        previous.beats *= 1.5;
      } else {
        extended = true;
        previous.beats += 1;
        if (previous.beats > 64) fail(index, "单个音或休止最多 64 拍");
      }
      continue;
    }
    if (char === "@") {
      if (closing) fail(index, "物理键码不能写在音区括号内");
      if (sharpAt >= 0) fail(sharpAt, "# 不能修饰物理键码");
      const match = source.slice(index).match(/^@([0-9a-f]{2})([0-9a-f]{2})/i);
      if (!match) fail(index, "物理键码应写成 @键盘HID鼠标位，例如 @1D00");
      const keyUsage = Number.parseInt(match[1], 16);
      const mouseButtons = Number.parseInt(match[2], 16);
      try {
        if (hidToSemitone(keyUsage, mouseButtons) === null) fail(index, "休止请直接写 0");
      } catch (error) {
        fail(index, error.message);
      }
      notes.push({ degree: PHYSICAL_KEY_USAGES.indexOf(keyUsage) + 1, octave: 0, sharp: false, beats: 1, keyUsage, mouseButtons });
      modifierAllowed = true;
      dotted = false;
      extended = false;
      reductions = 0;
      explicitDuration = false;
      skipUntil = index + match[0].length;
      continue;
    }
    if ("【（(".includes(char)) {
      if (closing) fail(index, "不支持嵌套音区括号");
      if (sharpAt >= 0) fail(sharpAt, "请把 # 写在括号内音符之前，例如【#6】");
      octave = char === "【" ? 1 : -1;
      closing = char === "【" ? "】" : char === "（" ? "）" : ")";
      opening = index;
    } else if ("】）)".includes(char)) {
      if (char !== closing) fail(index, "结束括号不匹配");
      if (sharpAt >= 0) fail(sharpAt, "# 后面缺少音符");
      octave = 0;
      closing = "";
    } else if (char === "#") {
      if (sharpAt >= 0) fail(index, "不支持连续 #");
      sharpAt = index;
    } else if (char >= "0" && char <= "7") {
      const degree = Number(char);
      if (degree === 0 && sharpAt >= 0) fail(index, "休止符不能升半音");
      notes.push({ degree, octave, sharp: sharpAt >= 0, beats: 1, keyUsage: null, mouseButtons: null });
      modifierAllowed = true;
      dotted = false;
      extended = false;
      reductions = 0;
      explicitDuration = false;
      sharpAt = -1;
    } else {
      fail(index, `无法识别“${char}”`);
    }
  }
  if (sharpAt >= 0) fail(sharpAt, "# 后面缺少音符");
  if (closing) fail(opening, "缺少结束括号");
  if (!notes.length) throw new Error("没有可演奏的音符");
  return notes;
}

function noteToHid(note) {
  if (note.keyUsage !== null) return { keyUsage: note.keyUsage, mouseButtons: note.mouseButtons };
  if (note.degree === 0) return { keyUsage: 0, mouseButtons: 0 };
  const keyUsage = note.octave === 1 && note.degree === 1 ? HIGH_ONE_USAGE : DEGREE_USAGES[note.degree - 1];
  let mouseButtons = 0;
  if (note.octave === -1) mouseButtons |= MOUSE_LEFT;
  if (note.octave === 1 && note.degree !== 1) mouseButtons |= MOUSE_RIGHT;
  if (note.sharp) mouseButtons |= MOUSE_MIDDLE;
  return { keyUsage, mouseButtons };
}

function transposeNote(note, semitones) {
  if (!semitones || note.degree === 0) return note;
  if (note.keyUsage !== null) throw new Error("物理音色不能再整体移调");
  const value = note.octave * 12 + DEGREE_SEMITONES[note.degree - 1] + (note.sharp ? 1 : 0) + semitones;
  if (value < -12 || value > 24) throw new Error(`音符移调 ${semitones > 0 ? "+" : ""}${semitones} 后超出游戏音域`);
  if (value === 24) return { ...note, degree: 7, octave: 1, sharp: true };
  const octave = Math.floor(value / 12);
  const chromatic = ((value % 12) + 12) % 12;
  const degreeMap = [[1, false], [1, true], [2, false], [2, true], [3, false], [4, false], [4, true], [5, false], [5, true], [6, false], [6, true], [7, false]];
  const [degree, sharp] = degreeMap[chromatic];
  return { ...note, degree, octave, sharp };
}

function roundHalfEven(value) {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (Math.abs(fraction - 0.5) < Number.EPSILON * Math.max(1, value) * 2) return lower % 2 === 0 ? lower : lower + 1;
  return Math.round(value);
}

export function compileSong(song) {
  const rhythm = Boolean(song.rhythm);
  const bpm = Number(song.bpm || 120);
  const gapMs = Number(song.gap_ms ?? 20);
  const beatMs = rhythm ? 60000 / bpm : Number(song.note_ms || 300);
  const transpose = Number(song.transpose_semitones || 0);
  if (transpose < -12 || transpose > 12) throw new Error("整体移调须在 -12～+12 个半音");
  const notes = parseScore(song.score, rhythm).map((note) => transposeNote(note, transpose));
  const events = notes.map((note) => {
    const durationMs = roundHalfEven(note.beats * beatMs);
    const hid = noteToHid(note);
    if (hid.keyUsage && durationMs - gapMs < 40) throw new Error("音符有效时间不足 40 ms");
    return { ...hid, durationMs, note };
  });
  if (events.length > MAX_EVENTS) throw new Error(`曲目事件超过单槽 ${MAX_EVENTS} 个上限`);
  const eventData = new Uint8Array(events.length * EVENT_SIZE);
  events.forEach((event, index) => {
    const offset = index * EVENT_SIZE;
    writeU16(eventData, offset, event.durationMs);
    eventData[offset + 2] = event.keyUsage;
    eventData[offset + 3] = event.mouseButtons;
  });
  const durationMs = events.reduce((sum, event) => sum + event.durationMs, 0);
  const header = new Uint8Array(HEADER_SIZE);
  writeU32(header, 0, MUSIC_MAGIC);
  writeU16(header, 4, 2);
  writeU16(header, 6, HEADER_SIZE);
  writeU16(header, 8, events.length);
  writeU16(header, 10, gapMs);
  writeU32(header, 12, crc32(eventData));
  writeU32(header, 16, durationMs);
  writeU32(header, 20, rhythm ? 1 : 0);
  const musicId = Number(song.music_id || 0);
  if (!Number.isInteger(musicId) || musicId < 0 || musicId > 0x7fffffff) throw new Error("音乐编号无效");
  writeU32(header, 24, musicId);
  writeU32(header, 28, crc32(header.slice(0, 28)));
  const packageBytes = new Uint8Array(header.length + eventData.length);
  packageBytes.set(header);
  packageBytes.set(eventData, header.length);
  return { events, notes, durationMs, gapMs, packageBytes };
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function readWavPcm(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) throw new Error("音色 WAV 格式无效");
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    if (id === 0x64617461) return new Int16Array(arrayBuffer, offset + 8, Math.floor(size / 2));
    offset += 8 + size + (size & 1);
  }
  throw new Error("音色 WAV 缺少 PCM 数据");
}

async function loadPhysicalBank() {
  physicalBankPromise ||= Promise.all([
    fetch("./assets/harmonica-physical-sprite.json").then((response) => {
      if (!response.ok) throw new Error(`音色索引 HTTP ${response.status}`);
      return response.json();
    }),
    fetch("./assets/harmonica-physical-sprite.wav").then((response) => {
      if (!response.ok) throw new Error(`音色文件 HTTP ${response.status}`);
      return response.arrayBuffer();
    }),
  ]).then(([manifest, wav]) => {
    if (manifest.formatVersion !== 1 || manifest.sampleRate !== PREVIEW_SAMPLE_RATE) throw new Error("物理音色库版本或采样率无效");
    return { manifest, pcm: readWavPcm(wav) };
  });
  return physicalBankPromise;
}

function recordedWave(sample, count, loopStart, loopEnd) {
  const output = new Float32Array(count);
  const prefixCount = Math.min(count, sample.length);
  for (let index = 0; index < prefixCount; index += 1) output[index] = sample[index] / 32768;
  if (count <= sample.length) return output;
  let cursor = prefixCount;
  const loopSize = loopEnd - loopStart;
  const crossfade = Math.min(Math.floor(0.12 * PREVIEW_SAMPLE_RATE), Math.floor(loopSize / 3));
  while (cursor < count) {
    const overlap = Math.min(crossfade, cursor, loopSize);
    const start = cursor - overlap;
    const available = Math.min(loopSize, count - start);
    for (let index = 0; index < overlap; index += 1) {
      const ramp = index / overlap;
      output[start + index] = output[start + index] * (1 - ramp) + (sample[loopStart + index] / 32768) * ramp;
    }
    const fresh = available - overlap;
    if (fresh <= 0) break;
    for (let index = 0; index < fresh; index += 1) output[cursor + index] = sample[loopStart + overlap + index] / 32768;
    cursor += fresh;
  }
  return output;
}

function synthesizedWave(semitone, count) {
  const output = new Float32Array(count);
  const frequency = 261.625565 * 2 ** (semitone / 12);
  for (let index = 0; index < count; index += 1) {
    const time = index / PREVIEW_SAMPLE_RATE;
    const vibrato = 0.003 * Math.sin(2 * Math.PI * 5.2 * time);
    const angle = 2 * Math.PI * frequency * (time + vibrato / frequency);
    output[index] = 0.32 * (Math.sin(angle) + 0.3 * Math.sin(2 * angle) + 0.13 * Math.sin(3 * angle)) / 1.43;
  }
  return output;
}

function shapeNote(wave, repeatedPhysical) {
  const attack = Math.min(Math.floor(wave.length / 3), Math.max(1, Math.floor(PREVIEW_SAMPLE_RATE * (repeatedPhysical ? 0.026 : 0.008))));
  const release = Math.min(Math.floor(wave.length / 3), Math.max(1, Math.floor(PREVIEW_SAMPLE_RATE * 0.015)));
  for (let index = 0; index < wave.length; index += 1) {
    const elapsed = index / PREVIEW_SAMPLE_RATE;
    const progress = Math.min(1, elapsed / 1.2);
    const smooth = progress * progress * (3 - 2 * progress);
    const continued = Math.max(0, elapsed - 1.2);
    wave[index] *= 0.78 + 0.22 * smooth + 0.8 * (1 - Math.exp(-continued / 1.5));
  }
  for (let index = 0; index < attack; index += 1) wave[index] *= index / attack;
  for (let index = 0; index < release; index += 1) wave[wave.length - release + index] *= 1 - index / Math.max(1, release - 1);
}

async function renderPreview(compiled) {
  let bank = null;
  try {
    bank = await loadPhysicalBank();
  } catch {
    physicalBankPromise = null;
  }
  const counts = compiled.events.map((event) => Math.max(1, Math.round(event.durationMs * PREVIEW_SAMPLE_RATE / 1000)));
  const output = new Float32Array(counts.reduce((sum, count) => sum + count, 0));
  let outputOffset = 0;
  let previousPhysical = null;
  compiled.events.forEach((event, eventIndex) => {
    const count = counts[eventIndex];
    const semitone = hidToSemitone(event.keyUsage, event.mouseButtons);
    if (semitone === null) {
      outputOffset += count;
      previousPhysical = null;
      return;
    }
    const soundingMs = Math.max(1, event.durationMs - Math.max(0, compiled.gapMs));
    const soundingCount = Math.min(count, Math.max(1, Math.round(soundingMs * PREVIEW_SAMPLE_RATE / 1000)));
    const physical = `${event.keyUsage.toString(16).toUpperCase().padStart(2, "0")}:${event.mouseButtons.toString(16).toUpperCase().padStart(2, "0")}`;
    const info = bank?.manifest.samples[physical];
    const sample = info ? bank.pcm.subarray(info.offset, info.offset + info.length) : null;
    const wave = sample ? recordedWave(sample, soundingCount, bank.manifest.loopStart, bank.manifest.loopEnd) : synthesizedWave(semitone, soundingCount);
    shapeNote(wave, physical === previousPhysical);
    for (let index = 0; index < soundingCount; index += 1) output[outputOffset + index] = Math.max(-1, Math.min(1, wave[index] * 0.82));
    outputOffset += count;
    previousPhysical = physical;
  });
  return output;
}

export function stopPreview() {
  // 先推进一代：让「正在渲染但还没出声」的那次作废。
  previewGeneration += 1;
  if (!activePreview) return;
  window.clearTimeout(activePreview.timer);
  for (const source of activePreview.sources) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  const done = activePreview.onDone;
  activePreview = null;
  done?.();
}

export async function startPreview(compiled, onDone) {
  stopPreview();
  const generation = previewGeneration;
  const pcm = await renderPreview(compiled);
  // 渲染期间被停止、或被更新的试听取代：直接放弃，不要出声
  if (generation !== previewGeneration) return;
  audioContext ||= new AudioContext({ sampleRate: PREVIEW_SAMPLE_RATE });
  await audioContext.resume();
  // resume() 同样是异步的，期间也可能已经被停止
  if (generation !== previewGeneration) return;
  const buffer = audioContext.createBuffer(1, pcm.length, PREVIEW_SAMPLE_RATE);
  buffer.copyToChannel(pcm, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.start();
  const timer = window.setTimeout(() => {
    const done = activePreview?.onDone;
    activePreview = null;
    done?.();
  }, Math.ceil(pcm.length * 1000 / PREVIEW_SAMPLE_RATE) + 100);
  activePreview = { sources: [source], timer, onDone };
}

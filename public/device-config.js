// Wire formats shared with the SJZ PyQt USB transport and CH32 APP.
export const KEYBOARD_MODE_PER_KEY = 0x80;
export const KEYBOARD_FORMAT_SPIN = 2;
export const KEYBOARD_FORMAT_SPEED = 3;
export const SPIN_DEFAULT_COUNTS = 12000;
export const SPIN_DEFAULT_CYCLE_MS = 500;
export const LED_FIXED_BRIGHTNESS = 128;

export const KEY_USAGES = {
  ...Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((key, index) => [key, 0x04 + index])),
  ...Object.fromEntries([..."123456789"].map((key, index) => [key, 0x1e + index])),
  "0": 0x27, Enter: 0x28, Esc: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
  "Caps Lock": 0x39,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, 0x3a + index])),
  "Print Screen": 0x46, "Scroll Lock": 0x47, Pause: 0x48, Insert: 0x49,
  Home: 0x4a, "Page Up": 0x4b, Delete: 0x4c, End: 0x4d, "Page Down": 0x4e,
  Right: 0x4f, Left: 0x50, Down: 0x51, Up: 0x52, "Num Lock": 0x53,
};
export const USAGE_KEYS = Object.fromEntries(Object.entries(KEY_USAGES).map(([key, usage]) => [usage, key]));
export const MODIFIER_BITS = { Ctrl: 1, Shift: 2, Alt: 4, Win: 8 };

const u16 = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);
const put16 = (bytes, offset, value) => { bytes[offset] = value & 255; bytes[offset + 1] = (value >>> 8) & 255; };

export function spinCounts(mouse, horizontal) {
  const x = Math.round(Number(mouse) * 100) / 100;
  const y = Math.round(Number(horizontal) * 100) / 100;
  if (!(x >= 0.1 && x <= 10 && y >= 0.1 && y <= 6)) throw new Error("鼠标灵敏度须为 0.1～10，水平灵敏度须为 0.1～6");
  return Math.max(100, Math.min(50000, Math.round(36000 / x / y)));
}

export function keyIsMusic(mode, slot) {
  return mode === 0 || Boolean(mode & KEYBOARD_MODE_PER_KEY && mode & (1 << slot));
}

export function keyIsSpin(mode, slot) {
  return Boolean(mode & KEYBOARD_MODE_PER_KEY && mode & (1 << (slot + 3)));
}

export function modeFromMappings(mappings) {
  if (mappings.length !== 3) throw new Error("必须设置 K1～K3");
  const roles = mappings.map((item) => item.role || "key");
  if (roles.some((role) => !["key", "music", "spin"].includes(role))) throw new Error("键位角色无效");
  if (roles.every((role) => role === "music")) return 0;
  if (roles.every((role) => role === "key")) return 1;
  return KEYBOARD_MODE_PER_KEY | roles.reduce((mask, role, slot) =>
    mask | (role === "music" ? 1 << slot : role === "spin" ? 1 << (slot + 3) : 0), 0);
}

export function decodeKeyboardConfig(payload, generation = 0, responseFormat = payload[0]) {
  const bytes = Uint8Array.from(payload);
  if (![1, 2, 3].includes(responseFormat) || bytes[0] !== responseFormat ||
      bytes.length !== (responseFormat === 3 ? 14 : 8)) throw new Error("键位配置格式无效");
  const mode = bytes[1];
  if (mode !== 0 && mode !== 1 && !(mode & KEYBOARD_MODE_PER_KEY)) throw new Error("键盘模式无效");
  if (mode & KEYBOARD_MODE_PER_KEY &&
      ((mode & (responseFormat === 1 ? ~0x87 : ~0xbf)) || ((mode & 7) & ((mode >> 3) & 7)))) {
    throw new Error("键盘角色位无效");
  }
  const mappings = [0, 1, 2].map((slot) => {
    const offset = 2 + slot * 2;
    if (keyIsSpin(mode, slot)) {
      if (responseFormat === 1) throw new Error("旧版键位格式不支持旋转");
      const counts = u16(bytes, offset);
      const cycleMs = responseFormat === 3 ? (u16(bytes, 8 + slot * 2) || SPIN_DEFAULT_CYCLE_MS) : SPIN_DEFAULT_CYCLE_MS;
      if (counts < 100 || counts > 50000 || cycleMs < 200 || cycleMs > 3000) throw new Error("旋转参数超出范围");
      return { role: "spin", mode: "single", modifiers: [], key: "A", spinCounts: counts,
        spinCycleMs: cycleMs, mouseSensitivity: Math.max(0.1, Math.min(10, Math.round(36000 / counts * 100) / 100)), horizontalSensitivity: 1 };
    }
    const modifierMask = bytes[offset];
    const usage = bytes[offset + 1];
    if (modifierMask & ~15 || usage < 0x04 || usage > 0x65) throw new Error("键盘 HID usage 或修饰键无效");
    const modifiers = Object.entries(MODIFIER_BITS).filter(([, bit]) => modifierMask & bit).map(([name]) => name);
    return { role: keyIsMusic(mode, slot) ? "music" : "key", mode: modifiers.length ? "combo" : "single",
      modifiers, key: USAGE_KEYS[usage] || `HID 0x${usage.toString(16).toUpperCase().padStart(2, "0")}`,
      spinCounts: SPIN_DEFAULT_COUNTS, spinCycleMs: SPIN_DEFAULT_CYCLE_MS, mouseSensitivity: 3, horizontalSensitivity: 1 };
  });
  return { mode, formatVersion: responseFormat, generation, mappings };
}

export function encodeKeyboardConfig(mappings, loadedFormat = 1) {
  const mode = modeFromMappings(mappings);
  const hasSpin = mappings.some((item) => item.role === "spin");
  const formatVersion = !hasSpin ? 1 :
    (loadedFormat >= 3 || mappings.some((item) => item.role === "spin" && item.spinCycleMs !== 500) ? 3 : 2);
  const bytes = new Uint8Array(formatVersion === 3 ? 14 : 8);
  bytes[0] = formatVersion;
  bytes[1] = mode;
  mappings.forEach((item, slot) => {
    const offset = 2 + slot * 2;
    if (item.role === "spin") {
      const counts = Number(item.spinCounts);
      const cycle = Number(item.spinCycleMs);
      if (!Number.isInteger(counts) || counts < 100 || counts > 50000 ||
          !Number.isInteger(cycle) || cycle < 200 || cycle > 3000) throw new Error(`K${slot + 1} 旋转参数无效`);
      put16(bytes, offset, counts);
      if (formatVersion === 3) put16(bytes, 8 + slot * 2, cycle);
    } else {
      const key = item.key || "A";
      const usage = KEY_USAGES[key] ?? (/^HID 0x[0-9A-F]{2}$/i.test(key) ? Number.parseInt(key.slice(6), 16) : -1);
      if (usage < 0x04 || usage > 0x65) throw new Error(`K${slot + 1} 不支持的按键：${key}`);
      bytes[offset] = item.mode === "combo" ? (item.modifiers || []).reduce((mask, name) => mask | (MODIFIER_BITS[name] || 0), 0) : 0;
      bytes[offset + 1] = usage;
    }
  });
  return { mode, formatVersion, payload: bytes };
}

export function decodeLedConfig(payload, generation = 0, formatVersion = 1) {
  const bytes = Uint8Array.from(payload);
  if (bytes.length !== 16 || formatVersion !== 1 || bytes[0] > 2 || bytes[1] > 1 ||
      bytes[2] !== LED_FIXED_BRIGHTNESS || bytes[3] !== 0 || bytes.slice(13).some(Boolean)) throw new Error("LED 配置格式无效");
  return { mode: bytes[0], randomColors: Boolean(bytes[1]), brightness: bytes[2], generation, formatVersion,
    colors: [4, 7, 10].map((offset) => Array.from(bytes.slice(offset, offset + 3))) };
}

export function encodeLedConfig(config) {
  const bytes = new Uint8Array(16);
  if (![0, 1, 2].includes(Number(config.mode)) || !Array.isArray(config.colors) || config.colors.length !== 3) throw new Error("LED 配置无效");
  bytes[0] = Number(config.mode);
  bytes[1] = config.mode === 2 && config.randomColors ? 1 : 0;
  bytes[2] = LED_FIXED_BRIGHTNESS;
  config.colors.forEach((color, slot) => {
    if (color.length !== 3 || color.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error(`K${slot + 1} 颜色无效`);
    bytes.set(color, 4 + slot * 3);
  });
  return bytes;
}

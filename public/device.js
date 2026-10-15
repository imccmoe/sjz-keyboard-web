import { decodeKeyboardConfig, decodeLedConfig, encodeKeyboardConfig, encodeLedConfig } from "./device-config.js";
import { crc32 } from "./music-engine.js";

const VID = 0x1a86;
const APP_PID = 0xfe01;
export const BOOT_PID = 0xfe02;
const VENDOR_USAGE_PAGE = 0xff00;
const REPORT_ID = 0;
const PACKET_SIZE = 63;
const MUSIC_DATA_SIZE = 48;

const MUSIC = {
  magic: [0x53, 0x42, 0x4d, 0x31],
  ping: 0x01,
  status: 0x02,
  begin: 0x10,
  data: 0x11,
  commit: 0x12,
  abort: 0x13,
  play: 0x20,
  stop: 0x21,
  enterIap: 0x30,
  getLed: 0x40,
  setLed: 0x41,
  getKeyboard: 0x42,
  setKeyboard: 0x43,
};

export const webHidSupported = "hid" in navigator;

async function authorizedSjzDevices() {
  if (!webHidSupported) return [];
  return (await navigator.hid.getDevices()).filter((device) =>
    device.vendorId === VID && [APP_PID, BOOT_PID].includes(device.productId) &&
    device.collections.some((collection) => collection.usagePage === VENDOR_USAGE_PAGE &&
      collection.usage === (device.productId === APP_PID ? 1 : 2)));
}

function validateUpgradeTopology(devices, { afterSwitch = false, expectedBootloader = null } = {}) {
  const appDevices = devices.filter((device) => device.productId === APP_PID);
  const bootDevices = devices.filter((device) => device.productId === BOOT_PID);
  if (afterSwitch) {
    if (bootDevices.length > 1) throw new Error("切换升级模式后检测到多个 FE02 Bootloader；请只连接一块待升级键盘后重试");
    if (appDevices.length) throw new Error("切换升级模式后仍检测到 FE01 键盘；请断开其他键盘后重试");
    if (!bootDevices.length) throw new Error("切换升级模式后 FE02 Bootloader 已消失；请重新连接键盘后重试");
    if (expectedBootloader && bootDevices[0] !== expectedBootloader) throw new Error("切换升级模式后 FE02 设备路径发生变化；请只连接一块待升级键盘后重试");
  } else {
    if (appDevices.length > 1) throw new Error("检测到多个 FE01 键盘；请只连接一块待升级键盘后重试");
    if (bootDevices.length > 1) throw new Error("检测到多个 FE02 Bootloader；请只连接一块待升级键盘后重试");
    if (appDevices.length && bootDevices.length) throw new Error("同时检测到 FE01 和 FE02 设备；请只连接一块待升级键盘后重试");
  }
  return { appDevices, bootDevices };
}

export async function inspectUpgradeDevices() {
  if (!webHidSupported) throw new Error("当前浏览器不支持 WebHID");
  return validateUpgradeTopology(await authorizedSjzDevices());
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function crc16(bytes) {
  let crc = 0xffff;
  for (const value of bytes) {
    crc ^= value << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function writeU16(array, offset, value) {
  array[offset] = value & 0xff;
  array[offset + 1] = (value >>> 8) & 0xff;
}

function buildMusicPacket(command, options = {}) {
  const data = options.data || new Uint8Array();
  const packet = new Uint8Array(PACKET_SIZE);
  packet.set(MUSIC.magic);
  packet[4] = command;
  packet[5] = options.session || 0;
  packet[6] = options.sequence || 0;
  packet[7] = options.slot ?? 0xff;
  writeU16(packet, 8, options.offset || 0);
  writeU16(packet, 10, options.total || 0);
  packet[12] = data.length;
  packet.set(data, 13);
  writeU16(packet, 61, crc16(packet.slice(0, 61)));
  return packet;
}

function viewBytes(dataView) {
  return new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
}

function parseMusicResponse(dataView) {
  let bytes = viewBytes(dataView);
  if (bytes.length >= 64 && bytes[0] === 0) bytes = bytes.slice(1, 64);
  if (bytes.length < 63 || !MUSIC.magic.every((value, index) => bytes[index] === value)) {
    throw new Error("设备响应格式无效");
  }
  if ((bytes[61] | (bytes[62] << 8)) !== crc16(bytes.slice(0, 61))) throw new Error("设备响应 CRC 无效");
  const u16 = (offset) => bytes[offset] | (bytes[offset + 1] << 8);
  const u32 = (offset) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  const command = bytes[4];
  const success = bytes[7] < 0x80;
  const ledConfig = success && [MUSIC.getLed, MUSIC.setLed].includes(command)
    ? decodeLedConfig(bytes.slice(37, 53), u32(53), bytes[57]) : null;
  const keyboardConfig = success && [MUSIC.getKeyboard, MUSIC.setKeyboard].includes(command)
    ? decodeKeyboardConfig(bytes.slice(37, bytes[57] === 3 ? 51 : 45), u32(53), bytes[57]) : null;
  const flags = bytes[54];
  return {
    command: bytes[4], session: bytes[5], sequence: bytes[6], status: bytes[7],
    expectedSequence: bytes[8], validMask: bytes[9], protocolVersion: bytes[11],
    activeSlot: bytes[12], playing: Boolean(bytes[13] & 1), eventIndex: u16(14),
    eventCount: u16(16), elapsedMs: u32(18), durationMs: u32(22),
    received: u16(26), total: u16(28), keyMask: bytes[31] & 7,
    detail: bytes[32], firmwareVersion: u32(33),
    bootVersion: ledConfig || keyboardConfig ? 0 : u32(37),
    musicIds: ledConfig || keyboardConfig ? [0, 0, 0] : [u32(41), u32(45), u32(49)],
    ledMode: ledConfig?.mode ?? bytes[53], ledRandom: ledConfig?.randomColors ?? Boolean(flags & 1),
    ledBrightness: ledConfig?.brightness ?? bytes[55],
    ledConfigFormat: ledConfig ? bytes[57] : bytes[56],
    ledGeneration: ledConfig ? u32(53) : u32(57),
    keyConfigSupported: keyboardConfig ? true : Boolean(flags & 8),
    spinSupported: keyboardConfig ? bytes[57] >= 2 : Boolean(flags & 0x80),
    keyIsMusic: keyboardConfig ? keyboardConfig.mappings.map((item) => item.role === "music")
      : [0x10, 0x20, 0x40].map((bit) => Boolean(flags & bit)),
    keyboardConfig, ledConfig,
  };
}

function statusError(response) {
  const messages = {
    0x80: "通信包格式错误", 0x81: "通信包 CRC 校验失败", 0x82: "传输会话不存在或已超时",
    0x83: "通信包顺序不正确", 0x84: "通信包长度或槽位超出范围", 0x85: "音乐数据无效",
    0x86: "音乐数据尚未接收完整", 0x87: "Flash 写入失败", 0x88: "传输超时",
    0x89: "设备忙，请先停止播放", 0x8a: "设备不支持该命令", 0x8b: "BOOT 版本过旧",
  };
  return new Error(`${messages[response.status] || `设备错误 0x${response.status.toString(16)}`}（详情 0x${response.detail.toString(16)}）`);
}

export class MusicHidDevice {
  constructor(onDisconnect) {
    this.device = null;
    this.exchangeTail = Promise.resolve();
    this.onDisconnect = onDisconnect;
    if (webHidSupported) {
      navigator.hid.addEventListener("disconnect", (event) => {
        if (event.device === this.device) {
          this.device = null;
          this.onDisconnect?.();
        }
      });
    }
  }

  async authorizedDevices({ includeBoot = false } = {}) {
    if (!webHidSupported) return [];
    const devices = await authorizedSjzDevices();
    return includeBoot ? devices : devices.filter((device) => device.productId === APP_PID);
  }

  async connect({ request = false, selectedDevice = null, appOnly = false } = {}) {
    if (!webHidSupported) throw new Error("当前浏览器不支持 WebHID，请使用桌面版 Chrome 或 Edge");
    const requestedDevices = selectedDevice ? [selectedDevice] : request
      ? await navigator.hid.requestDevice({ filters: appOnly
        ? [{ vendorId: VID, productId: APP_PID, usagePage: VENDOR_USAGE_PAGE, usage: 1 }]
        : [
          { vendorId: VID, productId: APP_PID, usagePage: VENDOR_USAGE_PAGE, usage: 1 },
          { vendorId: VID, productId: BOOT_PID, usagePage: VENDOR_USAGE_PAGE, usage: 2 },
        ] })
      : await this.authorizedDevices();
    const devices = requestedDevices.filter((device) => device.vendorId === VID &&
      device.productId === APP_PID && device.collections.some((collection) =>
        collection.usagePage === VENDOR_USAGE_PAGE && collection.usage === 1));
    if (!devices.length) {
      const bootSelected = requestedDevices.some((device) => device.vendorId === VID &&
        device.productId === BOOT_PID && device.collections.some((collection) =>
          collection.usagePage === VENDOR_USAGE_PAGE && collection.usage === 2));
      if (bootSelected) {
        const error = new Error("已识别 BOOT 升级设备；纯 BOOT 新板请到“设备维护”更新 APP 固件");
        error.bootMode = true;
        throw error;
      }
      throw new Error(request ? "未选中 SJZ 键盘；请检查 USB 连接后重试，首次连接需在浏览器弹窗中授权" : "未发现已授权的 SJZ 键盘");
    }
    this.device = devices[0];
    if (!this.device.opened) await this.device.open();
    return this.ping();
  }

  async exchange(packet, timeout = 900) {
    const previous = this.exchangeTail;
    let release;
    this.exchangeTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.exchangeOnce(packet, timeout);
    } finally {
      release();
    }
  }

  async exchangeOnce(packet, timeout = 900) {
    if (!this.device?.opened) throw new Error("请先连接 SJZ 键盘");
    const expected = [packet[4], packet[5], packet[6]];
    await this.device.sendFeatureReport(REPORT_ID, packet);
    const deadline = performance.now() + timeout;
    let lastError = null;
    while (performance.now() < deadline) {
      let response;
      try {
        response = parseMusicResponse(await this.device.receiveFeatureReport(REPORT_ID));
      } catch (error) {
        lastError = error;
        await delay(12);
        continue;
      }
      if (response.command === expected[0] && response.session === expected[1] && response.sequence === expected[2]) {
        if (response.protocolVersion !== 1) throw new Error(`USB 协议版本不一致：${response.protocolVersion}`);
        if (response.status >= 0x80) throw statusError(response);
        return response;
      }
      await delay(12);
    }
    throw new Error(`设备未确认 USB 通信包${lastError ? `：${lastError.message}` : ""}`);
  }

  ping() { return this.exchange(buildMusicPacket(MUSIC.ping)); }
  getStatus() { return this.exchange(buildMusicPacket(MUSIC.status)); }
  play(slot) { return this.exchange(buildMusicPacket(MUSIC.play, { slot })); }
  stop() { return this.exchange(buildMusicPacket(MUSIC.stop)); }

  async getLedConfig() {
    const response = await this.exchange(buildMusicPacket(MUSIC.getLed));
    if (!response.ledConfig) throw new Error("设备没有返回有效的 LED 配置");
    return response.ledConfig;
  }

  async setLedConfig(config) {
    const payload = encodeLedConfig(config);
    const response = await this.exchange(buildMusicPacket(MUSIC.setLed, { data: payload }), 5200);
    const saved = response.ledConfig;
    if (!saved || saved.mode !== payload[0] || Number(saved.randomColors) !== payload[1] ||
      saved.colors.flat().some((value, index) => value !== payload[4 + index])) throw new Error("设备回读的 LED 设置与下发内容不一致");
    return saved;
  }

  async getKeyboardConfig() {
    const response = await this.exchange(buildMusicPacket(MUSIC.getKeyboard));
    if (!response.keyboardConfig) throw new Error("设备没有返回有效的键位配置");
    return response.keyboardConfig;
  }

  async setKeyboardConfig(mappings, loadedFormat = 1) {
    const desired = encodeKeyboardConfig(mappings, loadedFormat);
    if (desired.formatVersion === 1) {
      const current = await this.getKeyboardConfig();
      if (current.mappings.some((item) => item.role === "spin")) {
        const cleared = Uint8Array.from(desired.payload);
        cleared[0] = 2;
        const transition = await this.exchange(buildMusicPacket(MUSIC.setKeyboard, { data: cleared }), 5200);
        if (!transition.keyboardConfig || transition.keyboardConfig.formatVersion !== 2 ||
            !encodeKeyboardConfig(transition.keyboardConfig.mappings, 2).payload.slice(1, 8)
              .every((value, index) => value === cleared[index + 1])) {
          throw new Error("设备没有确认已清除旋转键位");
        }
      }
    }
    const response = await this.exchange(buildMusicPacket(MUSIC.setKeyboard, { data: desired.payload }), 5200);
    const saved = response.keyboardConfig;
    if (!saved || saved.mode !== desired.mode || saved.formatVersion !== desired.formatVersion ||
      !encodeKeyboardConfig(saved.mappings, saved.formatVersion).payload.every((value, index) => value === desired.payload[index])) {
      throw new Error("设备回读的键位设置与下发内容不一致");
    }
    return saved;
  }

  async upload(slot, packageBytes, onProgress) {
    if (packageBytes.length < 32 || packageBytes.length > 4096) throw new Error("音乐数据长度无效");
    const packageVersion = packageBytes[4] | (packageBytes[5] << 8);
    if (![1, 2].includes(packageVersion)) throw new Error("音乐数据版本无效");
    await this.stop();
    await delay(30);
    const session = Math.floor(Math.random() * 255) + 1;
    let sequence = 0;
    let response = await this.exchange(buildMusicPacket(MUSIC.begin, {
      session, sequence, slot, data: Uint8Array.from([...new TextEncoder().encode("MUSICPKG"), packageVersion]),
    }));
    if (response.status !== 1) throw new Error("设备没有进入音乐接收模式");
    sequence = 1;
    try {
      for (let offset = 0; offset < packageBytes.length; offset += MUSIC_DATA_SIZE) {
        const chunk = packageBytes.slice(offset, offset + MUSIC_DATA_SIZE);
        response = await this.exchange(buildMusicPacket(MUSIC.data, {
          session, sequence, slot, offset, total: packageBytes.length, data: chunk,
        }));
        sequence = (sequence + 1) & 0xff;
        onProgress?.(Math.min(offset + chunk.length, packageBytes.length), packageBytes.length);
      }
      if (response.status !== 2) throw new Error("设备未确认完整音乐数据");
      response = await this.exchange(buildMusicPacket(MUSIC.commit, {
        session, sequence, slot, data: new TextEncoder().encode("FLASHNOW"),
      }), 5200);
      if (response.status !== 3 || !(response.validMask & (1 << slot))) throw new Error("设备未确认音乐已写入 Flash");
      return response;
    } catch (error) {
      try { await this.exchange(buildMusicPacket(MUSIC.abort, { session, sequence, slot }), 350); } catch { /* best effort */ }
      throw error;
    }
  }

  async enterIap() {
    const response = await this.exchange(buildMusicPacket(MUSIC.enterIap, {
      data: new TextEncoder().encode("ENTERIAP"),
    }), 1400);
    if (response.status !== 4) throw new Error("设备没有确认进入更新模式");
    return response;
  }
}

export async function requestBootloader({ afterSwitch = false, expectedBootloader = null, request = false } = {}) {
  if (!webHidSupported) throw new Error("当前浏览器不支持 WebHID");
  // The chooser must be invoked directly by a user click, before any await.
  const requested = request ? await navigator.hid.requestDevice({ filters: [{ vendorId: VID, productId: BOOT_PID,
    usagePage: VENDOR_USAGE_PAGE, usage: 2 }] }) : null;
  if (request && !requested.length) throw new Error("Bootloader 授权已取消");
  let authorized = await authorizedSjzDevices();
  let bootDevices = authorized.filter((device) => device.productId === BOOT_PID);
  if (!bootDevices.length) {
    const error = new Error("请点击“连接 BOOT 并继续”授权升级设备");
    error.needsPermission = true;
    throw error;
  }
  if (afterSwitch && bootDevices.length) {
    for (let attempt = 0; attempt < 5 && authorized.some((device) => device.productId === APP_PID); attempt += 1) {
      await delay(100);
      authorized = await authorizedSjzDevices();
    }
  }
  const topology = validateUpgradeTopology(authorized, { afterSwitch, expectedBootloader });
  if (!topology.bootDevices.length) throw new Error("未发现 SJZ Bootloader");
  const device = topology.bootDevices[0];
  if (!device.opened) await device.open();
  return device;
}

const IAP = {
  magic: [0x53, 0x42, 0x49, 0x31],
  ping: 0x01,
  status: 0x02,
  begin: 0x10,
  data: 0x11,
  end: 0x12,
};

function writeU32(array, offset, value) {
  array[offset] = value & 0xff;
  array[offset + 1] = (value >>> 8) & 0xff;
  array[offset + 2] = (value >>> 16) & 0xff;
  array[offset + 3] = (value >>> 24) & 0xff;
}

function buildIapPacket(command, options = {}) {
  const data = options.data || new Uint8Array();
  const packet = new Uint8Array(PACKET_SIZE);
  packet.set(IAP.magic);
  packet[4] = command;
  packet[5] = options.session || 0;
  packet[6] = options.sequence || 0;
  writeU32(packet, 8, options.offset || 0);
  writeU32(packet, 12, options.total || 0);
  packet[16] = data.length;
  packet.set(data, 17);
  writeU16(packet, 61, crc16(packet.slice(0, 61)));
  return packet;
}

function parseIapResponse(dataView) {
  let bytes = viewBytes(dataView);
  if (bytes.length >= 64 && bytes[0] === 0) bytes = bytes.slice(1, 64);
  if (bytes.length < 63 || !IAP.magic.every((value, index) => bytes[index] === value)) throw new Error("Bootloader 响应格式无效");
  if ((bytes[61] | (bytes[62] << 8)) !== crc16(bytes.slice(0, 61))) throw new Error("Bootloader 响应 CRC 无效");
  const u32 = (offset) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  return {
    command: bytes[4], session: bytes[5], sequence: bytes[6], status: bytes[7],
    progressOffset: u32(8), imageSize: u32(12), phase: bytes[18],
    erasedPages: bytes[19], totalPages: bytes[20], imageCrc32: u32(21),
    errorCode: u32(25), errorOffset: u32(29), bootVersion: u32(33),
  };
}

async function iapExchange(device, packet, timeout = 900, retries = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await device.sendFeatureReport(REPORT_ID, packet);
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        let response;
        try {
          response = parseIapResponse(await device.receiveFeatureReport(REPORT_ID));
        } catch (error) {
          lastError = error;
          await delay(8);
          continue;
        }
        if (response.command === packet[4] && response.session === packet[5] && response.sequence === packet[6]) {
          if (response.status >= 0x80 && packet[4] !== IAP.ping) throw new Error(`Bootloader 错误 0x${response.status.toString(16)}，位置 0x${response.errorOffset.toString(16)}`);
          return response;
        }
        await delay(8);
      }
      throw new Error("Bootloader 未确认通信包");
    } catch (error) {
      if (error.message?.startsWith("Bootloader 错误")) throw error;
      lastError = error;
      await delay(30);
    }
  }
  throw lastError || new Error("Bootloader 通信失败");
}

export async function uploadFirmware(device, image, onProgress) {
  if (!(image.data instanceof Uint8Array) || image.data.length < 1 || image.data.length > 0x6f00 ||
      image.sourceLow !== 0x4100 || image.sourceHigh !== 0x4100 + image.data.length ||
      !Number.isInteger(image.firmwareVersion) || image.firmwareVersion <= 0 ||
      image.crc32 !== crc32(image.data)) {
    throw new Error("APP 镜像地址、大小、版本或 CRC32 无效");
  }
  const deadline = performance.now() + 90000;
  const checkDeadline = () => { if (performance.now() >= deadline) throw new Error("固件升级总时间超过 90 秒"); };
  let sequence = 0;
  const nextSequence = () => {
    const value = sequence;
    sequence = (sequence + 1) & 0xff;
    return value;
  };
  const command = (cmd, options = {}, timeout = 900) => iapExchange(device, buildIapPacket(cmd, {
    ...options,
    sequence: nextSequence(),
  }), timeout);
  const ping = await command(IAP.ping);
  if (ping.bootVersion < 0x0001000d) throw new Error("当前 APP 需要 BOOT V1.13 或更高版本；已在擦除前停止升级");

  const session = Math.floor(Math.random() * 255) + 1;
  const metadata = new Uint8Array(16);
  writeU32(metadata, 0, image.data.length);
  writeU32(metadata, 4, image.crc32);
  writeU32(metadata, 8, 0x00004100);
  writeU32(metadata, 12, image.firmwareVersion || 0);
  let response = await command(IAP.begin, { session, data: metadata });
  if (!((response.phase === 1 && response.status === 1) || (response.phase === 2 && response.status === 2))) {
    throw new Error(`Bootloader 未进入擦除或续传阶段：phase=${response.phase} status=0x${response.status.toString(16)}`);
  }
  onProgress?.(2, "正在准备 APP 分区");
  const started = performance.now();
  while (response.phase !== 2) {
    checkDeadline();
    await delay(45);
    response = await command(IAP.status, { session });
    if (response.phase === 5) throw new Error("Bootloader 擦除 APP 分区失败");
    const pages = response.totalPages || 10;
    onProgress?.(2 + Math.floor(13 * response.erasedPages / pages), `正在擦除 APP：${response.erasedPages}/${pages}`);
  }

  let offset = response.progressOffset;
  if (offset < 0 || offset > image.data.length) throw new Error("Bootloader 返回的断点超出镜像范围");
  let stalled = 0;
  while (offset < image.data.length) {
    checkDeadline();
    const chunk = image.data.slice(offset, offset + 44);
    try {
      response = await command(IAP.data, { session, offset, total: image.data.length, data: chunk }, 700);
    } catch (error) {
      if (error.message?.startsWith("Bootloader 错误")) throw error;
      response = await command(IAP.status, { session });
    }
    if (response.progressOffset < offset || response.progressOffset > image.data.length) throw new Error("Bootloader 返回的下载偏移无效");
    if (response.progressOffset === offset) {
      if (++stalled > 8) throw new Error(`固件下载在 ${offset} 字节处没有进展`);
      continue;
    }
    stalled = 0;
    offset = response.progressOffset;
    const percent = Math.floor(offset * 100 / image.data.length);
    onProgress?.(15 + Math.floor(offset * 75 / image.data.length), `正在下载固件：${percent}%`);
  }

  response = await command(IAP.end, { session });
  if (response.status !== 4) throw new Error("Bootloader 未进入校验阶段");
  onProgress?.(90, "正在校验设备内固件");
  while (response.phase !== 4) {
    checkDeadline();
    await delay(40);
    response = await command(IAP.status, { session });
    if (response.phase === 5) throw new Error("设备端固件校验失败");
    onProgress?.(90 + Math.floor(9 * response.progressOffset / image.data.length), "正在校验设备内固件");
  }
  if (response.imageCrc32 !== image.crc32) throw new Error("设备端 CRC32 与更新文件不一致");
  onProgress?.(100, "固件升级完成，等待 APP 重新连接");
  return response;
}

export async function waitForAppReenumeration(timeoutMs = 12000) {
  const deadline = performance.now() + timeoutMs;
  let stableSince = 0;
  while (performance.now() < deadline) {
    const devices = await authorizedSjzDevices();
    const { appDevices, bootDevices } = validateUpgradeTopology(devices);
    if (appDevices.length === 1 && bootDevices.length === 0) {
      if (!stableSince) stableSince = performance.now();
      if (performance.now() - stableSince >= 1000) return appDevices[0];
    } else {
      stableSince = 0;
    }
    await delay(100);
  }
  throw new Error("12 秒内浏览器未确认 APP 稳定重连，可能需要重新授权");
}

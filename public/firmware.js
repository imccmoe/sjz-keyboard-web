import { crc32 } from "./music-engine.js";

// Matches the existing desktop upgrade format. The browser bundle exposes this
// deterrent key to its users, so it must never be treated as a device secret.
const AES_KEY = Uint8Array.from("7e921609ce90ee30f661b1ba57cba5ab".match(/../g), (hex) => Number.parseInt(hex, 16));
const TEXT_MAGIC = "GXM-AES128-GCM-HEX-V1";
const BINARY_MAGIC = "GXMAES01";
const APP_BASE = 0x4100;
const APP_MAX_SIZE = 0x6f00;
const HEADER_SIZE = 32;
const TAG_SIZE = 16;
const MAX_TEXT_SIZE = 2 * (HEADER_SIZE + APP_MAX_SIZE + TAG_SIZE) + 2048;

function manifestVersion(image) {
  const bytes = Uint8Array.from(image);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = new Set();
  for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
    if (bytes[offset] !== 0x41 || bytes[offset + 1] !== 0x50 || bytes[offset + 2] !== 0x56 || bytes[offset + 3] !== 0x31) continue;
    if (offset + 12 > bytes.length) continue;
    const version = view.getUint32(offset + 4, true);
    const inverse = view.getUint32(offset + 8, true);
    if (version !== 0 && version !== 0xffffffff && inverse === (~version >>> 0)) found.add(version);
  }
  if (found.size !== 1) throw new Error("APP 版本标记缺失、无效或相互冲突");
  return [...found][0];
}

export async function decryptFirmware(text) {
  if (typeof text !== "string" || text.length > MAX_TEXT_SIZE) throw new Error("加密固件文件过大或格式无效");
  const lines = text.split(/\r?\n/);
  if (lines[0] !== TEXT_MAGIC) throw new Error("不是 SJZ 加密 HEX；请选择 .enc.hex 升级包");
  const body = lines.slice(1).filter(Boolean).join("");
  if (body.length % 2 || !/^[0-9a-f]+$/i.test(body)) throw new Error("加密固件包含无效的十六进制数据");
  const packed = Uint8Array.from(body.match(/../g), (pair) => Number.parseInt(pair, 16));
  if (packed.length < HEADER_SIZE + TAG_SIZE) throw new Error("加密固件长度不足");
  const header = packed.slice(0, HEADER_SIZE);
  const view = new DataView(header.buffer);
  const magic = String.fromCharCode(...header.slice(0, 8));
  const size = view.getUint32(8, true);
  const version = view.getUint32(12, true);
  const base = view.getUint32(16, true);
  if (magic !== BINARY_MAGIC || base !== APP_BASE) throw new Error("加密固件格式或 APP 入口地址无效");
  if (size < 1 || size > APP_MAX_SIZE || packed.length !== HEADER_SIZE + size + TAG_SIZE) throw new Error("加密固件长度超出 APP 分区或与头部不一致");
  const key = await crypto.subtle.importKey("raw", AES_KEY, "AES-GCM", false, ["decrypt"]);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: header.slice(20, 32), additionalData: header, tagLength: 128 },
      key, packed.slice(HEADER_SIZE),
    );
  } catch {
    throw new Error("加密固件认证失败：文件损坏或密钥不匹配");
  }
  const data = new Uint8Array(plaintext);
  if (data.length !== size || manifestVersion(data) !== version) throw new Error("解密后 APP 版本标记与加密包不一致");
  return { data, sourceLow: APP_BASE, sourceHigh: APP_BASE + size, firmwareVersion: version, crc32: crc32(data), mode: "encrypted-hex" };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { compileSong } from "../public/music-engine.js";
import {
  decodeKeyboardConfig, decodeLedConfig, encodeKeyboardConfig, encodeLedConfig, spinCounts,
} from "../public/device-config.js";
import { decryptFirmware } from "../public/firmware.js";

test("rotation sensitivity matches the calibrated 360 degree relationship", () => {
  assert.equal(spinCounts(3, 1), 12000);
  assert.equal(spinCounts(2, 1), 18000);
  assert.equal(spinCounts(3, 0.5), 24000);
});

test("keyboard roles, keys, and spin cycle survive wire format round trip", () => {
  const mappings = [
    { role: "music", key: "A", mode: "single", modifiers: [] },
    { role: "key", key: "Space", mode: "combo", modifiers: ["Ctrl", "Shift"] },
    { role: "spin", spinCounts: 24000, spinCycleMs: 600 },
  ];
  const encoded = encodeKeyboardConfig(mappings);
  assert.equal(encoded.formatVersion, 3);
  const decoded = decodeKeyboardConfig(encoded.payload, 13, 3);
  assert.deepEqual(decoded.mappings.map((item) => item.role), ["music", "key", "spin"]);
  assert.equal(decoded.mappings[1].key, "Space");
  assert.deepEqual(decoded.mappings[1].modifiers, ["Ctrl", "Shift"]);
  assert.equal(decoded.mappings[2].spinCounts, 24000);
  assert.equal(decoded.mappings[2].spinCycleMs, 600);
  assert.deepEqual(encodeKeyboardConfig(decoded.mappings, 3).payload, encoded.payload);
  const invalid = Uint8Array.from(encoded.payload);
  invalid[1] |= 4;
  assert.throws(() => decodeKeyboardConfig(invalid, 13, 3), /角色位/);
});

test("LED fixed brightness and colors survive wire format round trip", () => {
  const input = { mode: 2, randomColors: true, colors: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] };
  const bytes = encodeLedConfig(input);
  const output = decodeLedConfig(bytes, 8, 1);
  assert.equal(output.brightness, 128);
  assert.deepEqual(output.colors, input.colors);
  assert.deepEqual(encodeLedConfig(output), bytes);
});

test("latest song package carries its music ID and matches the PyQt reference", () => {
  const catalog = JSON.parse(readFileSync(new URL("../public/data/music-catalog.json", import.meta.url), "utf8"));
  assert.equal(catalog.songs.length, 25);
  const packages = catalog.songs.map((item) => compileSong(item).packageBytes);
  assert.equal(createHash("sha256").update(Buffer.concat(packages.map((item) => Buffer.from(item)))).digest("hex"),
    "460f0a6cf5d05ad0e1e1b55694414f8c4516cd75182a0a17b5915373c6fdbd2e");
  const song = catalog.songs.find((item) => item.id === "小星星");
  const data = compileSong(song).packageBytes;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(view.getUint16(4, true), 2);
  assert.equal(view.getUint32(24, true), song.music_id);
  assert.equal(createHash("sha256").update(data).digest("hex"),
    "33361dc329fef85bc51f7bc309903b179da21c5095d84e6e5519c3c38ca624d9");
});

test("encrypted firmware rejects plain HEX", async () => {
  await assert.rejects(decryptFirmware(":020000040000FA"), /加密 HEX/);
});

test("default encrypted APP is valid and targets the current partition", async () => {
  const contents = readFileSync(new URL("../public/firmware/CH32V203C8T.enc.hex", import.meta.url), "utf8");
  const image = await decryptFirmware(contents);
  assert.equal(image.sourceLow, 0x4100);
  assert.equal(image.firmwareVersion, 0x1000b);
  assert.equal(image.data.length, 27392);
  assert.equal(image.crc32, 0x0304b728);
});

test("encrypted APP authenticates, decrypts, and detects tampering", async () => {
  const image = new Uint8Array(128).fill(0xff);
  image.set([0x41, 0x50, 0x56, 0x31], 32);
  const version = 0x0001000b;
  const imageView = new DataView(image.buffer);
  imageView.setUint32(36, version, true);
  imageView.setUint32(40, ~version >>> 0, true);
  const header = new Uint8Array(32);
  header.set(new TextEncoder().encode("GXMAES01"));
  const headerView = new DataView(header.buffer);
  headerView.setUint32(8, image.length, true);
  headerView.setUint32(12, version, true);
  headerView.setUint32(16, 0x4100, true);
  header.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 20);
  const key = await webcrypto.subtle.importKey("raw",
    Uint8Array.from("7e921609ce90ee30f661b1ba57cba5ab".match(/../g), (hex) => Number.parseInt(hex, 16)),
    "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv: header.slice(20, 32), additionalData: header, tagLength: 128 }, key, image));
  const pack = (bytes) => `GXM-AES128-GCM-HEX-V1\n${Buffer.from(bytes).toString("hex")}\n`;
  const packed = Uint8Array.from([...header, ...cipher]);
  const decoded = await decryptFirmware(pack(packed));
  assert.deepEqual(decoded.data, image);
  assert.equal(decoded.firmwareVersion, version);
  packed[packed.length - 1] ^= 1;
  await assert.rejects(decryptFirmware(pack(packed)), /认证失败/);
});

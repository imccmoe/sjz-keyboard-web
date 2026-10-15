import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeKeyboardConfig, encodeLedConfig } from "../public/device-config.js";
import { crc32 } from "../public/music-engine.js";

const crc16 = (bytes) => {
  let crc = 0xffff;
  for (const value of bytes) {
    crc ^= value << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
};

const initial = encodeKeyboardConfig([
  { role: "music", key: "A", mode: "single", modifiers: [] },
  { role: "key", key: "Space", mode: "single", modifiers: [] },
  { role: "spin", spinCounts: 24000, spinCycleMs: 600 },
]).payload;
let keyboard = initial;
let led = encodeLedConfig({ mode: 0, randomColors: false, colors: [[255, 64, 64], [80, 220, 120], [72, 128, 255]] });
const commands = [];
let lastPacket;
const fakeDevice = {
  vendorId: 0x1a86, productId: 0xfe01, productName: "Music Pad", opened: true,
  collections: [{ usagePage: 0xff00, usage: 1 }],
  async sendFeatureReport(id, packet) {
    assert.equal(id, 0);
    assert.equal(packet.length, 63);
    assert.equal(packet[61] | packet[62] << 8, crc16(packet.slice(0, 61)));
    lastPacket = packet;
    commands.push(packet[4]);
    if (packet[4] === 0x43) keyboard = packet.slice(13, 13 + packet[12]);
    if (packet[4] === 0x41) led = packet.slice(13, 13 + packet[12]);
  },
  async receiveFeatureReport() {
    const reply = new Uint8Array(63);
    reply.set([0x53, 0x42, 0x4d, 0x31]);
    reply.set(lastPacket.slice(4, 7), 4);
    reply[11] = 1;
    reply[33] = 11; reply[35] = 1;
    const command = lastPacket[4];
    if (command === 0x42 || command === 0x43) {
      reply.set(keyboard, 37);
      reply[53] = 7;
      reply[57] = keyboard[0];
    } else if (command === 0x40 || command === 0x41) {
      reply.set(led, 37);
      reply[53] = 4;
      reply[57] = 1;
    }
    const crc = crc16(reply.slice(0, 61));
    reply[61] = crc & 255;
    reply[62] = crc >> 8;
    return new DataView(reply.buffer);
  },
};

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { hid: { addEventListener() {}, async getDevices() { return [fakeDevice]; } } },
});
const { MusicHidDevice, uploadFirmware } = await import("../public/device.js");

test("post-update authorization requests the APP HID interface", async () => {
  const hidApi = globalThis.navigator.hid;
  hidApi.requestDevice = async ({ filters }) => {
    assert.deepEqual(filters, [{ vendorId: 0x1a86, productId: 0xfe01, usagePage: 0xff00, usage: 1 }]);
    return [fakeDevice];
  };
  try {
    const hid = new MusicHidDevice();
    const status = await hid.connect({ request: true, appOnly: true });
    assert.equal(status.firmwareVersion, 0x1000b);
  } finally {
    delete hidApi.requestDevice;
    commands.length = 0;
  }
});

test("WebHID reads and saves current keyboard and LED formats", async () => {
  const hid = new MusicHidDevice();
  await hid.connect({ selectedDevice: fakeDevice });
  const current = await hid.getKeyboardConfig();
  assert.deepEqual(current.mappings.map((item) => item.role), ["music", "key", "spin"]);
  assert.equal(current.mappings[2].spinCounts, 24000);
  const saved = await hid.setKeyboardConfig(current.mappings, current.formatVersion);
  assert.equal(saved.formatVersion, 3);
  assert.equal(saved.mappings[2].spinCycleMs, 600);
  const colors = await hid.getLedConfig();
  colors.colors[0] = [1, 2, 3];
  const savedLed = await hid.setLedConfig(colors);
  assert.deepEqual(savedLed.colors[0], [1, 2, 3]);
  assert.deepEqual(commands, [0x01, 0x42, 0x43, 0x40, 0x41]);
});

test("removing the last spin key uses the v2 transition before v1", async () => {
  const hid = new MusicHidDevice();
  await hid.connect({ selectedDevice: fakeDevice });
  keyboard = initial;
  commands.length = 0;
  const plain = [
    { role: "music", key: "A", mode: "single", modifiers: [] },
    { role: "key", key: "Space", mode: "single", modifiers: [] },
    { role: "key", key: "Enter", mode: "single", modifiers: [] },
  ];
  const saved = await hid.setKeyboardConfig(plain, 3);
  assert.equal(saved.formatVersion, 1);
  assert.deepEqual(commands, [0x42, 0x43, 0x43]);
});

test("OTA checks BOOT version before erase and uses the 0x4100 APP base", async () => {
  const image = { data: new Uint8Array(80).fill(0x5a), sourceLow: 0x4100,
    sourceHigh: 0x4150, firmwareVersion: 0x1000b };
  image.crc32 = crc32(image.data);
  let bootVersion = 0x1000c;
  let packet;
  const sent = [];
  const boot = {
    async sendFeatureReport(id, data) { assert.equal(id, 0); packet = data; sent.push(data); },
    async receiveFeatureReport() {
      const reply = new Uint8Array(63);
      reply.set([0x53, 0x42, 0x49, 0x31]);
      reply.set(packet.slice(4, 7), 4);
      const command = packet[4];
      const view = new DataView(reply.buffer);
      view.setUint32(33, bootVersion, true);
      if (command === 0x10) { reply[7] = 2; reply[18] = 2; }
      if (command === 0x11) {
        reply[7] = 2; reply[18] = 2;
        view.setUint32(8, new DataView(packet.buffer).getUint32(8, true) + packet[16], true);
      }
      if (command === 0x12) {
        reply[7] = 4; reply[18] = 4; view.setUint32(21, image.crc32, true);
      }
      const crc = crc16(reply.slice(0, 61));
      reply[61] = crc & 255; reply[62] = crc >> 8;
      return new DataView(reply.buffer);
    },
  };
  await assert.rejects(uploadFirmware(boot, image), /BOOT V1.13/);
  assert.deepEqual(sent.map((item) => item[4]), [0x01]);
  bootVersion = 0x1000d;
  sent.length = 0;
  await uploadFirmware(boot, image);
  assert.deepEqual(sent.map((item) => item[4]), [0x01, 0x10, 0x11, 0x11, 0x12]);
  const begin = sent[1];
  assert.equal(new DataView(begin.buffer).getUint32(25, true), 0x4100);
  assert.equal(new DataView(begin.buffer).getUint32(29, true), image.firmwareVersion);
});

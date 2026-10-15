// 试听播放的引擎行为：渲染期间被停止、或被另一次试听取代时，都不能出声。
//
// 回归（真实踩过）：startPreview() 是异步的（要读音色库、铺 PCM，几百毫秒），
// 而 activePreview 只在最后一步才登记。这段窗口里用户点「停止」，
// stopPreview() 因为 activePreview 还是 null 直接返回；渲染结束后却照样 start() ——
// 表现为「点了停止音乐还在响」，而且按钮已经回到「试听」，界面上根本没有停止入口。
//
// music-engine 只依赖两个浏览器全局：window.setTimeout / clearTimeout 和 AudioContext，
// 这里用最小替身把它们补齐，就能在纯 Node 下验证。

import assert from "node:assert/strict";
import { test } from "node:test";

import { compileSong, startPreview, stopPreview } from "../public/music-engine.js";

globalThis.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };

const started = [];
const allSources = [];
globalThis.AudioContext = class {
  constructor() {
    this.destination = {};
    this.sampleRate = 44100;
  }
  async resume() {}
  createBuffer(channels, length) {
    return { length, copyToChannel() {} };
  }
  createBufferSource() {
    const source = {
      stopped: false,
      connect() {},
      start() { started.push(source); },
      stop() { this.stopped = true; }
    };
    allSources.push(source);
    return source;
  }
};

const fixture = (score = "1 2 3") => compileSong({
  id: "preview-test", title: "测试曲", score, bpm: 120, rhythm: 1, gap_ms: 20, transpose_semitones: 0
});

test("渲染期间点停止：不再出声，也不回调 onDone", async () => {
  started.length = 0;
  let doneCount = 0;
  const pending = startPreview(fixture(), () => { doneCount += 1; });
  stopPreview();                                     // 渲染还没结束
  await pending;
  assert.equal(started.length, 0, "停止之后不能再 start() 音源");
  assert.equal(doneCount, 0, "被作废的试听不该回调 onDone（调用方已自己清状态）");
});

test("渲染期间被下一次试听取代：只有后一次出声", async () => {
  started.length = 0;
  const first = startPreview(fixture("1 2 3"), () => {});
  const second = startPreview(fixture("3 2 1"), () => {});
  await Promise.all([first, second]);
  assert.equal(started.length, 1, "被取代的那次不应出声");
  stopPreview();
});

test("正常播放与停止：start → stop，并回调 onDone 复位按钮", async () => {
  started.length = 0;
  let doneCount = 0;
  await startPreview(fixture(), () => { doneCount += 1; });
  assert.equal(started.length, 1, "渲染完成后应开始播放");
  assert.equal(doneCount, 0, "播放中不该回调");

  stopPreview();
  assert.equal(started[0].stopped, true, "停止时要 stop() 音源");
  assert.equal(doneCount, 1, "停止要回调 onDone，按钮才能回到「试听」");
});

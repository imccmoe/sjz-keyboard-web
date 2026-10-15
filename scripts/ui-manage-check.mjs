#!/usr/bin/env node
// 检查 manage.html 能在浏览器里正常加载：无未捕获异常、模块与样式就绪。
// 用法：node scripts/ui-manage-check.mjs [baseUrl]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/$/, "");
const PORT = 9347;
const browser = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].find((candidate) => fs.existsSync(candidate));
if (!browser) {
  console.error("未找到 Edge");
  process.exit(2);
}

const profile = path.join(os.tmpdir(), `manage-${process.pid}`);
const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  "--no-first-run", "--hide-scrollbars", "--window-size=1280,900",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 1;

async function waitFor() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return; } catch { /* 等待 */ }
    await sleep(500);
  }
  throw new Error("devtools not ready");
}

function connect(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const events = [];
    let queue = Promise.resolve();
    ws.addEventListener("open", () => resolve({
      events,
      send(method, params = {}) {
        const id = nextId++;
        const task = queue.then(() => new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        }));
        queue = task.catch(() => {});
        return task;
      }
    }));
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method) events.push(m);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  });
}

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok: Boolean(ok) });
  console.log(`  ${ok ? "✔" : "✖"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

async function main() {
  await waitFor();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const client = await connect(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Log.enable");

  await client.send("Page.navigate", { url: `${BASE}/manage.html?check=${Date.now()}` });
  await sleep(4000);

  const evaluate = (expression) => client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    .then((r) => r.result?.value);

  const state = await evaluate(`(() => ({
    title: document.title,
    theme: document.documentElement.dataset.theme,
    hasTable: Boolean(document.querySelector('.manage-table')),
    hasToken: Boolean(document.getElementById('token')),
    hasLoad: Boolean(document.getElementById('load')),
    rows: document.querySelectorAll('#rows tr').length,
    statusText: document.getElementById('status')?.textContent || '',
    segments: document.querySelectorAll('.theme-toggle').length,
    activeSegments: document.querySelectorAll('.theme-toggle[data-theme-press]').length,
    colored: getComputedStyle(document.querySelector('.button.primary')).backgroundColor
  }))()`);

  const errors = client.events
    .filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text);
  const consoleErrors = client.events
    .filter((e) => e.method === "Log.entryAdded" && e.params?.entry?.level === "error")
    .map((e) => e.params.entry.text);

  console.log("\n[曲库管理页]");
  check("页面标题正确", /曲库管理/.test(state?.title || ""), state?.title);
  check("主题已解析为 light/dark", state?.theme === "light" || state?.theme === "dark", state?.theme);
  check("样式表生效（主按钮有背景色）",
    /rgb\(/.test(state?.colored || "") && state?.colored !== "rgba(0, 0, 0, 0)", state?.colored);
  check("令牌输入框与读取按钮存在", state?.hasToken && state?.hasLoad);
  check("曲库表格已渲染", state?.hasTable);
  check("主题按钮为单图标且已标记当前模式",
    state?.segments === 1 && state?.activeSegments === 1,
    `按钮数 ${state?.segments} 已标记 ${state?.activeSegments}`);
  check("没有未捕获异常", errors.length === 0, errors.join(" | "));
  check("没有控制台错误", consoleErrors.length === 0, consoleErrors.join(" | "));

  console.log(`\n  状态栏文案：${state?.statusText}`);
  client.close?.();
}

try {
  await main();
} catch (error) {
  console.error(`管理页检查中断：${error.message}`);
  process.exitCode = 2;
} finally {
  child.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
if (failed.length) process.exitCode = 1;

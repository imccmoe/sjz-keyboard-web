#!/usr/bin/env node
// 量测主题切换的耗时，并确认切换过程中没有触发整页重渲染。
// 用法：node scripts/ui-theme-timing.mjs [baseUrl]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/$/, "");
const PORT = 9348;
const browser = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].find((candidate) => fs.existsSync(candidate));
if (!browser) {
  console.error("未找到 Edge");
  process.exit(2);
}

const profile = path.join(os.tmpdir(), `timing-${process.pid}`);
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
    let queue = Promise.resolve();
    ws.addEventListener("open", () => resolve({
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
  console.log(`  ${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  await waitFor();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const client = await connect(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  const evaluate = (expression) => client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    .then((r) => r.result?.value);

  await client.send("Page.navigate", { url: `${BASE}/?timing=${Date.now()}` });
  await sleep(4000);

  // 记录 toast 出现次数：主题切换不应弹提示。
  // 注意 showToast 是动态创建 .toast 节点挂到 body 上（不是固定 id），
  // 所以必须观察 body 的子节点变化。
  await evaluate(`(() => {
    window.__toasts = [];
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.classList && node.classList.contains('toast')) {
            window.__toasts.push(node.textContent);
          }
        }
      }
    }).observe(document.body, { childList: true });
    return true;
  })()`);

  console.log("\n[主题切换耗时]");
  const timings = await evaluate(`(async () => {
    const button = document.querySelector('[data-action="toggle-theme"]');
    if (!button) return { error: 'missing' };
    // 单击 → 应直接切到相反主题；再单击 → 切回
    const samples = [];
    const themes = [];
    for (let i = 0; i < 3; i++) {
      const before = document.documentElement.dataset.theme;
      const start = performance.now();
      button.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      samples.push(Math.round((performance.now() - start) * 100) / 100);
      themes.push({ before, after: document.documentElement.dataset.theme });
    }
    return {
      samples,
      worst: Math.max(...samples),
      themes,
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.themeMode,
      icon: button.textContent.trim(),
      toasts: window.__toasts ? window.__toasts.slice() : null
    };
  })()`);

  if (timings?.error) {
    check("找到主题按钮", false, timings.error);
  } else {
    console.log(`    各次耗时(ms)：${timings.samples.join(", ")}`);
    check("单次切换在一帧内完成（< 50ms）", timings.worst < 50, `最慢 ${timings.worst}ms`);
    check("切换过程不弹任何提示", (timings.toasts?.length ?? -1) === 0,
      `捕获到：${JSON.stringify(timings.toasts)}`);
    // 单击必须直达相反主题，不能出现「点了没变」或「跳过中间态」
    const toggles = (timings.themes || []).every((t) => t.before && t.after && t.before !== t.after);
    check("每次单击都直达相反主题", toggles, JSON.stringify(timings.themes));
    check("图标与模式同步更新",
      ["☀️", "🌙", "🌗"].includes(timings.icon) && ["auto", "light", "dark"].includes(timings.mode),
      `icon=${timings.icon} mode=${timings.mode}`);
  }

  client.close?.();
}

try {
  await main();
} catch (error) {
  console.error(`主题计时检查中断：${error.message}`);
  process.exitCode = 2;
} finally {
  child.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
if (failed.length) process.exitCode = 1;

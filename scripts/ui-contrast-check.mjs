#!/usr/bin/env node
// 真实浏览器里逐元素检查文字对比度，专门抓「文字与背景撞色导致看不见」。
//
// 用法：node scripts/ui-contrast-check.mjs [baseUrl]
// 需要先运行 npm run dev。
//
// 用 WCAG 相对亮度公式计算对比度：
//   大号文字（>=18.66px 粗体 或 >=24px）要求 >= 3.0
//   普通文字要求 >= 4.5
// 这里对「可疑元素」（按钮、标签、按键、徽标等）做检查并列出不达标项。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/$/, "");
const PORT = 9341;
const browser = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].find((candidate) => fs.existsSync(candidate));
if (!browser) {
  console.error("未找到 Edge");
  process.exit(2);
}

const profile = path.join(os.tmpdir(), `contrast-${process.pid}`);
const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  "--no-first-run", "--hide-scrollbars", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"],
  { stdio: "ignore" });

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

// 在页面里计算对比度：沿祖先链找到第一个不透明背景
const AUDIT_SCRIPT = `(() => {
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value);
    if (!m) return null;
    const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
    return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
  };
  const blend = (fg, bg, alpha) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
  const effectiveBackground = (node) => {
    let current = node;
    let acc = null;
    while (current) {
      const parsed = parse(getComputedStyle(current).backgroundColor);
      if (parsed && parsed.alpha > 0) {
        acc = acc ? blend(acc, parsed.rgb, 1) : parsed.rgb;
        if (parsed.alpha === 1) return acc;
      }
      current = current.parentElement;
    }
    return acc || [255, 255, 255];
  };
  const ratio = (a, b) => {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };

  const SELECTORS = [
    '.button', '.button.primary', '.theme-toggle', '.main-tab', '.main-tab.active',
    '.device-state', '.slot-badge', '.save-button', '.preview-button', '.keycap',
    '.keycap.active', '.status-chip', '.view-switch button.active',
    '.role-row button.active', '.summary-row span', '.song-detail h2',
    '.planet-song.active', '.toast', '.led-card h2', '.device-facts strong',
    '.page-heading h1', '.eyebrow', '.slot-target strong', '.output-box strong'
  ];

  const results = [];
  for (const selector of SELECTORS) {
    const node = document.querySelector(selector);
    if (!node) continue;
    const style = getComputedStyle(node);
    const fgParsed = parse(style.color);
    if (!fgParsed) continue;
    const bg = effectiveBackground(node);
    const fg = fgParsed.alpha < 1 ? blend(fgParsed.rgb, bg, fgParsed.alpha) : fgParsed.rgb;
    const size = parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    results.push({
      selector,
      text: (node.textContent || '').trim().slice(0, 16),
      color: style.color,
      background: 'rgb(' + bg.map(Math.round).join(', ') + ')',
      contrast: Math.round(ratio(fg, bg) * 100) / 100,
      required: large ? 3 : 4.5
    });
  }
  return results;
})()`;

async function main() {
  await waitFor();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const client = await connect(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  const evaluate = (expression) => client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    .then((r) => r.result?.value);

  let failures = 0;
  for (const scheme of ["light", "dark"]) {
    await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await client.send("Page.navigate", { url: `${BASE}/?contrast=${Date.now()}` });
    await sleep(3500);
    await evaluate(`localStorage.removeItem('zh-hub-theme')`);
    await client.send("Page.navigate", { url: `${BASE}/?contrast=${Date.now()}` });
    await sleep(3500);

    const theme = await evaluate(`document.documentElement.dataset.theme`);
    const rows = await evaluate(AUDIT_SCRIPT) || [];
    console.log(`\n[${scheme} 主题] data-theme=${theme}`);
    const bad = rows.filter((row) => row.contrast < row.required);
    for (const row of rows) {
      const mark = row.contrast < row.required ? "✖" : "✔";
      console.log(`  ${mark} ${row.selector.padEnd(26)} ${String(row.contrast).padStart(6)} (需 ${row.required})  ${row.color} on ${row.background}  "${row.text}"`);
    }
    failures += bad.length;
  }

  console.log(`\n共 ${failures} 项不达标`);
  client.close?.();
  process.exitCode = failures ? 1 : 0;
}

try {
  await main();
} catch (error) {
  console.error(`对比度检查中断：${error.message}`);
  process.exitCode = 2;
} finally {
  child.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}

#!/usr/bin/env node
// 检查搜索筛选栏：控件外观、清空按钮、Esc、匹配计数。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/$/, "");
const PORT = 9374;
const browser = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = path.join(os.tmpdir(), `strip-${process.pid}-${Date.now()}`);
const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  "--no-first-run", "--hide-scrollbars", "--window-size=1440,760",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;
async function waitFor() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return; } catch { /* wait */ }
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

await waitFor();
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const client = await connect(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await client.send("Runtime.enable");
await client.send("Page.enable");
const ev = (expr) => client.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })
  .then((r) => r.result?.value);

await client.send("Page.navigate", { url: `${BASE}/?strip=${Date.now()}` });
await sleep(4000);

console.log("\n[结构]");
const structure = await ev(`(() => {
  const strip = document.querySelector('.search-strip');
  if (!strip) return { error: 'missing' };
  return {
    hasLabel: Boolean(strip.querySelector('.search-label')),
    hasSearchField: Boolean(strip.querySelector('.search-field input#song-search')),
    hasIcon: Boolean(strip.querySelector('.search-field .field-icon svg')),
    hasChevron: Boolean(strip.querySelector('.select-field .field-chevron')),
    nativeArrowHidden: (() => {
      const s = strip.querySelector('#stage-filter');
      const cs = getComputedStyle(s);
      return cs.appearance === 'none' || cs.webkitAppearance === 'none';
    })(),
    countText: (strip.querySelector('.match-count') || {}).textContent?.trim(),
    cols: getComputedStyle(strip).gridTemplateColumns
  };
})()`);
check("有标签", structure?.hasLabel);
check("搜索框带放大镜图标", structure?.hasIcon);
check("下拉有自定义箭头（原生箭头已隐藏）", structure?.hasChevron && structure?.nativeArrowHidden,
  `chevron=${structure?.hasChevron} appearanceNone=${structure?.nativeArrowHidden}`);
check("计数默认显示总数", /25/.test(structure?.countText || ""), structure?.countText);

console.log("\n[交互]");
// 输入搜索词 → 清空按钮出现、计数变「匹配 N 首」
await ev(`(() => {
  const input = document.querySelector('#song-search');
  input.value = '星';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(500);
const afterInput = await ev(`(() => {
  const strip = document.querySelector('.search-strip');
  const clear = strip.querySelector('.field-clear');
  return {
    clearVisible: clear ? !clear.classList.contains('hidden') : false,
    hasClearIcon: clear ? Boolean(clear.querySelector('svg')) : false,
    countText: strip.querySelector('.match-count').textContent.trim(),
    countFiltered: strip.querySelector('.match-count').classList.contains('filtered'),
    inputValue: strip.querySelector('#song-search').value
  };
})()`);
check("有搜索词时显示清空按钮", afterInput?.clearVisible && afterInput?.hasClearIcon, JSON.stringify(afterInput));
check("计数变为「匹配 N 首」并高亮", /匹配/.test(afterInput?.countText || "") && afterInput?.countFiltered,
  afterInput?.countText);

// Esc 清空
await ev(`(() => {
  const input = document.querySelector('#song-search');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
})()`);
await sleep(500);
const afterEsc = await ev(`(() => {
  const strip = document.querySelector('.search-strip');
  const clear = strip.querySelector('.field-clear');
  return {
    inputValue: strip.querySelector('#song-search').value,
    clearHidden: clear ? clear.classList.contains('hidden') : null,
    focused: document.activeElement === strip.querySelector('#song-search'),
    countText: strip.querySelector('.match-count').textContent.trim()
  };
})()`);
check("Esc 清空搜索词", afterEsc?.inputValue === "", JSON.stringify(afterEsc));
check("清空后按钮隐藏、焦点回到输入框", afterEsc?.clearHidden === true && afterEsc?.focused === true,
  JSON.stringify(afterEsc));

// 点击清空按钮
await ev(`(() => {
  const input = document.querySelector('#song-search');
  input.value = '小';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(500);
await ev(`document.querySelector('.field-clear').click()`);
await sleep(500);
const afterClear = await ev(`(() => {
  const strip = document.querySelector('.search-strip');
  return {
    inputValue: strip.querySelector('#song-search').value,
    countText: strip.querySelector('.match-count').textContent.trim()
  };
})()`);
check("点击清空按钮可清空", afterClear?.inputValue === "", JSON.stringify(afterClear));

// 阶段筛选 → 计数也应进入「匹配」态
await ev(`(() => {
  const sel = document.querySelector('#stage-filter');
  sel.value = '3';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(500);
const afterStage = await ev(`(() => {
  const strip = document.querySelector('.search-strip');
  return { countText: strip.querySelector('.match-count').textContent.trim(), selected: strip.querySelector('#stage-filter').value };
})()`);
check("按阶段筛选后计数进入匹配态", /匹配/.test(afterStage?.countText || ""), JSON.stringify(afterStage));

client.close?.();
child.kill();
await sleep(300);
fs.rmSync(profile, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
if (failed.length) process.exitCode = 1;

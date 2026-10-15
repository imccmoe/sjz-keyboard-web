#!/usr/bin/env node
// 检查键盘页的两项交互：主题浮动按钮位置、星球视图是否显示全部曲目并可滚动。
//
// 用法：node scripts/ui-layout-check.mjs [baseUrl]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/$/, "");
const PORT = 9343;
const browser = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].find((candidate) => fs.existsSync(candidate));
if (!browser) {
  console.error("未找到 Edge");
  process.exit(2);
}

const profile = path.join(os.tmpdir(), `layout-${process.pid}`);
const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  "--no-first-run", "--hide-scrollbars", "--window-size=1440,900",
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
function check(label, ok, detail = "") {
  results.push({ label, ok: Boolean(ok) });
  console.log(`  ${ok ? "✔" : "✖"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

async function main() {
  await waitFor();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const client = await connect(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  const evaluate = (expression) => client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    .then((r) => r.result?.value);

  await client.send("Page.navigate", { url: `${BASE}/?layout=${Date.now()}` });
  await sleep(4000);

  console.log("\n[主题浮动控件]");
  const toggle = await evaluate(`(() => {
    const node = document.querySelector('.theme-switch');
    if (!node) return { error: 'missing' };
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const segments = [...node.querySelectorAll('[data-theme-choice]')];
    const active = segments.filter((s) => s.getAttribute('aria-pressed') === 'true');
    return {
      position: style.position,
      right: Math.round(window.innerWidth - rect.right),
      left: Math.round(rect.left),
      bottom: Math.round(window.innerHeight - rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      segments: segments.length,
      modes: segments.map((s) => s.dataset.themeChoice),
      activeCount: active.length,
      activeMode: active[0]?.dataset.themeChoice || null,
      inTopbar: Boolean(node.closest('.topbar')),
      // 是否真的挡住了可交互元素：用 elementFromPoint 实测，而不是矩形相交 ——
      // 矩形相交会把「仅横向重叠、纵向错开」误判成遮挡。
      coveredElements: (() => {
        const points = [
          [rect.left + 2, rect.top + 2],
          [rect.right - 2, rect.top + 2],
          [rect.left + 2, rect.bottom - 2],
          [rect.right - 2, rect.bottom - 2],
          [rect.left + rect.width / 2, rect.top + rect.height / 2]
        ];
        const covered = [];
        for (const [x, y] of points) {
          const hit = document.elementFromPoint(x, y);
          if (!hit || node.contains(hit)) continue;
          const interactive = hit.closest('button, a, input, select, textarea, [data-action]');
          if (interactive) covered.push(interactive.textContent.trim().slice(0, 16) || interactive.className);
        }
        return [...new Set(covered)];
      })()
    };
  })()`);
  check("存在主题控件", !toggle?.error, JSON.stringify(toggle));
  check("已脱离顶部栏", toggle?.inTopbar === false, JSON.stringify(toggle));
  check("固定定位贴在窗口角落（左或右，距边 < 40px）",
    toggle?.position === "fixed" && toggle?.bottom < 40
    && ((toggle?.left ?? 999) < 40 || (toggle?.right ?? 999) < 40),
    `position=${toggle?.position} left=${toggle?.left} right=${toggle?.right} bottom=${toggle?.bottom}`);
  check("三段式，且恰有一段选中",
    toggle?.segments === 3 && toggle?.activeCount === 1,
    `段数 ${toggle?.segments} 选中 ${toggle?.activeCount}`);
  check("三段顺序为 跟随系统 / 白天 / 夜晚",
    JSON.stringify(toggle?.modes) === JSON.stringify(["auto", "light", "dark"]),
    JSON.stringify(toggle?.modes));
  check("控件紧凑（高 <= 48px）", (toggle?.height || 99) <= 48, `高 ${toggle?.height}px 宽 ${toggle?.width}px`);
  check("浮动控件不遮挡任何可交互元素",
    (toggle?.coveredElements?.length ?? 1) === 0,
    `压在：${JSON.stringify(toggle?.coveredElements)}`);

  console.log("\n[星球视图]");
  const planet = await evaluate(`(() => {
    const stage = document.querySelector('.planet');
    if (!stage) return { error: 'missing' };
    const songs = [...stage.querySelectorAll('.planet-song')];
    const keys = songs.map((n) => n.style.getPropertyValue('--x') + ',' + n.style.getPropertyValue('--y'));
    const parent = document.querySelector('.library-stage');
    const rect = stage.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const ys = songs.map((n) => parseFloat(n.style.getPropertyValue('--y')));
    // 星球是否都落在容器可视范围内
    const inside = songs.every((n) => {
      const r = n.getBoundingClientRect();
      return r.top >= rect.top - 2 && r.bottom <= rect.bottom + 2;
    });
    return {
      rendered: songs.length,
      uniquePositions: keys.length === new Set(keys).size,
      duplicateCount: keys.length - new Set(keys).size,
      rectHeight: Math.round(rect.height),
      parentHeight: Math.round(parentRect.height),
      overflowY: getComputedStyle(stage).overflowY,
      minY: Math.min(...ys), maxY: Math.max(...ys),
      allInside: inside,
      // 星球底边与键位卡片顶边的关系：必须完全不重叠
      planetBottom: Math.round(rect.bottom),
      slotTop: Math.round(document.querySelector('.slot-row').getBoundingClientRect().top)
    };
  })()`);
  const catalogCount = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public", "data", "music-catalog.json"), "utf8")).songs.length;
  check("星球渲染出全部曲目", planet?.rendered === catalogCount,
    `渲染 ${planet?.rendered} / 曲库 ${catalogCount}`);
  check("每首歌有唯一坐标（(x,y) 不重复）", planet?.uniquePositions === true,
    `重复 ${planet?.duplicateCount} 组`);
  check("纵向坐标铺满容器（8%~92%）", planet?.minY <= 10 && planet?.maxY >= 88,
    `y 范围 ${planet?.minY}~${planet?.maxY}`);
  check("所有星球都在容器可视范围内", planet?.allInside === true);
  check("容器高度等于舞台高度（未被内容撑高）",
    planet?.rectHeight === planet?.parentHeight && planet?.rectHeight === 340,
    `planet=${planet?.rectHeight} stage=${planet?.parentHeight}`);
  check("星球未压住下方键位卡片", (planet?.planetBottom || 0) <= (planet?.slotTop || 0),
    `星球底 ${planet?.planetBottom} vs 卡片顶 ${planet?.slotTop}`);

  console.log("\n[按钮悬停]");
  // 用 CDP 强制 hover，确认主按钮文字色不变
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const { root } = await client.send("DOM.getDocument");
  const query = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".button.primary" });
  const before = await evaluate(`(() => { const n = document.querySelector('.button.primary');
    const s = getComputedStyle(n); return { color: s.color, background: s.backgroundColor }; })()`);
  await client.send("CSS.forcePseudoState", { nodeId: query.nodeId, forcedPseudoClasses: ["hover"] });
  await sleep(150);
  const after = await evaluate(`(() => { const n = document.querySelector('.button.primary');
    const s = getComputedStyle(n); return { color: s.color, background: s.backgroundColor }; })()`);
  await client.send("CSS.forcePseudoState", { nodeId: query.nodeId, forcedPseudoClasses: [] });
  check("悬停时文字仍是白色", after?.color === "rgb(255, 255, 255)", `${before?.color} → ${after?.color}`);
  check("悬停时底色仍是紫色（未变白）", after?.background === before?.background,
    `${before?.background} → ${after?.background}`);

  client.close?.();
}

try {
  await main();
} catch (error) {
  console.error(`布局检查中断：${error.message}`);
  process.exitCode = 2;
} finally {
  child.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
if (failed.length) process.exitCode = 1;

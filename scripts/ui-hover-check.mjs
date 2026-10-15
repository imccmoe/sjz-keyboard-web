#!/usr/bin/env node
// 强制 :hover 伪类，检查按钮在悬停状态下的文字与背景，专门抓「悬停后文字与背景撞色」。
//
// 用法：node scripts/ui-hover-check.mjs [baseUrl]
// 需要先 npx wrangler pages dev public（曲库存放在 D1，静态服务器上曲库为空）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/$/, "");
const PORT = 9342;
const browser = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].find((candidate) => fs.existsSync(candidate));
if (!browser) {
  console.error("未找到 Edge");
  process.exit(2);
}

const profile = path.join(os.tmpdir(), `hover-${process.pid}`);
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

/** 对比度计算（与 ui-contrast-check 一致）。 */
const CONTRAST_FN = `
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (v) => { const m = /rgba?\\(([^)]+)\\)/.exec(v); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: p.slice(0,3), a: p.length > 3 ? p[3] : 1 }; };
  const bg = (node) => {
    let cur = node, acc = null;
    while (cur) {
      const p = parse(getComputedStyle(cur).backgroundColor);
      if (p && p.a > 0) { acc = acc ? acc.map((v,i) => v*p.a + p.rgb[i]*(1-p.a)) : p.rgb; if (p.a === 1) return acc; }
      cur = cur.parentElement;
    }
    return acc || [255,255,255];
  };
  const ratio = (fg, b) => { const [h, l] = [lum(fg), lum(b)].sort((x,y) => y-x); return Math.round(((h+0.05)/(l+0.05))*100)/100; };
`;

async function main() {
  await waitFor();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const client = await connect(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("DOM.enable");
  await client.send("CSS.enable");

  const evaluate = (expression) => client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    .then((r) => r.result?.value);

  let failures = 0;

  for (const scheme of ["light", "dark"]) {
    await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await client.send("Page.navigate", { url: `${BASE}/?hover=${Date.now()}` });
    await sleep(3000);
    await evaluate(`localStorage.removeItem('zh-hub-theme')`);
    await client.send("Page.navigate", { url: `${BASE}/?hover=${Date.now()}` });
    await sleep(3000);

    console.log(`\n[${scheme} 主题] data-theme=${await evaluate("document.documentElement.dataset.theme")}`);

    // 目标：所有按钮，重点是连接按钮
    const buttons = await evaluate(`(() => {
      const out = [];
      document.querySelectorAll('button, .device-state').forEach((node, index) => {
        out.push({ index, text: (node.textContent || '').trim().slice(0, 14),
          cls: node.className || '(无类名)', action: node.dataset ? (node.dataset.action || '') : '' });
      });
      return out;
    })()`);
    console.log('  页面上可检查的元素：');
    for (const b of buttons) console.log(`    #${b.index} <${b.cls}>${b.action ? ' [' + b.action + ']' : ''} "${b.text}"`);

    // 对每个元素：常态 + 强制 hover 两种状态各测一次
    for (const b of buttons) {
      const probe = `(() => { ${CONTRAST_FN}
        const node = document.querySelectorAll('button, .device-state')[${b.index}];
        if (!node) return null;
        const s = getComputedStyle(node);
        const p = parse(s.color);
        const background = bg(node);
        const fg = p.a < 1 ? p.rgb.map((v,i) => v*p.a + background[i]*(1-p.a)) : p.rgb;
        return { color: s.color, background: 'rgb(' + background.map(Math.round).join(', ') + ')', contrast: ratio(fg, background) };
      })()`;

      const nodes = await client.send("DOM.getDocument");
      const query = await client.send("DOM.querySelectorAll", { nodeId: nodes.root.nodeId, selector: "button, .device-state" });
      const nodeId = query.nodeIds[b.index];
      if (!nodeId) continue;

      const before = await evaluate(probe);
      await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
      await sleep(120);
      const after = await evaluate(probe);
      await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });

      const broken = after.contrast < 4.5 || before.contrast < 4.5;
      if (broken) failures += 1;
      console.log(`  ${broken ? "✖" : "✔"} #${b.index} "${b.text}"`);
      console.log(`      常态 ${String(before.contrast).padStart(6)}  ${before.color} on ${before.background}`);
      console.log(`      悬停 ${String(after.contrast).padStart(6)}  ${after.color} on ${after.background}`);
    }
  }

  console.log(`\n共 ${failures} 项对比度不足`);
  client.close?.();
  process.exitCode = failures ? 1 : 0;
}

try {
  await main();
} catch (error) {
  console.error(`悬停检查中断：${error.message}`);
  process.exitCode = 2;
} finally {
  child.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}

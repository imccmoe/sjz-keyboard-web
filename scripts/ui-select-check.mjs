#!/usr/bin/env node
// 检查页面上所有下拉都已统一美化：
// 原生箭头隐藏、有自绘 chevron、容器与内层控件尺寸一致。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/$/, "");
const PORT = 9377;
const browser = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].find((candidate) => fs.existsSync(candidate));
if (!browser) {
  console.error("未找到 Edge");
  process.exit(2);
}

const profile = path.join(os.tmpdir(), `sel-${process.pid}-${Date.now()}`);
const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  "--no-first-run", "--hide-scrollbars", "--window-size=1440,1000",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// 检查当前视图里的所有 select
const PROBE = `(() => {
  const wraps = [...document.querySelectorAll('.select-wrap, .select-field')];
  const selects = [...document.querySelectorAll('select')].map((s) => {
    const cs = getComputedStyle(s);
    const wrap = s.closest('.select-wrap, .select-field');
    const chevron = wrap ? wrap.querySelector('.field-chevron') : null;
    const sr = s.getBoundingClientRect();
    const wr = wrap ? wrap.getBoundingClientRect() : null;
    return {
      id: s.id || '(无 id)',
      visible: sr.width > 0 && sr.height > 0,
      hasWrap: Boolean(wrap),
      appearanceHidden: cs.appearance === 'none' || cs.webkitAppearance === 'none',
      hasChevron: Boolean(chevron),
      // 内层 select 去掉边框后应和容器同高（允许 2px 误差）
      heightMatches: wr ? Math.abs(sr.height - wr.height) <= 2 : false,
      paddingRight: cs.paddingRight,
      // 容器背景应来自主题变量而非浏览器默认
      wrapBg: wrap ? getComputedStyle(wrap).backgroundColor : null
    };
  });
  return { wrapCount: wraps.length, selects };
})()`;

async function main() {
  await waitFor();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const client = await connect(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  const ev = (expr) => client.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })
    .then((r) => r.result?.value);

  await client.send("Page.navigate", { url: `${BASE}/?sel=${Date.now()}` });
  await sleep(4000);

  // 逐视图检查：音乐星球、键位设置、灯光设置、设备维护
  const views = [["library", "音乐星球"], ["mapping", "键位设置"], ["led", "灯光设置"], ["device", "设备维护"]];
  for (const [view, label] of views) {
    await ev(`(() => { const b = document.querySelector('[data-view="${view}"]'); if (b) b.click(); return true; })()`);
    await sleep(700);
    const info = await ev(PROBE);
    const visible = (info?.selects || []).filter((s) => s.visible);
    console.log(`\n[${label}] 可见下拉 ${visible.length} 个，容器 ${info?.wrapCount} 个`);
    for (const s of visible) {
      console.log(`    #${s.id}  容器=${s.hasWrap}  原生箭头已隐藏=${s.appearanceHidden}  自绘箭头=${s.hasChevron}  高度匹配=${s.heightMatches}`);
    }
    if (!visible.length) {
      check(`${label}：无下拉需要检查`, true);
      continue;
    }
    check(`${label}：每个下拉都有美化容器`, visible.every((s) => s.hasWrap),
      JSON.stringify(visible.filter((s) => !s.hasWrap).map((s) => s.id)));
    check(`${label}：原生箭头全部隐藏`, visible.every((s) => s.appearanceHidden),
      JSON.stringify(visible.filter((s) => !s.appearanceHidden).map((s) => s.id)));
    check(`${label}：每个下拉都有自绘箭头`, visible.every((s) => s.hasChevron),
      JSON.stringify(visible.filter((s) => !s.hasChevron).map((s) => s.id)));
    check(`${label}：下拉与容器同高`, visible.every((s) => s.heightMatches),
      JSON.stringify(visible.filter((s) => !s.heightMatches).map((s) => `${s.id}:${s.paddingRight}`)));
  }

  // 「当前星球」里的测试阶段下拉应已移除
  await ev(`(() => { const b = document.querySelector('[data-view="library"]'); if (b) b.click(); return true; })()`);
  await sleep(700);
  const detail = await ev(`(() => {
    const panel = document.querySelector('.song-detail');
    return {
      hasStageSelect: Boolean(document.querySelector('#detail-stage')),
      hasStageEditor: Boolean(panel && panel.querySelector('.stage-editor')),
      hasStatusChip: Boolean(panel && panel.querySelector('.status-chip')),
      chipText: panel ? (panel.querySelector('.status-chip') || {}).textContent : null
    };
  })()`);
  console.log("\n[当前星球面板]");
  check("测试阶段下拉已移除", detail?.hasStageSelect === false && detail?.hasStageEditor === false,
    JSON.stringify(detail));
  check("阶段信息仍由状态标签展示", detail?.hasStatusChip === true, detail?.chipText);

  client.close?.();
}

try {
  await main();
} catch (error) {
  console.error(`下拉检查中断：${error.message}`);
  process.exitCode = 2;
} finally {
  child.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
if (failed.length) process.exitCode = 1;

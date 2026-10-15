#!/usr/bin/env node
// 键盘页的界面与交互回归检查：主题浮动按钮、顶栏设备控件、搜索筛选栏、
// 键位卡片对齐、调试快捷键、试听播放、简介区、星球视图、按钮悬停。
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
// --autoplay-policy：试听检查需要音频真的开始播放（合成点击不算用户手势）。
const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  "--no-first-run", "--hide-scrollbars", "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required",
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

  // 统计 document 上 keydown 的注册次数。bindEvents() 每次 render() 都会执行，
  // 重复注册会让一次 Ctrl+Shift+L 切换多次 —— 偶数次时互相抵消，表现为「按了没反应」。
  // 只比较切换结果查不出这个问题（3 个监听器看起来照样「正常」），必须数注册次数。
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__keydownRegistrations = 0;
      const originalAddEventListener = Document.prototype.addEventListener;
      Document.prototype.addEventListener = function (type, ...rest) {
        if (type === "keydown") window.__keydownRegistrations += 1;
        return originalAddEventListener.call(this, type, ...rest);
      };
      // 试听检查要用：确认真有音源开始 / 停止，而不是只看按钮文案
      window.__audioStarts = 0;
      window.__audioStops = 0;
      if (typeof AudioBufferSourceNode !== "undefined") {
        const originalStart = AudioBufferSourceNode.prototype.start;
        const originalStop = AudioBufferSourceNode.prototype.stop;
        AudioBufferSourceNode.prototype.start = function (...args) {
          window.__audioStarts += 1; return originalStart.apply(this, args); };
        AudioBufferSourceNode.prototype.stop = function (...args) {
          window.__audioStops += 1; return originalStop.apply(this, args); };
      }`
  });

  await client.send("Page.navigate", { url: `${BASE}/?layout=${Date.now()}` });
  await sleep(4000);

  console.log("\n[主题浮动按钮]");
  const toggle = await evaluate(`(() => {
    const node = document.querySelector('.theme-toggle');
    if (!node) return { error: 'missing' };
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      position: style.position,
      right: Math.round(window.innerWidth - rect.right),
      left: Math.round(rect.left),
      bottom: Math.round(window.innerHeight - rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      icon: node.textContent.trim(),
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
  check("存在主题按钮", !toggle?.error, JSON.stringify(toggle));
  check("已脱离顶部栏", toggle?.inTopbar === false, JSON.stringify(toggle));
  check("固定定位在右下角",
    toggle?.position === "fixed" && (toggle?.right ?? 999) < 40 && (toggle?.bottom ?? 999) < 40,
    `position=${toggle?.position} right=${toggle?.right} bottom=${toggle?.bottom}`);
  check("只有一个图标按钮（非三段式）",
    (toggle?.width ?? 99) <= 52 && (toggle?.height ?? 99) <= 52,
    `${toggle?.width}x${toggle?.height}`);
  check("浮动按钮不遮挡任何可交互元素",
    (toggle?.coveredElements?.length ?? 1) === 0,
    `压在：${JSON.stringify(toggle?.coveredElements)}`);

  console.log("\n[顶栏设备控件]");
  // 回归：「未连接」状态块曾是 54px 高，比同一行的按钮高出一头，看着像另一个更大的按钮；
  // 窄屏下控件区是两列网格，状态块会与按钮并排等宽，高度更容易被看成一回事。
  // 两者必须同高，且与按钮在同一行居中对齐。
  const bar = await evaluate(`(() => {
    const box = (sel) => { const n = document.querySelector(sel); if (!n) return null;
      const b = n.getBoundingClientRect(); return { h: Math.round(b.height), w: Math.round(b.width), top: Math.round(b.top) }; };
    return {
      state: box('.device-state'),
      connect: box('button[data-action="connect-device"]'),
      scan: box('button[data-action="scan-device"]')
    };
  })()`);
  check("状态块与「连接」按钮同高",
    bar?.state?.h === bar?.connect?.h,
    `状态 ${bar?.state?.h}px vs 连接 ${bar?.connect?.h}px`);
  check("状态块与按钮在同一行居中对齐",
    Math.abs((bar?.state?.top ?? 0) - (bar?.connect?.top ?? 99)) <= 1,
    `状态 top=${bar?.state?.top} 连接 top=${bar?.connect?.top}`);
  check("「连接」与「刷新已授权设备」同高（按钮族一致）",
    bar?.connect?.h === bar?.scan?.h,
    `连接 ${bar?.connect?.h}px vs 刷新 ${bar?.scan?.h}px`);

  console.log("\n[搜索筛选栏]");
  // 回归：匹配计数那一列若是 auto，「星球展示 25 首」比「全部 25 首」宽 26px，
  // 会把 1fr 的搜索框挤窄 / 撑宽（实测 936px ↔ 962px），切换视图时搜索栏长度会变。
  const searchWidths = {};
  for (const mode of ["planet", "list"]) {
    await evaluate(`document.querySelector('[data-library-mode="${mode}"]').click()`);
    await sleep(350);
    searchWidths[mode] = await evaluate(`Math.round((document.querySelector('.search-field') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width)`);
  }
  // 后面的检查依赖星球视图，切回去
  await evaluate(`document.querySelector('[data-library-mode="planet"]').click()`);
  await sleep(350);
  check("搜索框在星球视图与全部音乐下等宽",
    searchWidths.planet === searchWidths.list && searchWidths.planet > 0,
    `星球 ${searchWidths.planet}px vs 全部 ${searchWidths.list}px`);

  console.log("\n[键位卡片对齐]");
  // 回归：三张卡片曾经带 52px 右内边距整体缩进，右边缘比上方搜索栏短一截。
  const align = await evaluate(`(() => {
    const rect = (sel) => { const n = document.querySelector(sel); if (!n) return null;
      const b = n.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; };
    return {
      row: rect('.slot-row'),
      strip: rect('.search-strip'),
      cards: [...document.querySelectorAll('.slot-target')].map((n) => { const b = n.getBoundingClientRect();
        return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; })
    };
  })()`);
  check("键位行与搜索栏左右边缘对齐",
    align?.row && align?.strip && align.row.l === align.strip.l && align.row.r === align.strip.r,
    `行 ${align?.row?.l}~${align?.row?.r} vs 搜索栏 ${align?.strip?.l}~${align?.strip?.r}`);
  check("第一张卡片贴左、第三张贴右",
    (align?.cards?.length ?? 0) === 3 && align.cards[0].l === align.row.l && align.cards[2].r === align.row.r,
    JSON.stringify(align?.cards));
  check("三张卡片等宽",
    new Set((align?.cards || []).map((card) => card.w)).size === 1 && (align?.cards || []).length === 3,
    JSON.stringify((align?.cards || []).map((card) => card.w)));

  console.log("\n[调试快捷键]");
  // F12 与开发者工具快捷键要在页面里被拦下；普通按键不能被误拦。
  const keys = await evaluate(`(() => {
    const fire = (init) => { const event = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init));
      document.dispatchEvent(event); return event.defaultPrevented; };
    return {
      f12: fire({ key: 'F12' }),
      inspect: fire({ key: 'I', ctrlKey: true, shiftKey: true }),
      consolePanel: fire({ key: 'J', ctrlKey: true, shiftKey: true }),
      source: fire({ key: 'u', ctrlKey: true }),
      plain: fire({ key: 'a' })
    };
  })()`);
  check("F12 被拦截", keys?.f12 === true, JSON.stringify(keys));
  check("Ctrl+Shift+I / J 与 Ctrl+U 被拦截",
    keys?.inspect === true && keys?.consolePanel === true && keys?.source === true, JSON.stringify(keys));
  check("普通按键不被拦截", keys?.plain === false, JSON.stringify(keys));

  // Ctrl+Shift+L 必须真的能切换主题；再配合下面的注册次数检查。
  const shortcut = await evaluate(`(() => {
    const press = () => document.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'l', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    const before = document.documentElement.dataset.theme;
    press();
    const once = document.documentElement.dataset.theme;
    press();
    const twice = document.documentElement.dataset.theme;
    return { before, once, twice };
  })()`);
  check("Ctrl+Shift+L 能切换主题",
    shortcut?.once !== shortcut?.before && shortcut?.twice === shortcut?.before,
    JSON.stringify(shortcut));
  // 精确检查「只挂一次」：多次 render() 之后仍然只能有 1 个 keydown 监听器。
  const registrations = await evaluate(`window.__keydownRegistrations`);
  check("document 上的 keydown 只注册一次",
    registrations === 1, `实际注册 ${registrations} 次`);

  console.log("\n[试听播放]");
  // 回归（用户反馈「播放无法暂停」）：播放中切歌再点试听，
  // startPreview() 会先 stopPreview()，触发上一首的 onDone；
  // 它若无条件清空 previewSongId，会把新歌的状态一起清掉 ——
  // 新歌在响，按钮却回到「试听」，界面上没有任何停止入口。
  const preview = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const button = () => document.querySelector('[data-action="preview-song"]');
    const label = () => (button() ? button().textContent.trim() : '');
    const pick = (title) => [...document.querySelectorAll('.planet-song')].find((n) => n.textContent.trim() === title);
    const titles = [...document.querySelectorAll('.planet-song')].map((n) => n.textContent.trim());
    if (label() === '停止') { button().click(); await sleep(500); }

    pick(titles[0]).click();
    await sleep(400);
    button().click();
    await sleep(1400);
    const playingFirst = label();
    const startsFirst = window.__audioStarts;

    pick(titles[1]).click();
    await sleep(400);
    button().click();
    await sleep(1800);
    const afterSwitch = label();
    const startsAfterSwitch = window.__audioStarts;

    if (label() === '停止') { button().click(); await sleep(500); }
    return {
      titles: titles.slice(0, 2), playingFirst, startsFirst,
      afterSwitch, startsAfterSwitch,
      afterStop: label(), stops: window.__audioStops
    };
  })()`);
  check("点试听后开始播放且按钮变为「停止」",
    preview?.playingFirst === "停止" && (preview?.startsFirst ?? 0) >= 1,
    JSON.stringify(preview));
  check("播放中切歌再试听：新歌在播、按钮仍是「停止」（有停止入口）",
    preview?.afterSwitch === "停止" && (preview?.startsAfterSwitch ?? 0) > (preview?.startsFirst ?? 0),
    JSON.stringify(preview));
  check("点「停止」后按钮回到「试听」且音源被停止",
    preview?.afterStop === "试听" && (preview?.stops ?? 0) >= 1,
    JSON.stringify(preview));

  console.log("\n[乐曲简介不压缩下方间距]");
  // 回归：长标题 + 两段简介会让右侧面板溢出 21px，把下方「拖到你的键盘」与
  // K1~K3 卡片的间距挤掉。现在简介在面板内部滚动，下方间距必须恒定。
  const detailProbe = `(() => {
    const r = (sel) => { const n = document.querySelector(sel); if (!n) return null;
      const b = n.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) }; };
    const panel = document.querySelector('.song-detail');
    const body = document.querySelector('.detail-body');
    return {
      title: (document.querySelector('.song-detail h2') || {}).textContent || '',
      panelH: panel ? Math.round(panel.getBoundingClientRect().height) : null,
      panelOverflow: panel ? panel.scrollHeight - panel.clientHeight : null,
      panelOverflowStyle: panel ? getComputedStyle(panel).overflow : null,
      hasBody: Boolean(body),
      bodyScrollable: body ? body.scrollHeight > body.clientHeight : null,
      slotHeadingTop: r('.slot-heading')?.top ?? null,
      slotRowTop: r('.slot-row')?.top ?? null,
      stageH: r('.library-stage')?.h ?? null
    };
  })()`;

  // 依次选中标题长短不同的曲目，比较下方间距是否被压缩
  const snapshots = [];
  const titles = await evaluate(`[...document.querySelectorAll('.planet-song')].map((n) => n.textContent.trim())`);
  const pick = [titles?.[0], titles?.find((t) => t.length >= 8), titles?.find((t) => t.length <= 4)].filter(Boolean);
  for (const title of [...new Set(pick)]) {
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('.planet-song')].find((n) => n.textContent.trim() === ${JSON.stringify(title)});
      if (btn) btn.click();
      return Boolean(btn);
    })()`);
    await sleep(400);
    snapshots.push(await evaluate(detailProbe));
  }

  for (const snap of snapshots) {
    console.log(`    「${snap.title}」 面板 ${snap.panelH}px 溢出 ${snap.panelOverflow} 简介区可滚动=${snap.bodyScrollable} 卡片顶 ${snap.slotRowTop}`);
  }
  const distinctTitles = snapshots.length >= 2 && new Set(snapshots.map((s) => s.title)).size >= 2;
  check("能选中标题长短不同的曲目进行对比", distinctTitles,
    JSON.stringify(snapshots.map((s) => s.title)));
  check("右侧面板高度恒等于舞台高度（内容不撑高面板）",
    snapshots.every((s) => s.panelH === 340 && s.stageH === 340),
    JSON.stringify(snapshots.map((s) => ({ h: s.panelH, stage: s.stageH }))));
  check("右侧面板自身不产生溢出滚动",
    snapshots.every((s) => s.panelOverflow === 0 && s.panelOverflowStyle === "hidden"),
    JSON.stringify(snapshots.map((s) => `${s.title}:溢出${s.panelOverflow}/${s.panelOverflowStyle}`)));
  check("下方「拖到你的键盘」位置不随简介变化",
    new Set(snapshots.map((s) => s.slotHeadingTop)).size === 1,
    JSON.stringify(snapshots.map((s) => s.slotHeadingTop)));
  check("下方键位卡片位置不随简介变化",
    new Set(snapshots.map((s) => s.slotRowTop)).size === 1,
    JSON.stringify(snapshots.map((s) => s.slotRowTop)));
  check("简介超长时在面板内部滚动（而非溢出）",
    snapshots.some((s) => s.bodyScrollable === true) || snapshots.every((s) => s.bodyScrollable === false),
    JSON.stringify(snapshots.map((s) => `${s.title}:${s.bodyScrollable}`)));

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
    // 星球是否都落在容器可视范围内（不能有被裁掉的）
    const outside = songs.filter((n) => {
      const r = n.getBoundingClientRect();
      return r.top < rect.top - 2 || r.bottom > rect.bottom + 2;
    }).map((n) => n.textContent.trim());
    return {
      rendered: songs.length,
      uniquePositions: keys.length === new Set(keys).size,
      duplicateCount: keys.length - new Set(keys).size,
      rectHeight: Math.round(rect.height),
      parentHeight: Math.round(parentRect.height),
      overflowY: getComputedStyle(stage).overflowY,
      scrollable: stage.className.includes('scrollable'),
      minY: Math.min(...ys), maxY: Math.max(...ys),
      outside,
      planetBottom: Math.round(rect.bottom),
      slotTop: Math.round(document.querySelector('.slot-row').getBoundingClientRect().top)
    };
  })()`);
  // 曲库存放在 D1：曲目数从 API 读取，页面只渲染 verified 的曲目，口径保持一致
  let catalogCount;
  try {
    const response = await fetch(`${BASE}/api/songs`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    catalogCount = (payload.songs || []).filter((song) => Boolean(song.verified)).length;
  } catch (error) {
    console.error(`读取曲库失败：${error.message}`);
    console.error("曲库只存放在 D1：请先用 `npx wrangler pages dev public` 启动带 Functions 与本地 D1 的服务器");
    process.exit(2);
  }
  check("星球渲染出全部曲目", planet?.rendered === catalogCount,
    `渲染 ${planet?.rendered} / 曲库 ${catalogCount}`);
  check("每首歌有唯一坐标（(x,y) 不重复）", planet?.uniquePositions === true,
    `重复 ${planet?.duplicateCount} 组`);
  check("所有星球都在容器可视范围内（无裁切）",
    (planet?.outside?.length ?? 1) === 0,
    `被裁掉：${JSON.stringify(planet?.outside)}`);
  check("容器高度等于舞台高度（未被内容撑高）",
    planet?.rectHeight === planet?.parentHeight && planet?.rectHeight === 340,
    `planet=${planet?.rectHeight} stage=${planet?.parentHeight}`);
  check("星球不滚动（坐标散落，无需滚动）",
    planet?.scrollable === false && planet?.overflowY === "hidden",
    `class 含 scrollable=${planet?.scrollable} overflowY=${planet?.overflowY}`);
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

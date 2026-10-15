import { compileSong, formatDuration, startPreview, stopPreview } from "./music-engine.js";
import { BOOT_PID, inspectUpgradeDevices, MusicHidDevice, requestBootloader, uploadFirmware, waitForAppReenumeration, webHidSupported } from "./device.js";
import { decryptFirmware } from "./firmware.js";
import { KEY_USAGES, spinCounts } from "./device-config.js";
import { cycleThemeMode, getThemeMode, modeName, setThemeMode, THEME_MODES, watchSystemTheme } from "./theme.js";

const APP_VERSION = "1.15";
const TEST_STAGE_LABELS = {
  1: "阶段 1 · 新接入未测试",
  2: "阶段 2 · Qt 试听通过",
  3: "阶段 3 · 游戏实测通过",
};
/**
 * 星球坐标：每首歌一个位置，散落在容器里（百分比坐标）。
 *
 * 前 20 组是原始设计，保持不动；第 21 组之后是续补的位置 ——
 * 原先只有 20 组配 `songs.slice(0, 20)`，第 21 首起直接不渲染。
 * 续补位置按纵向成组排布，保证同一行的几颗星球不会挤在一起。
 */
const PLANET_POSITIONS = [
  [54, 70, 1.18], [30, 35, 0.72], [62, 22, 0.66], [76, 42, 0.72], [20, 58, 0.55],
  [45, 44, 0.82], [70, 70, 0.9], [84, 61, 0.55], [36, 70, 0.62], [16, 31, 0.56],
  [87, 28, 0.68], [43, 18, 0.58], [25, 78, 0.7], [59, 51, 0.6], [72, 18, 0.58],
  [12, 70, 0.54], [92, 76, 0.55], [33, 18, 0.52], [51, 83, 0.56], [81, 82, 0.58],
  // 第 21~33 组：纵向落在 6%~29% 的空档，横向错开
  [26, 8, 0.5], [44, 26, 0.54], [62, 8, 0.48], [80, 25, 0.52],
  [18, 20, 0.5], [36, 9, 0.5], [70, 27, 0.48], [88, 12, 0.52],
  [10, 44, 0.5], [28, 48, 0.52], [66, 38, 0.5], [90, 44, 0.48],
  [14, 88, 0.5]
];

/** 取得第 index 首的位置；超出预设时退回一个稳定的兜底坐标。 */
function planetPosition(index) {
  if (index < PLANET_POSITIONS.length) return PLANET_POSITIONS[index];
  const overflow = index - PLANET_POSITIONS.length;
  return [12 + (overflow % 5) * 19, 6 + (overflow % 4) * 6, 0.48];
}

const PLANET_COLORS = ["#86ddd4", "#aeb9e7", "#f2aab3", "#8fd4cb", "#9fd9f1", "#d8bb75"];
const KEY_LABELS = { Space: "空格", Enter: "回车", Backspace: "退格", Delete: "删除",
  Up: "上方向", Down: "下方向", Left: "左方向", Right: "右方向" };
const KEY_ORDER = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", ..."0123456789",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  "Space", "Enter", "Esc", "Tab", "Backspace", "Insert", "Delete", "Up", "Down", "Left", "Right",
  "Home", "End", "Page Up", "Page Down", "Caps Lock", "Scroll Lock", "Print Screen", "Pause", "Num Lock"];
const KEY_OPTIONS = KEY_ORDER.filter((key) => key in KEY_USAGES).map((key) => [KEY_LABELS[key] || key, key]);
const DEFAULT_MAPPINGS = [
  { role: "key", mode: "single", modifiers: [], key: "A", spinCounts: 12000, spinCycleMs: 500, mouseSensitivity: 3, horizontalSensitivity: 1 },
  { role: "key", mode: "single", modifiers: [], key: "Space", spinCounts: 12000, spinCycleMs: 500, mouseSensitivity: 3, horizontalSensitivity: 1 },
  { role: "key", mode: "single", modifiers: [], key: "Enter", spinCounts: 12000, spinCycleMs: 500, mouseSensitivity: 3, horizontalSensitivity: 1 },
];

const state = {
  view: "library",
  libraryMode: "planet",
  search: "",
  stageFilter: 0,
  stageOverrides: readStageOverrides(),
  songs: [],
  selectedSongId: null,
  slotSongIds: readStorage("sjz_library_slots", [null, null, null], "gxm_library_slots"),
  previewSongId: null,
  mappingSlot: 0,
  mappings: readStorage("sjz_key_mappings", DEFAULT_MAPPINGS, "gxm_key_mappings")
    .map((mapping, slot) => ({ ...DEFAULT_MAPPINGS[slot], ...mapping })),
  savedMappings: null,
  keyboardLoaded: false,
  keyboardDirty: false,
  keyboardGeneration: null,
  keyboardFormat: 1,
  keyboardMessage: "连接键盘后读取当前工作模式和三个键位",
  led: { mode: 0, randomColors: false, colors: [[255, 64, 64], [80, 220, 120], [72, 128, 255]] },
  ledLoaded: false,
  ledDirty: false,
  ledGeneration: null,
  ledMessage: "连接键盘后读取当前灯光设置",
  devices: [],
  selectedDeviceIndex: 0,
  device: {
    connected: false,
    mode: "none",
    label: webHidSupported ? "点击连接检测设备" : "浏览器不支持 WebHID",
    validMask: 0,
    keyMask: null,
    playing: false,
    activeSlot: -1,
    firmwareVersion: 0,
    bootVersion: 0,
    musicIds: [0, 0, 0],
    keyConfigSupported: false,
    ledConfigFormat: 0,
    ledGeneration: 0,
  },
  uploadingSlot: -1,
  uploadPercent: 0,
  firmware: null,
  upgrading: false,
  pendingBoot: null,
  pendingApp: false,
};

const hid = new MusicHidDevice(() => {
  state.device = { ...state.device, connected: false, mode: "none", label: "设备已断开", keyMask: null, playing: false };
  state.savedMappings = null;
  state.keyboardLoaded = false;
  state.keyboardMessage = "设备已断开";
  state.ledLoaded = false;
  state.ledMessage = "设备已断开";
  render();
});
let toastTimer = 0;
let statusTimer = 0;
let statusBusy = false;
let configBusy = false;
let firmwareSelectionNonce = 0;

function readStorage(key, fallback, legacyKey = null) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || (legacyKey && localStorage.getItem(legacyKey)) || "null");
    return Array.isArray(value) && value.length === 3 ? value : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

function readStageOverrides() {
  try {
    const value = JSON.parse(localStorage.getItem("sjz_test_stage_overrides") || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function normalizeTestStage(value) {
  const stage = Number.parseInt(value, 10);
  return Math.max(1, Math.min(3, Number.isFinite(stage) ? stage : 1));
}

function stageLabel(song) {
  return TEST_STAGE_LABELS[normalizeTestStage(song.test_stage)];
}

function persist() {
  localStorage.setItem("sjz_library_slots", JSON.stringify(state.slotSongIds));
  localStorage.setItem("sjz_key_mappings", JSON.stringify(state.mappings));
  localStorage.setItem("sjz_test_stage_overrides", JSON.stringify(state.stageOverrides));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message, type = "info") {
  document.querySelector(".toast")?.remove();
  window.clearTimeout(toastTimer);
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  document.body.appendChild(node);
  toastTimer = window.setTimeout(() => node.remove(), 3200);
}

function filteredSongs() {
  const query = state.search.trim().toLowerCase();
  return state.songs.filter((song) => {
    if (state.stageFilter && song.test_stage !== state.stageFilter) return false;
    return !query || `${song.title} ${song.author} ${song.difficulty} ${song.source} ${stageLabel(song)}`.toLowerCase().includes(query);
  });
}

function selectedSong() {
  const visible = filteredSongs();
  return visible.find((song) => song.id === state.selectedSongId) || visible[0] || null;
}

function slotSong(slot) {
  return state.songs.find((song) => song.id === state.slotSongIds[slot]) || null;
}

function sourceTag(song) {
  if (song.source.includes("参考1/")) return "参考1";
  if (song.source.includes("参考2/")) return "参考2";
  return "内置";
}

function mappingText(mapping) {
  if (mapping.role === "spin") return "旋转陀螺";
  if (mapping.role === "music") return "播放 / 暂停";
  const parts = mapping.mode === "combo" ? [...mapping.modifiers] : [];
  parts.push(mapping.key);
  return parts.join(" + ");
}

function firmwareVersion(value) {
  return value ? `V${(value >>> 16) & 0xffff}.${String(value & 0xffff).padStart(2, "0")}` : "未读取";
}

function deviceSongText(slot) {
  if (!state.device.connected) return "未连接";
  if (!(state.device.validMask & (1 << slot))) return "空槽";
  const id = state.device.musicIds[slot];
  if (!id) return "旧版曲目（无编号）";
  const song = state.songs.find((item) => item.music_id === id);
  return song ? `${song.title} · #${id}` : `未知曲目 #${id}`;
}

function footerText() {
  if (state.view === "mapping") return "每颗键可选择输出键值、播放 / 暂停或旋转陀螺；保存后断电仍保留";
  if (state.view === "led") return "灯光设置只在点击“保存到键盘”后写入，所有模式最高 50% 亮度";
  if (state.view === "device") return "设备维护 · 查看按键状态并在需要时更新固件";
  if (state.view === "about") return `SJZ 键盘 ${APP_VERSION}`;
  return "准备就绪 · 把音乐星球拖到 K1～K3，然后直接保存到键盘";
}

function render() {
  const app = document.querySelector("#app");
  const deviceStatus = state.device.connected ? "已连接"
    : state.device.mode === "boot" ? "已进入更新模式"
      : state.devices.length ? "已发现设备，请点击连接" : "未连接";
  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand-block"><strong>SJZ</strong><span>把喜欢的音乐装进键盘</span></div>
        <div class="device-controls">
          <label for="device-select">我的设备</label>
          <select id="device-select" aria-label="我的设备">
            ${state.devices.length
              ? state.devices.map((device, index) => `<option value="${index}" ${state.selectedDeviceIndex === index ? "selected" : ""}>${device.productId === BOOT_PID ? "SJZ 键盘（更新模式）" : escapeHtml(device.productName === "Music Pad" ? "SJZ 键盘" : device.productName || "SJZ 键盘")} ${state.devices.length > 1 ? `(${index + 1})` : ""}</option>`).join("")
              : `<option>${escapeHtml(state.device.label)}</option>`}
          </select>
          <button class="button" data-action="scan-device">刷新已授权设备</button>
          <button class="button primary" data-action="connect-device">连接</button>
          <span class="device-state ${state.device.connected ? "online" : ""}">${deviceStatus}</span>
        </div>
      </header>
      <nav class="main-tabs" aria-label="主功能">
        ${[["library", "音乐星球"], ["mapping", "键位设置"], ["led", "灯光设置"], ["device", "设备维护"], ["about", "关于"]]
          .map(([id, label]) => `<button class="main-tab ${state.view === id ? "active" : ""}" data-view="${id}">${label}</button>`).join("")}
      </nav>
      <main class="page">${renderPage()}</main>
      <footer>${escapeHtml(footerText())}</footer>
    </div>`;
  bindEvents();
}

function renderPage() {
  if (state.view === "mapping") return renderMapping();
  if (state.view === "led") return renderLed();
  if (state.view === "device") return renderDevice();
  if (state.view === "about") return renderAbout();
  return renderLibrary();
}

function pageHeading(eyebrow, title, subtitle, aside = "") {
  return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${subtitle}</p></div>${aside}</div>`;
}

function renderLibrary() {
  const songs = filteredSongs();
  const song = selectedSong();
  const switches = `<div class="view-switch" role="group"><button class="${state.libraryMode === "planet" ? "active" : ""}" data-library-mode="planet">星球视图</button><button class="${state.libraryMode === "list" ? "active" : ""}" data-library-mode="list">全部音乐&nbsp; ${songs.length}</button><button class="button" data-action="reload-library">重新加载</button></div>`;
  return `
    ${pageHeading("发现音乐", "音乐星球", "像浏览星空一样选歌。单击查看，双击试听，也可以直接拖到 K1～K3。", switches)}
    <section class="search-strip"><strong>查找星球</strong><input id="song-search" value="${escapeHtml(state.search)}" placeholder="搜索歌名、作者、难度或测试阶段" /><select id="stage-filter" aria-label="测试阶段筛选"><option value="0">全部阶段</option>${Object.entries(TEST_STAGE_LABELS).map(([stage, label]) => `<option value="${stage}" ${state.stageFilter === Number(stage) ? "selected" : ""}>${label}</option>`).join("")}</select><span>${state.libraryMode === "planet" ? `星球展示 ${songs.length} 首` : `全部 ${songs.length} 首音乐`}</span></section>
    <div class="library-stage">
      ${state.libraryMode === "planet" ? renderPlanet(songs) : renderSongList(songs)}
      ${renderSongDetail(song)}
    </div>
    <div class="slot-heading"><strong>拖到你的键盘</strong><span>把歌曲拖到 K1～K3，或先选歌再点击键位卡片；放入歌曲后保存按钮可用。</span></div>
    <section class="slot-row">${[0, 1, 2].map(renderSlot).join("")}</section>`;
}

function renderPlanet(songs) {
  if (!songs.length) return `<div class="planet empty-state">没有找到匹配的音乐</div>`;
  // 容器高度固定（CSS 里的 340px），每首歌取 PLANET_POSITIONS 里的散落坐标。
  return `<div class="planet" aria-label="音乐星球">${songs.map((song, index) => {
    const [x, y, scale] = planetPosition(index);
    const active = song.id === selectedSong()?.id;
    return `<button class="planet-song ${active ? "active" : ""}" draggable="true" data-song-id="${escapeHtml(song.id)}" style="--x:${x}%;--y:${y}%;--scale:${scale};--color:${PLANET_COLORS[index % PLANET_COLORS.length]};--delay:${-(index % 7)}s"><i></i><span>${escapeHtml(song.title)}</span></button>`;
  }).join("")}</div>`;
}

function renderSongList(songs) {
  if (!songs.length) return `<div class="song-list empty-state">没有找到匹配的音乐</div>`;
  return `<div class="song-list">${songs.map((song) => `<button class="song-list-item ${song.id === selectedSong()?.id ? "active" : ""}" draggable="true" data-song-id="${escapeHtml(song.id)}"><strong>${escapeHtml(song.title)}</strong><span>${escapeHtml(song.author)} · ${escapeHtml(song.difficulty)} · ${song.bpm} BPM · ${sourceTag(song)} · ${stageLabel(song)}</span></button>`).join("")}</div>`;
}

function renderSongDetail(song) {
  if (!song) return `<aside class="song-detail"><span class="detail-eyebrow">当前星球</span><h2>选择一颗音乐星球</h2><p>单击查看，双击可以直接试听。</p><span class="status-chip">等待选择</span><button class="preview-button" disabled>试听</button></aside>`;
  return `<aside class="song-detail">
    <span class="detail-eyebrow">当前星球</span>
    <h2>${escapeHtml(song.title)}</h2>
    <p>${escapeHtml(song.author)}</p>
    <p>编号 #${song.music_id} · ${escapeHtml(song.difficulty)} · ${song.bpm} BPM · ${formatDuration(song.compiled.durationMs)}<br>${state.libraryMode === "planet" ? "按住星球拖到下方键位即可选中。" : "从列表拖到下方键位，双击可以直接试听。"}</p>
    <span class="status-chip">${stageLabel(song)}</span>
    <label class="stage-editor"><span>测试阶段</span><select id="detail-stage" aria-label="测试阶段">${Object.entries(TEST_STAGE_LABELS).map(([stage, label]) => `<option value="${stage}" ${song.test_stage === Number(stage) ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <button class="preview-button" data-action="preview-song" data-song-id="${escapeHtml(song.id)}">${state.previewSongId === song.id ? "停止" : "试听"}</button>
  </aside>`;
}

function renderSlot(slot) {
  const song = slotSong(slot);
  const uploading = state.uploadingSlot === slot;
  return `<article class="slot-target ${song ? "filled" : ""}" data-slot="${slot}">
    <span class="slot-badge">K${slot + 1}</span>
    <div><strong>${escapeHtml(song ? `${song.title} · #${song.music_id}` : "拖到这里")}</strong><small>设备已保存：${escapeHtml(deviceSongText(slot))}</small></div>
    <button class="save-button" data-action="save-slot" data-slot="${slot}" ${song && !state.upgrading ? "" : "disabled"}>${uploading ? `写入 ${state.uploadPercent}%` : `保存到 K${slot + 1}`}</button>
  </article>`;
}

function renderMapping() {
  const mapping = state.mappings[state.mappingSlot];
  const ready = state.device.connected && state.keyboardLoaded && !state.upgrading;
  const locked = ready ? "" : "disabled";
  const keyLocked = ready && mapping.role !== "spin" ? "" : "disabled";
  const options = KEY_OPTIONS.some(([, value]) => value === mapping.key) ? KEY_OPTIONS : [...KEY_OPTIONS, [mapping.key, mapping.key]];
  return `
    ${pageHeading("键盘模式", "键位设置", "每颗键可选输出键值、播放 / 暂停或旋转陀螺。保存后立即生效。", `<span class="preview-chip">${state.keyboardLoaded ? "已连接" : "等待连接"}</span>`)}
    <section class="keyboard-deck"><div><strong>SJZ 三键键盘</strong><span>选择一颗键帽进行设置</span></div>${state.mappings.map((item, slot) => `<button class="keycap ${state.mappingSlot === slot ? "active" : ""} ${state.device.keyMask & (1 << slot) ? "physical-down" : ""}" data-mapping-slot="${slot}" ${locked}><b>K${slot + 1}</b><span>${state.keyboardLoaded ? escapeHtml(mappingText(item)) : "未读取"}</span></button>`).join("")}</section>
    <div class="mapping-layout">
      <section class="mapping-editor">
        <div class="section-heading"><h2>编辑 K${state.mappingSlot + 1}</h2><span>修改会暂存在本次配置中</span></div>
        <div class="form-row"><label>这颗键</label><div class="role-row">${[["key", "输出键值"], ["music", "播放 / 暂停"], ["spin", "旋转陀螺"]].map(([role, label]) => `<button class="${mapping.role === role ? "active" : ""}" data-role="${role}" ${locked}>${label}</button>`).join("")}</div></div>
        <div class="spin-grid ${mapping.role === "spin" ? "" : "inactive"}"><label>鼠标灵敏度<input id="mouse-sensitivity" type="number" min="0.1" max="10" step="0.1" value="${mapping.mouseSensitivity}" ${ready && mapping.role === "spin" ? "" : "disabled"}></label><label>水平灵敏度<input id="horizontal-sensitivity" type="number" min="0.1" max="6" step="0.1" value="${mapping.horizontalSensitivity}" ${ready && mapping.role === "spin" ? "" : "disabled"}></label><label>旋转扭矩<input type="number" value="${mapping.spinCounts}" readonly></label><label>旋转速度（ms/圈）<input id="spin-cycle" type="number" min="200" max="3000" step="20" value="${mapping.spinCycleMs}" ${ready && mapping.role === "spin" ? "" : "disabled"}></label></div>
        <p class="spin-note">鼠标灵敏度 × 水平灵敏度 × 扭矩 = 36000；按住实体键持续旋转，松开停止。APP V1.10 起内置轻微垂直补偿。</p>
        <div class="form-row"><label>触发方式</label><div class="segmented"><button class="${mapping.mode === "single" ? "active" : ""}" data-map-mode="single" ${keyLocked}>单键</button><button class="${mapping.mode === "combo" ? "active" : ""}" data-map-mode="combo" ${keyLocked}>组合键</button></div></div>
        <div class="form-row"><label>修饰键</label><div class="modifier-row">${["Ctrl", "Shift", "Alt", "Win"].map((name) => `<label><input type="checkbox" data-modifier="${name}" ${mapping.modifiers.includes(name) ? "checked" : ""} ${mapping.mode === "single" || keyLocked ? "disabled" : ""}> ${name}</label>`).join("")}</div></div>
        <div class="form-row"><label for="key-capture">按键录入</label><div class="key-entry"><input id="key-capture" value="${escapeHtml(mapping.role === "key" ? mappingText(mapping) : mapping.key)}" readonly ${keyLocked}><select id="key-select" ${keyLocked}>${options.map(([label, value]) => `<option value="${escapeHtml(value)}" ${mapping.key === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></div></div>
        <div class="output-box"><span>最终输出</span><strong>${escapeHtml(mappingText(mapping))}</strong></div>
        <div class="editor-actions"><button class="button" data-action="reset-mapping" ${locked}>恢复默认</button><button class="button primary" data-action="apply-mapping" ${locked}>应用到当前键位</button></div>
      </section>
      <aside class="mapping-summary">
        <h2>当前键盘布局</h2><p>这里是待保存配置；设备维护显示键盘里已保存的配置</p>
        ${state.mappings.map((item, slot) => `<div class="summary-row"><span>K${slot + 1}</span><strong>${state.keyboardLoaded ? escapeHtml(mappingText(item) === "旋转陀螺" ? `旋转陀螺 · 扭矩 ${item.spinCounts} · ${item.spinCycleMs} ms/圈` : item.role === "key" ? `输出 ${mappingText(item)}` : mappingText(item)) : "未读取"}</strong></div>`).join("")}
        <div class="write-state"><span>设备写入</span><b>${escapeHtml(state.keyboardMessage)}</b></div>
        <button class="button" data-action="reload-mapping" ${state.device.connected && !state.upgrading ? "" : "disabled"}>重新读取</button>
        <button class="button primary" data-action="save-mapping" ${ready ? "" : "disabled"}>保存到键盘</button>
      </aside>
    </div>`;
}

function renderLed() {
  const led = state.led;
  const ready = state.device.connected && state.ledLoaded && !state.upgrading;
  const disabled = ready ? "" : "disabled";
  return `${pageHeading("RGB 灯光", "灯光设置", "选择工作方式和三个按键的颜色；只有点击“保存到键盘”才会写入设备 Flash。")}
    <section class="led-card"><h2>控制模式</h2><select id="led-mode" ${disabled}>${[[0, "按下点亮"], [1, "常亮"], [2, "流水灯"]].map(([mode, label]) => `<option value="${mode}" ${led.mode === mode ? "selected" : ""}>${label}</option>`).join("")}</select><label><input id="led-random" type="checkbox" ${led.randomColors ? "checked" : ""} ${ready && led.mode === 2 ? "" : "disabled"}> 流水时使用随机颜色</label><p>${["按下对应按键时点亮，松开后熄灭。", "三个灯以最高 50% 亮度常亮。", "按 K1 → K2 → K3 顺序流水。"][led.mode]}</p></section>
    <section class="led-card"><h2>按键颜色</h2>${led.colors.map((color, slot) => `<label class="led-color">K${slot + 1} <input type="color" data-led-color="${slot}" value="#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}" ${ready && !(led.mode === 2 && led.randomColors) ? "" : "disabled"}> RGB ${color.join(", ")}</label>`).join("")}</section>
    <section class="led-card"><h2>亮度保护</h2><p>所有模式的最大亮度固定为 50%（128/255）。</p></section>
    <div class="led-actions"><span>${escapeHtml(state.ledMessage)}</span><button class="button primary" data-action="reload-led" ${state.device.connected && !state.upgrading ? "" : "disabled"}>重新读取</button><button class="button primary" data-action="save-led" ${ready ? "" : "disabled"}>保存到键盘</button></div>`;
}

function renderDevice() {
  const firmware = state.firmware;
  const bootMode = state.device.mode === "boot" && !state.device.connected;
  const updateAction = state.pendingApp ? "complete-update" : state.pendingBoot ? "continue-update" : "start-update";
  const updateLabel = state.upgrading ? "正在更新" : state.pendingApp ? "连接 APP 并完成" : state.pendingBoot ? "连接 BOOT 并继续" : "开始更新";
  return `
    ${pageHeading("设备与支持", "设备维护", "查看实体按键状态，或在需要时更新键盘固件。")}
    <section class="device-facts"><div><span>APP 固件</span><strong>${bootMode ? "更新模式" : firmwareVersion(state.device.firmwareVersion)}</strong></div><div><span>BOOT 固件</span><strong>${bootMode ? "连接 APP 后读取" : firmwareVersion(state.device.bootVersion)}</strong></div><div><span>键位配置</span><strong>${state.keyboardLoaded ? `格式 V${state.keyboardFormat} · 第 ${state.keyboardGeneration} 代` : "未读取"}</strong></div><div><span>LED 配置</span><strong>${state.ledLoaded ? `第 ${state.ledGeneration} 代` : "未读取"}</strong></div></section>
    <fieldset class="key-status"><legend>键盘按键状态</legend>${[0, 1, 2].map((slot) => {
      const pressed = state.device.connected && Boolean(state.device.keyMask & (1 << slot));
      const mapping = state.savedMappings?.[slot];
      return `<div class="${pressed ? "pressed" : ""}"><strong>K${slot + 1} · ${state.device.connected ? (pressed ? "按下" : "松开") : "未连接"}</strong><span>${mapping ? escapeHtml(mappingText(mapping)) : "配置未读取"}</span><small>${escapeHtml(deviceSongText(slot))}</small></div>`;
    }).join("")}</fieldset>
    <section class="firmware-card">
      <h2>固件更新</h2><p>默认加载随网页发布的 APP 加密升级包（.enc.hex），也可手动选择新包。浏览器会在本机解密并核验版本、大小与认证标签，再通过 USB 写入。更新保留 K1～K3 已存音乐；中断后可重新选同一文件继续。</p>
      <p>若新板只烧录了 BOOT，顶部“连接”无法连接正常键盘功能。可直接点击下方“开始更新”，再按提示选择 BOOT 设备并完成 APP 更新。</p>
      <div class="firmware-file"><span>${firmware ? escapeHtml(firmware.summary) : "尚未选择加密升级包"}</span><label class="button">选择更新文件<input id="firmware-input" type="file" accept=".enc.hex,.hex,text/plain"></label></div>
      <div class="progress"><span style="width:${firmware?.progress || 0}%"></span></div>
      <button class="button primary update-button" data-action="${updateAction}" ${(state.pendingApp || firmware?.valid) && !state.upgrading ? "" : "disabled"}>${updateLabel}</button>
      <pre class="upgrade-log">${escapeHtml(firmware?.log?.join("\n") || "更新过程会显示在这里")}</pre>
    </section>`;
}

function renderAbout() {
  return `
    ${pageHeading("ABOUT SJZ", "关于 SJZ 键盘", "音乐演奏、键值输出与旋转陀螺由键盘端独立执行。")}
    <section class="process-flow">${["本地曲库", "CH32 芯片", "标准 USB HID", "游戏输入响应"].map((text, index) => `${index ? "<i>→</i>" : ""}<span>${text}</span>`).join("")}</section>
    <section class="about-section"><h2>工作方式</h2><p>网页将最新曲库中的乐谱编译成带时间信息的设备曲包，通过 USB 写入键盘 Flash。K1～K3 可以分别配置成音乐播放 / 暂停、标准键值输出或按住持续旋转。键盘通过标准 USB HID 报告向电脑发送键盘与鼠标输入；关闭网页后，已保存的音乐和配置仍能使用。</p></section>
    <section class="about-section"><h2>关于旋转陀螺</h2><p>旋转扭矩根据鼠标灵敏度与水平灵敏度计算，每圈速度可以单独调节。固件内置轻微垂直补偿。不同游戏设置和枪械可能产生不同效果，建议在训练场校准。</p></section>
    <section class="about-section caution"><h2>游戏规则</h2><p>游戏对自动输入与外设宏的规则可能变化；使用前请查看游戏官方现行规则。SJZ 不承诺规避反作弊检测或封禁。</p></section>`;
}

function bindEvents() {
  // 右下角三段式主题控件：一次点击直达目标模式（不循环、不弹提示）。
  // 该控件在静态 HTML 里，不随 render() 重建，所以在这里绑定一次即可。
  // 注意属性名是 data-theme-choice，不能叫 data-theme-mode ——
  // 后者已经被 <html> 占用（theme.js 会写 root.dataset.themeMode），会互相干扰。
  document.querySelector(".theme-switch")?.addEventListener("click", (event) => {
    const segment = event.target.closest("[data-theme-choice]");
    if (segment) switchTheme(segment.dataset.themeChoice);
  });
  document.querySelector("#device-select")?.addEventListener("change", (event) => {
    state.selectedDeviceIndex = Number(event.target.value);
  });
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    state.view = button.dataset.view;
    render();
  }));
  document.querySelectorAll("[data-library-mode]").forEach((button) => button.addEventListener("click", () => {
    state.libraryMode = button.dataset.libraryMode;
    render();
  }));
  document.querySelector("#song-search")?.addEventListener("input", (event) => {
    state.search = event.target.value;
    state.selectedSongId = filteredSongs()[0]?.id || null;
    render();
    const input = document.querySelector("#song-search");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
  document.querySelector("#stage-filter")?.addEventListener("change", (event) => {
    state.stageFilter = Number(event.target.value);
    state.selectedSongId = filteredSongs()[0]?.id || null;
    render();
  });
  document.querySelector("#detail-stage")?.addEventListener("change", (event) => {
    const song = selectedSong();
    if (!song) return;
    song.test_stage = normalizeTestStage(event.target.value);
    state.stageOverrides[song.id] = song.test_stage;
    state.songs.sort((left, right) => left.test_stage - right.test_stage || left.catalogIndex - right.catalogIndex);
    persist();
    render();
  });
  document.querySelectorAll("[data-song-id]").forEach((node) => {
    node.addEventListener("click", () => { state.selectedSongId = node.dataset.songId; render(); });
    node.addEventListener("dblclick", () => previewSong(node.dataset.songId));
    node.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", node.dataset.songId));
  });
  document.querySelectorAll("[data-slot]").forEach((node) => {
    if (!node.classList.contains("slot-target")) return;
    node.addEventListener("dragover", (event) => { event.preventDefault(); node.classList.add("drag-over"); });
    node.addEventListener("dragleave", () => node.classList.remove("drag-over"));
    node.addEventListener("drop", (event) => {
      event.preventDefault();
      assignSong(Number(node.dataset.slot), event.dataTransfer.getData("text/plain"));
    });
    node.addEventListener("click", (event) => {
      if (!event.target.closest("button") && selectedSong()) assignSong(Number(node.dataset.slot), selectedSong().id);
    });
  });
  document.querySelectorAll("[data-mapping-slot]").forEach((button) => button.addEventListener("click", () => {
    state.mappingSlot = Number(button.dataset.mappingSlot);
    render();
  }));
  document.querySelectorAll("[data-role]").forEach((button) => button.addEventListener("click", () => {
    state.mappings[state.mappingSlot].role = button.dataset.role;
    markKeyboardDirty();
  }));
  document.querySelectorAll("[data-map-mode]").forEach((button) => button.addEventListener("click", () => {
    const mapping = state.mappings[state.mappingSlot];
    mapping.mode = button.dataset.mapMode;
    if (mapping.mode === "single") mapping.modifiers = [];
    markKeyboardDirty();
  }));
  document.querySelectorAll("[data-modifier]").forEach((input) => input.addEventListener("change", () => {
    const mapping = state.mappings[state.mappingSlot];
    mapping.modifiers = [...document.querySelectorAll("[data-modifier]:checked")].map((item) => item.dataset.modifier);
    markKeyboardDirty();
  }));
  document.querySelector("#key-select")?.addEventListener("change", (event) => {
    state.mappings[state.mappingSlot].key = event.target.value;
    markKeyboardDirty();
  });
  for (const id of ["mouse-sensitivity", "horizontal-sensitivity", "spin-cycle"]) {
    document.querySelector(`#${id}`)?.addEventListener("change", () => {
      const mapping = state.mappings[state.mappingSlot];
      try {
        const mouse = Number(document.querySelector("#mouse-sensitivity").value);
        const horizontal = Number(document.querySelector("#horizontal-sensitivity").value);
        const cycle = Number(document.querySelector("#spin-cycle").value);
        if (!Number.isInteger(cycle) || cycle < 200 || cycle > 3000) throw new Error("旋转速度须为 200～3000 ms/圈");
        mapping.spinCounts = spinCounts(mouse, horizontal);
        mapping.spinCycleMs = cycle;
        mapping.mouseSensitivity = mouse;
        mapping.horizontalSensitivity = horizontal;
        markKeyboardDirty();
      } catch (error) {
        showToast(error.message, "error");
        render();
      }
    });
  }
  document.querySelector("#led-mode")?.addEventListener("change", (event) => {
    state.led.mode = Number(event.target.value);
    markLedDirty();
  });
  document.querySelector("#led-random")?.addEventListener("change", (event) => {
    state.led.randomColors = event.target.checked;
    markLedDirty();
  });
  document.querySelectorAll("[data-led-color]").forEach((input) => input.addEventListener("change", () => {
    const slot = Number(input.dataset.ledColor);
    state.led.colors[slot] = [1, 3, 5].map((offset) => Number.parseInt(input.value.slice(offset, offset + 2), 16));
    markLedDirty();
  }));
  document.querySelector("#key-capture")?.addEventListener("keydown", captureKey);
  document.querySelector("#firmware-input")?.addEventListener("change", readFirmware);
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => handleAction(button)));
  // 注意：主题按钮统一走上面的 [data-action] 分发（handleAction 里有 toggle-theme 分支）。
  // 曾经在这里又额外绑了一次 switchTheme，导致一次点击触发两次、跳过中间模式。
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
    if (event.key !== "L" && event.key !== "l") return;
    event.preventDefault();
    switchTheme();
  });
}

/**
 * 切换主题。
 *
 * 这里**不能**调用 render()：那会重建页面节点，
 * 把「按键捕获」输入框里正在录制的按键状态清空。
 *
 * 不弹 toast —— 用户反馈「切换完不要出现主题：白天之类的」。
 * 模式已经由控件上的选中态直观体现，再弹提示只是噪音。
 *
 * @param {string} [mode] 指定模式；不传则按 auto → light → dark 循环
 */
function switchTheme(mode) {
  const next = THEME_MODES.includes(mode) ? setThemeMode(mode) : cycleThemeMode();
  syncThemeButton(next);
}

/** 把当前模式同步到右下角三段控件的选中态。 */
function syncThemeButton(mode = getThemeMode()) {
  document.querySelectorAll("[data-theme-choice]").forEach((segment) => {
    const active = segment.dataset.themeChoice === mode;
    segment.setAttribute("aria-pressed", active ? "true" : "false");
    segment.title = `${modeName(segment.dataset.themeChoice)}${active ? "（当前）" : ""}`;
  });
}

function captureKey(event) {
  event.preventDefault();
  const ignored = ["Control", "Shift", "Alt", "Meta"];
  if (ignored.includes(event.key)) return;
  const aliases = { " ": "Space", Escape: "Esc", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
  const key = aliases[event.key] || (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  const mapping = state.mappings[state.mappingSlot];
  mapping.key = key;
  mapping.modifiers = [event.ctrlKey && "Ctrl", event.shiftKey && "Shift", event.altKey && "Alt", event.metaKey && "Win"].filter(Boolean);
  mapping.mode = mapping.modifiers.length ? "combo" : "single";
  markKeyboardDirty();
  document.querySelector("#key-capture")?.focus();
}

function markKeyboardDirty() {
  state.keyboardDirty = true;
  state.keyboardMessage = "待保存到键盘";
  persist();
  render();
}

function markLedDirty() {
  state.ledDirty = true;
  state.ledMessage = "待保存到键盘";
  render();
}

function handleAction(button) {
  const action = button.dataset.action;
  if (action === "preview-song") return previewSong(button.dataset.songId);
  if (action === "save-slot") return saveSlot(Number(button.dataset.slot));
  if (action === "scan-device") return scanDevices();
  if (action === "connect-device") return state.pendingApp ? completeFirmwareUpdate() : connectDevice();
  if (action === "reload-library") return loadCatalog(true);
  if (action === "reload-mapping") return readKeyboardConfig(true);
  if (action === "save-mapping") return saveKeyboardConfig();
  if (action === "reload-led") return readLedConfig(true);
  if (action === "save-led") return saveLedConfig();
  if (action === "reset-mapping") {
    state.mappings[state.mappingSlot] = structuredClone(DEFAULT_MAPPINGS[state.mappingSlot]);
    markKeyboardDirty(); showToast(`K${state.mappingSlot + 1} 已恢复默认设置`); return;
  }
  if (action === "apply-mapping") { markKeyboardDirty(); showToast(`K${state.mappingSlot + 1} 已应用到本次配置`); return; }
  if (action === "start-update") return startFirmwareUpdate();
  if (action === "continue-update") return continueFirmwareUpdate();
  if (action === "complete-update") return completeFirmwareUpdate();
  if (action === "toggle-theme") return switchTheme();
}

function assignSong(slot, songId) {
  if (!state.songs.some((song) => song.id === songId)) return;
  state.slotSongIds[slot] = songId;
  persist();
  render();
  showToast(`《${slotSong(slot).title}》已放到 K${slot + 1}`);
}

async function previewSong(songId) {
  const song = state.songs.find((item) => item.id === songId);
  if (!song) return;
  if (state.previewSongId === songId) {
    stopPreview();
    state.previewSongId = null;
    render();
    return;
  }
  state.previewSongId = songId;
  render();
  try {
    await startPreview(song.compiled, () => {
      state.previewSongId = null;
      render();
    });
  } catch (error) {
    state.previewSongId = null;
    render();
    showToast(`试听失败：${error.message}`, "error");
  }
}

async function scanDevices() {
  try {
    const authorized = await hid.authorizedDevices({ includeBoot: true });
    const appDevices = authorized.filter((device) => device.productId !== BOOT_PID);
    const bootDevices = authorized.filter((device) => device.productId === BOOT_PID);
    state.devices = appDevices.length ? appDevices : bootDevices;
    state.selectedDeviceIndex = Math.min(state.selectedDeviceIndex, Math.max(0, state.devices.length - 1));
    if (!state.device.connected) state.device.mode = appDevices.length ? "none" : bootDevices.length ? "boot" : "none";
    state.device.label = appDevices.length ? (appDevices[0].productName || "SJZ 键盘")
      : bootDevices.length ? "SJZ 键盘（更新模式）" : (webHidSupported ? "点击连接检测设备" : "浏览器不支持 WebHID");
    render();
    if (appDevices.length) showToast(`发现 ${appDevices.length} 台已授权键盘`);
    else if (bootDevices.length) showToast(`发现 ${bootDevices.length} 台更新模式设备`);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function connectDevice() {
  try {
    const selectedDevice = state.devices[state.selectedDeviceIndex] || null;
    if (selectedDevice?.productId === BOOT_PID) {
      state.device.mode = "boot";
      state.device.label = "SJZ 键盘（更新模式）";
      state.view = "device";
      render();
      showToast("键盘正在等待 APP 更新，请使用设备维护中的固件更新", "success");
      return;
    }
    const status = await hid.connect({ request: !selectedDevice, selectedDevice });
    await finishAppConnection(status);
    reportAppConnection("SJZ 键盘已连接");
  } catch (error) {
    if (error.bootMode) {
      await scanDevices();
      state.device.mode = "boot";
      state.device.label = "SJZ 键盘（更新模式）";
      state.view = "device";
      render();
    }
    showToast(error.message || "连接已取消", "error");
  }
}

async function finishAppConnection(status) {
  applyConnectionStatus(status);
  state.devices = [hid.device];
  state.selectedDeviceIndex = 0;
  state.savedMappings = null;
  state.keyboardLoaded = false;
  state.ledLoaded = false;
  render();
  await readKeyboardConfig(false);
  await readLedConfig(false);
  if (!state.device.connected) throw new Error("APP 在读取配置时断开，请重新连接");
  startStatusPolling();
  state.pendingApp = false;
}

function reportAppConnection(successMessage) {
  const unread = [];
  if (!state.device.firmwareVersion) unread.push("APP 版本");
  if (!state.device.bootVersion) unread.push("BOOT 版本");
  if (!state.keyboardLoaded) unread.push("键位配置");
  if (!state.ledLoaded) unread.push("灯光配置");
  if (unread.length) showToast(`设备已连接，但${unread.join("、")}未读取；请重新连接或在对应页面重读`, "error");
  else showToast(successMessage, "success");
}

function applyConnectionStatus(status) {
  state.device = {
      connected: true,
      mode: "app",
      label: hid.device.productName || "SJZ 键盘",
      validMask: status.validMask,
      keyMask: status.keyMask,
      playing: status.playing,
      activeSlot: status.activeSlot,
      firmwareVersion: status.firmwareVersion,
      bootVersion: status.bootVersion,
      musicIds: status.musicIds,
      keyConfigSupported: status.keyConfigSupported,
      spinSupported: status.spinSupported,
      ledConfigFormat: status.ledConfigFormat,
      ledGeneration: status.ledGeneration,
  };
}

async function readKeyboardConfig(showErrors = true) {
  if (!state.device.connected || configBusy) return;
  configBusy = true;
  try {
    const config = await hid.getKeyboardConfig();
    const mappings = config.mappings.map((item, slot) => {
      const existing = state.mappings[slot];
      if (item.role === "spin" && existing?.role === "spin" && existing.spinCounts === item.spinCounts) {
        return { ...item, mouseSensitivity: existing.mouseSensitivity,
          horizontalSensitivity: existing.horizontalSensitivity };
      }
      return item;
    });
    state.mappings = mappings;
    state.savedMappings = structuredClone(mappings);
    state.keyboardGeneration = config.generation;
    state.keyboardFormat = config.formatVersion;
    state.keyboardLoaded = true;
    state.keyboardDirty = false;
    state.keyboardMessage = `已读取第 ${config.generation} 代配置`;
    persist();
  } catch (error) {
    state.keyboardLoaded = false;
    state.savedMappings = null;
    state.keyboardMessage = `读取失败：${error.message}`;
    if (showErrors) showToast(state.keyboardMessage, "error");
  } finally {
    configBusy = false;
    render();
  }
}

async function saveKeyboardConfig() {
  if (!state.device.connected || !state.keyboardLoaded || configBusy) return;
  configBusy = true;
  try {
    const saved = await hid.setKeyboardConfig(state.mappings, state.keyboardFormat);
    state.keyboardGeneration = saved.generation;
    state.keyboardFormat = saved.formatVersion;
    state.savedMappings = structuredClone(state.mappings);
    state.keyboardDirty = false;
    state.keyboardMessage = `已保存第 ${saved.generation} 代配置`;
    showToast("键位设置已保存到键盘", "success");
  } catch (error) {
    state.keyboardMessage = `保存失败：${error.message}`;
    showToast(state.keyboardMessage, "error");
  } finally {
    configBusy = false;
    render();
  }
}

async function readLedConfig(showErrors = true) {
  if (!state.device.connected || configBusy) return;
  configBusy = true;
  try {
    const config = await hid.getLedConfig();
    state.led = { mode: config.mode, randomColors: config.randomColors, colors: config.colors };
    state.ledLoaded = true;
    state.ledDirty = false;
    state.ledGeneration = config.generation;
    state.ledMessage = `已读取第 ${config.generation} 代配置`;
  } catch (error) {
    state.ledLoaded = false;
    state.ledMessage = `读取失败：${error.message}`;
    if (showErrors) showToast(state.ledMessage, "error");
  } finally {
    configBusy = false;
    render();
  }
}

async function saveLedConfig() {
  if (!state.device.connected || !state.ledLoaded || configBusy) return;
  configBusy = true;
  try {
    const saved = await hid.setLedConfig(state.led);
    state.led = { mode: saved.mode, randomColors: saved.randomColors, colors: saved.colors };
    state.ledGeneration = saved.generation;
    state.ledDirty = false;
    state.ledMessage = `已保存第 ${saved.generation} 代配置`;
    showToast("灯光设置已保存到键盘", "success");
  } catch (error) {
    state.ledMessage = `保存失败：${error.message}`;
    showToast(state.ledMessage, "error");
  } finally {
    configBusy = false;
    render();
  }
}

function startStatusPolling() {
  window.clearInterval(statusTimer);
  statusTimer = window.setInterval(async () => {
    if (!state.device.connected || state.upgrading || state.uploadingSlot >= 0 || statusBusy || configBusy) return;
    statusBusy = true;
    try {
      const status = await hid.getStatus();
      const oldKeyMask = state.device.keyMask;
      const oldMusicIds = state.device.musicIds;
      const oldValidMask = state.device.validMask;
      const oldFirmwareVersion = state.device.firmwareVersion;
      const oldBootVersion = state.device.bootVersion;
      Object.assign(state.device, {
        validMask: status.validMask, keyMask: status.keyMask, playing: status.playing,
        activeSlot: status.activeSlot, firmwareVersion: status.firmwareVersion,
        bootVersion: status.bootVersion, musicIds: status.musicIds,
        keyConfigSupported: status.keyConfigSupported, spinSupported: status.spinSupported,
        ledConfigFormat: status.ledConfigFormat, ledGeneration: status.ledGeneration,
      });
      if (state.view === "device" &&
          (oldKeyMask !== status.keyMask || oldValidMask !== status.validMask ||
            oldFirmwareVersion !== status.firmwareVersion || oldBootVersion !== status.bootVersion ||
            oldMusicIds.some((id, slot) => id !== status.musicIds[slot]))) render();
      if (state.view === "mapping" && oldKeyMask !== status.keyMask) render();
      if (state.view === "library" &&
          (oldValidMask !== status.validMask || oldMusicIds.some((id, slot) => id !== status.musicIds[slot]))) render();
      if (state.ledLoaded && !state.ledDirty && status.ledGeneration !== state.ledGeneration) await readLedConfig(false);
    } catch {
      // A transient status miss does not disconnect a healthy HID handle.
    } finally {
      statusBusy = false;
    }
  }, 180);
}

async function saveSlot(slot) {
  const song = slotSong(slot);
  if (!song) return;
  if (!state.device.connected) {
    showToast("请先在右上角连接 SJZ 键盘", "error");
    return;
  }
  state.uploadingSlot = slot;
  state.uploadPercent = 0;
  render();
  try {
    const status = await hid.upload(slot, song.compiled.packageBytes, (current, total) => {
      state.uploadPercent = Math.round(current * 100 / total);
      render();
    });
    state.device.validMask = status.validMask;
    const confirmed = await hid.getStatus();
    state.device.musicIds = confirmed.musicIds;
    showToast(`保存完成，《${song.title}》已经放进 K${slot + 1}`, "success");
  } catch (error) {
    showToast(`保存失败：${error.message}`, "error");
  } finally {
    state.uploadingSlot = -1;
    render();
  }
}

async function readFirmware(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const nonce = ++firmwareSelectionNonce;
  try {
    const contents = await file.text();
    if (nonce !== firmwareSelectionNonce) return;
    await prepareFirmware(contents, file.name, nonce);
  } catch (error) {
    if (nonce !== firmwareSelectionNonce) return;
    state.firmware = { valid: false, progress: 0, summary: `固件无效：${error.message}`, log: [error.message] };
    showToast(error.message, "error");
  }
  render();
}

async function prepareFirmware(contents, name, nonce) {
  const image = await decryptFirmware(contents);
  if (nonce !== firmwareSelectionNonce) return;
  state.firmware = {
    ...image, valid: true, progress: 0,
    summary: `${name} · ${image.data.length.toLocaleString()} 字节 · CRC32 ${image.crc32.toString(16).toUpperCase().padStart(8, "0")}`,
    log: ["加密更新文件校验通过",
      `APP 地址 0x${image.sourceLow.toString(16).toUpperCase()} - 0x${(image.sourceHigh - 1).toString(16).toUpperCase()}`],
  };
  state.pendingBoot = null;
}

async function loadDefaultFirmware() {
  const nonce = firmwareSelectionNonce;
  try {
    const response = await fetch("./firmware/CH32V203C8T.enc.hex", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contents = await response.text();
    if (nonce !== firmwareSelectionNonce) return;
    await prepareFirmware(contents, "CH32V203C8T.enc.hex（默认）", nonce);
  } catch (error) {
    if (nonce !== firmwareSelectionNonce) return;
    state.firmware = { valid: false, progress: 0,
      summary: `默认加密固件不可用：${error.message}`, log: [error.message] };
  }
  render();
}

async function startFirmwareUpdate() {
  if (!state.firmware?.valid || state.upgrading) return;
  state.upgrading = true;
  state.pendingBoot = null;
  state.firmware.log.push("准备连接 SJZ Bootloader");
  render();
  try {
    await inspectUpgradeDevices();
    let switchedFromApp = false;
    if (state.device.connected) {
      await hid.enterIap();
      switchedFromApp = true;
      state.device.connected = false;
      state.firmware.log.push("设备已进入更新模式");
      await new Promise((resolve) => window.setTimeout(resolve, 900));
    }
    let bootloader;
    try {
      bootloader = await requestBootloader({ afterSwitch: switchedFromApp });
    } catch (error) {
      if (!error.needsPermission) throw error;
      state.pendingBoot = { afterSwitch: switchedFromApp };
      state.firmware.log.push("BOOT 已进入授权步骤；点击“连接 BOOT 并继续”");
      return;
    }
    await performFirmwareUpload(bootloader);
  } catch (error) {
    state.firmware.log.push(`升级失败：${error.message}`);
    showToast(`固件升级失败：${error.message}`, "error");
  } finally {
    state.upgrading = false;
    render();
  }
}

async function continueFirmwareUpdate() {
  if (!state.pendingBoot || !state.firmware?.valid || state.upgrading) return;
  const { afterSwitch } = state.pendingBoot;
  // requestBootloader invokes the WebHID chooser before its first await.
  const bootPromise = requestBootloader({ afterSwitch, request: true });
  state.upgrading = true;
  state.pendingBoot = null;
  render();
  try {
    await performFirmwareUpload(await bootPromise);
  } catch (error) {
    state.firmware.log.push(`升级失败：${error.message}`);
    showToast(`固件升级失败：${error.message}`, "error");
  } finally {
    state.upgrading = false;
    render();
  }
}

async function completeFirmwareUpdate() {
  if (!state.pendingApp || state.upgrading) return;
  // Open the APP chooser during this click; WebHID requires a user gesture.
  const appPromise = hid.connect({ request: true, appOnly: true });
  state.upgrading = true;
  render();
  try {
    const status = await appPromise;
    await finishAppConnection(status);
    state.firmware.log.push("APP 已连接并读取固件版本，固件升级完成");
    reportAppConnection("固件升级完成");
  } catch (error) {
    markAppReconnectPending(error);
    state.firmware.log.push(`APP 连接未完成：${error.message}`);
    showToast(`APP 连接未完成：${error.message}`, "error");
  } finally {
    state.upgrading = false;
    render();
  }
}

function markAppReconnectPending(error) {
  state.pendingApp = true;
  state.devices = [];
  state.selectedDeviceIndex = 0;
  state.device = { ...state.device, connected: false, mode: "none", label: "等待连接 APP",
    firmwareVersion: 0, bootVersion: 0, keyMask: null };
  state.savedMappings = null;
  state.keyboardLoaded = false;
  state.keyboardMessage = "连接 APP 后重新读取";
  state.ledLoaded = false;
  state.ledMessage = "连接 APP 后重新读取";
  state.firmware.log.push(`固件已通过 CRC32 校验；${error.message}。点击“连接 APP 并完成”重试`);
}

async function performFirmwareUpload(bootloader) {
  try {
    await uploadFirmware(bootloader, state.firmware, (percent, message) => {
      state.firmware.progress = Math.max(0, Math.min(100, percent));
      if (state.firmware.log.at(-1) !== message) state.firmware.log.push(message);
      render();
    });
  } finally {
    if (bootloader.opened) {
      try { await bootloader.close(); } catch { /* BOOT may have disconnected while starting APP. */ }
    }
  }
  state.firmware.log.push("设备端写入与 CRC32 校验成功；等待 APP 重新连接");
  try {
    const appDevice = await waitForAppReenumeration();
    const status = await hid.connect({ selectedDevice: appDevice });
    await finishAppConnection(status);
  } catch (error) {
    markAppReconnectPending(error);
    showToast("固件已通过校验；请连接 APP 完成状态读取", "error");
    return;
  }
  state.firmware.log.push("APP 已稳定重连，固件升级完成");
  reportAppConnection("固件升级完成");
}

/**
 * 读取曲库。优先走 D1 API，取不到时回退到随站点发布的 JSON 快照 ——
 * 这样离线、或 API 未部署（例如只跑静态服务器）时页面仍然可用。
 */
async function loadCatalog(reload = false) {
  const stamp = reload ? `?t=${Date.now()}` : "";
  let payload = null;
  let source = "";

  try {
    const response = await fetch(`./api/songs${stamp}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.message || data.error || "接口返回失败");
    payload = data;
    source = "D1";
  } catch (apiError) {
    try {
      const response = await fetch(`./data/music-catalog.json${stamp}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json();
      source = "本地 JSON 快照";
    } catch {
      state.songs = [];
      render();
      showToast(`曲库读取失败：API（${apiError.message}）与本地快照都不可用`, "error");
      return;
    }
  }

  try {
    const songs = Array.isArray(payload) ? payload : payload.songs || [];
    state.catalogSource = source;
    state.songs = songs
      .filter((song) => song.verified)
      .map((song, catalogIndex) => ({
        ...song,
        catalogIndex,
        test_stage: normalizeTestStage(state.stageOverrides[song.id] ?? song.test_stage),
        compiled: compileSong(song),
      }))
      .sort((left, right) => left.test_stage - right.test_stage || left.catalogIndex - right.catalogIndex);
    state.selectedSongId = state.songs.some((song) => song.id === state.selectedSongId) ? state.selectedSongId : state.songs[0]?.id || null;
    render();
    if (reload) showToast(`曲库已重新加载，共 ${state.songs.length} 首（来源：${source}）`);
  } catch (error) {
    state.songs = [];
    render();
    showToast(`曲库解析失败：${error.message}`, "error");
  }
}

// 主题：引导脚本已设好 data-theme，这里恢复存储的模式并在 auto 下跟随系统。
// 只同步浮动按钮，不调用 render()，以免打断「按键捕获」等交互状态。
setThemeMode(getThemeMode());
syncThemeButton();
watchSystemTheme(() => syncThemeButton());

render();
loadCatalog();
scanDevices();
loadDefaultFirmware();

// 主题控制：三档模式 auto / light / dark，默认跟随系统。
//
// 设计：<html data-theme="light|dark"> 始终是**解析后**的具体主题，
// auto 由 JS 通过 matchMedia 解析，并监听系统变化实时跟随。
// 这样 CSS 只需处理两个具体值，不存在第三套规则。
//
// 防闪烁：index.html / keyboard.html 里有一段内联脚本，在 CSS 之前
// 用同一套规则设置好 data-theme，模块加载后这里只负责后续交互。

export const THEME_KEY = "zh-hub-theme";
export const THEME_MODES = ["auto", "light", "dark"];

const MODE_LABELS = { auto: "跟随系统", light: "白天", dark: "夜晚" };
const MODE_ICONS = { auto: "🌗", light: "☀️", dark: "🌙" };

/** 当前系统是否偏好暗色。matchMedia 在非浏览器环境（如预览脚本）下不可用。 */
function systemPrefersDark() {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
  } catch {
    return false;
  }
}

function readStored() {
  try {
    const value = globalThis.localStorage?.getItem(THEME_KEY);
    return THEME_MODES.includes(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

function store(mode) {
  try {
    globalThis.localStorage?.setItem(THEME_KEY, mode);
  } catch {
    /* 隐私模式下写入会失败，主题仍然在本次会话生效 */
  }
}

/** 把模式与系统偏好解析成具体主题，并写到 <html data-theme>。 */
export function applyTheme(mode) {
  const resolved = mode === "auto" ? (systemPrefersDark() ? "dark" : "light") : mode;
  const root = globalThis.document?.documentElement;
  if (root) {
    root.dataset.theme = resolved;
    root.dataset.themeMode = mode;
    root.style.colorScheme = resolved;
  }
  return resolved;
}

// 模块级模式状态；preview/test 环境没有 document 时也要能工作。
let currentMode = readStored();

export function getThemeMode() {
  return currentMode;
}

export function resolvedTheme() {
  return currentMode === "auto" ? (systemPrefersDark() ? "dark" : "light") : currentMode;
}

export function modeLabel(mode = currentMode) {
  return `${MODE_ICONS[mode] || ""} ${MODE_LABELS[mode] || mode}`.trim();
}

/** 只取图标，用于圆形浮动按钮。 */
export function modeIcon(mode = currentMode) {
  return MODE_ICONS[mode] || "🌗";
}

/** 只取中文名，用于提示与 toast。 */
export function modeName(mode = currentMode) {
  return MODE_LABELS[mode] || mode;
}

/** 点击时在 跟随系统 → 白天 → 夜晚 之间循环。 */
export function setThemeMode(mode) {
  currentMode = THEME_MODES.includes(mode) ? mode : "auto";
  store(currentMode);
  applyTheme(currentMode);
  return currentMode;
}

export function cycleThemeMode() {
  const index = THEME_MODES.indexOf(currentMode);
  return setThemeMode(THEME_MODES[(index + 1) % THEME_MODES.length]);
}

/**
 * 直接在白天 / 夜晚之间切换（不经过「跟随系统」）。
 * 单图标按钮用这个：一次点击就到目标，不用按两次；
 * 想回到跟随系统用长按或 Ctrl+Shift+L。
 * 当前是 auto 时，按「与系统相反」的方向切。
 */
export function toggleLightDark() {
  const current = resolvedTheme();
  return setThemeMode(current === "dark" ? "light" : "dark");
}

/** auto 模式下跟随系统切换。返回取消订阅函数（测试用）。 */
export function watchSystemTheme(onChange) {
  let media;
  try {
    media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  } catch {
    return () => {};
  }
  if (!media?.addEventListener) return () => {};
  const handler = () => {
    if (currentMode !== "auto") return;
    applyTheme(currentMode);
    onChange?.(resolvedTheme());
  };
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}

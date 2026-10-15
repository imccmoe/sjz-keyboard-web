import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const css = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");

/** WCAG 相对亮度。 */
function luminance(hex) {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 取出某个主题块内的变量，并把块内的 var(--x) 引用就地解析（最多两级）。 */
function themeVars(marker) {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `找不到 ${marker}`);
  const block = css.slice(start, css.indexOf("}", start));
  const raw = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    raw[match[1]] = match[2].trim();
  }
  const resolve = (value, depth = 0) => {
    const reference = /^var\((--[a-z0-9-]+)(?:,\s*([^)]+))?\)$/.exec(value);
    if (!reference || depth > 2) return value;
    const next = raw[reference[1]] ?? reference[2]?.trim();
    return next ? resolve(next, depth + 1) : value;
  };
  const vars = {};
  for (const [name, value] of Object.entries(raw)) {
    const resolved = resolve(value);
    if (/^#[0-9a-fA-F]{3,8}$/.test(resolved)) vars[name] = resolved.toLowerCase();
  }
  return vars;
}

const THEMES = [':root[data-theme="light"]', ':root[data-theme="dark"]'];

/**
 * 回归：暗色主题的 --violet 曾经是 #8b7cf0（引入时）/#7d6cf0（初版），
 * 白色按钮文字对比度不足 4.5，鼠标悬停时按钮上的字几乎看不见。
 */
test("两套主题的主色都能承载白色文字（对比度 >= 4.5）", () => {
  for (const marker of THEMES) {
    const vars = themeVars(marker);
    assert.ok(vars["--violet"], `${marker} 缺少 --violet`);
    const ratio = contrast(vars["--violet"], vars["--on-accent"] || "#ffffff");
    assert.ok(ratio >= 4.5,
      `${marker} 的 --violet ${vars["--violet"]} 与白字对比度仅 ${ratio.toFixed(2)}，应 >= 4.5`);
  }
});

test("薄荷色按钮能承载深色文字（对比度 >= 4.5）", () => {
  for (const marker of THEMES) {
    const vars = themeVars(marker);
    assert.ok(vars["--mint"] && vars["--on-mint"], `${marker} 缺少 --mint 或 --on-mint`);
    const ratio = contrast(vars["--mint"], vars["--on-mint"]);
    assert.ok(ratio >= 4.5,
      `${marker} 的 --mint 与 --on-mint 对比度 ${ratio.toFixed(2)}，应 >= 4.5`);
  }
});

test("正文与面板背景对比度达标", () => {
  for (const marker of THEMES) {
    const vars = themeVars(marker);
    for (const [foreground, background] of [["--ink", "--canvas"], ["--ink", "--panel"], ["--muted", "--panel"]]) {
      assert.ok(vars[foreground] && vars[background], `${marker} 缺少 ${foreground} 或 ${background}`);
      const required = foreground === "--muted" ? 3.5 : 4.5;
      const ratio = contrast(vars[foreground], vars[background]);
      assert.ok(ratio >= required,
        `${marker} 的 ${foreground}(${vars[foreground]}) 与 ${background}(${vars[background]}) 对比度 ${ratio.toFixed(2)}，应 >= ${required}`);
    }
  }
});

/**
 * 回归：.eyebrow（「发现音乐」这类小标题）用紫色文字压在暗色画布上。
 * 主色 --violet 为了承载白字必须偏暗（#6a5ae0 只有 3.76），
 * 所以文字场景拆出更亮的 --violet-text。
 */
test("紫色文字在暗色画布上对比度达标（--violet-text 与 --violet 分离）", () => {
  for (const marker of THEMES) {
    const vars = themeVars(marker);
    assert.ok(vars["--violet-text"], `${marker} 缺少 --violet-text`);
    const ratio = contrast(vars["--violet-text"], vars["--canvas"]);
    assert.ok(ratio >= 4.5,
      `${marker} 的 --violet-text ${vars["--violet-text"]} 与画布 ${vars["--canvas"]} 对比度 ${ratio.toFixed(2)}，应 >= 4.5（-2 与文字同色会看不见）`);
  }
});

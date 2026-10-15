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

/**
 * 回归：用户报告「鼠标放到连接按钮上就变成白色」，连续两次反馈后决定**彻底去掉按钮悬停变色**。
 * 根因是 `.button:hover` 与 `.button.primary` 优先级相同（都是 0,2,0），胜负只由书写顺序决定。
 * 现在通过两条约束避免复发：
 *   1. 不存在 `.button` / `.button.primary` 的 :hover 背景规则
 *   2. 主按钮的 color 用 inherit，永远继承基础规则（--button-ink），
 *      即使将来有人误加悬停规则，文字也不会变成白色
 */
test("主按钮不参与悬停变色，文字色使用前景变量", () => {
  // 先剥掉注释，否则注释里提到的 `.button:hover` 会被当成真实规则
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const buttonHoverRules = [
    ...code.matchAll(/([^{}]*\.button[^{}]*:hover[^{}]*)\{([^}]*)\}/g)
  ].map((match) => ({ selector: match[1].trim(), body: match[2] }));

  assert.deepEqual(buttonHoverRules, [],
    `不应再为 .button 定义悬停规则，实际存在：${buttonHoverRules.map((r) => r.selector).join(" / ")}`);

  const primary = /\.button\.primary\s*\{([^}]*)\}/.exec(code);
  assert.ok(primary, "找不到 .button.primary");
  assert.match(primary[1], /background:\s*var\(--violet\)/, "主按钮底色应保持紫色");
  // 不能用 inherit：按钮 color 默认继承父元素的 --button-ink，实测只有 3.46 的对比度
  assert.ok(!/color:\s*inherit/.test(primary[1]),
    "主按钮的文字色不能用 inherit，会继承到深色的 --button-ink");
  assert.match(primary[1], /color:\s*var\(--on-accent\)/,
    "主按钮文字应使用 --on-accent（两套主题都是白色）");
});

test("开发服务器为静态资源提供 ETag，避免浏览器用旧缓存", () => {
  // 改完样式看不到变化，多半是弱缓存命中。dev.mjs 必须给出验证依据。
  const dev = fs.readFileSync(path.join(ROOT, "scripts", "dev.mjs"), "utf8");
  assert.match(dev, /etag/i, "dev.mjs 未提供 ETag");
  assert.match(dev, /last-modified/i, "dev.mjs 未提供 Last-Modified");
  assert.match(dev, /304/, "dev.mjs 未处理条件请求（应返回 304）");
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.match(html, /styles\.css\?v=\d+/, "样式表引用应带版本号，便于强制刷新");
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

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
 * 回归：`.button:hover` 与 `.button.primary` 优先级相同（都是 0,2,0），
 * 若通用悬停规则不排除主按钮，胜负只由书写顺序决定 ——
 * 曾导致悬停时紫色底被换成浅色、白字消失（对比度 1.04）。
 * 现在的约定：通用悬停规则用 :not(.primary) 排除主按钮，
 * 主按钮自己的悬停态显式重声明底色与文字色。
 */
test("悬停规则不互相覆盖：通用规则排除主按钮，主按钮自行声明", () => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

  const generic = /\.button:hover:not\(:disabled\)([^{]*)\{([^}]*)\}/.exec(code);
  assert.ok(generic, "找不到通用按钮悬停规则");
  assert.match(generic[1], /:not\(\.primary\)/,
    "通用悬停规则必须排除主按钮，否则会覆盖主按钮的紫色底");
  assert.match(generic[2], /background:/, "通用悬停规则应保留背景反馈");

  const primaryHover = /\.button\.primary:hover[^{]*\{([^}]*)\}/.exec(code);
  assert.ok(primaryHover, "主按钮缺少自己的悬停规则");
  assert.match(primaryHover[1], /background:\s*var\(--violet\)/,
    "主按钮悬停态必须重新声明紫色底");
  assert.match(primaryHover[1], /color:\s*var\(--on-accent\)/,
    "主按钮悬停态必须重新声明白色文字");

  const primary = /\.button\.primary\s*\{([^}]*)\}/.exec(code);
  assert.ok(primary, "找不到 .button.primary");
  assert.ok(!/color:\s*inherit/.test(primary[1]),
    "主按钮文字色不能用 inherit，会继承到深色的 --button-ink");
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

/**
 * 回归：键盘区的底盘与键帽原先在两套主题里都用同一组深色变量，
 * 在浅色页面中表现为一条横贯全宽的深色大色块（用户反馈「不要出现一大块色块」）。
 * 现在底盘与键帽都跟随主题，这里固定它们的对比度，避免以后调色时又变得看不清。
 */
test("键盘区底盘与键帽在两套主题下都清晰可读", () => {
  for (const marker of THEMES) {
    const vars = themeVars(marker);
    const pairs = [
      ["--keycap-ink", "--keycap-bg", 4.5, "键帽文字"],
      ["--deck-label-ink", "--deck-bg", 4.5, "底盘标题"],
      ["--deck-sub-ink", "--deck-bg", 3.5, "底盘次要文字"]
    ];
    for (const [foreground, background, required, label] of pairs) {
      assert.ok(vars[foreground] && vars[background], `${marker} 缺少 ${foreground} 或 ${background}`);
      const ratio = contrast(vars[foreground], vars[background]);
      assert.ok(ratio >= required,
        `${marker} 的 ${label} ${vars[foreground]} 与 ${vars[background]} 对比度 ${ratio.toFixed(2)}，应 >= ${required}`);
    }
  }
});

test("键盘区底盘不得使用星空深色变量，且两套主题取值不同", () => {
  // 成因断言：底盘曾用 --space-deck（星球视图那种 #15162f 深色），
  // 在浅色页面里就是一大块深色。现在必须走独立的 --deck-bg。
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const deckRule = /\.keyboard-deck\s*\{([^}]*)\}/.exec(code);
  assert.ok(deckRule, "找不到 .keyboard-deck 规则");
  assert.match(deckRule[1], /background:\s*var\(--deck-bg\)/,
    "底盘背景应使用 --deck-bg");
  assert.ok(!/var\(--space-deck\)/.test(deckRule[1]),
    "底盘不应再使用 --space-deck（那是星球视图的深色）");

  const light = themeVars(':root[data-theme="light"]');
  const dark = themeVars(':root[data-theme="dark"]');
  assert.ok(light["--deck-bg"] && dark["--deck-bg"], "两套主题都要定义 --deck-bg");
  assert.notEqual(light["--deck-bg"], dark["--deck-bg"],
    "--deck-bg 应随主题变化，否则总有一套主题会显得突兀");
});

test("所有滚动区域的滚动条都要自定义，不能用系统默认", () => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // 这四个是页面里真正会滚动的容器：
  //   .song-list   「全部音乐」列表（用户实际看到滚动条的地方）
  //   .planet      星球视图（曲目多于坐标时）
  //   .upgrade-log 固件升级日志
  //   .detail-body 乐曲简介（长标题 + 两段简介放不下时内部滚动）
  const scrollables = [".song-list", ".planet", ".upgrade-log", ".detail-body"];
  for (const selector of scrollables) {
    assert.match(code, new RegExp(`\\${selector}::-webkit-scrollbar-thumb`),
      `${selector} 缺少 WebKit 滚动条滑块样式`);
    assert.match(code, new RegExp(`\\${selector}::-webkit-scrollbar-track`),
      `${selector} 缺少 WebKit 滚动条轨道样式`);
  }
  assert.match(code, /scrollbar-width:\s*thin/, "缺少 scrollbar-width: thin（标准属性）");
  assert.match(code, /scrollbar-color:\s*var\(--space-ring\)\s+transparent/,
    "缺少 scrollbar-color，轨道应为透明");
  assert.match(code, /::-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent/,
    "WebKit 滚动条轨道应为透明");
  assert.match(code, /::-webkit-scrollbar-thumb\s*\{[^}]*border-radius:\s*999px/,
    "滚动条滑块应做圆角，避免生硬的方块");

  for (const marker of THEMES) {
    const vars = themeVars(marker);
    assert.ok(vars["--space-ring"], `${marker} 缺少 --space-ring（滚动条滑块颜色）`);
    assert.ok(vars["--focus-ring"], `${marker} 缺少 --focus-ring（滚动条悬停色）`);
  }
});

test("搜索筛选栏的文字与图标在两套主题下都可读", () => {
  // 搜索栏用了多个色板变量，逐个固定对比度，避免以后调色看不见
  for (const marker of THEMES) {
    const vars = themeVars(marker);
    const pairs = [
      ["--ink", "--surface", 4.5, "「查找星球」标签"],
      ["--ink", "--surface-sunken", 4.5, "搜索框与下拉里的文字"],
      ["--muted", "--surface-sunken", 3.0, "占位符与放大镜图标"],
      ["--violet-text", "--surface", 4.5, "筛选后的「匹配 N 首」计数"],
      ["--muted", "--surface", 3.5, "默认计数"],
      ["--control-ink", "--surface-sunken", 3.0, "下拉箭头"],
      ["--control-ink", "--surface-soft", 3.0, "清空按钮图标"]
    ];
    for (const [foreground, background, required, label] of pairs) {
      assert.ok(vars[foreground] && vars[background], `${marker} 缺少 ${foreground} 或 ${background}`);
      const ratio = contrast(vars[foreground], vars[background]);
      assert.ok(ratio >= required,
        `${marker} 的${label} ${vars[foreground]} 与 ${vars[background]} 对比度 ${ratio.toFixed(2)}，应 >= ${required}`);
    }
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

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

/** 取出某个选择器块内的 --变量名。 */
function varsIn(css, startMarker, endMarker) {
  const start = css.indexOf(startMarker);
  assert.ok(start >= 0, `找不到 ${startMarker}`);
  const sliced = endMarker ? css.slice(start, css.indexOf(endMarker, start)) : css.slice(start);
  return [...sliced.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]);
}

test("styles.css 的亮/暗主题定义了完全相同的变量集合", () => {
  const css = read("public/styles.css");
  const light = new Set(varsIn(css, ':root[data-theme="light"]', ':root[data-theme="dark"]'));
  const dark = new Set(varsIn(css, ':root[data-theme="dark"]'));
  assert.ok(light.size > 5, `亮色主题变量过少（${light.size}）`);
  assert.ok(dark.size > 5, `暗色主题变量过少（${dark.size}）`);

  const onlyLight = [...light].filter((name) => !dark.has(name));
  const onlyDark = [...dark].filter((name) => !light.has(name));
  assert.deepEqual(onlyLight, [], "这些变量只在亮色主题定义，暗色下会取不到值");
  assert.deepEqual(onlyDark, [], "这些变量只在暗色主题定义，亮色下会取不到值");
});

test("样式表没有自引用变量", () => {
  const css = read("public/styles.css");
  const broken = [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*var\(\1\)\s*;/gm)].map((match) => match[1]);
  assert.deepEqual(broken, [], `存在自引用变量：${broken.join(", ")}`);
});

test("样式表正文不再散落硬编码颜色（除变量定义块外）", () => {
  const css = read("public/styles.css");
  const body = css.replace(/:root[^{]*\{[^}]*\}/gs, "");
  const hex = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(hex)], [], `正文仍有硬编码颜色：${[...new Set(hex)].join(" ")}`);
});

test("页面在样式表之前设置 data-theme，避免主题闪烁", () => {
  const html = read("public/index.html");
  const scriptAt = html.indexOf("dataset.theme");
  const linkAt = html.search(/<link[^>]+stylesheet/);
  assert.ok(scriptAt > 0, "缺少主题引导脚本");
  assert.ok(linkAt > 0, "缺少样式表引用");
  assert.ok(scriptAt < linkAt, "主题脚本必须在样式表之前执行");
  assert.match(html, /prefers-color-scheme: dark/, "引导脚本未读取系统偏好");
  assert.match(html, /zh-hub-theme/, "引导脚本未读取已保存的主题");
});

test("theme.js 的三档模式与持久化键与引导脚本一致", () => {
  const theme = read("public/theme.js");
  assert.match(theme, /export const THEME_MODES = \["auto", "light", "dark"\]/);
  assert.match(theme, /export const THEME_KEY = "zh-hub-theme"/);
  const bootstrapKey = /localStorage\.getItem\("([^"]+)"\)/.exec(read("public/index.html"))?.[1];
  assert.equal(bootstrapKey, "zh-hub-theme");
});

test("主题切换只有一条触发路径，避免重复绑定导致跳过模式", () => {
  // 回归：曾经既在 [data-action] 分发里处理 toggle-theme，又额外给按钮绑了一次
  // switchTheme，一次点击触发两次，auto 直接跳过 light 跳到 dark。
  const app = read("public/app.js");
  const directBindings = [...app.matchAll(/addEventListener\("click",\s*switchTheme\)/g)];
  assert.equal(directBindings.length, 0, "不应再直接给主题按钮绑定 switchTheme");
  assert.match(app, /if \(action === "toggle-theme"\) return switchTheme\(\);/,
    "handleAction 必须处理 toggle-theme");
});

test("主题按钮是静态浮动按钮，不参与页面重渲染", () => {
  // 按钮放在 index.html 而不是渲染函数里：浮动元素若每次重渲染都重建会闪动、丢焦点。
  const html = read("public/index.html");
  const buttons = [...html.matchAll(/<button[^>]*data-action="toggle-theme"/g)];
  assert.equal(buttons.length, 1, `index.html 里应只有一个主题按钮，实际 ${buttons.length}`);
  assert.match(html, /class="theme-toggle"/, "主题按钮应带 .theme-toggle 类名");

  const app = read("public/app.js");
  const renderedButtons = [...app.matchAll(/<button[^>]*data-action="toggle-theme"/g)];
  assert.equal(renderedButtons.length, 0, "渲染函数里不应再生成主题按钮");
  assert.match(app, /function syncThemeButton/, "缺少同步按钮图标与提示的函数");
  assert.match(app, /syncThemeButton\(\)/, "启动时应调用 syncThemeButton 初始化按钮");

  // 浮动样式应定义在样式表里
  const styles = read("public/styles.css");
  const toggleRule = /\.theme-toggle\s*\{([^}]*)\}/.exec(styles);
  assert.ok(toggleRule, "styles.css 缺少 .theme-toggle 规则");
  assert.match(toggleRule[1], /position:\s*fixed/, "主题按钮应为固定定位的浮动按钮");
  assert.match(toggleRule[1], /right:|bottom:/, "主题按钮应贴在窗口角落");
});

test("切换主题不得重建页面（否则会清空正在录制的交互状态）", () => {
  const app = read("public/app.js");
  const body = /function switchTheme\(\)\s*\{([\s\S]*?)\n\}/.exec(app)?.[1] || "";
  assert.ok(body.length > 0, "找不到 switchTheme 实现");
  assert.ok(!/\brender\(/.test(body), "switchTheme 内不应调用 render()");
});

test("页面不引用其他站点或配装方案资源", () => {
  // 本仓库是独立的键盘网页端，不应残留指向配装站的链接或数据引用。
  for (const file of ["public/app.js", "public/index.html"]) {
    const source = read(file);
    assert.ok(!source.includes("/hub/"), `${file} 仍引用 /hub/`);
    assert.ok(!source.includes("orzice"), `${file} 仍引用 orzice`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, "public/data/schemes.json")), "不应携带配装方案数据");
});

test("强调色面上的文字使用前景色变量，而不是被当作背景色的 --surface", () => {
  // 回归：主题化时把 #fff 统一换成了 var(--surface)，但 --surface 是面板背景色
  // （暗色下 #171a2b）。用在紫色按钮/徽标上会让文字几乎看不见 —— 表现为
  // 「鼠标放到连接按钮上就变成白色/看不见」。
  const css = read("public/styles.css");
  const accentBackgrounds = /background:\s*var\(--(violet|mint|key-pressed-bg|space-[a-z-]+|keycap-bg|toast-bg)\)/;

  for (const block of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [, selectors, body] = block;
    if (!accentBackgrounds.test(body)) continue;
    assert.ok(!/color:\s*var\(--surface\)/.test(body),
      `${selectors.trim()} 在强调/深色背景上把 --surface 当文字色用，应改用 --on-accent / --on-space / --keycap-ink`);
  }
});

test("前景色变量在亮暗两套主题里都不指向背景色", () => {
  const css = read("public/styles.css");
  for (const marker of [':root[data-theme="light"]', ':root[data-theme="dark"]']) {
    const start = css.indexOf(marker);
    const block = css.slice(start, css.indexOf("}", start));
    for (const name of ["--on-accent", "--on-space", "--keycap-ink", "--keycap-on", "--toast-ink"]) {
      const value = new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
      assert.ok(value, `${marker} 缺少 ${name}`);
      assert.ok(!value.startsWith("var(--surface"),
        `${marker} 的 ${name} 指向了背景色（${value}），会导致文字看不见`);
    }
  }
});

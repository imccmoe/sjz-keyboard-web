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

/**
 * 取出某个具名函数的函数体。
 * 用花括号配对而不是正则 —— 函数体里常有嵌套的 {}（对象、回调），
 * 非贪婪正则会提前在第一个 `\n}` 处截断。
 */
function functionBody(source, name) {
  // 参数列表里可能有 `mode = getThemeMode()` 这类带括号的默认值，
  // 所以做括号配对找参数结尾，而不是用 [^)]* 这种会提前截断的写法。
  const head = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!head) return "";
  let index = head.index + head[0].length;
  let paren = 1;
  for (; index < source.length && paren > 0; index += 1) {
    if (source[index] === "(") paren += 1;
    else if (source[index] === ")") paren -= 1;
  }
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (source[index] !== "{") return "";
  const bodyStart = index + 1;
  let depth = 1;
  for (index = bodyStart; index < source.length && depth > 0; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
  }
  return source.slice(bodyStart, index - 1);
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

test("主题切换只有一条触发路径，避免重复绑定导致切换两次", () => {
  // 回归（真实踩过）：bindEvents() 会在初始化和 render() 后各执行一次，
  // 于是 [data-action] 按钮上挂了两个监听器、handleAction 执行两次。
  // 主题「切了两次又切回去」，表现为点了没反应。
  // 现在统一用一条委托监听，并用一次性标志保证只挂一次。
  const app = read("public/app.js");
  const perElement = [...app.matchAll(/querySelectorAll\("\[data-action\]"\)\.forEach\([\s\S]{0,80}?addEventListener\("click"/g)];
  assert.equal(perElement.length, 0, "不应再逐个 [data-action] 元素绑定 click");

  assert.match(app, /closest\("\[data-action\]"\)/,
    "缺少 [data-action] 的委托监听");
  // 断言要匹配真正的代码，不能只匹配到注释
  assert.match(app, /if \(!document\.documentElement\.dataset\.actionDelegateBound\)\s*\{/,
    "委托监听必须用一次性标志防止重复挂载");
  assert.match(app, /dataset\.themeHoldBound/, "长按绑定也必须有一次性标志");

  // 主题按钮本身不能再有独立的 click 切换路径
  const direct = [...app.matchAll(/addEventListener\("click",\s*switchTheme\)|toggleLightDark\(\);\s*\n\s*syncThemeButton\(\);/g)];
  assert.equal(direct.length, 0, "主题按钮不应有独立的 click 切换路径（会与委托叠加成两次）");
  assert.match(app, /if \(action === "toggle-theme"\) return switchTheme\(\);/,
    "handleAction 必须处理 toggle-theme");
});

test("主题按钮是静态单图标，点击在白天 / 夜晚间切换，长按跟随系统", () => {
  // 放在 index.html 而不是渲染函数里：浮动元素若每次重渲染都重建会闪动、丢焦点。
  // 用户要求「有一个图标就行了，不要有三个」+「放到右下角」。
  const html = read("public/index.html");
  const buttons = [...html.matchAll(/<button[^>]*data-action="toggle-theme"/g)];
  assert.equal(buttons.length, 1, `index.html 应只有一个主题按钮，实际 ${buttons.length}`);
  assert.match(html, /class="theme-toggle"/, "主题按钮应带 .theme-toggle 类名");
  assert.ok(!/theme-segment|theme-switch|data-theme-choice/.test(html),
    "不应再残留三段式控件的结构");

  const app = read("public/app.js");
  const rendered = [...app.matchAll(/<button[^>]*data-action="toggle-theme"/g)];
  assert.equal(rendered.length, 0, "渲染函数里不应再生成主题按钮");
  assert.match(app, /function syncThemeButton/, "缺少同步图标的函数");
  assert.match(app, /syncThemeButton\(\)/, "启动时应调用 syncThemeButton 初始化图标");
  // 单击直达目标模式；长按 600ms 回到跟随系统
  assert.match(app, /toggleLightDark\(\)/, "单击应调用 toggleLightDark");
  assert.match(app, /setTimeout\([\s\S]*?600\)/, "长按应使用 600ms 定时器");
  assert.match(app, /setThemeMode\("auto"\)/, "长按应回到跟随系统");

  const styles = read("public/styles.css");
  const toggleRule = /\.theme-toggle\s*\{([^}]*)\}/.exec(styles);
  assert.ok(toggleRule, "styles.css 缺少 .theme-toggle 规则");
  assert.match(toggleRule[1], /position:\s*fixed/, "主题按钮应为固定定位的浮动按钮");
  assert.match(toggleRule[1], /right:\s*\d+px/, "按钮应贴在窗口右侧（用户要求右下角）");
  assert.match(toggleRule[1], /bottom:\s*\d+px/, "按钮应贴在窗口底部");
  assert.ok(!/\.theme-segment/.test(styles), "不应再残留三段式样式");
});

test("theme.js 提供「白天 / 夜晚」直达切换", () => {
  const theme = read("public/theme.js");
  const body = functionBody(theme, "toggleLightDark");
  assert.ok(body, "缺少 toggleLightDark");
  // 应基于已解析主题反向切换，而不是走 auto→light→dark 循环
  assert.match(body, /resolvedTheme\(\)/, "应基于当前解析出的主题判断");
  assert.match(body, /setThemeMode\(/, "应调用 setThemeMode");
  assert.ok(!/cycleThemeMode/.test(body), "不应退化成循环切换");
});

test("切换主题不弹提示（用户反馈不要「主题：白天」这类提示）", () => {
  const app = read("public/app.js");
  const body = functionBody(app, "switchTheme");
  assert.ok(body, "找不到 switchTheme 实现");
  assert.ok(!/showToast\(/.test(body), "switchTheme 内不应再调用 showToast");
  // 同步选中态的函数同样不该弹提示
  const sync = functionBody(app, "syncThemeButton");
  assert.ok(sync, "找不到 syncThemeButton 实现");
  assert.ok(!/showToast\(/.test(sync), "syncThemeButton 内不应调用 showToast");
});

test("切换主题不得重建页面（否则会清空正在录制的交互状态）", () => {
  const app = read("public/app.js");
  const body = functionBody(app, "switchTheme");
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

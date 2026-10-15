# SJZ 三键音乐键盘 · 网页端

SJZ 三键音乐键盘的网页配置工具。通过 **WebHID** 直连键盘，把音乐、键位与灯光配置写进设备，
并支持在浏览器里完成固件升级。

- **前端**：`public/` 纯静态资源，**没有构建步骤**
- **后端**：`functions/` 是 Cloudflare Pages Functions，曲库存在 **D1**，由 `/api/songs` 提供
- **部署**：Cloudflare Pages（静态资源 + Functions + D1 一起部署，见 [部署](#部署)）

## 功能

- **音乐星球**：从当前曲库试听、搜索、拖放并写入 K1～K3；V2 曲包包含曲目编号，
  设备维护可显示已保存的歌曲
- **键位设置**：读取、编辑、保存每颗键的键值、播放暂停或旋转陀螺角色，
  支持鼠标灵敏度、水平灵敏度和每圈速度
- **灯光设置**：读取、编辑、保存按下点亮、常亮、流水灯，以及三个按键的颜色（亮度固定 50%）
- **设备维护**：查看实体按键状态、固件版本，并在需要时更新固件
- **主题**：右下角图标按钮单击切换白天 / 夜晚，长按（或 `Ctrl/Cmd + Shift + L`）跟随系统

默认加载 PyQt 使用的 `.enc.hex` 加密 APP 升级包，也能手动选择新包；在浏览器本地解密验证后
通过 USB 更新。切换到 BOOT 后如需新授权，页面会显示「连接 BOOT 并继续」。只有设备端 CRC32
校验通过且 APP 稳定重连，才报告升级完成。

升级网页内置的 AES 密钥仅用于与现有 PyQt 加密包兼容，属于文件格式门槛，不构成防逆向的强安全保护。

## 曲库与 D1

曲目存在 Cloudflare D1 里（不再是写死的 JSON 文件），可以随时通过管理页增删改，
无需改代码重新部署。

| 路径 | 说明 |
| --- | --- |
| `GET /api/songs` | 曲库列表，支持 `stage`、`q`、`sort`、`limit`、`offset` |
| `GET /api/songs/:id` | 单曲详情，`:id` 支持主键、曲目编号或标题 |
| `GET/POST /api/admin/songs` | 管理端列表 / 新增 / 批量导入（需令牌） |
| `GET/PATCH/DELETE /api/admin/songs/:id` | 管理端单曲读写与删除（需令牌） |
| `/manage.html` | 网页版曲库管理界面 |

管理接口用 `Authorization: Bearer <ADMIN_TOKEN>` 鉴权，令牌比较是常数时间实现。
服务端没配 `ADMIN_TOKEN` 时管理接口整体关闭（返回 503）。

`/manage.html` 支持列出、编辑、删除曲目，以及两种批量导入：**JSON 合并导入**（只更新给出的曲目）
与 **JSON 替换导入**（清空后导入）。

`seeds/songs.sql` 是**初始**曲库快照（25 首）。线上曲库以 D1 为准，后续改动不会回写这个文件。

## 本地开发

```powershell
npm install                      # 只有一个 devDependency：wrangler
npm run dev                      # 纯静态服务器（没有 Functions，曲库读不到，仅用于看样式 / 布局）
npx wrangler pages dev public    # 完整环境：Pages Functions + 本地 D1（默认 http://127.0.0.1:8788）
```

本地 D1 首次使用先建表再导入种子：

```powershell
npx wrangler d1 migrations apply sjz-keyboard-web --local
npx wrangler d1 execute sjz-keyboard-web --local --file seeds/songs.sql
```

`.dev.vars` 里放 `ADMIN_TOKEN=...`（已被 gitignore），本地管理接口才可用：

```
ADMIN_TOKEN=local-dev-token
```

> 曲库只存放在 D1，页面始终通过 `/api/songs` 读取，**没有本地 JSON 快照**。
> 只跑 `npm run dev` 时曲库为空并提示读取失败；要完整浏览曲库，请用 `wrangler pages dev`。

> WebHID 需要**安全上下文**。`localhost` / `127.0.0.1` 被视为安全来源，本地可以直接用；
> 线上**必须 HTTPS**，否则浏览器不提供 WebHID，页面上不会出现「连接」按钮。

## 部署

站点跑在 **Cloudflare Pages** 上：`public/` 是静态资源，`functions/` 是曲库 API，数据在 D1。

> ⚠️ **不能当纯静态站点部署。** 曲库只从 `/api/songs` 读，页面里没有 JSON 快照兜底。
> 把 `public/` 丢给 Netlify 或任意静态托管，页面能打开，但曲库一律读取失败。

### 前置条件

- Node 18+，`npx wrangler` 可用（`npm install` 装的 devDependency 就是它）
- 一个 Cloudflare 账号，并登录：`npx wrangler login`
  （CI 里改用环境变量 `CLOUDFLARE_API_TOKEN`，权限需含 Pages:Edit 与 D1:Edit）
- `wrangler.toml` 里的 `database_id` 还是占位符，第一步会替换掉

### 首次部署

```powershell
# 1. 建 D1 库，把输出里的 database_id 填进 wrangler.toml
npx wrangler d1 create sjz-keyboard-web

# 2. 远程建表（songs / song_counters）
npx wrangler d1 migrations apply sjz-keyboard-web --remote

# 3. 导入初始曲库（25 首；seeds/songs.sql 是曲库唯一的数据快照）
npx wrangler d1 execute sjz-keyboard-web --remote --file seeds/songs.sql

# 4. 设置管理令牌（不设的话 /api/admin/* 一律 503）
npx wrangler pages secret put ADMIN_TOKEN --project-name sjz-keyboard-web

# 5. 部署（输出目录取自 wrangler.toml 的 pages_build_output_dir）
npx wrangler pages deploy --project-name sjz-keyboard-web
```

第一次 `pages deploy` 时若项目还不存在，wrangler 会提示创建；也可以先显式建好：

```powershell
npx wrangler pages project create sjz-keyboard-web --production-branch main
```

**D1 绑定**：`wrangler.toml` 里声明了 `[[d1_databases]] binding = "DB"`，部署时会带上。
若线上 `/api/songs` 返回 `503 {"error":"db_unbound"}`，说明项目没绑上这个库 ——
到 Pages 项目 → Settings → Functions → D1 database bindings 里添加变量名 `DB` 指向该库，
然后重新部署一次。

### 部署后验证

```powershell
# 曲库列表：应返回 ok:true、25 首、next_music_id 26
curl.exe https://sjz-keyboard-web.pages.dev/api/songs

# 单曲：主键、编号、标题三种写法都支持
curl.exe https://sjz-keyboard-web.pages.dev/api/songs/1
```

再打开 `https://<项目>.pages.dev/manage.html`，填入 `ADMIN_TOKEN`，确认能列出、编辑曲目。

`*.pages.dev` 自带 HTTPS；绑自定义域名时同样要开 HTTPS，否则 WebHID 不可用。

### 日常更新

| 要改什么 | 怎么做 |
| --- | --- |
| 前端代码 / 样式 / 固件包 | `npx wrangler pages deploy` 重新部署 |
| 曲库内容 | 打开 `/manage.html` 增删改，**立即生效，不用重新部署** |
| 表结构 | 新增 `migrations/000N_*.sql`，再 `npx wrangler d1 migrations apply sjz-keyboard-web --remote` |
| 管理令牌 | `npx wrangler pages secret put ADMIN_TOKEN --project-name sjz-keyboard-web` |
| 导出线上曲库 | `npx wrangler d1 export sjz-keyboard-web --remote --output backup.sql` |

### 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 页面能开，曲库提示「读取失败」 | 当纯静态站部署了，或 Functions 没传上去；确认 `/api/songs` 可用 |
| `/api/songs` 返回 503 `db_unbound` | Pages 项目没绑定 D1，见上面「D1 绑定」 |
| `/api/admin/*` 返回 503 `admin_token_missing` | 没设 `ADMIN_TOKEN` 环境变量 |
| `/api/admin/*` 返回 401 | 令牌不对，格式是 `Authorization: Bearer <token>` |
| 页面上没有「连接」按钮 | 不是安全上下文：必须 HTTPS（本地 localhost 例外） |
| 曲库是空的 | 没导入种子，见首次部署第 3 步 |

## 连接与固件升级

顶部「刷新已授权设备」只显示浏览器此前授权的键盘；首次授权请点击「连接」。

若板子只烧录了 BOOT，设备会以 `1A86:FE02` 出现，正常键盘连接需要 `1A86:FE01` 的 APP。
此时进入「设备维护」，确认默认加密升级包已加载，点击「开始更新」，再按页面提示授权 BOOT 设备。
若选择弹窗仍为空，先在 Windows 设备管理器确认 `1A86:FE02` 设备当前在线。

升级文件写入并通过 CRC32 校验后，网页会等待 APP 设备重新出现。如果浏览器尚未授权新的
`1A86:FE01` 设备，「设备维护」会显示「连接 APP 并完成」；点击后在浏览器弹窗中选择 APP，
即可读取固件版本与配置。灯光和键位配置读取成功后可直接保存；音乐保存按钮需要先把歌曲放入
对应的 K1～K3 键位。

## 目录结构

```
public/
  index.html            单页入口（主题防闪烁引导脚本 + 右下角静态主题按钮）
  manage.html           曲库管理页（内联模块，不经构建）
  app.js                主逻辑与视图渲染
  styles.css            样式（亮/暗两套主题变量）
  theme.js              主题控制器：auto / light / dark
  device.js             WebHID 传输层：报文、IAP 固件升级、CRC16
  device-config.js      键位与灯光配置的二进制编解码
  music-engine.js       曲谱编译、WAV 音色库、试听渲染、CRC32
  firmware.js           .enc.hex 的 AES-128-GCM 解密校验
  favicon.svg
  _redirects            /keyboard → 站点根（308）
  firmware/CH32V203C8T.enc.hex   默认加密 APP 升级包
  assets/               物理音色库（sprite JSON + WAV）
functions/
  api/songs/            公开曲库 API
  api/admin/songs/      管理端 API（需令牌）
  api/_lib/             共享工具：响应封装、路径参数解码、校验、SQL 查询
migrations/0001_songs.sql   songs / song_counters 建表与计数器初始化
seeds/songs.sql          初始曲库种子（25 首，曲库唯一的数据快照）
tests/                   纯 Node 测试，无需网络与依赖
scripts/
  dev.mjs                零依赖本地静态服务器（npm run dev）
  check-inline-modules.mjs   HTML 内联模块语法检查
  ui-*.mjs               无头浏览器界面回归检查（npm run ui:*）
```

## 测试

```powershell
npm test              # 单元测试（纯 Node，无需依赖与联网）
npm run ui:theme      # 主题切换：耗时、不弹提示、直达相反主题（需先 npx wrangler pages dev public）
npm run ui:layout     # 页面交互回归：浮动控件遮挡、顶栏状态块与按钮同高、搜索栏等宽、键位卡片对齐、调试快捷键、试听播放、星球坐标（同上）
npm run ui:manage     # 曲库管理页可正常加载（同上）
npm run ui:contrast   # 真实浏览器逐元素对比度（同上）
npm run check:inline  # HTML 内联模块语法
```

`npm test` 只用 Node 内置测试运行器，不需要装依赖或联网；`ui:*` 需要 Edge 与本地服务器。

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/protocol.test.js` | 曲包协议、旋转灵敏度换算、键位/灯光往返、加密固件校验 |
| `tests/device-wire.test.js` | WebHID 报文往返、OTA 分区基址、旋转键 v1→v2 过渡 |
| `tests/theme.test.js` | 亮暗变量集合一致、无自引用变量、无硬编码颜色、主题只有一条触发路径、前景色不误用背景色 |
| `tests/contrast.test.js` | 主色承载白字、薄荷底承载深字、正文与背景、紫色文字的 WCAG 对比度、悬停规则不互相覆盖 |
| `tests/songs-api.test.js` | 曲库 API 契约：列表筛选与 LIKE 转义、单曲三种定位（含路径参数百分号编码）、鉴权、编号分配与不复用、导入 replace/merge、迁移与种子 SQL 可执行 |
| `tests/preview.test.js` | 试听播放：渲染期间被停止或被新试听取代时不得出声、正常 start → stop 与 onDone 复位（用替身 AudioContext 在纯 Node 下跑） |

`npm run ui:contrast` 会在无头浏览器里对按钮、标签、按键、徽标等元素逐个计算对比度，
并报告不达标的项。它抓的是「文字与背景撞色导致看不见」这类静态检查发现不了的问题：

```
[dark 主题]
  ✔ .button.primary   5.06 (需 4.5)  rgb(255,255,255) on rgb(106,90,224)  "连接"
  ✖ .eyebrow          3.76 (需 4.5)  rgb(106,90,224) on rgb(14,15,27)     "发现音乐"
```

### 主题切换

右下角一个图标按钮：**单击**在白天 / 夜晚之间直达切换，**长按 600ms**（或 `Ctrl/Cmd + Shift + L`）
回到跟随系统。不循环、不弹提示，当前模式由图标体现。

三条约束由测试固定，都是踩过坑的：

- **主题按钮写在 `index.html` 里，不参与 `render()`** —— 浮动元素每次重渲染都重建会闪动、丢焦点。
- **切换只能有一条触发路径**。`bindEvents()` 每次 `render()` 都会执行，逐元素绑定会让一次点击
  执行两遍、两次切换互相抵消，表现为「点了没反应」；所以按钮走一次性标志的委托监听，
  全局 `keydown` 也必须只挂一次（`npm run ui:layout` 会数 `document` 上的 keydown 注册次数）。
- **浮动控件不能压住可交互元素**。右下角的主题按钮会遮住 K3 卡片的「保存到 K3」：
  按钮占位距视口右缘 50px（宽 38 + right 12），而卡片右缘只距视口 24px，横竖都会相交。
  主题按钮保持在右下角，改由键位卡片在**内部**留出右侧空间
  （`.slot-target` 的 `padding-right: 32px`）来避让 —— 卡片外框仍左右贴齐整行，
  三个保存按钮之间也仍然对齐。`npm run ui:layout` 的「浮动按钮不遮挡任何可交互元素」盯着这条。

### 配色约束

- **主色要够暗**：`--violet` 用于按钮底色并承载白字，必须满足 4.5:1
  （`#7d6cf0` 只有 3.98，会把按钮文字变得难辨）
- **紫色文字要另用变量**：同一个色既做底色又做文字会互相矛盾，
  深色底上的紫字用 `--violet-text`（比 `--violet` 更亮）
- **主按钮的悬停态要显式声明底色与文字色**：`.button:hover` 与 `.button.primary`
  优先级相同（都是 0,2,0），胜负只由书写顺序决定；通用规则已用 `:not(.primary)` 排除主按钮

> `node --test` 会为每个测试文件派生一个子进程。若运行环境禁止 spawn（报 `EPERM`），
> 逐个文件直接跑即可：`node tests/protocol.test.js`。

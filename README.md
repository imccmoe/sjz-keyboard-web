# SJZ 三键音乐键盘 · 网页端

SJZ 三键音乐键盘的网页配置工具。通过 **WebHID** 直连键盘，写入音乐、键位与灯光配置，
并支持在浏览器内完成固件升级。

| 组成 | 实现 |
| --- | --- |
| 前端 | `public/` 静态资源，无构建步骤 |
| 后端 | `functions/`，Cloudflare Pages Functions，曲库接口为 `/api/songs` |
| 数据 | Cloudflare D1 |
| 部署 | Cloudflare Pages，静态资源、Functions 与 D1 一并部署，详见[部署](#部署) |

## 功能

- **音乐星球**：试听、搜索曲目，拖放写入 K1～K3；V2 曲包携带曲目编号，设备维护页可显示已保存的曲目
- **键位设置**：读取、编辑并保存每颗键的键值、播放/暂停或旋转陀螺角色，支持鼠标灵敏度、水平灵敏度与每圈速度
- **灯光设置**：读取、编辑并保存按下点亮、常亮、流水灯三种模式与三个按键颜色（亮度固定 50%）
- **设备维护**：查看实体按键状态与固件版本，并在需要时更新固件
- **主题**：右下角图标按钮单击切换白天/夜晚，长按或 `Ctrl/Cmd + Shift + L` 切换为跟随系统

固件升级默认使用 PyQt 版本的 `.enc.hex` 加密 APP 升级包，也可手动选择其他升级包。
升级包在浏览器内解密校验后经 USB 写入。切换至 BOOT 后如需重新授权，页面会提示
「连接 BOOT 并继续」。仅当设备端 CRC32 校验通过且 APP 稳定重连后，才报告升级完成。

页面内置的 AES 密钥用于兼容既有 PyQt 加密包，仅构成文件格式门槛，不构成防逆向的强安全保护。

## 曲库与 D1

曲目存储于 Cloudflare D1，可通过管理页增删改，无需重新部署前端。

| 路径 | 说明 |
| --- | --- |
| `GET /api/songs` | 曲库列表，支持 `stage`、`q`、`sort`、`limit`、`offset` |
| `GET /api/songs/:id` | 单曲详情，`:id` 可为主键、曲目编号或标题 |
| `GET/POST /api/admin/songs` | 管理端列表、新增与批量导入（需令牌） |
| `GET/PATCH/DELETE /api/admin/songs/:id` | 管理端单曲读写与删除（需令牌） |
| `/manage.html` | 曲库管理界面 |

管理接口使用 `Authorization: Bearer <ADMIN_TOKEN>` 鉴权，令牌比较为常数时间实现。
服务端未配置 `ADMIN_TOKEN` 时，管理接口整体关闭并返回 503。

`/manage.html` 支持列出、编辑与删除曲目，以及两种批量导入：JSON 合并导入（仅更新给出的曲目）
与 JSON 替换导入（清空后导入）。

`seeds/songs.sql` 为初始曲库快照（25 首）。线上曲库以 D1 为准，后续改动不回写该文件。

## 本地开发

```powershell
npm install                      # 唯一 devDependency：wrangler
npm run dev                      # 纯静态服务器；无 Functions，曲库不可用，仅用于查看样式与布局
npx wrangler pages dev public    # 完整环境：Pages Functions + 本地 D1（默认 http://127.0.0.1:8788）
```

本地 D1 首次使用需建表并导入种子：

```powershell
npx wrangler d1 migrations apply sjz-keyboard-web --local
npx wrangler d1 execute sjz-keyboard-web --local --file seeds/songs.sql
```

本地 D1 状态按 `database_id` 分目录存放。修改 `wrangler.toml` 中的 `database_id` 后，
本地会指向另一份空库，需重新执行上述两条命令，否则接口返回
`D1_ERROR: no such table: songs`。

本地管理接口需要 `.dev.vars`（已在 `.gitignore` 中）。该值仅用于本地测试，
不应使用线上令牌：

```
ADMIN_TOKEN=dev-only-change-me
```

曲库仅存于 D1，页面始终通过 `/api/songs` 读取，无本地 JSON 快照。
仅运行 `npm run dev` 时曲库为空并提示读取失败；完整浏览曲库需使用 `wrangler pages dev`。

WebHID 要求安全上下文。`localhost` 与 `127.0.0.1` 属于安全来源，可用于本地开发；
线上必须启用 HTTPS，否则浏览器不提供 WebHID，页面不会显示「连接」按钮。

## 部署

站点运行于 Cloudflare Pages：`public/` 为静态资源，`functions/` 为曲库 API，数据存于 D1。

曲库仅通过 `/api/songs` 读取，页面无 JSON 快照兜底。若仅将 `public/` 部署至静态托管
（Netlify 或任意静态服务），页面可以打开，但曲库会全部读取失败。

### 前置条件

- Node 18+，并已执行 `npm install`（`npx wrangler` 使用项目内的 devDependency）
- Cloudflare 账号，并完成登录：`npx wrangler login`
  （CI 或无交互环境改用环境变量 `CLOUDFLARE_API_TOKEN`，权限需包含 Pages:Edit 与 D1:Edit）

### 首次部署

以下步骤存在先后依赖，需按顺序执行。

**1. 创建 D1 数据库**

```powershell
npx wrangler d1 create sjz-keyboard-web
```

输出包含配置片段，其中 `database_id` 为该数据库的 UUID。

**2. 将 UUID 写入 `wrangler.toml`**

该字段初始为占位符：

```toml
[[d1_databases]]
binding = "DB"
database_name = "sjz-keyboard-web"
database_id = "replace-with-your-d1-id"   # 替换为上一步输出的 UUID
```

`wrangler d1 create` 不会修改该文件（其帮助文本为 “provides the binding and UUID that you
will put in your config file”），UUID 需手动写入。此外，`wrangler.toml` 是 Pages 项目的配置来源
（source of truth）：部署时按该文件写入绑定，控制台中对应字段为只读。
保留占位符会导致部署失败，且无法仅在控制台修正，必须修改该文件后重新部署。

写入后可自行检查：

```powershell
Select-String -Path wrangler.toml -Pattern 'database_id'
# 输出中不应再出现 replace-with-your-d1-id
```

`database_id` 是资源标识符而非密钥，建议提交至仓库；使用 Git 集成自动部署时，
部署读取的即仓库中的值。

本步骤不影响本地开发：`--local` 使用本地模拟数据库，占位符不影响 `wrangler pages dev`
与 `d1 ... --local`；仅 `--remote` 命令与 `pages deploy` 需要真实 UUID。

**3. 远程建表（songs / song_counters）**

```powershell
npx wrangler d1 migrations apply sjz-keyboard-web --remote
```

**4. 导入初始曲库（25 首）**

```powershell
npx wrangler d1 execute sjz-keyboard-web --remote --file seeds/songs.sql
```

**5. 创建 Pages 项目**

```powershell
npx wrangler pages project create sjz-keyboard-web --production-branch main
```

第 6 步的 `pages secret put` 要求项目已存在，因此需先创建。
（首次 `pages deploy` 也会隐式创建项目，但会使设置令牌晚于部署，见第 6 步说明。）

**6. 设置管理令牌**

```powershell
npx wrangler pages secret put ADMIN_TOKEN --project-name sjz-keyboard-web
```

必须在部署之前设置：secrets 与绑定仅对设置之后的部署生效。若先部署再设置令牌，
线上仍返回 503 `admin_token_missing`，需再次部署。

**7. 部署**

```powershell
npx wrangler pages deploy
```

输出目录取自 `wrangler.toml` 的 `pages_build_output_dir = "public"`，无需额外传入目录参数。

### 部署后验证

```powershell
# 曲库列表：应返回 ok:true、25 首，next_music_id 为 26
curl.exe https://sjz-keyboard-web.pages.dev/api/songs

# 单曲：主键、编号、标题三种写法均可
curl.exe https://sjz-keyboard-web.pages.dev/api/songs/1
```

随后打开 `https://<项目>.pages.dev/manage.html`，填入 `ADMIN_TOKEN`，确认可列出与编辑曲目。

`*.pages.dev` 默认启用 HTTPS；绑定自定义域名时同样需要 HTTPS，否则 WebHID 不可用。

### 日常更新

| 变更内容 | 操作 |
| --- | --- |
| 前端代码、样式或固件包 | 执行 `npx wrangler pages deploy` 重新部署 |
| 曲库内容 | 在 `/manage.html` 增删改，立即生效，无需重新部署 |
| 表结构 | 新增 `migrations/000N_*.sql`，执行 `npx wrangler d1 migrations apply sjz-keyboard-web --remote` |
| 管理令牌 | 执行 `npx wrangler pages secret put ADMIN_TOKEN --project-name sjz-keyboard-web`，随后重新部署 |
| 更换数据库 | 修改 `wrangler.toml` 中的 `database_id`，随后执行 `npx wrangler pages deploy`（控制台中的对应字段为只读） |
| 导出线上曲库 | `npx wrangler d1 export sjz-keyboard-web --remote --output backup.sql` |

### 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 部署失败，错误信息涉及 D1、database_id 或 UUID | `wrangler.toml` 中仍为占位符 `replace-with-your-d1-id`，替换为第 1 步输出的 UUID 后重新部署 |
| `/api/songs` 返回 503 `db_unbound` | 绑定未生效。确认 `wrangler.toml` 中 `binding = "DB"` 与 `database_id` 正确后重新部署；控制台中对应字段为只读，无法在此修正 |
| `/api/admin/*` 返回 503 `admin_token_missing` | 未设置 `ADMIN_TOKEN`，或设置后未重新部署（secrets 仅对设置之后的部署生效） |
| `pages secret put` 提示找不到项目 | 先执行首次部署第 5 步创建 Pages 项目 |
| `/api/admin/*` 返回 401 | 令牌不正确，格式为 `Authorization: Bearer <token>` |
| 页面可访问，但曲库读取失败 | 以纯静态方式部署，或 Functions 未上传。确认 `/api/songs` 可用 |
| 页面未显示「连接」按钮 | 非安全上下文，需使用 HTTPS（本地 `localhost` 除外） |
| 曲库为空 | 未导入种子数据，见首次部署第 4 步 |
| `database_id` 遗失 | 执行 `npx wrangler d1 list`，或 `npx wrangler d1 info sjz-keyboard-web` |

## 连接与固件升级

顶部「刷新已授权设备」仅显示浏览器此前授权过的键盘；首次授权需点击「连接」。

若板子仅烧录了 BOOT，设备以 `1A86:FE02` 出现，正常键盘连接需要 `1A86:FE01` 的 APP。
此情况下进入「设备维护」，确认默认加密升级包已加载，点击「开始更新」，再按页面提示授权 BOOT 设备。
若弹窗中仍无设备，请先在 Windows 设备管理器中确认 `1A86:FE02` 设备在线。

升级文件写入并通过 CRC32 校验后，页面会等待 APP 设备重新出现。若浏览器尚未授权新的
`1A86:FE01` 设备，「设备维护」会显示「连接 APP 并完成」；点击后在浏览器弹窗中选择 APP，
即可读取固件版本与配置。灯光与键位配置读取成功后可直接保存；音乐保存需先将曲目放入
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
npm run ui:theme      # 主题切换：耗时、不弹提示、直达相反主题（需先启动 npx wrangler pages dev public）
npm run ui:layout     # 页面交互回归：浮动控件遮挡、顶栏状态块与按钮同高、搜索栏等宽、键位卡片对齐、调试快捷键、试听播放、滚动条槽位、星球坐标（同上）
npm run ui:manage     # 曲库管理页可正常加载（同上）
npm run ui:contrast   # 真实浏览器逐元素对比度（同上）
npm run check:inline  # HTML 内联模块语法
```

`npm test` 仅使用 Node 内置测试运行器，无需安装依赖或联网；`ui:*` 需要 Edge 与本地服务器。

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/protocol.test.js` | 曲包协议、旋转灵敏度换算、键位/灯光往返、加密固件校验 |
| `tests/device-wire.test.js` | WebHID 报文往返、OTA 分区基址、旋转键 v1→v2 过渡 |
| `tests/theme.test.js` | 亮暗变量集合一致、无自引用变量、无硬编码颜色、主题只有一条触发路径、前景色不误用背景色 |
| `tests/contrast.test.js` | 主色承载白字、薄荷底承载深字、正文与背景、紫色文字的 WCAG 对比度、悬停规则不互相覆盖、滚动条样式与槽位常驻 |
| `tests/songs-api.test.js` | 曲库 API 契约：列表筛选与 LIKE 转义、单曲三种定位（含路径参数百分号编码）、鉴权、编号分配与不复用、导入 replace/merge、迁移与种子 SQL 可执行 |
| `tests/preview.test.js` | 试听播放：渲染期间被停止或被新试听取代时不得出声、正常 start → stop 与 onDone 复位（用替身 AudioContext 在纯 Node 下运行） |

`npm run ui:contrast` 在无头浏览器中逐元素计算对比度，并报告未达标项，
用于发现「文字与背景撞色导致不可见」这类静态检查无法覆盖的问题：

```
[dark 主题]
  ✔ .button.primary   5.06 (需 4.5)  rgb(255,255,255) on rgb(106,90,224)  "连接"
  ✖ .eyebrow          3.76 (需 4.5)  rgb(106,90,224) on rgb(14,15,27)     "发现音乐"
```

### 主题切换

右下角为单图标按钮：单击在白天/夜晚之间直达切换，长按 600ms（或 `Ctrl/Cmd + Shift + L`）
切换为跟随系统。模式不循环、不弹提示，当前模式由图标体现。

以下三条约束由测试固定，均对应已出现过的缺陷：

- **主题按钮写在 `index.html` 中，不参与 `render()`**。浮动元素若随每次重渲染重建，会闪动并丢失焦点。
- **切换只有一条触发路径**。`bindEvents()` 在每次 `render()` 时执行，逐元素绑定会使单次点击执行两遍，
  两次切换相互抵消（表现为点击无响应）。因此按钮使用带一次性标志的委托监听，
  全局 `keydown` 同样只注册一次（`npm run ui:layout` 会统计 `document` 上的 keydown 注册次数）。
- **浮动控件不得遮挡可交互元素**。右下角主题按钮与 K3 卡片的「保存到 K3」按钮存在重叠风险：
  按钮占位距视口右缘 50px（宽 38 + right 12），卡片右缘距视口仅 24px，横纵方向均会相交。
  主题按钮保持在右下角，由键位卡片在内部预留右侧空间（`.slot-target` 的 `padding-right: 32px`）
  进行避让。卡片外框仍与整行对齐，三个保存按钮之间亦保持对齐。
  `npm run ui:layout` 的「浮动按钮不遮挡任何可交互元素」覆盖该约束。

### 配色约束

- **主色需满足对比度要求**：`--violet` 用作按钮底色并承载白字，需达到 4.5:1
  （`#7d6cf0` 仅 3.98，会使按钮文字对比度不足）。
- **紫色文字使用独立变量**：同一颜色同时用作底色与文字会相互冲突，
  深色背景上的紫字使用 `--violet-text`（比 `--violet` 更亮）。
- **主按钮的悬停态需显式声明底色与文字色**：`.button:hover` 与 `.button.primary`
  的层叠优先级相同（均为 0,2,0），结果取决于书写顺序；通用规则已用 `:not(.primary)` 排除主按钮。

> `node --test` 会为每个测试文件派生一个子进程。若运行环境禁止 spawn（报 `EPERM`），
> 可逐个文件直接运行，例如 `node tests/protocol.test.js`。

# SJZ 三键音乐键盘 · 网页端

SJZ 三键音乐键盘的网页配置工具。通过 **WebHID** 直连键盘，把音乐、键位与灯光配置写进设备，
并支持在浏览器里完成固件升级。

前端是纯静态站点，**没有构建步骤**；曲库存在 **Cloudflare D1**，通过 Pages Functions 提供 API。

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

### 首次部署

```powershell
# 1. 建库，把输出的 database_id 填进 wrangler.toml
npx wrangler d1 create sjz-keyboard-web

# 2. 建表
npx wrangler d1 migrations apply sjz-keyboard-web --remote

# 3. 从 JSON 快照导入现有 25 首曲目
npm run db:seed
npx wrangler d1 execute sjz-keyboard-web --remote --file seeds/songs.sql

# 4. 设置管理令牌，然后部署
npx wrangler pages secret put ADMIN_TOKEN
npx wrangler pages deploy
```

也可以不走 wrangler，直接调 API 批量导入（`/manage.html` 页面上有「导入本地 JSON 文件」按钮）。

### 本地开发

```powershell
npm run dev                      # 纯静态服务器，曲库回退到 JSON 快照
npx wrangler pages dev public    # 带 Functions 与本地 D1
```

`.dev.vars` 里放 `ADMIN_TOKEN=...`（已被 gitignore）。

> 前端在 API 不可用时会**自动回退**到 `public/data/music-catalog.json` 快照，
> 所以只用静态服务器也能完整浏览曲库。

## 本地运行

```powershell
npm run dev          # 零依赖静态服务器，默认 http://127.0.0.1:8788
```

在 Chrome 或 Edge 打开 `http://127.0.0.1:8788`，点击右上角「连接」选择 SJZ 键盘。

> WebHID 需要**安全上下文**。`localhost` / `127.0.0.1` 被视为安全来源，所以本地开发可直接使用；
> 部署到线上**必须使用 HTTPS**。

## 连接与固件升级

顶部「刷新已授权设备」只显示浏览器此前授权的键盘；首次授权请点击「连接」。

若板子只烧录了 BOOT，设备会以 `1A86:FE02` 出现，正常键盘连接需要 `1A86:FE01` 的 APP。
此时进入「设备维护」，确认默认加密升级包已加载，点击「开始更新」，再按页面提示授权 BOOT 设备。
若选择弹窗仍为空，先在 Windows 设备管理器确认 `1A86:FE02` 设备当前在线。

升级文件写入并通过 CRC32 校验后，网页会等待 APP 设备重新出现。如果浏览器尚未授权新的
`1A86:FE01` 设备，「设备维护」会显示「连接 APP 并完成」；点击后在浏览器弹窗中选择 APP，
即可读取固件版本与配置。灯光和键位配置读取成功后可直接保存；音乐保存按钮需要先把歌曲放入
对应的 K1～K3 键位。

## 功能

- **音乐星球**：从当前曲库试听、搜索、拖放并写入 K1～K3；V2 曲包包含曲目编号，
  设备维护可显示已保存的歌曲
- **键位设置**：读取、编辑、保存每颗键的键值、播放暂停或旋转陀螺角色，
  支持鼠标灵敏度、水平灵敏度和每圈速度
- **灯光设置**：读取、编辑、保存按下点亮、常亮、流水灯，以及三个按键的颜色（亮度固定 50%）
- **设备维护**：查看实体按键状态、固件版本，并在需要时更新固件
- **主题**：白天 / 夜晚 / 跟随系统三档，顶部按钮或 `Ctrl/Cmd + Shift + L` 切换

默认加载 PyQt 使用的 `.enc.hex` 加密 APP 升级包，也能手动选择新包；在浏览器本地解密验证后
通过 USB 更新。切换到 BOOT 后如需新授权，页面会显示「连接 BOOT 并继续」。只有设备端 CRC32
校验通过且 APP 稳定重连，才报告升级完成。

升级网页内置的 AES 密钥仅用于与现有 PyQt 加密包兼容，属于文件格式门槛，不构成防逆向的强安全保护。

## 目录结构

```
public/
  index.html            单页入口（含主题防闪烁引导脚本）
  app.js                主逻辑与视图渲染
  styles.css            样式（亮/暗两套主题变量）
  theme.js              主题控制器：auto / light / dark
  device.js             WebHID 传输层：报文、IAP 固件升级、CRC16
  device-config.js      键位与灯光配置的二进制编解码
  music-engine.js       曲谱编译、WAV 音色库、试听渲染、CRC32
  firmware.js           .enc.hex 的 AES-128-GCM 解密校验
  data/music-catalog.json  当前曲库（25 首）
  firmware/CH32V203C8T.enc.hex  默认加密 APP 升级包
  assets/               物理音色库
tests/                  纯 Node 测试，无需网络与依赖
scripts/dev.mjs         零依赖本地静态服务器
```

## 测试

```powershell
npm test              # 单元测试与主题/对比度检查（纯 Node，无需依赖与网络）
npm run ui:theme      # 主题切换：耗时、不弹提示、三段式（需先 npm run dev）
npm run ui:layout     # 布局：浮动控件位置与遮挡、星球坐标（需先 npm run dev）
npm run ui:manage     # 曲库管理页可正常加载（需先 npm run dev）
npm run ui:contrast   # 真实浏览器逐元素对比度（需先 npm run dev）
npm run check:inline  # HTML 内联模块语法
```

不需要安装任何依赖，Node 内置测试运行器即可。

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/protocol.test.js` | 曲包协议、旋转灵敏度换算、键位/灯光往返、加密固件校验 |
| `tests/device-wire.test.js` | WebHID 报文往返、OTA 分区基址、旋转键 v1→v2 过渡 |
| `tests/theme.test.js` | 亮暗变量集合一致、无自引用变量、无硬编码颜色、主题只有一条触发路径、前景色不误用背景色 |
| `tests/contrast.test.js` | 主色承载白字、薄荷底承载深字、正文与背景、紫色文字的 WCAG 对比度、悬停规则不互相覆盖 |
| `tests/songs-api.test.js` | 曲库 API 契约：列表筛选与 LIKE 转义、单曲三种定位、鉴权、编号分配与不复用、导入 replace/merge、迁移与种子 SQL 可执行 |

`npm run ui:contrast` 会在无头浏览器里对按钮、标签、按键、徽标等元素逐个计算对比度，
并报告不达标的项。它抓的是「文字与背景撞色导致看不见」这类静态检查发现不了的问题：

```
[dark 主题]
  ✔ .button.primary   5.06 (需 4.5)  rgb(255,255,255) on rgb(106,90,224)  "连接"
  ✖ .eyebrow          3.76 (需 4.5)  rgb(106,90,224) on rgb(14,15,27)     "发现音乐"
```

### 主题切换

右下角（窄屏为左下角）的三段式控件，**一次点击直达** 跟随系统 / 白天 / 夜晚，
不循环、不弹提示。当前模式由选中段的高亮体现。

有两条约束由测试固定，都是踩过坑的：

- **按钮属性不能叫 `data-theme-mode`** —— 该属性已被 `<html>` 占用
  （`theme.js` 会写 `root.dataset.themeMode`），撞名会让选择器多选出 `<html>`，选中态错乱。
  按钮上用 `data-theme-choice`。
- **浮动控件不能压住可交互元素**。右下角会遮住 K3 卡片的「保存到 K3」按钮
  （实测控件 y 697–739 与按钮 y 732–772 重叠），因此改到左侧。

### 配色约束

- **主色要够暗**：`--violet` 用于按钮底色并承载白字，必须满足 4.5:1
  （`#7d6cf0` 只有 3.98，会把按钮文字变得难辨）
- **紫色文字要另用变量**：同一个色既做底色又做文字会互相矛盾，
  深色底上的紫字用 `--violet-text`（比 `--violet` 更亮）
- **主按钮的悬停态要显式声明底色与文字色**：`.button:hover` 与 `.button.primary`
  优先级相同（都是 0,2,0），胜负只由书写顺序决定；通用规则已用 `:not(.primary)` 排除主按钮

> `node --test` 会为每个测试文件派生一个子进程。若运行环境禁止 spawn（报 `EPERM`），
> 逐个文件直接跑即可：`node tests/protocol.test.js`。

## 部署

纯静态站点，把 `public/` 作为站点根目录即可（Cloudflare Pages / Netlify / 任意静态托管）。
必须启用 HTTPS，否则浏览器不会提供 WebHID。

若使用 Cloudflare Pages，建议加一个 `public/_redirects`：

```
/keyboard  /  308
```

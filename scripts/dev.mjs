#!/usr/bin/env node
// 零依赖本地静态服务器：`npm run dev`。
//
// 键盘网页是纯静态站点（WebHID 直连键盘，没有后端），
// 因此不需要 wrangler 或任何构建步骤。
//
// 用法：
//   node scripts/dev.mjs [port]
//
// 注意：WebHID 需要安全上下文，localhost / 127.0.0.1 被视为安全来源，
// 所以本地开发可以直接使用；部署到线上必须走 HTTPS。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.argv[2] || process.env.PORT || 8788);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".hex": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

/** 解析请求路径到磁盘文件，越界一律拒绝。 */
function resolveTarget(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.endsWith("/")) decoded += "index.html";
  const full = path.resolve(path.join(PUBLIC_DIR, decoded));
  const rootResolved = path.resolve(PUBLIC_DIR);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
    return path.join(full, "index.html");
  }
  return full;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  // 方便记：/keyboard 与键盘页等价
  const pathname = url.pathname === "/keyboard" ? "/index.html" : url.pathname;
  const target = resolveTarget(pathname);

  if (!target || !fs.existsSync(target)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404 找不到该文件");
    return;
  }
  response.writeHead(200, {
    "content-type": MIME[path.extname(target)] || "application/octet-stream",
    "cache-control": "no-cache"
  }).end(fs.readFileSync(target));
});

server.listen(PORT, () => {
  console.log(`SJZ 键盘网页已启动：http://127.0.0.1:${PORT}`);
  console.log("在 Chrome 或 Edge 打开上面的地址，点击右上角「连接」选择 SJZ 键盘。");
  console.log("提示：WebHID 只在安全上下文可用，localhost 属于安全来源。");
});

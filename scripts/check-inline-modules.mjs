#!/usr/bin/env node
// 检查 HTML 里的内联 ES 模块语法是否合法。
//
// 直接跑 `node --check` 只能查 .js 文件，内联在 HTML 里的模块语法错误
// 要到浏览器打开才会暴露。这里把它们抽出来交给 node 检查。
//
// 用法：node scripts/check-inline-modules.mjs public/manage.html [更多文件...]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法：node scripts/check-inline-modules.mjs <html 文件> [...]");
  process.exit(2);
}

let failures = 0;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "inline-mod-"));

for (const file of files) {
  const html = fs.readFileSync(file, "utf8");
  const modules = [...html.matchAll(/<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)];
  if (!modules.length) {
    console.log(`  ·  ${file} 没有内联模块`);
    continue;
  }
  modules.forEach((match, index) => {
    // 相对导入要能解析：把文件放进与被检 HTML 同级的目录
    const target = path.join(path.dirname(file), `.inline-module-${index}.mjs`);
    fs.writeFileSync(target, match[1], "utf8");
    const result = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
    if (result.status === 0) {
      console.log(`  OK  ${file} 内联模块 #${index + 1}（${match[1].length} 字符）`);
    } else {
      failures += 1;
      console.log(`  FAIL ${file} 内联模块 #${index + 1}`);
      console.log(`       ${(result.stderr || "").split("\n").slice(0, 4).join("\n       ")}`);
    }
    fs.rmSync(target, { force: true });
  });
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} 个内联模块语法有误` : "\n全部内联模块语法正常");
process.exitCode = failures ? 1 : 0;

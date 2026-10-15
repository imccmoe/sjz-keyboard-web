#!/usr/bin/env node
// 把 public/data/music-catalog.json 转成 D1 可执行的 SQL 种子文件。
//
// 用法：
//   node scripts/build-song-seed.mjs                     # 输出 seeds/songs.sql
//   node scripts/build-song-seed.mjs out.sql 40          # 自定义输出路径与每批行数
//
// 之后执行：
//   npx wrangler d1 execute sjz-keyboard-web --local  --file seeds/songs.sql
//   npx wrangler d1 execute sjz-keyboard-web --remote --file seeds/songs.sql
//
// 也可以走管理端 API 批量导入（无需 wrangler）：
//   node scripts/import-songs.mjs <baseUrl> <ADMIN_TOKEN> --replace
//
// 说明：music_id 必须原样保留 —— 它已经写进用户键盘，改变会导致键盘里显示错歌。
// score 是设备端编译用的记谱文本，按原样存储，不做格式化。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const COLUMNS = [
  "id", "music_id", "title", "score", "bpm", "rhythm", "gap_ms",
  "transpose_semitones", "author", "source", "license", "difficulty",
  "verified", "verification", "test_stage"
];

const quote = (value) => `'${String(value ?? "").replace(/'/g, "''")}'`;
const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

function rowValues(song, index) {
  const musicId = number(song.music_id, index + 1);
  return [
    quote(song.id || `song-${musicId}`),
    musicId,
    quote(song.title || `未命名 ${musicId}`),
    quote(song.score || ""),
    number(song.bpm, 120),
    song.rhythm === false ? 0 : 1,
    number(song.gap_ms, 20),
    number(song.transpose_semitones, 0),
    quote(song.author || ""),
    quote(song.source || ""),
    quote(song.license || ""),
    quote(song.difficulty || ""),
    song.verified ? 1 : 0,
    quote(song.verification || ""),
    Math.min(3, Math.max(1, number(song.test_stage, 1)))
  ];
}

/**
 * 生成种子 SQL。
 * @param {Array<object>} songs 曲库数组
 * @param {{ batchSize?: number, replace?: boolean, sourceLabel?: string }} [options]
 */
export function buildSongSeed(songs, { batchSize = 30, replace = true, sourceLabel = "public/data/music-catalog.json" } = {}) {
  if (!Array.isArray(songs)) throw new TypeError("songs 必须是数组");
  const size = Math.max(1, Number(batchSize) || 30);
  const lines = [
    "-- 由 scripts/build-song-seed.mjs 自动生成，请勿手工编辑。",
    `-- 源文件：${sourceLabel}（${songs.length} 首）`,
    ""
  ];
  if (replace) lines.push("DELETE FROM songs;", "");

  let maxMusicId = 0;
  for (let start = 0; start < songs.length; start += size) {
    const chunk = songs.slice(start, start + size);
    const rows = chunk.map((song, offset) => {
      maxMusicId = Math.max(maxMusicId, number(song.music_id, start + offset + 1));
      return `  (${rowValues(song, start + offset).join(", ")})`;
    });
    lines.push(`INSERT OR REPLACE INTO songs (${COLUMNS.join(", ")}) VALUES`);
    lines.push(`${rows.join(",\n")};`);
    lines.push("");
  }

  // 计数器推到最大值之后，保证新增曲目不会撞号
  lines.push(
    `UPDATE song_counters SET value = MAX(value, ${maxMusicId + 1}) WHERE name = 'next_music_id';`,
    ""
  );
  return { sql: `${lines.join("\n")}\n`, rows: songs.length, nextMusicId: maxMusicId + 1 };
}

function main() {
  const ROOT = process.cwd();
  const source = process.env.SEED_SOURCE || path.join(ROOT, "public", "data", "music-catalog.json");
  const output = process.argv[2] || path.join("seeds", "songs.sql");
  const batchSize = Number(process.argv[3]) || 30;

  if (!fs.existsSync(source)) {
    console.error(`找不到源数据：${source}`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(source, "utf8"));
  const songs = Array.isArray(payload) ? payload : payload.songs;
  if (!Array.isArray(songs)) {
    console.error("music-catalog.json 里找不到 songs 数组");
    process.exit(1);
  }

  const { sql, rows, nextMusicId } = buildSongSeed(songs, {
    batchSize,
    sourceLabel: path.relative(ROOT, source)
  });
  const target = path.isAbsolute(output) ? output : path.join(ROOT, output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, sql, "utf8");

  const kb = (fs.statSync(target).size / 1024).toFixed(1);
  console.log(`已生成 ${path.relative(ROOT, target)}：${rows} 首 / ${kb} KB，每批 ${batchSize} 首`);
  console.log(`下一个曲目编号将被设为 ${nextMusicId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

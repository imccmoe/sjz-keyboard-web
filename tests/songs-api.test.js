import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MockD1 } from "./d1-mock.mjs";
import { splitStatements } from "./sql-utils.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ADMIN_TOKEN = "test-admin-token";

/** 按 Pages Functions 约定调用 handler。 */
async function callApi(modulePath, { method = "GET", url = "/api", body, token, params = {}, env = {} } = {}) {
  const handlers = await import(modulePath);
  const named = method === "GET" ? handlers.onRequestGet
    : method === "POST" ? handlers.onRequestPost
      : method === "PATCH" ? handlers.onRequestPatch
        : method === "DELETE" ? handlers.onRequestDelete
          : null;
  const handler = named || handlers.onRequest;
  assert.ok(handler, `${modulePath} 没有可用的 handler（${method}）`);
  const request = new Request(`https://kb.test${url}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const response = await handler({ request, env, params, waitUntil() {}, next: async () => new Response("next") });
  return { response, payload: await response.json().catch(() => null) };
}

function apiEnv(db, extra = {}) {
  return { DB: db, ADMIN_TOKEN, ...extra };
}

function seedDatabase(songs = []) {
  return new MockD1(
    { songs, song_counters: [{ name: "next_music_id", value: 1 }] },
    { primaryKeys: { songs: "id", song_counters: "name" } }
  );
}

const SONG_A = {
  id: "song-a", music_id: 1, title: "小星星", score: "1 1 5 5 6 6 5-",
  bpm: 90, rhythm: 1, gap_ms: 20, transpose_semitones: 0,
  author: "公版旋律整理", source: "测试", license: "Public domain",
  difficulty: "入门", verified: 1, verification: "通过", test_stage: 3,
  created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z"
};
const SONG_B = {
  ...SONG_A, id: "song-b", music_id: 2, title: "欢乐颂", score: "@0500:0.55 @1B02:0.45",
  bpm: 100, test_stage: 1, verified: 1
};
const SONG_HIDDEN = { ...SONG_A, id: "song-c", music_id: 3, title: "未验证曲目", verified: 0 };

test("GET /api/songs 返回列表与下一个编号", async () => {
  const db = seedDatabase([SONG_A, SONG_B, SONG_HIDDEN]);
  const { response, payload } = await callApi("../functions/api/songs/index.js", { env: apiEnv(db) });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  // 公开列表包含全部曲目（前端自行按 verified 过滤），但顺序按阶段
  assert.equal(payload.total, 3);
  assert.equal(payload.items.length, 3);
  assert.equal(payload.next_music_id, 1);
  assert.equal(payload.items[0].test_stage, 1, "默认按测试阶段排序");
  assert.equal(typeof payload.items[0].verified, "boolean", "verified 应转成布尔值");
});

test("列表支持按阶段筛选与关键词搜索", async () => {
  const db = seedDatabase([SONG_A, SONG_B, SONG_HIDDEN]);
  const byStage = await callApi("../functions/api/songs/index.js", { url: "/api/songs?stage=3", env: apiEnv(db) });
  assert.deepEqual(byStage.payload.items.map((s) => s.id), ["song-a", "song-c"]);

  const byTitle = await callApi("../functions/api/songs/index.js", { url: "/api/songs?q=%E6%AC%A2%E4%B9%90", env: apiEnv(db) });
  assert.deepEqual(byTitle.payload.items.map((s) => s.id), ["song-b"]);

  // LIKE 通配符必须转义，否则 % 会命中全部
  const wildcard = await callApi("../functions/api/songs/index.js", { url: "/api/songs?q=%25", env: apiEnv(db) });
  assert.equal(wildcard.payload.total, 0, "% 应被转义而不是匹配所有");
});

test("GET /api/songs/:id 支持主键、编号与标题三种定位", async () => {
  const db = seedDatabase([SONG_A, SONG_B]);
  const env = apiEnv(db);

  const byId = await callApi("../functions/api/songs/[id].js", { params: { id: "song-a" }, env });
  assert.equal(byId.payload.song.title, "小星星");

  const byMusicId = await callApi("../functions/api/songs/[id].js", { params: { id: "2" }, env });
  assert.equal(byMusicId.payload.song.title, "欢乐颂");

  const byTitle = await callApi("../functions/api/songs/[id].js", { params: { id: "小星星" }, env });
  assert.equal(byMusicId.payload.song.music_id, 2);
  assert.equal(byTitle.payload.song.id, "song-a");

  const missing = await callApi("../functions/api/songs/[id].js", { params: { id: "不存在" }, env });
  assert.equal(missing.response.status, 404);
});

test("管理端列表需要令牌", async () => {
  const db = seedDatabase([SONG_A]);
  const denied = await callApi("../functions/api/admin/songs/index.js", { env: apiEnv(db) });
  assert.equal(denied.response.status, 401);

  const allowed = await callApi("../functions/api/admin/songs/index.js", { token: ADMIN_TOKEN, env: apiEnv(db) });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.payload.songs.length, 1);
  assert.equal(allowed.payload.counts[3], 1);
  assert.equal(allowed.payload.next_music_id, 1);
});

test("新增曲目自动分配编号并推进计数器", async () => {
  const db = seedDatabase([SONG_A]);
  db.tables.song_counters[0].value = 5;
  const env = apiEnv(db);

  const created = await callApi("../functions/api/admin/songs/index.js", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { title: "新曲", score: "@0500:0.5 @1100:1", bpm: 128, test_stage: 2, verified: true },
    env
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.song.music_id, 5, "应使用计数器里的编号");
  assert.equal(db.tables.song_counters[0].value, 6, "计数器应自增");
  assert.equal(db.tables.songs.length, 2);

  // 非法 score 必须被拒绝
  const badScore = await callApi("../functions/api/admin/songs/index.js", {
    method: "POST", token: ADMIN_TOKEN, body: { title: "坏曲", score: "这不是记谱 @@@@:" }, env
  });
  assert.equal(badScore.response.status, 400);
  assert.equal(badScore.payload.error, "invalid_song");

  const noTitle = await callApi("../functions/api/admin/songs/index.js", {
    method: "POST", token: ADMIN_TOKEN, body: { score: "1 2 3" }, env
  });
  assert.equal(noTitle.response.status, 400);
});

test("批量导入支持 replace 与 merge，并保留原 music_id", async () => {
  const db = seedDatabase([SONG_A]);
  const env = apiEnv(db);

  const replace = await callApi("../functions/api/admin/songs/index.js", {
    method: "POST",
    token: ADMIN_TOKEN,
    url: "/api/admin/songs?mode=replace",
    body: {
      songs: [
        { id: "s1", music_id: 7, title: "甲", score: "1 2 3", bpm: 100, test_stage: 2, verified: true },
        { id: "s2", music_id: 9, title: "乙", score: "@0500:1", bpm: 120, test_stage: 3, verified: true }
      ]
    },
    env
  });
  assert.equal(replace.response.status, 200);
  assert.equal(replace.payload.imported, 2);
  assert.equal(db.tables.songs.length, 2, "replace 应先清空");
  assert.deepEqual(db.tables.songs.map((s) => s.music_id).sort((a, b) => a - b), [7, 9]);
  assert.equal(db.tables.song_counters[0].value, 10, "计数器应推到最大编号之后");

  // merge：同 music_id 更新而不是新增
  const merge = await callApi("../functions/api/admin/songs/index.js", {
    method: "POST", token: ADMIN_TOKEN, url: "/api/admin/songs?mode=merge",
    body: { songs: [{ id: "s1", music_id: 7, title: "甲改", score: "1 2 3", bpm: 111, test_stage: 1, verified: true }] },
    env
  });
  assert.equal(merge.response.status, 200);
  assert.equal(db.tables.songs.length, 2, "merge 不应新增重复编号");
  const updated = db.tables.songs.find((s) => s.music_id === 7);
  assert.equal(updated.title, "甲改");
  assert.equal(updated.bpm, 111);
});

test("批量导入会汇总校验错误", async () => {
  const db = seedDatabase([]);
  const result = await callApi("../functions/api/admin/songs/index.js", {
    method: "POST", token: ADMIN_TOKEN,
    body: { songs: [{ id: "x", music_id: 1, title: "坏", score: "@@@", bpm: 100 }] },
    env: apiEnv(db)
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.error, "invalid_songs");
  assert.match(result.payload.message, /第 1 首/);
});

test("管理端可更新与删除曲目", async () => {
  const db = seedDatabase([SONG_A, SONG_B]);
  const env = apiEnv(db);

  const patched = await callApi("../functions/api/admin/songs/[id].js", {
    method: "PATCH", token: ADMIN_TOKEN, params: { id: "song-a" },
    body: { title: "小星星（改）", test_stage: 1 },
    env
  });
  assert.equal(patched.response.status, 200);
  assert.equal(patched.payload.song.title, "小星星（改）");
  assert.equal(patched.payload.song.test_stage, 1);
  // 未提供的字段应保持原值
  assert.equal(patched.payload.song.bpm, SONG_A.bpm);
  assert.equal(patched.payload.song.score, SONG_A.score);

  const removed = await callApi("../functions/api/admin/songs/[id].js", {
    method: "DELETE", token: ADMIN_TOKEN, params: { id: "song-b" }, env
  });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.payload.deleted.music_id, 2);
  assert.equal(db.tables.songs.length, 1);

  const gone = await callApi("../functions/api/admin/songs/[id].js", {
    method: "DELETE", token: ADMIN_TOKEN, params: { id: "song-b" }, env
  });
  assert.equal(gone.response.status, 404);
});

test("删除后编号不复用（避免键盘里的旧编号指向新歌）", async () => {
  const db = seedDatabase([SONG_A, SONG_B]);
  db.tables.song_counters[0].value = 3;
  const env = apiEnv(db);
  await callApi("../functions/api/admin/songs/[id].js", { method: "DELETE", token: ADMIN_TOKEN, params: { id: "song-b" }, env });
  const created = await callApi("../functions/api/admin/songs/index.js", {
    method: "POST", token: ADMIN_TOKEN, body: { title: "新曲", score: "1 2 3", bpm: 100, verified: true }, env
  });
  assert.equal(created.payload.song.music_id, 3, "不应复用已删除的编号 2");
});

test("未配置 ADMIN_TOKEN 时管理接口关闭，未绑定 DB 时返回 503", async () => {
  const db = seedDatabase([SONG_A]);
  const noToken = await callApi("../functions/api/admin/songs/index.js", { env: { DB: db, ADMIN_TOKEN: "" } });
  assert.equal(noToken.response.status, 503);
  assert.equal(noToken.payload.error, "admin_token_missing");

  const noDb = await callApi("../functions/api/songs/index.js", { env: {} });
  assert.equal(noDb.response.status, 503);
  assert.equal(noDb.payload.error, "db_unbound");
});

test("迁移文件定义了 songs 与计数器，且种子 SQL 可执行", async () => {
  const migration = fs.readFileSync(path.join(ROOT, "migrations", "0001_songs.sql"), "utf8");
  const statements = splitStatements(migration);
  const tables = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, ["songs", "song_counters"]);
  assert.ok(statements.some((s) => /INSERT OR IGNORE INTO song_counters/.test(s)), "应初始化计数器");
  assert.match(migration, /music_id INTEGER NOT NULL UNIQUE/, "曲目编号必须唯一");
  assert.match(migration, /idx_songs_stage/, "缺少阶段索引");

  const { buildSongSeed } = await import("../scripts/build-song-seed.mjs");
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "data", "music-catalog.json"), "utf8"));
  const { sql, rows, nextMusicId } = buildSongSeed(catalog.songs, { batchSize: 10 });
  assert.equal(rows, catalog.songs.length);
  assert.equal(nextMusicId, 26, "25 首之后下一个编号应为 26");

  // 在模拟 D1 上真跑一遍，确认 SQL 语法与字段对齐
  const db = new MockD1({ songs: [], song_counters: [{ name: "next_music_id", value: 1 }] },
    { primaryKeys: { songs: "id", song_counters: "name" } });
  for (const statement of splitStatements(sql)) {
    const head = statement.trim().toUpperCase();
    if (!head.startsWith("SELECT")) await db.prepare(statement).run();
  }
  assert.equal(db.tables.songs.length, catalog.songs.length);
  assert.equal(db.tables.song_counters[0].value, 26);
  // music_id 必须原样保留
  const ids = db.tables.songs.map((s) => s.music_id).sort((a, b) => a - b);
  assert.deepEqual(ids, catalog.songs.map((s) => s.music_id).sort((a, b) => a - b));
});

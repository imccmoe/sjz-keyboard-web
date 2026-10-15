// 曲库领域模型与校验。API 与导入脚本共用同一套规则，避免两处不一致。

import { bool, int, text } from "./http.js";

export const STAGES = [1, 2, 3];
export const DEFAULT_GAP_MS = 20;
export const MAX_SCORE_LENGTH = 20000;
/**
 * 记谱文本的校验。
 *
 * 这里刻意**不做严格的逐记号解析** —— 真实曲库的写法很杂，实测包含：
 *   键码 1 / 16 / 1B          带时值 5:0.5 / @0500:0.55 / 0:0.45
 *   延长音 5- / 4_ / 3__      小节线 |
 *   跨八度 【1_】 / 【1__】     黑键与括号 （#6） / （7）:0.5
 *   小数时值 1.4763
 * 早期版本用严格正则，把 8 首合法曲目误判为非法；而「设备端能否编译」
 * 由 compileSong() 真正验证，这里只拦明显不是曲谱的内容。
 *
 * 因此校验策略是：非空 + 长度上限 + 字符白名单 + 必须含有至少一个音高记号。
 */
const SCORE_ALLOWED = /^[\s0-9A-Fa-f@:._\-|#()（）【】\[\]+~]+$/;
/** 至少出现一个十六进制数字（即真正的键码/音高），只有 @ 或标点不算曲谱。 */
const SCORE_HAS_NOTE = /[0-9A-Fa-f]/;

export function validateScore(score) {
  const value = String(score ?? "").trim();
  if (!value) return "score 不能为空";
  if (value.length > MAX_SCORE_LENGTH) return `score 过长（上限 ${MAX_SCORE_LENGTH} 字符）`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    return "score 含不可见控制字符";
  }
  if (!SCORE_ALLOWED.test(value)) {
    const bad = value.split("").find((char) => !SCORE_ALLOWED.test(char));
    return `score 含非法字符：${bad}`;
  }
  if (!SCORE_HAS_NOTE.test(value)) {
    return "score 里找不到任何音符记号";
  }
  return null;
}

export function d1(env) {
  const db = env && env.DB;
  if (!db) {
    const error = new Error("D1 binding DB is not configured");
    error.status = 503;
    error.code = "db_unbound";
    throw error;
  }
  return db;
}

/** 把 D1 行转成前端消费的曲目对象。 */
export function shapeSong(row) {
  if (!row) return null;
  return {
    id: row.id,
    music_id: Number(row.music_id) || 0,
    title: row.title,
    score: row.score,
    bpm: Number(row.bpm) || 0,
    rhythm: Number(row.rhythm) !== 0,
    gap_ms: Number(row.gap_ms) || 0,
    transpose_semitones: Number(row.transpose_semitones) || 0,
    author: row.author || "",
    source: row.source || "",
    license: row.license || "",
    difficulty: row.difficulty || "",
    verified: Number(row.verified) !== 0,
    verification: row.verification || "",
    // 前端沿用 test_stage 字段名，保持与既有渲染逻辑兼容
    test_stage: Number(row.test_stage) || 1
  };
}

/**
 * 规范化写入用的曲目数据。
 * @param {object} body 请求体
 * @param {{ requireScore?: boolean }} [options]
 */
export function normalizeSong(body, { requireScore = true } = {}) {
  const errors = [];
  const title = text(body.title, 80);
  if (title.length < 1) errors.push("title 不能为空");

  const score = String(body.score ?? "").trim();
  if (requireScore) {
    const scoreError = validateScore(score);
    if (scoreError) errors.push(scoreError);
  }

  const bpm = int(body.bpm, 120, { min: 20, max: 400 });
  const testStage = int(body.test_stage ?? body.testStage, 1, { min: 1, max: 3 });
  const transpose = int(body.transpose_semitones ?? body.transposeSemitones, 0, { min: -24, max: 24 });

  return {
    errors,
    value: {
      title,
      score,
      bpm,
      rhythm: bool(body.rhythm, true) ? 1 : 0,
      gap_ms: int(body.gap_ms ?? body.gapMs, DEFAULT_GAP_MS, { min: 0, max: 2000 }),
      transpose_semitones: transpose,
      author: text(body.author, 200),
      source: text(body.source, 300),
      license: text(body.license, 300),
      difficulty: text(body.difficulty, 40),
      verified: bool(body.verified, false) ? 1 : 0,
      verification: text(body.verification, 300),
      test_stage: testStage
    }
  };
}

const SORTS = {
  stage: "test_stage ASC, music_id ASC",
  id: "music_id ASC",
  title: "title ASC",
  updated: "updated_at DESC"
};

export function listQuery(url) {
  const where = [];
  const params = [];

  const stage = int(url.searchParams.get("stage"), 0, { min: 0, max: 3 });
  if (stage >= 1 && stage <= 3) {
    where.push("test_stage = ?");
    params.push(stage);
  }

  const query = text(url.searchParams.get("q"), 60);
  if (query) {
    where.push("(title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')");
    const pattern = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    params.push(pattern, pattern, pattern);
  }

  const sortKey = text(url.searchParams.get("sort"), 16) || "stage";
  const limit = int(url.searchParams.get("limit"), 100, { min: 1, max: 500 });
  const offset = int(url.searchParams.get("offset"), 0, { min: 0, max: 100000 });

  return {
    sort: SORTS[sortKey] ? sortKey : "stage",
    limit,
    offset,
    where: where.length ? ` WHERE ${where.join(" AND ")}` : "",
    params,
    order: SORTS[sortKey] || SORTS.stage
  };
}

export async function querySongs(db, options) {
  const [list, count] = await db.batch([
    db.prepare(`SELECT * FROM songs${options.where} ORDER BY ${options.order} LIMIT ? OFFSET ?`)
      .bind(...options.params, options.limit, options.offset),
    db.prepare(`SELECT COUNT(*) AS total FROM songs${options.where}`).bind(...options.params)
  ]);
  return {
    items: (list.results || []).map((row) => shapeSong(row)),
    total: Number(count.results?.[0]?.total) || 0
  };
}

export async function getSong(db, id) {
  const row = await db.prepare("SELECT * FROM songs WHERE id = ?").bind(id).first();
  return row ? shapeSong(row) : null;
}

/** 从计数器取下一个曲目编号（不复用已删除的编号）。 */
export async function nextMusicId(db) {
  const row = await db
    .prepare("SELECT value FROM song_counters WHERE name = 'next_music_id'")
    .first();
  const value = Number(row?.value) || 1;
  await db
    .prepare("UPDATE song_counters SET value = value + 1 WHERE name = 'next_music_id'")
    .run();
  return value;
}

/** 让计数器至少超过给定的最大编号，供批量导入后调用。 */
export async function bumpCounterTo(db, maxMusicId) {
  await db
    .prepare(
      "UPDATE song_counters SET value = MAX(value, ? + 1) WHERE name = 'next_music_id'"
    )
    .bind(Number(maxMusicId) || 0)
    .run();
}

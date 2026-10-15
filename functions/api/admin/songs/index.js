// 管理端曲库接口：列表、新增、批量导入。
//
// GET  /api/admin/songs          列出全部曲目（含未验证），支持 page 参数
// POST /api/admin/songs          新增一首（自动分配 music_id）
// POST /api/admin/songs?mode=replace|merge&source=import  批量导入
//
// 全部需要 Authorization: Bearer <ADMIN_TOKEN>。
import {
  bumpCounterTo, d1, nextMusicId, normalizeSong, querySongs, shapeSong
} from "../../_lib/songs.js";
import { adminGuard, fail, methodNotAllowed, newId, ok, readJsonBody, text } from "../../_lib/http.js";

export async function onRequestGet({ request, env }) {
  const denied = adminGuard(request, env);
  if (denied) return denied;
  try {
    const db = d1(env);
    const url = new URL(request.url);
    // 管理端不分页限制，直接给全量（曲库规模很小）
    const { items, total } = await querySongs(db, {
      where: "",
      params: [],
      order: "music_id ASC",
      limit: 500,
      offset: 0
    });
    const counter = await db
      .prepare("SELECT value FROM song_counters WHERE name = 'next_music_id'")
      .first();
    return ok({
      songs: items,
      total,
      next_music_id: Number(counter?.value) || 1,
      counts: items.reduce((acc, song) => {
        acc[song.test_stage] = (acc[song.test_stage] || 0) + 1;
        return acc;
      }, {})
    });
  } catch (error) {
    return fail(error.status || 500, error.code || "admin_list_failed", error.message);
  }
}

export async function onRequestPost({ request, env }) {
  const denied = adminGuard(request, env);
  if (denied) return denied;
  try {
    const db = d1(env);
    const url = new URL(request.url);
    const { body, error } = await readJsonBody(request);
    if (error) return error;

    // 批量导入：body.songs 为数组
    if (Array.isArray(body.songs)) {
      return importSongs(db, body.songs, {
        mode: text(url.searchParams.get("mode") || body.mode, 20) || "merge",
        source: text(url.searchParams.get("source") || body.source, 40) || "import"
      });
    }

    const { errors, value } = normalizeSong(body, { requireScore: true });
    if (errors.length) return fail(400, "invalid_song", errors.join("；"), errors);

    const id = newId("song");
    const musicId = await nextMusicId(db);
    await db
      .prepare(
        "INSERT INTO songs (id, music_id, title, score, bpm, rhythm, gap_ms," +
        " transpose_semitones, author, source, license, difficulty, verified, verification, test_stage)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        id, musicId, value.title, value.score, value.bpm, value.rhythm, value.gap_ms,
        value.transpose_semitones, value.author, value.source, value.license,
        value.difficulty, value.verified, value.verification, value.test_stage
      )
      .run();

    const row = await db.prepare("SELECT * FROM songs WHERE id = ?").bind(id).first();
    return ok({ song: shapeSong(row) }, { status: 201 });
  } catch (error) {
    return fail(error.status || 500, error.code || "admin_create_failed", error.message);
  }
}

/**
 * 批量导入。
 * replace：清空后写入（用于从 JSON 全量迁移）
 * merge：按 music_id 存在则更新、不存在则插入
 */
async function importSongs(db, rawSongs, { mode, source }) {
  if (!rawSongs.length) return fail(400, "empty_import", "songs 数组为空");
  if (rawSongs.length > 2000) return fail(413, "too_many_songs", "单次最多导入 2000 首");

  const prepared = [];
  const errors = [];
  rawSongs.forEach((raw, index) => {
    const { errors: itemErrors, value } = normalizeSong(raw, { requireScore: true });
    if (itemErrors.length) {
      errors.push(`第 ${index + 1} 首（${text(raw?.title, 30) || "无标题"}）：${itemErrors.join("；")}`);
      return;
    }
    const musicId = Number(raw.music_id ?? raw.musicId);
    prepared.push({ ...value, music_id: Number.isFinite(musicId) && musicId > 0 ? musicId : null, raw });
  });
  if (errors.length) return fail(400, "invalid_songs", errors.slice(0, 8).join("；"), errors.slice(0, 20));
  if (!prepared.length) return fail(400, "empty_import", "没有可导入的有效曲目");

  const statements = [];
  if (mode === "replace") statements.push(db.prepare("DELETE FROM songs"));

  let maxMusicId = 0;
  for (const song of prepared) {
    const musicId = song.music_id ?? (await nextMusicId(db));
    maxMusicId = Math.max(maxMusicId, musicId);
    const id = text(song.raw?.id, 120) || newId("song");
    if (mode === "replace") {
      statements.push(
        db.prepare(
          "INSERT OR REPLACE INTO songs (id, music_id, title, score, bpm, rhythm, gap_ms," +
          " transpose_semitones, author, source, license, difficulty, verified, verification, test_stage)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          id, musicId, song.title, song.score, song.bpm, song.rhythm, song.gap_ms,
          song.transpose_semitones, song.author, song.source || source, song.license,
          song.difficulty, song.verified, song.verification, song.test_stage
        )
      );
    } else {
      statements.push(
        db.prepare(
          "INSERT INTO songs (id, music_id, title, score, bpm, rhythm, gap_ms," +
          " transpose_semitones, author, source, license, difficulty, verified, verification, test_stage)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)" +
          " ON CONFLICT(music_id) DO UPDATE SET" +
          " title = excluded.title, score = excluded.score, bpm = excluded.bpm," +
          " rhythm = excluded.rhythm, gap_ms = excluded.gap_ms," +
          " transpose_semitones = excluded.transpose_semitones, author = excluded.author," +
          " source = excluded.source, license = excluded.license, difficulty = excluded.difficulty," +
          " verified = excluded.verified, verification = excluded.verification," +
          " test_stage = excluded.test_stage, updated_at = CURRENT_TIMESTAMP"
        ).bind(
          id, musicId, song.title, song.score, song.bpm, song.rhythm, song.gap_ms,
          song.transpose_semitones, song.author, song.source || source, song.license,
          song.difficulty, song.verified, song.verification, song.test_stage
        )
      );
    }
  }
  statements.push(
    db.prepare("UPDATE song_counters SET value = MAX(value, ? + 1) WHERE name = 'next_music_id'")
      .bind(maxMusicId)
  );

  await db.batch(statements);
  const total = await db.prepare("SELECT COUNT(*) AS total FROM songs").first();
  return ok({
    mode,
    imported: prepared.length,
    total: Number(total?.total) || 0,
    message: `已${mode === "replace" ? "替换" : "合并"} ${prepared.length} 首曲目`
  });
}

export function onRequest(context) {
  const method = context.request.method;
  if (method === "GET") return onRequestGet(context);
  if (method === "POST") return onRequestPost(context);
  return methodNotAllowed(["GET", "POST"]);
}

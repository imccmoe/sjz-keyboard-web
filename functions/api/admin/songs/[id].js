// 管理端单曲操作。
//   GET    /api/admin/songs/:id   读取（含 id 等管理字段）
//   PATCH  /api/admin/songs/:id   部分更新
//   DELETE /api/admin/songs/:id   删除
//
// 全部需要 Authorization: Bearer <ADMIN_TOKEN>。
// :id 支持数据库主键或曲目编号（纯数字）。
import { d1, normalizeSong, shapeSong } from "../../_lib/songs.js";
import { adminGuard, fail, methodNotAllowed, ok, readJsonBody, text } from "../../_lib/http.js";

async function findRow(db, raw) {
  let row = await db.prepare("SELECT * FROM songs WHERE id = ?").bind(raw).first();
  if (!row && /^\d+$/.test(raw)) {
    row = await db.prepare("SELECT * FROM songs WHERE music_id = ?").bind(Number(raw)).first();
  }
  return row || null;
}

export async function onRequestGet({ request, env, params }) {
  const denied = adminGuard(request, env);
  if (denied) return denied;
  try {
    const db = d1(env);
    const row = await findRow(db, text(params.id, 120));
    if (!row) return fail(404, "not_found", "曲目不存在");
    return ok({ song: shapeSong(row) });
  } catch (error) {
    return fail(error.status || 500, error.code || "admin_get_failed", error.message);
  }
}

export async function onRequestPatch({ request, env, params }) {
  const denied = adminGuard(request, env);
  if (denied) return denied;
  try {
    const db = d1(env);
    const row = await findRow(db, text(params.id, 120));
    if (!row) return fail(404, "not_found", "曲目不存在");

    const { body, error } = await readJsonBody(request);
    if (error) return error;

    // 以现有值为基底做部分更新，未提供的字段保持原样
    const merged = {
      title: row.title,
      score: row.score,
      bpm: row.bpm,
      rhythm: Number(row.rhythm) !== 0,
      gap_ms: row.gap_ms,
      transpose_semitones: row.transpose_semitones,
      author: row.author,
      source: row.source,
      license: row.license,
      difficulty: row.difficulty,
      verified: Number(row.verified) !== 0,
      verification: row.verification,
      test_stage: row.test_stage,
      ...body
    };
    const { errors, value } = normalizeSong(merged, { requireScore: true });
    if (errors.length) return fail(400, "invalid_song", errors.join("；"), errors);

    await db
      .prepare(
        "UPDATE songs SET title = ?, score = ?, bpm = ?, rhythm = ?, gap_ms = ?," +
        " transpose_semitones = ?, author = ?, source = ?, license = ?, difficulty = ?," +
        " verified = ?, verification = ?, test_stage = ?, updated_at = CURRENT_TIMESTAMP" +
        " WHERE id = ?"
      )
      .bind(
        value.title, value.score, value.bpm, value.rhythm, value.gap_ms,
        value.transpose_semitones, value.author, value.source, value.license,
        value.difficulty, value.verified, value.verification, value.test_stage, row.id
      )
      .run();

    const updated = await db.prepare("SELECT * FROM songs WHERE id = ?").bind(row.id).first();
    return ok({ song: shapeSong(updated) });
  } catch (error) {
    return fail(error.status || 500, error.code || "admin_update_failed", error.message);
  }
}

export async function onRequestDelete({ request, env, params }) {
  const denied = adminGuard(request, env);
  if (denied) return denied;
  try {
    const db = d1(env);
    const row = await findRow(db, text(params.id, 120));
    if (!row) return fail(404, "not_found", "曲目不存在");

    // 编号不复用：删除后不回退计数器，避免键盘里已保存的编号指向另一首歌
    const statements = [db.prepare("DELETE FROM songs WHERE id = ?").bind(row.id)];
    if (Number(row.music_id) + 1 > 1) {
      statements.push(
        db.prepare("UPDATE song_counters SET value = MAX(value, ?) WHERE name = 'next_music_id'")
          .bind(Number(row.music_id) + 1)
      );
    }
    await db.batch(statements);

    const total = await db.prepare("SELECT COUNT(*) AS total FROM songs").first();
    return ok({
      deleted: { id: row.id, music_id: Number(row.music_id), title: row.title },
      total: Number(total?.total) || 0
    });
  } catch (error) {
    return fail(error.status || 500, error.code || "admin_delete_failed", error.message);
  }
}

export function onRequest(context) {
  const method = context.request.method;
  if (method === "GET") return onRequestGet(context);
  if (method === "PATCH" || method === "PUT") return onRequestPatch(context);
  if (method === "DELETE") return onRequestDelete(context);
  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

// GET /api/songs/:id —— 单曲详情。
// id 支持三种写法：数据库主键、曲目编号（纯数字）、标题精确匹配。
import { d1, shapeSong } from "../_lib/songs.js";
import { fail, methodNotAllowed, ok, text } from "../_lib/http.js";

export async function onRequestGet({ params, env }) {
  try {
    const db = d1(env);
    const raw = text(Array.isArray(params.id) ? params.id[0] : params.id, 120);
    if (!raw) return fail(400, "missing_id", "缺少曲目 id");

    let row = await db.prepare("SELECT * FROM songs WHERE id = ?").bind(raw).first();
    if (!row && /^\d+$/.test(raw)) {
      row = await db.prepare("SELECT * FROM songs WHERE music_id = ?").bind(Number(raw)).first();
    }
    if (!row) {
      row = await db.prepare("SELECT * FROM songs WHERE title = ?").bind(raw).first();
    }
    if (!row) return fail(404, "not_found", "曲目不存在");

    return ok({ song: shapeSong(row) });
  } catch (error) {
    return fail(error.status || 500, error.code || "query_failed", error.message);
  }
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return methodNotAllowed(["GET"]);
}

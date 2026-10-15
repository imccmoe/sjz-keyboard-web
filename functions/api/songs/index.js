// GET /api/songs —— 曲库列表（按阶段/关键词筛选、排序、分页）。
import { d1, listQuery, querySongs } from "../_lib/songs.js";
import { fail, methodNotAllowed, ok } from "../_lib/http.js";

export async function onRequestGet({ request, env }) {
  try {
    const db = d1(env);
    const url = new URL(request.url);
    const options = listQuery(url);
    const { items, total } = await querySongs(db, options);
    const counter = await db
      .prepare("SELECT value FROM song_counters WHERE name = 'next_music_id'")
      .first();
    return ok({
      songs: items,
      items,
      total,
      limit: options.limit,
      offset: options.offset,
      sort: options.sort,
      hasMore: options.offset + items.length < total,
      next_music_id: Number(counter?.value) || 1
    });
  } catch (error) {
    return fail(error.status || 500, error.code || "query_failed", error.message);
  }
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return methodNotAllowed(["GET"]);
}

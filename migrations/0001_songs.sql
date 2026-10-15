-- SJZ 键盘网页端的曲库表。
--
-- 曲库只存放在 D1，可以随时插入/修改曲目，网页直接读 API；
-- 初始数据来自 seeds/songs.sql。
--
-- score 是设备端编译曲包用的记谱文本（形如 "@0500:0.55 @1B02:0.45 ..."），
-- 必须原样保存，不做任何格式化。music_id 是写进键盘的曲目编号，必须唯一且稳定。

CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  music_id INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  score TEXT NOT NULL,
  bpm INTEGER NOT NULL DEFAULT 120,
  rhythm INTEGER NOT NULL DEFAULT 1,
  gap_ms INTEGER NOT NULL DEFAULT 20,
  transpose_semitones INTEGER NOT NULL DEFAULT 0,
  author TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0,
  verification TEXT NOT NULL DEFAULT '',
  test_stage INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 列表默认按测试阶段与曲目编号排序
CREATE INDEX IF NOT EXISTS idx_songs_stage ON songs (test_stage, music_id);
CREATE INDEX IF NOT EXISTS idx_songs_updated ON songs (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_songs_title ON songs (title);

-- 单行表：记录下一个可用的曲目编号。
-- 用独立计数器而不是 MAX(music_id)+1，避免删除曲目后编号被复用
-- （编号已经写进设备，复用会导致键盘里显示成另一首歌）。
CREATE TABLE IF NOT EXISTS song_counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT OR IGNORE INTO song_counters (name, value) VALUES ('next_music_id', 1);

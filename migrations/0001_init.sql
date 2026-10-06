-- My Chess DB: shared best-move database (Cloudflare D1 / SQLite).

-- One row per position. position_key is the board, side to move, castling
-- rights and legal en passant square (see positionKey() in web/chesslib.js).
CREATE TABLE IF NOT EXISTS saved_positions (
  position_key TEXT PRIMARY KEY,
  fen          TEXT    NOT NULL,
  move_uci     TEXT    NOT NULL,
  pv           TEXT    NOT NULL,            -- UCI moves separated by spaces
  evaluation   TEXT    NOT NULL,
  depth        INTEGER NOT NULL,
  knodes       INTEGER,                     -- Lichess only
  source       TEXT    NOT NULL CHECK (source IN ('stockfish', 'lichess')),
  -- 1 = checked by the server against Lichess, or saved with the admin
  -- token / a contributor key. 0 = sent by an anonymous visitor.
  verified     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  saved_by     TEXT    NOT NULL,            -- 'admin' | 'key:<id>' | 'anon' | 'import'
  saved_at     TEXT    NOT NULL             -- ISO 8601 UTC
);

-- Every entry that is replaced or removed is copied here first, so nothing
-- is ever lost and the admin can restore it.
CREATE TABLE IF NOT EXISTS saved_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  position_key TEXT    NOT NULL,
  fen          TEXT    NOT NULL,
  move_uci     TEXT    NOT NULL,
  pv           TEXT    NOT NULL,
  evaluation   TEXT    NOT NULL,
  depth        INTEGER NOT NULL,
  knodes       INTEGER,
  source       TEXT    NOT NULL,
  verified     INTEGER NOT NULL,
  saved_by     TEXT    NOT NULL,
  saved_at     TEXT    NOT NULL,
  archived_at  TEXT    NOT NULL,
  reason       TEXT    NOT NULL             -- 'replaced' | 'removed' | 'restored-over'
);
CREATE INDEX IF NOT EXISTS idx_saved_history_key ON saved_history (position_key, id);

-- Contributor keys the admin hands to people whose Stockfish results should
-- count as verified. Only the SHA-256 of each key is stored.
CREATE TABLE IF NOT EXISTS contributor_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash   TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Per-visitor hourly write counter for anonymous saves.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT    PRIMARY KEY,               -- '<hashed ip>:<hour number>'
  hour   INTEGER NOT NULL,
  count  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_hour ON rate_limits (hour);

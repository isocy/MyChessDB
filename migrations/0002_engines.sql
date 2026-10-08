-- Results are kept per engine: a position can have a Stockfish 19 entry and
-- a Lichess entry side by side, and neither replaces the other. Until now
-- there was one row per position, whichever source it came from.

CREATE TABLE saved_positions_v2 (
  position_key TEXT    NOT NULL,
  -- Which engine the entry is from. 'stockfish' is Stockfish 19 run by a
  -- visitor's engine bridge; 'lichess' is Lichess's cloud evaluation.
  source       TEXT    NOT NULL CHECK (source IN ('stockfish', 'lichess')),
  fen          TEXT    NOT NULL,
  move_uci     TEXT    NOT NULL,
  pv           TEXT    NOT NULL,            -- UCI moves separated by spaces
  evaluation   TEXT    NOT NULL,
  depth        INTEGER NOT NULL,
  knodes       INTEGER,                     -- Lichess only
  verified     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  saved_by     TEXT    NOT NULL,            -- 'admin' | 'key:<id>' | 'anon' | 'import'
  saved_at     TEXT    NOT NULL,            -- ISO 8601 UTC
  PRIMARY KEY (position_key, source)
) WITHOUT ROWID;

INSERT INTO saved_positions_v2
  (position_key, source, fen, move_uci, pv, evaluation, depth, knodes, verified, saved_by, saved_at)
SELECT position_key, source, fen, move_uci, pv, evaluation, depth, knodes, verified, saved_by, saved_at
FROM saved_positions;

DROP TABLE saved_positions;
ALTER TABLE saved_positions_v2 RENAME TO saved_positions;

-- Evaluations taken over in bulk from the Lichess evaluation database
-- (https://database.lichess.org/#evals) with scripts/lichess_db.mjs. They are
-- reference data, not something a visitor saved: no history, no backup, and
-- one compact row per position. The page shows one as the position's Lichess
-- entry unless a deeper one was saved from the site.
CREATE TABLE lichess_db (
  position_key TEXT PRIMARY KEY,            -- as in saved_positions
  depth        INTEGER NOT NULL,
  knodes       INTEGER,
  cp           INTEGER,                     -- centipawns, from White's side; NULL when it is a mate
  mate         INTEGER,                     -- moves to mate, positive when White mates; NULL otherwise
  pv           TEXT    NOT NULL             -- UCI moves separated by spaces, castling as a king move
) WITHOUT ROWID;

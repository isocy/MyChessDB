-- Puzzle lists kept on the server for those with a key (the admin, and each
-- contributor key), so that every browser they log in with has the same
-- ones. Others keep theirs in the browser only. See /api/puzzles/* in
-- worker/index.js and the sync in web/puzzles.js.
--
-- One row per account (kind 'profile', id ''), per game that has puzzles
-- and per puzzle, holding what the page keeps for it as JSON. Of two
-- changes the later one (changed_at, when it was made in a browser) wins.
-- rev counts the writes of one account, so a browser asks only for what
-- changed since its last sync. An account that was deleted keeps its
-- profile row with data NULL, so that browsers still holding it delete it
-- too.
CREATE TABLE IF NOT EXISTS puzzle_store (
  owner      TEXT    NOT NULL,             -- 'admin' | 'key:<id>'
  profile    TEXT    NOT NULL,             -- 'chesscom:<name>' | 'lichess:<name>'
  kind       TEXT    NOT NULL CHECK (kind IN ('profile', 'game', 'puzzle')),
  id         TEXT    NOT NULL,             -- the game's or puzzle's id; '' for the profile
  data       TEXT,                         -- JSON; NULL: the account was deleted (profile row)
  changed_at INTEGER NOT NULL,             -- ms since 1970, in the browser that changed it
  rev        INTEGER NOT NULL,
  PRIMARY KEY (owner, profile, kind, id)
);
CREATE INDEX IF NOT EXISTS idx_puzzle_store_rev ON puzzle_store (owner, profile, rev);
-- The list of an owner's accounts, without reading their puzzles.
CREATE INDEX IF NOT EXISTS idx_puzzle_store_kind ON puzzle_store (owner, kind, changed_at);

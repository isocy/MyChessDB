-- How much each key keeps in puzzle_store (rows, and bytes of data), so
-- that the limits per key (worker/index.js, PUZZLE_MAX_*) are checked
-- without counting rows. The Worker keeps it up to date as it writes.
CREATE TABLE IF NOT EXISTS puzzle_totals (
  owner TEXT    PRIMARY KEY,               -- 'admin' | 'key:<id>'
  rows  INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0
);
INSERT INTO puzzle_totals (owner, rows, bytes)
  SELECT owner, COUNT(*), COALESCE(SUM(LENGTH(data)), 0) FROM puzzle_store GROUP BY owner;

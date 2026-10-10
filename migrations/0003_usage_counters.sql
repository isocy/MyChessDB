-- Monthly counters kept by the Worker. 'engine:YYYY-MM' counts how often the
-- browser engine was served from the R2 bucket that month, so that it can stop
-- using R2 well before R2's free tier runs out (ENGINE_DOWNLOADS_PER_MONTH).
CREATE TABLE IF NOT EXISTS usage_counters (
  name  TEXT    PRIMARY KEY,
  count INTEGER NOT NULL
);

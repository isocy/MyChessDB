-- The browser engine's files now come from unpkg only, not from an R2 bucket
-- through the Worker, so its download counter (0003) is no longer used.
DROP TABLE IF EXISTS usage_counters;

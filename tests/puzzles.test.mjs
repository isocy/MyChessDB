// Run: node tests/puzzles.test.mjs
// When puzzles come back, and deleted ones (web/puzzlestore.js). Finding them, and fetching
// the games, happens in the engine bridge: see bridge/*_test.go.
import assert from "node:assert/strict";
import { withResult, withDeleted, mergePuzzle, pickNext, pickPractice, reviewOf, isDue, DAY, MASTER_AFTER } from "../web/puzzlestore.js";

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

// --- when puzzles come back ------------------------------------------------
{
  const now = 1_000 * DAY;
  let puzzle = { id: "p", ply: 3, playedAt: 1 };
  ok(isDue(puzzle, now), "a new puzzle is due");
  const days = [];
  for (let solve = 1; solve < MASTER_AFTER; solve++) {
    puzzle = withResult(puzzle, true, now);
    days.push((reviewOf(puzzle).due - now) / DAY);
  }
  eq(days, [1, 3, 7], "solved at the first try: back after 1, 3, then 7 days");
  puzzle = withResult(puzzle, true, now);
  ok(puzzle.mastered, "the fourth time in a row it is mastered");
  let missed = withResult({ id: "q" }, true, now);
  missed = withResult(missed, false, now + 10);
  eq([reviewOf(missed).streak, reviewOf(missed).misses, reviewOf(missed).due, reviewOf(missed).results], [0, 1, now + 10, "WL"]);
  const early = withResult(withResult({ id: "r" }, true, now), true, now + 1000, true);
  eq([reviewOf(early).streak, reviewOf(early).due, reviewOf(early).attempts], [1, now + DAY, 2], "practice before it is due does not move it on");
  const earlyMiss = withResult(withResult({ id: "s" }, true, now), false, now + 1000, true);
  eq([reviewOf(earlyMiss).streak, reviewOf(earlyMiss).due], [0, now + 1000], "but a miss counts");

  const fresh = (id, playedAt) => ({ id, ply: 1, playedAt });
  const failed = { ...withResult(fresh("failed", 5), false, now - 50) };
  const later = withResult(fresh("later", 9), true, now);
  const pool = [fresh("old", 1), fresh("newest", 8), failed, later];
  eq(pickNext(pool, now, [])?.id, "failed", "a missed puzzle first");
  eq(pickNext(pool, now, ["failed"])?.id, "newest", "not right after it was shown; then the newest game's");
  eq(pickNext(pool, now, ["x", "y", "newest"])?.id, "failed");
  eq(pickNext(pool, now, ["newest", "x", "y", "z"]).id, "failed");
  const otherFailed = { ...withResult(fresh("failed2", 6), false, now - 40) };
  eq(pickNext([failed, otherFailed, fresh("old", 1)], now, ["failed"]).id, "old", "after a missed one, not another missed one while others wait");
  eq(pickNext([failed, otherFailed], now, ["failed"]).id, "failed2", "unless only missed ones are due");
  eq(pickNext([fresh("a", 1), fresh("b", 2)], now, ["b", "x", "y", "z"]).id, "a", "a puzzle not shown yet before one skipped");
  eq(pickNext([later], now, []), null, "nothing due");
  eq(pickPractice([later, { ...fresh("m", 1), mastered: true }], [])?.id, "later", "practice: the next one due, never a mastered one");
}

// --- deleted puzzles ---------------------------------------------------------
{
  const now = 1_000 * DAY;
  const puzzle = withResult({ id: "p", ply: 1 }, false, now);
  const deleted = withDeleted(puzzle, true, now + 1);
  ok(!isDue(deleted, now + 5) && isDue(puzzle, now + 5), "a deleted puzzle is never due");
  eq(pickPractice([deleted], []), null, "nor practised");
  eq([deleted.deleted, deleted.deletedChangedAt, reviewOf(deleted)], [true, now + 1, reviewOf(puzzle)], "it keeps how it was solved");

  // Importing: the copy tried more often, deleted or not as decided last.
  const triedMore = withResult(puzzle, true, now + 2);
  eq(mergePuzzle(undefined, deleted), deleted, "a puzzle not here is taken");
  const merged = mergePuzzle(deleted, triedMore);
  eq([merged.deleted, reviewOf(merged).attempts], [true, 2], "deleted here: stays deleted, with the other copy's tries");
  eq(mergePuzzle(triedMore, deleted).deleted, true, "deleted in the import: deleted here too");
  const back = withDeleted(deleted, false, now + 9);
  eq(mergePuzzle(back, deleted).deleted, false, "brought back after the import's copy was deleted: stays back");
  eq(mergePuzzle(deleted, back).deleted, false, "and the other way round");
  eq(mergePuzzle(puzzle, triedMore), triedMore, "neither deleted: the one tried more often");
}

console.log(`puzzles: ${checks} checks passed`);

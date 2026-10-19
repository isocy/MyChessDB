// Run: node tests/puzzles.test.mjs
// When puzzles come back, and deleted ones (web/puzzlestore.js). Finding them, and fetching
// the games, happens in the engine bridge: see bridge/*_test.go.
import assert from "node:assert/strict";
import {
  withResult, withDeleted, mergePuzzle, changedAtOf, pickNext, pickPractice, reviewOf, isDue, DAY, MASTER_AFTER,
  cleanPuzzle, cleanGame, cleanProfileData, safeGameUrl,
} from "../web/puzzlestore.js";

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

// --- when a puzzle last changed (the later change wins on the server) --------
{
  const now = 1_000 * DAY;
  eq(changedAtOf({ foundAt: 5 }), 5, "found, never tried");
  eq(changedAtOf({ foundAt: 5, review: { lastAt: 9 } }), 9, "kept before it was recorded: its last try");
  eq(changedAtOf(withResult({ id: "p", foundAt: 5 }, true, now)), now, "a try");
  eq(changedAtOf(withDeleted({ id: "p", changedAt: 3 }, true, now + 1)), now + 1, "deleted");
  eq(changedAtOf({ analysedAt: 7 }), 7, "a game: when it was analysed");
}

// --- records from an imported file, the server or the bridge -----------------
{
  const FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
  const good = {
    id: "lichess:g1#4", gameId: "lichess:g1", key: "k", ply: 4, color: "w", fenBefore: FEN, lastMove: "f7f6",
    solution: ["f3e5"], kind: "only-move", score: { cp: 150 }, played: "f1c4", judgement: "Mistake", playedScore: { cp: -20 },
    review: { streak: 1, due: 5, attempts: 2, misses: 1, lastAt: 3, results: "LW" }, playedAt: 1, foundAt: 2, changedAt: 3,
  };
  eq(cleanPuzzle(good), { ...good, source: "" }, "a puzzle as the page keeps it");
  eq(cleanPuzzle({ ...good, extra: "<b>", unsynced: true }).extra, undefined, "unknown fields go");
  eq(cleanPuzzle({ ...good, unsynced: true }).unsynced, true);
  for (const [field, value] of [["fenBefore", "nonsense"], ["lastMove", "<img>"], ["solution", []], ["solution", ["e2e4", "x"]],
    ["color", "red"], ["score", { cp: "<b>9</b>" }], ["gameId", "nocolon"], ["id", 5]]) {
    eq(cleanPuzzle({ ...good, [field]: value }), null, `a bad ${field}`);
  }
  const odd = cleanPuzzle({ ...good, judgement: "<img src=x>", played: "javascript:", ply: "<b>", playedAt: "<i>",
    review: { streak: "<b>1</b>", attempts: -3, results: "<script>" } });
  eq([odd.judgement, odd.played, odd.ply, odd.playedAt, odd.review.streak, odd.review.attempts, odd.review.results],
    [undefined, undefined, 1, 0, 0, 0, ""], "text where it does not belong goes; numbers stay numbers");
  eq(cleanPuzzle({ ...good, score: { mate: 3 } }).score, { mate: 3 });

  const game = { id: "lichess:g1", site: "lichess", url: "https://lichess.org/g1", playedAt: 1, color: "b", rating: 1450,
    opponent: "Rival", opponentRating: 1500, result: "win", moves: ["e2e4", "e7e5"], status: "done", puzzles: 1, analysedAt: 2, analysedWith: "lichess" };
  eq(cleanGame(game), game, "a game as the page keeps it");
  eq(cleanGame({ ...game, url: "javascript:alert(1)" }).url, "", "a link that is not to the game goes");
  eq(cleanGame({ ...game, url: "https://evil.example/g1" }).url, "");
  eq(cleanGame({ ...game, opponentRating: "<b>1500</b>", rating: "x" }).opponentRating, null);
  eq(cleanGame({ ...game, moves: ["e2e4", "<b>"] }).moves, [], "moves only when all of them are moves");
  eq(cleanGame({ ...game, site: "chesscom" }), null, "the id must be of its site");
  eq(cleanGame({ ...game, evals: [1, 2] }).evals, undefined);

  eq(safeGameUrl("https://www.chess.com/game/live/123"), "https://www.chess.com/game/live/123");
  eq([safeGameUrl("http://lichess.org/x"), safeGameUrl("data:text/html,x"), safeGameUrl(undefined)], ["", "", ""]);

  eq(cleanProfileData({ username: "Minsu", rating: 1500, ratingAt: 1, bridge: { games: 3, counted: "<b>", analysed: 2, pending: 0, oldest: 5, complete: true },
    cloud: { owner: "x" }, __proto__: { polluted: true }, extra: 1 }),
  { username: "Minsu", rating: 1500, ratingAt: 1, bridge: { games: 3, counted: 0, analysed: 2, pending: 0, oldest: 5, complete: true } },
  "only an account's own fields, of their kind");
  eq(cleanProfileData({ username: "<b>x</b>", rating: "1500" }), {});
  eq(cleanProfileData(JSON.parse('{"__proto__": {"polluted": true}, "rating": 1200}')).polluted, undefined, "no prototype from a file");
}

console.log(`puzzles: ${checks} checks passed`);

// puzzlestore.js - the puzzle pools, kept in this browser (IndexedDB), and
// when each puzzle comes back.
//
// A pool belongs to one player on one site ("profile"): the player's games
// (with the rating they had in each, and whether it has been analysed) and
// the puzzles found in them, with how each was solved.
//
// Repetition: a puzzle solved at the first try comes back after 1, then 3,
// then 7 days; solved at the first try a fourth time in a row, it leaves the
// list ("mastered"; it can be brought back). A miss (a wrong move, or asking
// for the solution) sets it back to the start: it is due at once and comes
// back after a few other puzzles until it is solved. Solving a puzzle before
// it is due ("practice") does not move it on, but a miss still counts.
//
// A puzzle the player deletes stays in the pool, marked, so that it is not
// found again (nor the same position from another game); it can be brought
// back.
//
// Each record also says when it last changed (changedAt), and "unsynced"
// marks what changed here and has not reached the server yet (only for those
// logged in with a key; see the sync in puzzles.js).

import { parseFen } from "./chesslib.js";

export const DAY = 86_400_000;
export const REVIEW_DAYS = [1, 3, 7];
export const MASTER_AFTER = REVIEW_DAYS.length + 1;
// A missed puzzle is not shown again until this many others have been (when
// there are that many due).
export const RETRY_GAP = 3;

export function reviewOf(puzzle) {
  return puzzle.review || { streak: 0, due: 0, attempts: 0, misses: 0, lastAt: 0, results: "" };
}

export function isNew(puzzle) { return reviewOf(puzzle).attempts === 0; }
export function isDue(puzzle, now) { return !puzzle.mastered && !puzzle.deleted && reviewOf(puzzle).due <= now; }

/** The puzzle deleted from the list (deleted: true) or brought back. */
export function withDeleted(puzzle, deleted, now) {
  return { ...puzzle, deleted, deletedChangedAt: now, changedAt: now };
}

/**
 * When a puzzle last changed (changedAt): of two copies in two browsers the
 * later change wins (the server's sync, worker/index.js). Puzzles from
 * before it was kept count from their last try, or when they were found.
 */
export function changedAtOf(item) {
  return item.changedAt || item.review?.lastAt || item.foundAt || item.analysedAt || 0;
}

/**
 * Of two copies of a puzzle (this browser's and an import's): the one tried
 * more often, deleted or not as it was decided last.
 */
export function mergePuzzle(mine, theirs) {
  if (!mine) return theirs;
  const kept = reviewOf(theirs).attempts > reviewOf(mine).attempts ? theirs : mine;
  const changed = puzzle => puzzle.deletedChangedAt || 0;
  const decided = changed(theirs) > changed(mine) ? theirs : mine;
  if (changed(decided) === changed(kept)) return kept;
  return { ...kept, deleted: !!decided.deleted, deletedChangedAt: decided.deletedChangedAt };
}

/**
 * The puzzle after one attempt. solved: solved at the first try, without
 * the solution. early: it was not due yet when it was shown.
 */
export function withResult(puzzle, solved, now, early = false) {
  const before = reviewOf(puzzle);
  const review = {
    ...before, attempts: before.attempts + 1, lastAt: now,
    results: (before.results + (solved ? "W" : "L")).slice(-10),
  };
  let mastered = false;
  if (!solved) {
    review.streak = 0;
    review.misses = before.misses + 1;
    review.due = now;
  } else if (!early) {
    review.streak = before.streak + 1;
    if (review.streak >= MASTER_AFTER) mastered = true;
    else review.due = now + REVIEW_DAYS[review.streak - 1] * DAY;
  }
  return { ...puzzle, review, mastered, changedAt: now };
}

/**
 * The next puzzle among `puzzles` (the active ones), or null when none is
 * due. Missed ones first, but not one of the `recent` (ids shown, newest
 * last) while another is due, and not two missed ones in a row while a new
 * or due one waits; then new ones (not shown yet before those skipped, then
 * the newest game first), then the rest by when they fell due.
 */
export function pickNext(puzzles, now, recent = []) {
  const due = puzzles.filter(puzzle => isDue(puzzle, now));
  if (!due.length) return null;
  const blocked = new Set(recent.slice(-RETRY_GAP));
  const fresh = due.filter(puzzle => !blocked.has(puzzle.id));
  const pool = fresh.length ? fresh : due;
  const shown = puzzle => recent.lastIndexOf(puzzle.id);
  const missed = pool.filter(puzzle => !isNew(puzzle) && reviewOf(puzzle).streak === 0)
    .sort((a, b) => reviewOf(a).lastAt - reviewOf(b).lastAt);
  const others = pool.filter(puzzle => !missed.includes(puzzle)).sort((a, b) =>
    isNew(a) !== isNew(b) ? (isNew(a) ? -1 : 1)
      : isNew(a) ? shown(a) - shown(b) || (b.playedAt || 0) - (a.playedAt || 0) || a.ply - b.ply
        : reviewOf(a).due - reviewOf(b).due);
  const lastId = recent[recent.length - 1];
  const lastWasMissed = puzzles.some(puzzle => puzzle.id === lastId && reviewOf(puzzle).streak === 0 && !isNew(puzzle));
  if (missed.length && (!lastWasMissed || !others.length)) return missed[0];
  return others[0] || missed[0] || null;
}

/** For practice when nothing is due: the one due soonest, not a recent one. */
export function pickPractice(puzzles, recent = []) {
  const active = puzzles.filter(puzzle => !puzzle.mastered && !puzzle.deleted);
  const blocked = new Set(recent.slice(-RETRY_GAP));
  const pool = active.filter(puzzle => !blocked.has(puzzle.id));
  return (pool.length ? pool : active).sort((a, b) => reviewOf(a).due - reviewOf(b).due)[0] || null;
}

// ------------------------------------------------ records from outside ----
// Puzzles, games and accounts also come from an imported file, from the
// server (with a key) and from the engine bridge. Each is rebuilt from the
// fields the page knows, each of the right type, and dropped when one it
// needs is missing; so nothing else, and no text where a number belongs,
// reaches the page.

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/;
const JUDGEMENTS = ["Inaccuracy", "Mistake", "Blunder"];
const isNumber = value => typeof value === "number" && Number.isFinite(value);
const number = (value, fallback = 0) => isNumber(value) ? value : fallback;
const count = value => isNumber(value) ? Math.max(0, Math.round(value)) : 0;
const text = (value, most) => typeof value === "string" && value.length <= most ? value : "";

function cleanScore(score) {
  if (Number.isInteger(score?.mate)) return { mate: score.mate };
  if (isNumber(score?.cp)) return { cp: Math.round(score.cp) };
  return null;
}

/** The address of a game on Lichess or chess.com, or "" for anything else. */
export function safeGameUrl(address) {
  try {
    const url = new URL(address);
    return url.protocol === "https:" && (url.hostname === "lichess.org" || url.hostname === "www.chess.com") ? url.href : "";
  } catch (error) {
    return "";
  }
}

/** A puzzle as the page keeps it, or null. */
export function cleanPuzzle(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const id = text(raw.id, 120), gameId = text(raw.gameId, 120), score = cleanScore(raw.score);
  if (!id || !gameId.includes(":") || !score || (raw.color !== "w" && raw.color !== "b") || !UCI.test(raw.lastMove)) return null;
  if (!Array.isArray(raw.solution) || !raw.solution.length || raw.solution.length > 60 || !raw.solution.every(move => UCI.test(move))) return null;
  try { parseFen(raw.fenBefore); } catch (error) { return null; }
  const puzzle = {
    id, gameId, key: text(raw.key, 120), ply: Math.max(1, count(raw.ply)), color: raw.color,
    fenBefore: raw.fenBefore, lastMove: raw.lastMove, solution: [...raw.solution],
    kind: text(raw.kind, 20), source: text(raw.source, 20), score,
    playedAt: number(raw.playedAt), foundAt: number(raw.foundAt),
  };
  if (UCI.test(raw.played)) puzzle.played = raw.played;
  if (cleanScore(raw.playedScore)) puzzle.playedScore = cleanScore(raw.playedScore);
  if (JUDGEMENTS.includes(raw.judgement)) puzzle.judgement = raw.judgement;
  if (raw.review !== null && typeof raw.review === "object") {
    const review = raw.review;
    puzzle.review = {
      streak: count(review.streak), due: number(review.due), attempts: count(review.attempts), misses: count(review.misses),
      lastAt: number(review.lastAt), results: /^[WL]{0,10}$/.test(review.results) ? review.results : "",
    };
  }
  if (raw.mastered === true) puzzle.mastered = true;
  if (typeof raw.deleted === "boolean") { puzzle.deleted = raw.deleted; puzzle.deletedChangedAt = number(raw.deletedChangedAt); }
  if (isNumber(raw.changedAt)) puzzle.changedAt = raw.changedAt;
  if (raw.unsynced === true) puzzle.unsynced = true;
  return puzzle;
}

/** A game as the page keeps it, or null. */
export function cleanGame(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const id = text(raw.id, 120), site = raw.site;
  if ((site !== "chesscom" && site !== "lichess") || !id.startsWith(`${site}:`)) return null;
  const moves = Array.isArray(raw.moves) && raw.moves.length <= 1000 && raw.moves.every(move => UCI.test(move)) ? [...raw.moves] : [];
  const game = {
    id, site, url: safeGameUrl(raw.url), playedAt: number(raw.playedAt), color: raw.color === "b" ? "b" : "w",
    rating: count(raw.rating), opponent: text(raw.opponent, 60) || "?",
    opponentRating: isNumber(raw.opponentRating) ? Math.round(raw.opponentRating) : null,
    result: text(raw.result, 10), moves, status: text(raw.status, 10), puzzles: count(raw.puzzles),
    analysedAt: number(raw.analysedAt), analysedWith: text(raw.analysedWith, 20),
  };
  if (text(raw.error, 300)) game.error = raw.error;
  if (isNumber(raw.changedAt)) game.changedAt = raw.changedAt;
  if (raw.unsynced === true) game.unsynced = true;
  return game;
}

/** The fields of an account (profile) that may come from elsewhere. */
export function cleanProfileData(raw) {
  const out = {};
  if (raw === null || typeof raw !== "object") return out;
  if (USERNAME.test(raw.username)) out.username = raw.username;
  if (isNumber(raw.rating) && raw.rating > 0) out.rating = Math.round(raw.rating);
  if (isNumber(raw.ratingAt)) out.ratingAt = raw.ratingAt;
  if (isNumber(raw.createdAt)) out.createdAt = raw.createdAt;
  if (isNumber(raw.changedAt)) out.changedAt = raw.changedAt;
  const stats = raw.bridge;
  if (stats !== null && typeof stats === "object") {
    out.bridge = {
      games: count(stats.games), counted: count(stats.counted), analysed: count(stats.analysed),
      pending: count(stats.pending), oldest: number(stats.oldest), complete: stats.complete === true,
    };
  }
  return out;
}

// ------------------------------------------------------------- storage ----

const DB_NAME = "mychessdb-puzzles", DB_VERSION = 1;
let opening = null;

function openDb() {
  opening ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("profiles", { keyPath: "id" });
      for (const name of ["games", "puzzles"]) {
        db.createObjectStore(name, { keyPath: "key" }).createIndex("profile", "profile");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = null; reject(request.error || Error("This browser cannot store the puzzles (IndexedDB).")); };
  });
  return opening;
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(stores, mode, work) {
  const db = await openDb();
  const tx = db.transaction(stores, mode);
  const finished = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error || Error("Could not save the puzzles."));
  });
  const result = await work(tx);
  await finished;
  return result;
}

export function profileId(site, username) {
  return `${site}:${username.toLowerCase()}`;
}

const stored = (profile, item) => ({ ...item, key: `${profile}|${item.id}`, profile });
const unstored = ({ key, profile, ...item }) => item;

/** { profile, games, puzzles } for a profile id, or null. */
export async function loadProfile(id) {
  return transaction(["profiles", "games", "puzzles"], "readonly", async tx => {
    const profile = await done(tx.objectStore("profiles").get(id));
    if (!profile) return null;
    const [games, puzzles] = await Promise.all(["games", "puzzles"].map(name =>
      done(tx.objectStore(name).index("profile").getAll(id))));
    return { profile, games: games.map(unstored), puzzles: puzzles.map(unstored) };
  });
}

export async function listProfiles() {
  return transaction(["profiles"], "readonly", tx => done(tx.objectStore("profiles").getAll()));
}

/** Saves the profile and any of its games and puzzles given. */
export async function save(profile, { games = [], puzzles = [] } = {}) {
  return transaction(["profiles", "games", "puzzles"], "readwrite", async tx => {
    tx.objectStore("profiles").put(profile);
    for (const game of games) tx.objectStore("games").put(stored(profile.id, game));
    for (const puzzle of puzzles) tx.objectStore("puzzles").put(stored(profile.id, puzzle));
  });
}

export async function deleteProfile(id) {
  return transaction(["profiles", "games", "puzzles"], "readwrite", async tx => {
    tx.objectStore("profiles").delete(id);
    for (const name of ["games", "puzzles"]) {
      const store = tx.objectStore(name);
      for (const key of await done(store.index("profile").getAllKeys(id))) store.delete(key);
    }
  });
}

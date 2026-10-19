// My Chess DB - puzzles from the player's own games: the puzzle view of the
// page (index.html, #puzzle-view), loaded by app.js the first time it is
// shown.
//
// The player can have a chess.com and a Lichess account; their puzzles are
// shown together, each marked with its site. Update asks the engine bridge to
// bring each account up to date (bridge/puzzles.go): it checks the rapid
// rating, fetches the rated rapid games, analyses the ones played at 80% or
// more of the current rating with Stockfish 19 and looks for puzzles the way
// Lichess finds its puzzles (bridge/puzzlegen.go), until every game that
// counts has been analysed, whether or not this tab stays open. The page
// collects what it found and the puzzles come back for practice on a
// schedule (puzzlestore.js). The puzzles are kept in this browser; for those
// logged in with a key (the admin, contributors) also on this site's server,
// the same in every browser they log in with (see "server" below).
import * as chess from "./chesslib.js";
import { playMoveSound } from "./sounds.js";
import { PuzzleBoard } from "./puzzleboard.js";
import * as store from "./puzzlestore.js";
import {
  MOBILE, bridge, checkBridge, bridgeStatus, onBridgeChange, openBridgeSetup, openLine, versionAtLeast, drawMaterial,
  api, cloudOwner, onRoleChange,
} from "./app.js";

// Games count when the player's rating in them was at least this share of
// their current rapid rating (the bridge decides; this sets puzzles aside).
const RATING_SHARE = 0.8;
const SITES = { chesscom: "chess.com", lichess: "Lichess" };
const ACCOUNTS_KEY = "chessdb_puzzles_accounts", EFFORT_KEY = "chessdb_puzzles_effort";
const OPPONENT_DELAY_MS = 400, REPLY_DELAY_MS = 450, WRONG_SHOWN_MS = 700, SOLUTION_STEP_MS = 650;
// The engine bridge that finds puzzles (bridge/puzzles.go).
const PUZZLES_MIN_VERSION = "1.0.9";
// How hard the bridge's engine works (bridge/puzzlegen.go, puzzleEfforts).
const EFFORTS = { lichess: "As Lichess (1,000,000 nodes per position)", quick: "Quicker (300,000 nodes per position)" };
const FOLLOW_MS = 1500, RECONNECT_MS = 15000;
// The server (with a key): a change is sent this soon; what other browsers
// changed is asked for this often while the puzzles are on screen; this many
// items go in one request (worker/index.js takes 30); and what the server
// takes of one item.
const SYNC_SOON_MS = 1500, SYNC_EVERY_MS = 60_000, SYNC_PART = 30, SYNC_ID_MOST = 120, SYNC_ITEM_BYTES = 16 * 1024;
const $ = selector => document.querySelector(selector);

const state = {
  accounts: [],         // the stored profiles shown: {id, site, username, rating, bridge, ...}, one per site
  games: new Map(),     // game id -> game (the analysed ones, of every account)
  puzzles: new Map(),   // puzzle id -> puzzle (of every account)
  current: null,        // the puzzle on the board (see showPuzzle), or {waiting: true}
  recent: [],           // ids of the puzzles shown, newest last
  flipped: false,
  deleteArmed: 0,
  following: null,      // while the bridge's work is followed
  views: {},            // account id -> the bridge's last word on it
  session: null,        // since Update was clicked: {finished, found, stopped}
};
// The sync with the server: whose lists (owner), the one running, timers,
// when it last worked, and what went wrong.
const cloud = { owner: null, running: null, again: false, soon: null, poll: null, at: 0, error: null };
let timers = [];
const board = new PuzzleBoard($("#pz-board"), $("#pz-annotation-layer"), { onMove: (uci, options) => userMove(uci, options) });

function later(fn, ms) {
  const timer = setTimeout(() => { timers = timers.filter(other => other !== timer); fn(); }, ms);
  timers.push(timer);
}
function clearTimers() { timers.forEach(clearTimeout); timers = []; }
const shown = () => !$("#puzzle-view").hidden;
const validUsername = name => /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/.test(name);
const siteOf = id => id.slice(0, id.indexOf(":"));
const accountFor = site => state.accounts.find(account => account.site === site) || null;

// ---------------------------------------------------------------- text ----

const dateText = ms => ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "?";
function inText(ms) {
  const hours = Math.max(0, ms) / 3600_000;
  if (hours < 1) return "in less than an hour";
  if (hours < 22) return `in ${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const colorName = color => color === "w" ? "White" : "Black";
// The number of the player's move in the puzzle (fenBefore is the position
// before the opponent's move).
function puzzleMoveNumber(puzzle) {
  const parts = puzzle.fenBefore.split(" ");
  const full = Number(parts[5]) || 1;
  return parts[1] === "b" ? full + 1 : full;
}
// "23. Bxf7+ Kxf7 24. Ng5+" for UCI moves from fen.
function sanLine(fen, uciMoves) {
  let position = chess.parseFen(fen);
  const out = [];
  for (const [index, uci] of uciMoves.entries()) {
    const moves = chess.legalMoves(position);
    const move = chess.parseUci(position, uci, moves);
    if (!move) break;
    const san = chess.moveToSan(position, move, moves);
    if (position.turn === "w") out.push(`${position.full}. ${san}`);
    else out.push(index === 0 ? `${position.full}... ${san}` : san);
    position = chess.makeMove(position, move);
  }
  return out.join(" ");
}
function soundFor(move, next) {
  if (chess.inCheck(next)) return chess.legalMoves(next).length ? "check" : "mate";
  if (move.castle) return "castle";
  return move.captured ? "capture" : "move";
}
/** "+1.25", "-0.40", "#3", "#-2", from the side the score is for. */
function scoreText(score) {
  if (score.mate !== undefined) return `#${score.mate}`;
  return `${score.cp < 0 ? "-" : "+"}${(Math.abs(score.cp) / 100).toFixed(2)}`;
}
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

// ------------------------------------------------------------ accounts ----

function threshold(account) {
  return account?.rating ? Math.ceil(account.rating * RATING_SHARE) : null;
}
function counts(game) {
  const limit = game ? threshold(accountFor(game.site)) : null;
  return limit !== null && game.rating >= limit;
}
function activePuzzles() {
  return [...state.puzzles.values()].filter(puzzle => !puzzle.mastered && !puzzle.deleted && counts(state.games.get(puzzle.gameId)));
}
// The account a puzzle belongs to (the site of its game).
function ownerOf(puzzle) { return accountFor(siteOf(puzzle.gameId)); }

function setStatus(text, error = false) {
  const element = $("#pz-work-status");
  element.textContent = text || "";
  element.classList.toggle("error", error);
}
function feedback(text, kind = "info") {
  const element = $("#pz-feedback");
  element.textContent = text;
  element.className = `feedback ${kind}`;
}

function renderSummary() {
  const summary = $("#pz-summary");
  $("#pz-export").disabled = $("#pz-delete").disabled = !state.accounts.length;
  renderWork();
  renderCloud();
  if (!state.accounts.length) { summary.textContent = ""; renderPool(); return; }
  // Everything put into the HTML is escaped, numbers too: what an account
  // holds can come from an imported file, the server or the bridge.
  const html = value => escapeHtml(String(value));
  const lines = [];
  for (const account of state.accounts) {
    const stats = account.bridge;
    let line = `${html(SITES[account.site] || "")} <b>${html(account.username)}</b>`;
    if (account.rating) line += `: rapid ${html(account.rating)}, games at ${html(threshold(account))} or more count`;
    if (stats?.games) {
      line += ` · ${html(plural(stats.games, "rated rapid game"))}${stats.complete || !stats.oldest ? "" : ` since ${html(dateText(stats.oldest))}`}`
        + `, ${html(stats.analysed)} of ${html(stats.counted)} analysed`;
    } else if (!account.rating) {
      line += ": not updated yet";
    }
    lines.push(line);
  }
  const all = [...state.puzzles.values()], kept = all.filter(puzzle => !puzzle.deleted);
  const active = activePuzzles();
  const due = active.filter(puzzle => store.isDue(puzzle, Date.now())).length;
  const mastered = kept.filter(puzzle => puzzle.mastered).length;
  const setAside = kept.filter(puzzle => !puzzle.mastered && !counts(state.games.get(puzzle.gameId))).length;
  let puzzles = `${plural(active.length, "puzzle")} (${due} due)`;
  if (mastered) puzzles += `, ${mastered} mastered`;
  if (setAside) puzzles += `, ${setAside} set aside (from games below 80% of the rating)`;
  if (all.length > kept.length) puzzles += `, ${all.length - kept.length} deleted`;
  lines.push(puzzles);
  summary.innerHTML = lines.join("<br>");
  renderPool();
}

// The names typed: {chesscom, lichess}, each "" when not used.
function typedNames() {
  return { chesscom: $("#pz-chesscom").value.trim(), lichess: $("#pz-lichess").value.trim() };
}

// Opens the accounts (creating the ones not seen before) and shows their
// puzzles together. An account the server keeps for the key logged in comes
// from there (kept: the server's account ids, when already asked for).
async function openAccounts(names, { create = false, kept = null } = {}) {
  if (create && !kept && cloudOwner()) kept = await cloudProfiles().catch(() => []);
  const loaded = [];
  let created = false;
  for (const site of Object.keys(SITES)) {
    const username = names[site];
    if (!username) continue;
    const id = store.profileId(site, username);
    let found = null;
    try { found = await store.loadProfile(id); } catch (error) { setStatus(error.message, true); return; }
    if (!found) {
      if (!create) continue;
      found = { profile: { id, site, username, rating: null, createdAt: Date.now() }, games: [], puzzles: [] };
      await store.save(found.profile);
      if (!kept?.includes(id)) created = true;
    }
    loaded.push(found);
  }
  clearTimers();
  state.current = null;
  state.recent = [];
  state.following = null;
  state.views = {};
  state.session = null;
  // What is stored is checked again: an earlier version took imported files
  // as they were.
  state.accounts = loaded.map(entry => accountFrom(entry.profile));
  state.games = new Map(loaded.flatMap(entry => entry.games.map(store.cleanGame).filter(Boolean).map(game => [game.id, game])));
  state.puzzles = new Map(loaded.flatMap(entry => entry.puzzles.map(store.cleanPuzzle).filter(Boolean).map(puzzle => [puzzle.id, puzzle])));
  rememberAccounts();
  $("#pz-chesscom").value = accountFor("chesscom")?.username || "";
  $("#pz-lichess").value = accountFor("lichess")?.username || "";
  setStatus("");
  renderSummary();
  // A new account is brought up to date at once; for the others, what the
  // bridge is doing (or did meanwhile) is collected.
  if (created) update();
  else watchBridge();
  nextPuzzle();
  if (cloudOwner()) syncAll();
}

// An account as stored, with only the fields the page knows.
function accountFrom(profile) {
  const account = {
    id: profile.id, site: profile.site, username: validUsername(profile.username) ? profile.username : profile.id.slice(profile.site.length + 1),
    rating: null, ...store.cleanProfileData(profile),
  };
  const synced = profile.cloud;
  if (typeof synced?.owner === "string" && Number.isSafeInteger(synced.rev)) account.cloud = { owner: synced.owner, rev: synced.rev };
  if (profile.unsynced === true) account.unsynced = true;
  return account;
}

function rememberAccounts() {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(Object.fromEntries(state.accounts.map(account => [account.site, account.username]))));
  } catch (error) { /* not remembered */ }
}

// --------------------------------------------------------- engine bridge ----

// What stops the bridge from finding puzzles, or null when it can.
function bridgeProblem(status = bridgeStatus()) {
  if (MOBILE) return { text: "Finding puzzles needs the engine bridge on a computer. Puzzles exported from a computer can be solved here (Settings and data, Import)." };
  if (!status) return { text: "Engine bridge: not connected. Finding puzzles needs it (Stockfish 19 on this computer).", setup: "Set up" };
  if (!versionAtLeast(status.version, PUZZLES_MIN_VERSION) || !status.puzzles) {
    return { text: `Engine bridge ${status.version} is too old to find puzzles (${PUZZLES_MIN_VERSION} or newer): run the install command again.`, setup: "Update" };
  }
  if (!status.engine?.ready) return { text: "The engine bridge has no Stockfish 19 yet.", setup: "Set up" };
  return null;
}
function renderBridge() {
  const problem = bridgeProblem(), status = bridgeStatus();
  $("#pz-bridge-status").textContent = problem ? problem.text
    : `Engine bridge ${status.version}: ${status.engine.name} ready · up to ${plural(status.threads, "thread")}`;
  $("#pz-bridge-setup").hidden = !problem?.setup;
  $("#pz-bridge-setup").textContent = problem?.setup || "Set up";
}
onBridgeChange(() => {
  renderBridge();
  // The bridge came (back): see what it did meanwhile.
  if (state.accounts.length && !state.following && !bridgeProblem()) follow();
});

// --------------------------------------------------------------- update ----
// Update asks the bridge to bring every account up to date; the bridge goes
// on by itself to the end, also with this tab closed. The page follows it
// and collects the puzzles; opened again later, it collects what was found
// meanwhile.

const working = () => Object.values(state.views).some(view => view?.running || view?.task);
function renderWork() {
  $("#pz-update").disabled = !state.accounts.length;
  $("#pz-stop").hidden = !working();
  const bar = $("#pz-progress");
  const task = Object.values(state.views).find(view => view?.task?.step === "analyse")?.task;
  bar.hidden = !task;
  if (task) bar.value = Math.round((task.phase === "scan" ? (task.total ? task.done / task.total : 0) * 0.85 : 0.85) * 100);
}
const idle = () => !state.current || !!state.current.waiting;

async function update() {
  if (!state.accounts.length) return;
  if (!MOBILE) await checkBridge().catch(() => {});
  renderBridge();
  const problem = bridgeProblem();
  if (problem) { setStatus(problem.text, true); return; }
  let effort = "lichess";
  try { effort = localStorage.getItem(EFFORT_KEY) in EFFORTS ? localStorage.getItem(EFFORT_KEY) : effort; } catch (error) { /* the default */ }
  state.session = { finished: 0, found: 0, stopped: false };
  try {
    for (const account of state.accounts) {
      state.views[account.id] = await bridge("/api/puzzles/update", {
        body: { profile: account.id, site: account.site, username: account.username, effort },
      });
    }
  } catch (error) {
    setStatus(error.message, true);
    return;
  }
  setStatus("The engine bridge is updating the puzzles…");
  renderWork();
  follow();
}

// Starts following the bridge's work, if it can find puzzles: whether or
// not this page asked for it, results are collected. After the bridge went
// away while it was followed, it is looked for again now and then.
let reconnectTimer = null;
async function watchBridge() {
  clearTimeout(reconnectTimer);
  if (MOBILE || !state.accounts.length) return;
  await checkBridge().catch(() => {});
  if (!state.accounts.length || state.following) return;
  if (!bridgeProblem()) follow();
  else if (state.lostBridge) reconnectTimer = setTimeout(watchBridge, RECONNECT_MS);
}

// Follows the bridge's work for the accounts: collects what it found and
// shows how far it is, until it has nothing left to do.
async function follow() {
  if (state.following) return;
  const token = state.following = {};
  const following = () => state.following === token;
  for (;;) {
    const accounts = state.accounts.slice(), views = {};
    try {
      for (const account of accounts) {
        views[account.id] = await bridge(`/api/puzzles?profile=${encodeURIComponent(account.id)}`);
      }
    } catch (error) {
      // The bridge went away; following starts again when it is back.
      if (following()) {
        state.following = null;
        state.views = {};
        state.lostBridge = true;
        renderWork();
        renderBridge();
        setStatus("The engine bridge is not running. Its work goes on when it is started again.", true);
        reconnectTimer = setTimeout(watchBridge, RECONNECT_MS);
      }
      return;
    }
    if (!following()) return;
    for (const account of accounts) {
      try { await collect(account, views[account.id]); } catch (error) { setStatus(error.message, true); }
    }
    if (!following()) return;
    state.views = views;
    state.lostBridge = false;
    renderWork();
    renderRemote();
    if (!working()) { state.following = null; return; }
    await new Promise(resolve => setTimeout(resolve, FOLLOW_MS));
    if (!following()) return;
  }
}

// What the bridge is doing, account by account.
function renderRemote() {
  const lines = [];
  let error = false;
  for (const account of state.accounts) {
    const view = state.views[account.id];
    if (!view?.known) continue;
    const name = SITES[account.site], task = view.task;
    if (view.error) {
      lines.push(`${name}: ${view.error}`);
      error = true;
    } else if (task?.step === "rating") {
      lines.push(`${name}: checking the rapid rating…`);
    } else if (task?.step === "games" || task?.step === "older") {
      lines.push(`${name}: fetching ${task.step === "older" ? "older " : ""}games: ${task.read || 0} read, ${task.kept || 0} rated rapid`);
    } else if (task?.step === "analyse") {
      const step = task.phase === "scan" ? `position ${task.done} of ${task.total}` : `looking for puzzles, move ${Math.ceil(task.done / 2)}`;
      const threads = task.threads ? ` with ${plural(task.threads, "thread")}` : "";
      lines.push(`${name}: analysing the game against ${task.opponent} (${dateText(task.played_at)})${threads}, ${step} · ${view.pending - 1} more waiting`);
    } else if (view.running) {
      lines.push(`${name}: ${view.pending} game${view.pending === 1 ? "" : "s"} waiting`);
    }
  }
  const session = state.session;
  if (working()) {
    lines.push("The engine bridge goes on when this tab is closed.");
  } else if (session && !session.stopped && !error) {
    lines.push(`Up to date: ${plural(session.finished, "game")} analysed, ${plural(session.found, "new puzzle")}.`);
  }
  const element = $("#pz-work-status");
  element.textContent = lines.join("\n");
  element.classList.toggle("error", error && !working());
}

// Stores what the bridge found and tells it so. The same position from
// another game is not added twice, nor a deleted one again. Keeps the
// account's rating and counts.
async function collect(account, view) {
  if (!view?.known) return;
  // Whatever answers on the bridge's port is not taken at its word: only
  // fields of the right kind are kept (store.clean*).
  const { bridge: stats, rating, ratingAt } = store.cleanProfileData({
    rating: view.rating, ratingAt: view.rating_at,
    bridge: { games: view.games, counted: view.counted, analysed: view.analysed, pending: view.pending, oldest: view.oldest, complete: view.complete },
  });
  const changed = JSON.stringify(stats) !== JSON.stringify(account.bridge) || (rating && rating !== account.rating);
  if (rating) { account.rating = rating; account.ratingAt = ratingAt; }
  account.bridge = stats;
  if (changed) { account.changedAt = Date.now(); account.unsynced = true; }
  const results = Array.isArray(view.results) ? view.results : [];
  const games = [], puzzles = [];
  for (const result of results) {
    const analysedAt = Number(result.analysed_at) || Date.now();
    const game = store.cleanGame({
      ...result.game, status: result.error ? "failed" : "done", puzzles: 0, analysedAt, analysedWith: result.effort,
      error: result.error, changedAt: analysedAt, unsynced: true,
    });
    if (!game || game.site !== account.site) continue;
    for (const candidate of Array.isArray(result.puzzles) ? result.puzzles : []) {
      const id = `${game.id}#${candidate?.ply}`;
      if (state.puzzles.has(id) || (candidate?.key && [...state.puzzles.values()].some(puzzle => puzzle.key === candidate.key))) continue;
      const now = Date.now();
      const puzzle = store.cleanPuzzle({ ...candidate, id, gameId: game.id, playedAt: game.playedAt, foundAt: now, changedAt: now, unsynced: true });
      if (!puzzle) continue;
      state.puzzles.set(id, puzzle);
      puzzles.push(puzzle);
      game.puzzles++;
    }
    state.games.set(game.id, game);
    games.push(game);
  }
  if (changed || results.length) await store.save(account, { games, puzzles });
  if (results.length) {
    await bridge("/api/puzzles/collected", { body: { profile: account.id, games: results.map(result => result.id).filter(id => typeof id === "string") } });
    if (state.session) { state.session.finished += results.length; state.session.found += puzzles.length; }
  }
  if (changed || results.length) renderSummary();
  if (puzzles.length && idle()) nextPuzzle();
  if (changed || puzzles.length) syncSoon();
}

async function stop() {
  if (state.session) state.session.stopped = true;
  for (const account of state.accounts) {
    try { state.views[account.id] = await bridge("/api/puzzles/stop", { body: { profile: account.id } }); } catch (error) { /* gone */ }
  }
  const session = state.session;
  setStatus(session ? `Stopped: ${plural(session.finished, "game")} analysed, ${plural(session.found, "new puzzle")}. Update carries on from there.` : "Stopped.");
  renderWork();
}

// --------------------------------------------------------------- solving ---

function nextPuzzle({ practice = false } = {}) {
  clearTimers();
  $("#pz-deleted").hidden = true;
  const active = activePuzzles();
  let puzzle = store.pickNext(active, Date.now(), state.recent);
  if (!puzzle && practice) puzzle = store.pickPractice(active, state.recent);
  if (puzzle) { showPuzzle(puzzle); return; }
  // Nothing to show now.
  state.current = state.accounts.length ? { waiting: true } : null;
  if (!board.position) board.set(chess.parseFen(chess.START_FEN));
  board.setMovable(false);
  $("#pz-solution").disabled = true;
  $("#pz-analyse").hidden = true;
  $("#pz-delete-puzzle").hidden = true;
  $("#pz-info").textContent = "";
  updateHistoryButtons();
  renderToMove(null);
  renderPool();
  if (!state.accounts.length) {
    $("#pz-next").disabled = true;
    feedback("Enter your chess.com and/or Lichess username and click Load.");
  } else if (active.length) {
    const nextDue = Math.min(...active.map(item => store.reviewOf(item).due));
    $("#pz-next").disabled = false;
    $("#pz-next").textContent = "Practice anyway";
    feedback(`No puzzle is due. The next one is due ${inText(nextDue - Date.now())}.`);
  } else {
    $("#pz-next").disabled = true;
    $("#pz-next").textContent = "Next puzzle";
    feedback(working() ? "No puzzles yet. They appear here as the games are analysed."
      : state.puzzles.size ? "No puzzles left: every puzzle is mastered, set aside or deleted." : "No puzzles yet. Click Update puzzles.");
  }
}

function orientationFor(puzzle) {
  return state.flipped ? (puzzle.color === "w" ? "b" : "w") : puzzle.color;
}

function showPuzzle(puzzle) {
  clearTimers();
  $("#pz-deleted").hidden = true;
  const start = chess.parseFen(puzzle.fenBefore);
  const opponentMove = chess.parseUci(start, puzzle.lastMove);
  const position = chess.makeMove(start, opponentMove);
  const current = state.current = {
    puzzle,
    early: !store.isDue(puzzle, Date.now()),
    failed: false, done: false, busy: true,
    // Everything played on the board: positions[i] after moves[i - 1]; view
    // is the one shown (◀ ▶ go back and forth).
    positions: [start, position], moves: [puzzle.lastMove], step: 0, view: 0,
  };
  // What each side has taken, at each position (captured[i] for positions[i]).
  const before = capturedBefore(puzzle, start);
  current.captured = [before, capturedAfter(before, start, opponentMove)];
  state.recent = [...state.recent.filter(id => id !== puzzle.id), puzzle.id].slice(-20);
  board.setOrientation(orientationFor(puzzle));
  board.set(start, { movable: false });
  renderToMove(start);
  renderMaterial(start, current.captured[0]);
  $("#pz-solution").disabled = false;
  $("#pz-next").disabled = false;
  $("#pz-next").textContent = "Next puzzle";
  $("#pz-analyse").hidden = true;
  $("#pz-delete-puzzle").hidden = true;   // once it is solved or its solution shown
  feedback(`${colorName(puzzle.color === "w" ? "b" : "w")} plays…`);
  renderPuzzleInfo();
  updateHistoryButtons();
  renderPool();
  // The opponent's move slides into place, then it is the player's turn.
  later(() => {
    if (state.current !== current) return;
    current.busy = false;
    showView(1, { sound: true, auto: true });
    feedback(`Your turn: find the best move for ${colorName(puzzle.color)}.`);
  }, OPPONENT_DELAY_MS);
}

function renderToMove(position) {
  const element = $("#pz-to-move");
  element.replaceChildren();
  if (!position) return;
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.background = position.turn === "w" ? "#f2f2f2" : "#111";
  const text = document.createElement("span");
  text.textContent = `${colorName(position.turn)} to move`;
  element.append(swatch, text);
}

// The pieces taken before the puzzle: from the game's moves, or, without
// them, from what is missing on the board.
function capturedBefore(puzzle, start) {
  const game = state.games.get(puzzle.gameId);
  const moves = Array.isArray(game?.moves) ? game.moves.slice(0, puzzle.ply - 1) : null;
  if (moves && game.moves[puzzle.ply - 1] === puzzle.lastMove) {
    let position = chess.parseFen(chess.START_FEN), captured = { w: [], b: [] };
    for (const uci of moves) {
      const move = chess.parseUci(position, uci);
      if (!move) break;
      captured = capturedAfter(captured, position, move);
      position = chess.makeMove(position, move);
    }
    if (chess.positionKey(chess.toFen(position)) === chess.positionKey(chess.toFen(start))) return captured;
  }
  // A piece beyond the usual number is a promoted pawn, which was not taken.
  const full = { p: 8, n: 2, b: 2, r: 2, q: 1 }, captured = { w: [], b: [] };
  for (const [side, white] of [["w", false], ["b", true]]) {   // what side took: the other colour's pieces
    const pieceOf = type => white ? type.toUpperCase() : type;
    const left = type => start.board.filter(square => square === pieceOf(type)).length;
    let promoted = 0;
    for (const type of ["n", "b", "r", "q"]) promoted += Math.max(0, left(type) - full[type]);
    for (const [type, count] of Object.entries(full)) {
      const missing = Math.max(0, count - left(type) - (type === "p" ? promoted : 0));
      for (let i = 0; i < missing; i++) captured[side].push(pieceOf(type));
    }
  }
  return captured;
}
function capturedAfter(captured, position, move) {
  if (!move?.captured) return captured;
  const side = position.turn;
  return { ...captured, [side]: [...captured[side], move.captured] };
}
function renderMaterial(position, captured) {
  drawMaterial($("#pz-captured-top"), $("#pz-captured-bottom"), position.board, captured, board.orientation === "b");
}

function isCheckmate(position) {
  return chess.inCheck(position) && !chess.legalMoves(position).length;
}
// The player may move on the board: while solving, at the newest position.
function canMove(current = state.current) {
  return !!current?.puzzle && !current.done && !current.busy && current.view === current.positions.length - 1;
}

function userMove(uci, { slide } = {}) {
  const current = state.current;
  if (!canMove(current)) return;
  const position = current.positions[current.positions.length - 1];
  const move = chess.parseUci(position, uci);
  if (!move) return;
  const next = chess.makeMove(position, move);
  const expected = current.puzzle.solution[current.step];
  const to = uci.slice(2, 4);
  // Any checkmate is right, as on Lichess.
  const captured = capturedAfter(current.captured[current.positions.length - 1], position, move);
  if (uci === expected || isCheckmate(next)) {
    current.positions.push(next);
    current.moves.push(uci);
    current.captured.push(captured);
    current.view = current.positions.length - 1;
    current.step++;
    const ends = isCheckmate(next) || current.step >= current.puzzle.solution.length;
    current.busy = !ends;
    board.set(next, { lastMove: uci, mark: { square: to, kind: "good" }, animate: slide, movable: false });
    playMoveSound(soundFor(move, next));
    renderToMove(next);
    renderMaterial(next, captured);
    updateHistoryButtons();
    if (ends) { finish(); return; }
    feedback("Best move! Keep going…", "good");
    later(() => playReply(current), REPLY_DELAY_MS);
    return;
  }
  // A wrong move is shown, then taken back.
  current.busy = true;
  board.set(next, { lastMove: uci, mark: { square: to, kind: "bad" }, animate: slide, movable: false });
  playMoveSound("wrong");
  renderToMove(next);
  renderMaterial(next, captured);
  updateHistoryButtons();
  if (!current.failed) { current.failed = true; record(current, false); }
  feedback("That's not the move. Try something else, or show the solution.", "bad");
  later(() => {
    if (state.current !== current || current.done) return;
    current.busy = false;
    board.set(position, { lastMove: current.moves[current.moves.length - 1], movable: true });
    renderToMove(position);
    renderMaterial(position, current.captured[current.positions.length - 1]);
    updateHistoryButtons();
  }, WRONG_SHOWN_MS);
}

// Plays the solution's next move on the board (the opponent's answer, or a
// move of the shown solution).
function playSolutionMove(current) {
  const position = current.positions[current.positions.length - 1];
  const uci = current.puzzle.solution[current.step];
  const move = chess.parseUci(position, uci);
  if (!move) return false;
  current.captured.push(capturedAfter(current.captured[current.positions.length - 1], position, move));
  current.positions.push(chess.makeMove(position, move));
  current.moves.push(uci);
  current.step++;
  showView(current.positions.length - 1, { sound: true, auto: true });
  return true;
}

// The opponent's answer in the solution.
function playReply(current) {
  if (state.current !== current || current.done) return;
  if (!playSolutionMove(current) || current.step >= current.puzzle.solution.length) { finish(); return; }
  current.busy = false;
  board.setMovable(canMove(current));   // without drawing again: the reply is still sliding
  updateHistoryButtons();
  feedback(`Your turn: ${colorName(current.puzzle.color)} again.`, "good");
}

function showSolution() {
  const current = state.current;
  if (!current?.puzzle || current.done) return;
  clearTimers();
  if (!current.failed) { current.failed = true; record(current, false); }
  current.busy = true;
  // From the puzzle's newest position (a wrong move is taken back).
  showView(current.positions.length - 1, { force: true });
  feedback("The solution:", "bad");
  const step = () => {
    if (state.current !== current) return;
    if (current.step >= current.puzzle.solution.length || !playSolutionMove(current)) { finish(); return; }
    later(step, SOLUTION_STEP_MS);
  };
  later(step, 250);
}

function finish() {
  const current = state.current;
  current.done = true;
  current.busy = false;
  clearTimers();
  board.setMovable(false);
  if (!current.failed) record(current, true);
  const review = store.reviewOf(current.puzzle);
  let text;
  if (current.failed) text = "Missed this time: it comes back after a few other puzzles.";
  else if (current.puzzle.mastered) text = "Solved! Four times in a row: it leaves the list (mastered).";
  else if (current.early) text = "Solved! It was not due yet, so this was practice: it comes back as planned.";
  else text = `Solved! It comes back ${inText(review.due - Date.now())}.`;
  feedback(text, current.failed ? "bad" : "good");
  if (!current.failed) playMoveSound("complete");
  $("#pz-solution").disabled = true;
  $("#pz-next").disabled = false;
  $("#pz-next").textContent = "Next puzzle";
  $("#pz-analyse").hidden = false;
  $("#pz-delete-puzzle").hidden = !!state.puzzles.get(current.puzzle.id)?.deleted;
  renderPuzzleInfo();
  updateHistoryButtons();
  renderSummary();
}

function record(current, solved) {
  // The stored copy: it may have been deleted or brought back meanwhile.
  const updated = store.withResult(state.puzzles.get(current.puzzle.id) || current.puzzle, solved, Date.now(), current.early);
  current.puzzle = updated;
  savePuzzle(updated);
}

// A puzzle changed here: kept in this browser, and sent to the server soon
// (with a key).
function savePuzzle(puzzle) {
  puzzle = { ...puzzle, unsynced: true };
  state.puzzles.set(puzzle.id, puzzle);
  const owner = ownerOf(puzzle);
  if (owner) store.save(owner, { puzzles: [puzzle] }).catch(error => setStatus(error.message, true));
  renderSummary();
  syncSoon();
  return puzzle;
}

// Deletes the puzzle on the board from the list and shows the next one: once
// it is done (solved, or its solution shown). It is kept, marked, so that it
// is not found again; Undo (or the list's deleted puzzles) brings it back.
function deleteShownPuzzle() {
  const shown = state.current?.puzzle;
  if (!shown || !state.current.done) return;
  const puzzle = store.withDeleted(state.puzzles.get(shown.id) || shown, true, Date.now());
  savePuzzle(puzzle);
  nextPuzzle();
  const game = state.games.get(puzzle.gameId);
  $("#pz-deleted-text").textContent = `Deleted the puzzle from the game against ${game?.opponent || "?"} (${dateText(puzzle.playedAt)}, move ${puzzleMoveNumber(puzzle)}).`;
  // Back in the list as it was; the puzzle on the board stays.
  $("#pz-deleted-undo").onclick = () => {
    playMoveSound("ui");
    bringBack(puzzle.id);
    $("#pz-deleted").hidden = true;
    if (state.current?.waiting) nextPuzzle();
  };
  $("#pz-deleted").hidden = false;
}

// Brings a deleted puzzle back to the list, as it was.
function bringBack(id) {
  const puzzle = state.puzzles.get(id);
  if (!puzzle?.deleted) return null;
  const back = store.withDeleted(puzzle, false, Date.now());
  savePuzzle(back);
  return back;
}

function renderPuzzleInfo() {
  const current = state.current, info = $("#pz-info");
  if (!current?.puzzle) { info.textContent = ""; return; }
  const puzzle = current.puzzle, game = state.games.get(puzzle.gameId);
  const fen = chess.toFen(current.positions[1]);
  // Escaped, numbers too, and a link only to the game on Lichess or chess.com.
  const html = value => escapeHtml(String(value));
  const lines = [];
  const opponent = game ? `${html(game.opponent)}${game.opponentRating ? ` (${html(game.opponentRating)})` : ""}` : "?";
  const address = store.safeGameUrl(game?.url);
  const link = address ? ` · <a href="${html(address)}" target="_blank" rel="noopener noreferrer">open the game</a>` : "";
  lines.push(`From your ${html(SITES[siteOf(puzzle.gameId)] || "")} game against ${opponent}, ${html(dateText(puzzle.playedAt))}, move ${html(puzzleMoveNumber(puzzle))}${link}`);
  if (current.done) {
    lines.push(`Solution: <span class="line">${html(sanLine(fen, puzzle.solution))}</span>`
      + ` (${html(puzzle.kind === "mate" ? `mate in ${puzzle.score.mate}` : scoreText(puzzle.score))})`);
    if (puzzle.played) {
      lines.push(`In the game you played <span class="line">${html(sanLine(fen, [puzzle.played]))}</span>`
        + (puzzle.judgement ? `, ${html(puzzle.judgement.toLowerCase())}` : "")
        + (puzzle.playedScore ? ` (${html(scoreText(puzzle.playedScore))} after it)` : "") + ".");
    }
    const review = store.reviewOf(puzzle);
    lines.push(html(`Solved at the first try ${review.streak} time${review.streak === 1 ? "" : "s"} in a row · tried ${review.attempts} time${review.attempts === 1 ? "" : "s"}, missed ${review.misses}`));
  }
  info.innerHTML = lines.join("<br>");
}

// Opens the puzzle's game, up to the position shown, and its solution on
// the best-move board, where live analysis follows it.
function analyseInBestMoves() {
  const current = state.current;
  if (!current?.puzzle) return;
  const puzzle = current.puzzle, game = state.games.get(puzzle.gameId);
  const played = current.moves.slice(1);   // after the opponent's move
  const before = Array.isArray(game?.moves) ? game.moves.slice(0, puzzle.ply) : null;
  if (before && before[before.length - 1] === puzzle.lastMove) {
    openLine({ moves: [...before, ...played], index: puzzle.ply - 1 + current.view, flipped: orientationFor(puzzle) === "b" });
  } else {
    // Without the game's moves: from the puzzle's first position on.
    openLine({ startFen: puzzle.fenBefore, moves: current.moves, index: current.view, flipped: orientationFor(puzzle) === "b" });
  }
}

// ------------------------------------------------------- moving through ----

function updateHistoryButtons() {
  const current = state.current;
  const positions = current?.positions?.length || 0;
  const can = positions > 1 && !current.busy;
  const view = current?.view || 0;
  $("#pz-history-first").disabled = !can || view === 0;
  $("#pz-history-back").disabled = !can || view === 0;
  $("#pz-history-forward").disabled = !can || view >= positions - 1;
  $("#pz-history-last").disabled = !can || view >= positions - 1;
}
// Shows positions[index]. While solving the player can look back (the board
// does not take moves there) and comes back to move on.
// auto: a move the puzzle plays (the opponent's, or the solution's).
function showView(index, { sound = false, auto = false, force = false } = {}) {
  const current = state.current;
  if (!current?.positions) return;
  const target = Math.max(0, Math.min(current.positions.length - 1, index));
  if (target === current.view && !force && !auto) return;
  const forward = target === current.view + 1 || (auto && target > 0);
  current.view = target;
  const position = current.positions[target];
  const lastMove = target ? current.moves[target - 1] : null;
  board.set(position, { lastMove, animate: true, movable: canMove(current) });
  if (forward && (sound || !auto) && target > 0) {
    const before = current.positions[target - 1];
    playMoveSound(soundFor(chess.parseUci(before, lastMove), position));
  }
  renderToMove(position);
  renderMaterial(position, current.captured[target]);
  updateHistoryButtons();
}
function step(delta) {
  const current = state.current;
  if (!current?.positions || current.busy) return;
  showView(current.view + delta);
}

// ------------------------------------------------------------------ list ----

function stateText(puzzle, now) {
  const review = store.reviewOf(puzzle);
  if (puzzle.mastered) return { text: "mastered", kind: "later" };
  if (store.isNew(puzzle)) return { text: "new", kind: "" };
  if (review.streak === 0) return { text: `missed ×${review.misses}`, kind: "missed" };
  if (review.due <= now) return { text: "due", kind: "" };
  return { text: inText(review.due - now).replace(/^in /, ""), kind: "later" };
}

function renderPool() {
  const list = $("#pz-pool-list");
  list.replaceChildren();
  if (!state.accounts.length) { $("#pz-pool-summary").textContent = "Puzzle list"; return; }
  const now = Date.now();
  const show = $("#pz-pool-show").value;
  const active = activePuzzles(), all = [...state.puzzles.values()];
  const listed = show === "mastered" ? all.filter(puzzle => puzzle.mastered && !puzzle.deleted)
    : show === "deleted" ? all.filter(puzzle => puzzle.deleted) : active;
  $("#pz-pool-summary").textContent = show === "mastered" ? `Mastered puzzles (${listed.length})`
    : show === "deleted" ? `Deleted puzzles (${listed.length})` : `Puzzle list (${active.length})`;
  if (show === "deleted") listed.sort((a, b) => (b.deletedChangedAt || 0) - (a.deletedChangedAt || 0));   // the last deleted first
  else listed.sort((a, b) => store.reviewOf(a).due - store.reviewOf(b).due || (b.playedAt || 0) - (a.playedAt || 0));
  for (const puzzle of listed.slice(0, 300)) {
    const game = state.games.get(puzzle.gameId), site = siteOf(puzzle.gameId);
    const item = document.createElement("li");
    if (state.current?.puzzle?.id === puzzle.id) item.classList.add("current");
    const tag = document.createElement("span");
    tag.className = `site-tag ${site}`;
    tag.textContent = SITES[site];
    const open = document.createElement("button");
    open.className = "pool-text";
    open.textContent = `${dateText(puzzle.playedAt)} · against ${game?.opponent || "?"} · move ${puzzleMoveNumber(puzzle)}`;
    open.title = "Open this puzzle";
    open.onclick = () => { playMoveSound("ui"); showPuzzle(puzzle); };
    const status = stateText(puzzle, now);
    const label = document.createElement("span");
    label.className = `pool-state ${status.kind}`;
    label.textContent = status.text;
    item.append(tag, open, label);
    if (puzzle.mastered || puzzle.deleted) {
      const back = document.createElement("button");
      back.className = "small";
      back.textContent = "Bring back";
      back.onclick = () => {
        const latest = state.puzzles.get(puzzle.id) || puzzle;
        if (latest.deleted) bringBack(latest.id);
        else savePuzzle({ ...latest, mastered: false, review: { ...store.reviewOf(latest), streak: 0, due: Date.now() }, changedAt: Date.now() });
        if (state.current?.puzzle?.id === puzzle.id && state.current.done) $("#pz-delete-puzzle").hidden = false;
        if (state.current?.waiting) nextPuzzle();
      };
      item.appendChild(back);
    }
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------- server ----
// Logged in with a key (the admin token or a contributor key, on the best
// moves page), the accounts are kept on this site's server too, the same in
// every browser logged in with that key (/api/puzzles/* in worker/index.js):
// what changed here is sent, what changed elsewhere comes back, and of two
// changes to one puzzle the later one wins. Of the games, only those with
// puzzles are kept there. Without a key, everything stays in this browser.

// What only this browser needs to know.
const withoutLocal = ({ unsynced, cloud: synced, ...kept }) => kept;

// The ids of the accounts the server keeps for the key ("lichess:name"),
// the last changed first.
async function cloudProfiles() {
  return (await api("/api/puzzles/profiles")).profiles.map(entry => entry.profile);
}

// Sends what changed in a moment (several changes go together).
function syncSoon() {
  if (!cloudOwner() || !state.accounts.length || cloud.soon) return;
  cloud.soon = setTimeout(() => { cloud.soon = null; syncAll(); }, SYNC_SOON_MS);
}

// Syncs every open account; asked again while it runs, it runs once more.
// While the puzzles are on screen, it runs again now and then, for what
// other browsers changed.
async function syncAll() {
  if (cloud.running) { cloud.again = true; return cloud.running; }
  clearTimeout(cloud.poll);
  cloud.running = (async () => {
    try {
      do {
        cloud.again = false;
        for (const account of state.accounts.slice()) await syncAccount(account);
      } while (cloud.again && cloudOwner());
      cloud.at = Date.now();
      cloud.error = null;
    } catch (error) {
      cloud.error = error.message;
    } finally {
      cloud.running = null;
      renderCloud();
      if (cloudOwner() && state.accounts.length) {
        const poll = () => { if (shown() && !document.hidden) syncAll(); else cloud.poll = setTimeout(poll, SYNC_EVERY_MS); };
        cloud.poll = setTimeout(poll, SYNC_EVERY_MS);
      }
    }
  })();
  renderCloud();
  return cloud.running;
}

async function syncAccount(account) {
  const owner = cloudOwner();
  if (!owner || !state.accounts.includes(account)) return;
  // The first time with this key everything is sent, after that what
  // changed here since.
  const fresh = account.cloud?.owner !== owner;
  const mine = [...state.puzzles.values()].filter(puzzle => siteOf(puzzle.gameId) === account.site);
  const withPuzzles = new Set(mine.map(puzzle => puzzle.gameId));
  const sent = [];   // [record, item]
  // An item the server would refuse is kept here only, so that it cannot
  // stop the rest from being sent.
  const send = (record, item) => {
    if ((item.id || "").length <= SYNC_ID_MOST && JSON.stringify(item.data).length <= SYNC_ITEM_BYTES) sent.push([record, item]);
  };
  const profileAt = account.changedAt || 0;
  if (fresh || account.unsynced) send(account, { kind: "profile", changed_at: profileAt, data: withoutLocal(account) });
  for (const game of state.games.values()) {
    if (game.site !== account.site || !withPuzzles.has(game.id) || !(fresh || game.unsynced)) continue;
    send(game, { kind: "game", id: game.id, changed_at: store.changedAtOf(game), data: withoutLocal(game) });
  }
  for (const puzzle of mine) {
    if (fresh || puzzle.unsynced) send(puzzle, { kind: "puzzle", id: puzzle.id, changed_at: store.changedAtOf(puzzle), data: withoutLocal(puzzle) });
  }
  let rev = fresh ? 0 : account.cloud.rev;
  for (let start = 0; start === 0 || start < sent.length; start += SYNC_PART) {
    const items = sent.slice(start, start + SYNC_PART).map(([, item]) => item);
    let answer = await api("/api/puzzles/sync", { body: { profile: account.id, since: rev, items } });
    if (answer.gone) { await forgetHere(account); return; }
    if (answer.missing) { account.cloud = null; return syncAccount(account); }   // everything again
    for (;;) {
      await take(account, answer.items);
      rev = answer.rev;
      if (!answer.more) break;
      answer = await api("/api/puzzles/sync", { body: { profile: account.id, since: rev } });
    }
  }
  // What was sent is on the server now, unless it changed here meanwhile.
  const games = [], puzzles = [];
  for (const [record, item] of sent) {
    const map = item.kind === "game" ? state.games : item.kind === "puzzle" ? state.puzzles : null;
    if (!map || map.get(record.id) !== record) continue;
    const synced = { ...record, unsynced: false };
    map.set(synced.id, synced);
    (item.kind === "game" ? games : puzzles).push(synced);
  }
  if ((account.changedAt || 0) === profileAt) account.unsynced = false;
  account.cloud = { owner, rev };
  if (state.accounts.includes(account)) await store.save(account, { games, puzzles });
}

// Takes what changed in other browsers, unless it changed here since.
async function take(account, items = []) {
  const games = [], puzzles = [];
  let profile = false;
  const newerHere = (here, changedAt) => here?.unsynced && store.changedAtOf(here) >= changedAt;
  for (const { kind, changed_at: changedAt, data } of Array.isArray(items) ? items : []) {
    if (!Number.isFinite(changedAt)) continue;
    if (kind === "profile") {
      if (account.unsynced && (account.changedAt || 0) >= changedAt) continue;
      // Only the fields the page knows, each of its kind.
      Object.assign(account, store.cleanProfileData(data), { changedAt });
      profile = true;
    } else if (kind === "game") {
      const game = store.cleanGame({ ...data, changedAt, unsynced: false });
      if (!game || game.site !== account.site || newerHere(state.games.get(game.id), changedAt)) continue;
      state.games.set(game.id, game);
      games.push(game);
    } else if (kind === "puzzle") {
      const puzzle = store.cleanPuzzle({ ...data, changedAt, unsynced: false });
      if (!puzzle || siteOf(puzzle.gameId) !== account.site || newerHere(state.puzzles.get(puzzle.id), changedAt)) continue;
      state.puzzles.set(puzzle.id, puzzle);
      puzzles.push(puzzle);
    }
  }
  if (!profile && !games.length && !puzzles.length) return;
  if (state.accounts.includes(account)) await store.save(account, { games, puzzles });
  renderSummary();
  if (puzzles.length && idle()) nextPuzzle();
}

// The account was deleted in another browser logged in with the same key.
async function forgetHere(account) {
  await store.deleteProfile(account.id);
  state.accounts = state.accounts.filter(other => other !== account);
  for (const [id, game] of state.games) if (game.site === account.site) state.games.delete(id);
  for (const [id, puzzle] of state.puzzles) if (siteOf(puzzle.gameId) === account.site) state.puzzles.delete(id);
  delete state.views[account.id];
  if (bridgeStatus()?.puzzles) bridge("/api/puzzles/forget", { body: { profile: account.id } }).catch(() => {});
  rememberAccounts();
  $(account.site === "chesscom" ? "#pz-chesscom" : "#pz-lichess").value = "";
  setStatus(`${SITES[account.site]} ${account.username}: deleted in another browser logged in with this key, so here too.`);
  renderSummary();
  if (idle() || siteOf(state.current.puzzle.gameId) === account.site) nextPuzzle();
}

// Logged in with no accounts open here: the ones the server keeps for the
// key (the last changed of each site).
async function openFromCloud() {
  if (!cloudOwner() || state.accounts.length) return;
  let kept;
  try { kept = await cloudProfiles(); } catch (error) { cloud.error = error.message; renderCloud(); return; }
  const names = { chesscom: "", lichess: "" };
  for (const id of kept) {
    const site = siteOf(id);
    if (site in names && !names[site]) names[site] = id.slice(site.length + 1);
  }
  if ((names.chesscom || names.lichess) && !state.accounts.length) await openAccounts(names, { create: true, kept });
}

function renderCloud() {
  const element = $("#pz-cloud");
  element.classList.toggle("error", !!(cloudOwner() && cloud.error));
  if (!cloudOwner()) {
    element.textContent = state.accounts.length
      ? "Kept in this browser only. Logged in with a key (Best moves), the puzzles are kept on the server too, the same in every browser."
      : "";
  } else if (cloud.error) {
    element.textContent = `Not synced with the server: ${cloud.error}`;
  } else if (cloud.running) {
    element.textContent = "Syncing with the server…";
  } else {
    const at = cloud.at ? ` · synced at ${new Date(cloud.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "";
    element.textContent = state.accounts.length ? `Kept on the server for your key${at}.` : "";
  }
}

// Logging in or out, here or on the best moves page.
onRoleChange(() => started.then(() => {
  const owner = cloudOwner();
  if (owner === cloud.owner) return;
  cloud.owner = owner;
  cloud.error = null;
  renderCloud();
  if (!owner) { clearTimeout(cloud.poll); return; }
  if (state.accounts.length) syncAll();
  else openFromCloud();
}));
document.addEventListener("visibilitychange", () => { if (!document.hidden && shown()) syncSoon(); });

// ------------------------------------------------------- export, import ----

function exportAccounts() {
  if (!state.accounts.length) return;
  const accounts = state.accounts.map(profile => ({
    profile: withoutLocal(profile),
    games: [...state.games.values()].filter(game => game.site === profile.site).map(withoutLocal),
    puzzles: [...state.puzzles.values()].filter(puzzle => siteOf(puzzle.gameId) === profile.site).map(withoutLocal),
  }));
  const data = { format: "mychessdb-puzzles", version: 2, exported_at: new Date().toISOString(), accounts };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `mychessdb-puzzles-${state.accounts.map(account => `${account.site}-${account.username}`).join("-")}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

// Merges an export into what this browser has: an analysed game wins over
// one that is not, and of two copies of a puzzle the one tried more often,
// deleted or not as decided last (store.mergePuzzle). Takes both this
// version's exports (several accounts) and the first one's. With a key,
// what was imported goes to the server too.
async function importAccounts(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (error) { setStatus("That file is not an export of the puzzles.", true); return; }
  const accounts = data?.format !== "mychessdb-puzzles" ? null
    : Array.isArray(data.accounts) ? data.accounts
      : data.profile ? [{ profile: data.profile, games: data.games, puzzles: data.puzzles }] : null;
  const valid = entry => entry?.profile && entry.profile.site in SITES && validUsername(entry.profile.username)
    && Array.isArray(entry.games) && Array.isArray(entry.puzzles);
  if (!accounts?.length || !accounts.every(valid)) { setStatus("That file is not an export of the puzzles.", true); return; }
  const names = typedNames();
  let puzzleCount = 0;
  for (const entry of accounts) {
    const profile = entry.profile;
    const id = store.profileId(profile.site, profile.username);
    const existing = await store.loadProfile(id);
    const games = new Map((existing?.games || []).map(game => [game.id, game]));
    for (const raw of entry.games) {
      const game = store.cleanGame(raw);
      if (!game || game.site !== profile.site) continue;
      const mine = games.get(game.id);
      if (!mine || (mine.status !== "done" && game.status === "done")) games.set(game.id, { ...game, unsynced: true });
    }
    const puzzles = new Map((existing?.puzzles || []).map(puzzle => [puzzle.id, puzzle]));
    for (const raw of entry.puzzles) {
      const puzzle = store.cleanPuzzle(raw);
      if (!puzzle || siteOf(puzzle.gameId) !== profile.site) continue;
      puzzles.set(puzzle.id, { ...store.mergePuzzle(puzzles.get(puzzle.id), puzzle), unsynced: true });
    }
    // Of the account, the fields the page knows; how far this browser synced
    // with the server is its own.
    await store.save({ rating: null, ...(existing?.profile || {}), ...store.cleanProfileData(profile), id, site: profile.site, username: profile.username, unsynced: true },
      { games: [...games.values()], puzzles: [...puzzles.values()] });
    names[profile.site] = profile.username;
    puzzleCount += entry.puzzles.length;
  }
  await openAccounts(names);
  setStatus(`Imported ${plural(puzzleCount, "puzzle")}.`);
}

async function deleteAccounts() {
  if (!state.accounts.length) return;
  const button = $("#pz-delete");
  if (Date.now() - state.deleteArmed > 4000) {
    state.deleteArmed = Date.now();
    button.textContent = "Click again to delete";
    setTimeout(() => { button.textContent = "Delete these accounts' data"; }, 4000);
    return;
  }
  state.deleteArmed = 0;
  button.textContent = "Delete these accounts' data";
  // With a key, from the server first: then from every browser logged in
  // with it (they are told at their next sync).
  if (cloudOwner()) {
    try {
      for (const account of state.accounts) await api("/api/puzzles/forget", { body: { profile: account.id } });
    } catch (error) {
      setStatus(`Not deleted: ${error.message}`, true);
      return;
    }
  }
  // Nothing follows the bridge for these accounts any more, first.
  const accounts = state.accounts;
  state.accounts = [];
  state.following = null;
  state.session = null;
  state.views = {};
  clearTimeout(reconnectTimer);
  for (const account of accounts) {
    // The bridge forgets them too (what it had not handed over yet).
    if (bridgeStatus()?.puzzles) await bridge("/api/puzzles/forget", { body: { profile: account.id } }).catch(() => {});
    await store.deleteProfile(account.id);
  }
  try { localStorage.removeItem(ACCOUNTS_KEY); } catch (error) { /* nothing remembered */ }
  state.games = new Map();
  state.puzzles = new Map();
  state.current = null;
  $("#pz-chesscom").value = $("#pz-lichess").value = "";
  setStatus("Deleted.");
  renderSummary();
  nextPuzzle();
}

// ------------------------------------------------------------- controls ----

for (const [name, label] of Object.entries(EFFORTS)) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = label;
  $("#pz-effort").appendChild(option);
}
try { if (localStorage.getItem(EFFORT_KEY) in EFFORTS) $("#pz-effort").value = localStorage.getItem(EFFORT_KEY); } catch (error) { /* the default */ }
$("#pz-effort").onchange = () => {
  try { localStorage.setItem(EFFORT_KEY, $("#pz-effort").value); } catch (error) { /* not remembered */ }
};
$("#pz-load").onclick = () => {
  const names = typedNames();
  if (!names.chesscom && !names.lichess) { setStatus("Enter a chess.com or a Lichess username (or both).", true); return; }
  for (const site of Object.keys(SITES)) {
    if (names[site] && !validUsername(names[site])) { setStatus(`The ${SITES[site]} username: letters, digits, _ or -.`, true); return; }
  }
  playMoveSound("ui");
  openAccounts(names, { create: true });
};
for (const id of ["#pz-chesscom", "#pz-lichess"]) {
  $(id).addEventListener("keydown", event => { if (event.key === "Enter") $("#pz-load").click(); });
}
$("#pz-update").onclick = () => { playMoveSound("ui"); update(); };
$("#pz-stop").onclick = () => { playMoveSound("ui"); stop(); };
$("#pz-bridge-setup").onclick = () => { playMoveSound("ui"); openBridgeSetup(); };
$("#pz-next").onclick = () => {
  playMoveSound("ui");
  nextPuzzle({ practice: !!state.current?.waiting });
};
$("#pz-solution").onclick = () => showSolution();
$("#pz-analyse").onclick = () => { playMoveSound("ui"); analyseInBestMoves(); };
$("#pz-delete-puzzle").onclick = () => { playMoveSound("ui"); deleteShownPuzzle(); };
$("#pz-flip").onclick = () => {
  state.flipped = !state.flipped;
  board.setOrientation(board.orientation === "w" ? "b" : "w");
  const current = state.current;
  if (current?.positions) renderMaterial(current.positions[current.view], current.captured[current.view]);
};
$("#pz-pool-show").onchange = () => renderPool();
$("#pz-export").onclick = () => exportAccounts();
$("#pz-import").onclick = () => $("#pz-import-file").click();
$("#pz-import-file").onchange = async () => {
  const file = $("#pz-import-file").files[0];
  $("#pz-import-file").value = "";
  if (file) await importAccounts(file).catch(error => setStatus(error.message, true));
};
$("#pz-delete").onclick = () => deleteAccounts().catch(error => setStatus(error.message, true));
$("#pz-history-first").onclick = () => step(-Infinity);
$("#pz-history-back").onclick = () => step(-1);
$("#pz-history-forward").onclick = () => step(1);
$("#pz-history-last").onclick = () => step(Infinity);
$("#pz-board-wrap").addEventListener("wheel", event => {
  if (!state.current?.positions) return;
  event.preventDefault();
  step(event.deltaY > 0 ? 1 : -1);
}, { passive: false });
document.addEventListener("keydown", event => {
  if (!shown() || event.target.closest?.("input, select, textarea")) return;
  if (event.key === "ArrowLeft") step(-1);
  else if (event.key === "ArrowRight") step(1);
});

/** Called by app.js each time the puzzle view is shown. */
export function pageShown() {
  renderBridge();
  if (state.accounts.length) {
    renderSummary();
    if (!state.following) watchBridge();
    syncSoon();
  } else if (!MOBILE && !bridgeStatus()) {
    checkBridge().catch(() => {});
  }
}

// The accounts used last (one per site; the first version kept one), or,
// logged in with a key, the ones the server keeps for it.
const started = (async () => {
  cloud.owner = cloudOwner();
  let names = null;
  try {
    names = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "null");
    const older = localStorage.getItem("chessdb_puzzles_profile");
    if (!names && older?.includes(":")) names = { [siteOf(older)]: older.slice(older.indexOf(":") + 1) };
  } catch (error) { /* none */ }
  if (names && typeof names === "object") {
    await openAccounts({ chesscom: typeof names.chesscom === "string" ? names.chesscom : "", lichess: typeof names.lichess === "string" ? names.lichess : "" });
  }
  if (!state.accounts.length) await openFromCloud();
  if (!state.accounts.length) nextPuzzle();
  renderCloud();
})();

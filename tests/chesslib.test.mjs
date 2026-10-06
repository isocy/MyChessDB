// Run: node tests/chesslib.test.mjs
// Proves web/chesslib.js against (1) published perft node counts and
// (2) python-chess output for thousands of random positions.
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import {
  START_FEN, parseFen, toFen, positionKey, legalMoves, makeMove, moveToUci, moveToSan,
  parseUci, parseSan, replayUci, replaySan, formatSanLine, perft,
} from "../web/chesslib.js";

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

// --- perft: the standard move-generator correctness suite ---------------
const PERFT = [
  [START_FEN, [20, 400, 8902, 197281]],
  ["r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", [48, 2039, 97862, 4085603]],
  ["8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812, 43238, 674624]],
  ["r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264, 9467, 422333]],
  ["rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486, 62379, 2103487]],
  ["r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", [46, 2079, 89890, 3894594]],
];
for (const [fen, counts] of PERFT) {
  const position = parseFen(fen);
  counts.forEach((expected, i) => eq(perft(position, i + 1), expected, `perft(${i + 1}) of ${fen}`));
}

// --- invalid input is rejected, never crashes ---------------------------
for (const bad of [
  "", "not a fen", "8/8/8/8/8/8/8/8 w - - 0 1",                       // no kings
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1",          // bad turn
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1",           // short rank
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e5 0 1",         // bad ep rank
  "Pnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR w KQkq - 0 1",          // pawn on last rank
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1\nquit",    // injected line
  "4k3/8/8/8/8/8/4R3/4K3 w - - 0 1",                                   // side not to move in check
]) {
  assert.throws(() => parseFen(bad), Error, `should reject: ${JSON.stringify(bad)}`);
  checks++;
}
eq(positionKey("garbage text here ok extra"), "garbage text here ok", "positionKey falls back for invalid text");

// --- helpers ------------------------------------------------------------
eq(formatSanLine(["e4", "e5", "Nf3"]), "1. e4 e5 2. Nf3");
eq(formatSanLine([]), "");
{
  const r = replayUci(START_FEN, ["e2e4", "e7e5", "g1f3", "zz", "b8c6"]);
  eq(r.san, ["e4", "e5", "Nf3"]);
  eq(r.complete, false);
  const s = replaySan(START_FEN, ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "0-0"]);
  eq(s.uci[s.uci.length - 1], "e1g1", "0-0 spelling accepted");
  eq(s.complete, true);
}

// --- cross-check with python-chess --------------------------------------
const fixturePath = new URL("./chess_fixture.json", import.meta.url);
if (!existsSync(fixturePath)) {
  console.log("chess_fixture.json missing - skipping the python-chess cross-check");
} else {
  const plies = JSON.parse(readFileSync(fixturePath, "utf8"));
  let castles = 0, eps = 0, promotions = 0;
  for (const ply of plies) {
    const position = parseFen(ply.fen);
    const moves = legalMoves(position);
    eq(moves.map(moveToUci).sort(), ply.legal, `legal moves of ${ply.fen}`);
    eq(toFen(position), ply.fen, "FEN round-trips");
    eq(positionKey(ply.fen), ply.key, "positionKey matches python-chess");
    eq(positionKey(ply.fen_ep_always), ply.key, `en passant square is normalised: ${ply.fen_ep_always}`);
    const move = parseUci(position, ply.uci, moves);
    ok(move, `parseUci ${ply.uci} in ${ply.fen}`);
    eq(parseUci(position, ply.uci960, moves), move, `king-takes-rook spelling ${ply.uci960}`);
    eq(moveToSan(position, move, moves), ply.san, `SAN of ${ply.uci} in ${ply.fen}`);
    eq(parseSan(position, ply.san, moves), move, `parseSan ${ply.san} in ${ply.fen}`);
    const next = makeMove(position, move);
    eq(toFen(next), ply.fen_after, `position after ${ply.uci} in ${ply.fen}`);
    if (move.castle) castles++;
    if (move.enPassant) eps++;
    if (move.promotion) promotions++;
  }
  ok(castles > 20 && eps > 20 && promotions > 20, `special moves covered (castle ${castles}, ep ${eps}, promo ${promotions})`);
  console.log(`cross-checked ${plies.length} positions (castle ${castles}, en passant ${eps}, promotion ${promotions})`);
}

console.log(`chesslib: ${checks} checks passed`);

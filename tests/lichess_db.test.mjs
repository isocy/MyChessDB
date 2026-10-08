// Run: node tests/lichess_db.test.mjs
// scripts/lichess_db.mjs against a small stand-in for the Lichess evaluation
// dump (same format, packed the same way), through to what the API then
// gives the page.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import worker from "../worker/index.js";
import { LocalD1 } from "../scripts/d1_local.mjs";
import { extractLine, pieceCount, fewestMoves } from "../scripts/lichess_db.mjs";
import { parseFen, toFen, legalMoves, makeMove, START_FEN } from "../web/chesslib.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "lichess_db.mjs");
const work = mkdtempSync(join(tmpdir(), "lichess-db-test-"));
let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (value, message) => { assert.ok(value, message); checks++; };

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
const ITALIAN = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -";
const AFTER_E4_EP = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3";   // as some tools write it
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";
const MATE_IN_ONE = "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - -";
const MATED = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq -";
// The format of https://database.lichess.org/#evals: several evaluations per
// position, ordered by number of lines, castling as king-takes-rook.
const dump = [
  // deepest evaluation is the second one; castling e1h1 becomes e1g1
  { fen: ITALIAN, evals: [
    { pvs: [{ cp: 30, line: "c2c3 g8f6" }, { cp: 20, line: "d2d3 g8f6" }], knodes: 100, depth: 40 },
    { pvs: [{ cp: 25, line: "e1h1 g8f6 d2d3 d7d6 c2c3 a7a6 a2a4 c5a7 f1e1 e8h8" }], knodes: 123456, depth: 52 }] },
  { fen: START, evals: [{ pvs: [{ cp: 18, line: "e2e4 e7e5 g1f3" }], knodes: 999, depth: 70 }] },
  { fen: AFTER_E4_EP, evals: [{ pvs: [{ cp: -22, line: "e7e5 g1f3" }], knodes: 5, depth: 46 }] },
  { fen: MATE_IN_ONE, evals: [{ pvs: [{ mate: 1, line: "d1d8" }], knodes: 1, depth: 99 }] },
  // left out: too shallow, the game is over, a line that does not fit, not a position
  { fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -", evals: [{ pvs: [{ cp: 30, line: "g1f3" }], knodes: 7, depth: 45 }] },
  { fen: MATED, evals: [{ pvs: [{ mate: 0, line: "a2a3" }], knodes: 7, depth: 60 }] },
  { fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -", evals: [{ pvs: [{ cp: 30, line: "e2e4 e7e5" }], knodes: 7, depth: 60 }] },
  { fen: "8/8/8/8/8/8/8/8 w - -", evals: [{ pvs: [{ cp: 0, line: "a1a2" }], knodes: 7, depth: 60 }] },
];
const lines = dump.map(record => JSON.stringify(record));

try {
  eq([pieceCount(START), pieceCount(MATE_IN_ONE), pieceCount("8/8/8/8/8/8/8/K6k w - -")], [32, 9, 2]);
  // --- how early a position can be: the fewest moves it needs ---
  eq(fewestMoves(START), { white: 0, black: 0, plies: 0 });
  eq(fewestMoves(AFTER_E4), { white: 1, black: 0, plies: 1 });
  eq(fewestMoves(ITALIAN), { white: 3, black: 3, plies: 6 }, "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5");
  // Castling is one move; a pawn on the fifth rank took two; a bishop that moved three times counts once.
  eq(fewestMoves("r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 b - -").plies, 17, "the Ruy Lopez after 9. h3: 17 half-moves");
  eq(fewestMoves("rnbqkbnr/pppp1ppp/8/4P3/8/8/PPPP1PPP/RNBQKBNR b KQkq -"), { white: 2, black: 0, plies: 3 });
  eq(fewestMoves("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq -").plies, 1, "Black to move: White has moved (and moved back)");
  // An ending is never early, however few of its pieces have moved: what is gone had to be taken, a move each.
  eq(fewestMoves(MATE_IN_ONE), { white: 12, black: 11, plies: 24 }, "Black has lost 12 pieces and pawns, White 11");
  eq(fewestMoves("rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq -"), { white: 2, black: 0, plies: 3 }, "1. e4 d5 2. exd5");
  // It never asks for more than was played: every position of a game's first N moves passes --max-moves N.
  {
    let seed = 2026, positions = 0;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let game = 0; game < 200; game++) {
      let position = parseFen(START_FEN);
      for (let ply = 1; ply <= 120; ply++) {
        const moves = legalMoves(position);
        if (!moves.length) break;
        const special = moves.filter(move => move.castle || move.promotion);   // make sure these come up
        position = makeMove(position, special.length && random() < 0.5 ? special[Math.floor(random() * special.length)] : moves[Math.floor(random() * moves.length)]);
        const needed = fewestMoves(toFen(position).split(" ").slice(0, 4).join(" ")).plies;
        assert.ok(needed <= ply, `${toFen(position)} was reached in ${ply} half-moves but is said to need ${needed}`);
        positions++;
      }
    }
    ok(positions > 10000, `${positions} positions of random games checked`);
  }

  // --- one line at a time ---
  eq(extractLine(lines[0], 46, 16), { key: ITALIAN, depth: 52, knodes: 123456, cp: 25, mate: null, pv: "e1g1 g8f6 d2d3 d7d6 c2c3 a7a6 a2a4 c5a7 f1e1 e8g8" });
  eq(extractLine(lines[0], 46, 4).pv, "e1g1 g8f6 d2d3 d7d6", "the line is cut to the number of moves asked for");
  eq(extractLine(lines[0], 53, 16), "shallow");
  eq(extractLine(lines[2], 46, 16).key, AFTER_E4, "the position is named as the site names it");
  eq(extractLine(lines[3], 46, 16), { key: MATE_IN_ONE, depth: 99, knodes: 1, cp: null, mate: 1, pv: "d1d8" });
  eq([4, 5, 6, 7].map(index => extractLine(lines[index], 46, 16)),
    ["shallow", "game over", "line does not fit the position", "not a position this site can show"]);
  eq(extractLine("{not json", 1, 16), "shallow");
  eq(extractLine('{"depth":60,"fen":3}', 46, 16), "unreadable");

  // --- the commands, on a dump packed the way Lichess packs it ---
  // The real file is written by pzstd: many data frames, cut anywhere (also
  // in the middle of a line), each with a skippable frame in front that
  // holds its packed size. Node's own zstd reader cannot read that.
  const text = Buffer.from(lines.join("\n") + "\n");
  const cuts = [0, 150, 151, Math.floor(text.length * 0.4), Math.floor(text.length * 0.7), text.length - 30, text.length];
  ok(cuts.every((cut, index) => index === 0 || cut > cuts[index - 1]), `cuts in order: ${cuts}`);
  const frames = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const frame = zlib.zstdCompressSync(text.subarray(cuts[i], cuts[i + 1]));
    const note = Buffer.alloc(12);
    note.writeUInt32LE(0x184D2A50, 0); note.writeUInt32LE(4, 4); note.writeUInt32LE(frame.length, 8);
    frames.push(note, frame);
  }
  const packed = join(work, "lichess_db_eval.jsonl.zst"), extracted = join(work, "lichess_db.jsonl"), sqlDir = join(work, "sql");
  writeFileSync(packed, Buffer.concat(frames));
  const run = (...args) => execFileSync(process.execPath, ["--no-warnings", script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let output = run("extract", packed, "--out", extracted);
  ok(output.includes(`8 positions read, 4 kept in ${extracted}.`), output);
  ok(!existsSync(extracted + ".part"), "the working file is renamed once it is complete");
  // A file packed in one piece is read too.
  const onePiece = join(work, "one.jsonl.zst");
  writeFileSync(onePiece, zlib.zstdCompressSync(text));
  ok(run("extract", onePiece, "--out", join(work, "one.jsonl")).includes("8 positions read, 4 kept"));
  eq(readFileSync(join(work, "one.jsonl"), "utf8"), readFileSync(extracted, "utf8"));
  // --limit stops early and says how far it got.
  const limited = run("extract", packed, "--limit", "2", "--out", join(work, "limited.jsonl"));
  ok(limited.includes("2 positions read, 2 kept") && limited.includes("Stopped at the limit of 2 positions."), limited);
  // A download that is cut off, or something that is not zstd, is said plainly and leaves no result behind.
  for (const [name, bytes, message] of [
    ["cut.jsonl.zst", Buffer.concat(frames).subarray(0, 100), /download is not complete/],
    ["wrong.jsonl.zst", Buffer.from("<html>not found</html>"), /not a zstd file/],
  ]) {
    writeFileSync(join(work, name), bytes);
    let failure = null;
    try { run("extract", join(work, name), "--out", join(work, name + ".out")); } catch (error) { failure = error; }
    ok(failure && failure.status === 1 && message.test(failure.stderr) && !/node:events|at .*\(node:/.test(failure.stderr), failure?.stderr);
    ok(!existsSync(join(work, name + ".out")), "no result file after a failure");
  }
  ok(/By depth: 40-49: 1, 50-59: 1, 70\+: 2/.test(output), output);
  // Forced mates and positions with few pieces are counted apart: they are most of what is deep.
  ok(output.includes("Forced mates among them: 1."), output);
  ok(output.includes("By pieces on the board (in brackets: without forced mates): 8-15: 1 (0), 30-32: 3 (3)"), output);
  ok(/Left out although deep enough: 1 \(game over\), 1 \(line does not fit the position\), 1 \(not a position this site can show\)/.test(output), output);
  eq(readFileSync(extracted, "utf8").trim().split("\n").map(line => JSON.parse(line).key), [ITALIAN, START, AFTER_E4, MATE_IN_ONE]);
  // plain JSON lines work too, and so does a higher depth
  const plain = join(work, "dump.jsonl");
  writeFileSync(plain, lines.join("\n"));
  ok(run("extract", plain, "--min-depth", "60", "--out", join(work, "deep.jsonl")).includes("8 positions read, 2 kept"));

  output = run("sql", "--in", extracted, "--out-dir", sqlDir, "--rows-per-file", "3");
  ok(output.includes("4 rows written to 2 file(s)"), output);
  const files = readdirSync(sqlDir).sort();
  eq(files, ["lichess_db_0001.sql", "lichess_db_0002.sql"]);

  // Only part of what was extracted can be taken.
  const partDir = join(work, "part");
  ok(run("sql", "--in", extracted, "--out-dir", partDir, "--no-mates").includes("3 rows written to 1 file(s) in " + partDir + "; 1 left out by the options."));
  ok(run("sql", "--in", extracted, "--out-dir", partDir, "--min-pieces", "32", "--min-depth", "50").includes("2 rows written"));
  ok(!readFileSync(join(partDir, "lichess_db_0001.sql"), "utf8").includes(MATE_IN_ONE));
  // The first moves only: the start position and the one after 1. e4 pass --max-moves 1, the Italian (3 moves) does not.
  ok(run("sql", "--in", extracted, "--out-dir", partDir, "--max-moves", "1").includes("2 rows written to 1 file(s) in " + partDir + "; 2 left out by the options."));
  const early = readFileSync(join(partDir, "lichess_db_0001.sql"), "utf8");
  ok(early.includes(START) && early.includes(AFTER_E4) && !early.includes(ITALIAN) && !early.includes(MATE_IN_ONE));
  ok(run("sql", "--in", extracted, "--out-dir", partDir, "--max-moves", "3").includes("3 rows written"));
  // "count" shows what each N would keep, without writing anything.
  const counted = run("count", "--in", extracted);
  ok(counted.includes(`4 positions in ${extracted}, 3 of them not forced mates.`), counted);
  eq(counted.split("\n").filter(line => /^\s+\d+\s+\d+\s+\d+$/.test(line)).slice(0, 3).map(line => line.trim().split(/\s+/).map(Number)),
    [[1, 2, 2], [2, 2, 2], [3, 3, 3]]);
  // Without --min-pieces an ending passes a large enough N: it needs only one move for each piece taken.
  eq(counted.split("\n").find(line => /^\s+12\s/.test(line)).trim().split(/\s+/).map(Number), [12, 4, 3]);
  ok(run("count", "--in", extracted, "--min-pieces", "28").includes(`3 positions in ${extracted} that have at least 28 pieces, 3 of them not forced mates.`));
  // With --max-moves it counts exactly what "sql" would write with the same options, and goes on by pieces instead.
  const firstMoves = run("count", "--in", extracted, "--max-moves", "12");
  ok(firstMoves.includes(`4 positions in ${extracted} that can be from the first 12 moves, 3 of them not forced mates.`), firstMoves);
  ok(/adding --min-pieces P keeps/.test(firstMoves) && !/--max-moves N keeps/.test(firstMoves), firstMoves);
  const rows = text => text.split("\n").filter(line => /^\s+\d+\s+\d+\s+\d+$/.test(line)).map(line => line.trim().split(/\s+/).map(Number));
  eq(rows(firstMoves).filter(([pieces]) => [32, 31, 16].includes(pieces)), [[32, 3, 3], [31, 3, 3], [16, 3, 3]], "the ending (9 pieces) is in the total only");
  for (const options of [["--max-moves", "1"], ["--max-moves", "3", "--no-mates"], ["--max-moves", "12", "--min-pieces", "20", "--min-depth", "50"], ["--no-mates"]]) {
    const counted = Number(/^(\d+) positions/.exec(run("count", "--in", extracted, ...options))[1]);
    const written = Number(/^(\d+) rows written/.exec(run("sql", "--in", extracted, "--out-dir", partDir, ...options))[1]);
    eq(counted, written, `count and sql agree for ${options.join(" ")}`);
  }

  // --- loaded into the database, the API gives them to the page ---
  const env = { DB: new LocalD1().migrate(join(root, "migrations")), ADMIN_TOKEN: "lichess-db-test-token-0123" };
  const load = () => { for (const name of files) env.DB.db.exec(readFileSync(join(sqlDir, name), "utf8")); };
  const at = async fen => (await (await worker.fetch(new Request("https://chess.example/api/position?fen=" + encodeURIComponent(fen)), env)).json()).entries;
  load();
  eq(env.DB.db.prepare("SELECT COUNT(*) AS n FROM lichess_db").get().n, 4);
  eq(await at(ITALIAN + " 4 4"), { lichess: {
    fen: ITALIAN + " 0 1", move_uci: "e1g1", pv: "e1g1 g8f6 d2d3 d7d6 c2c3 a7a6 a2a4 c5a7 f1e1 e8g8".split(" "),
    evaluation: "+0.25", depth: 52, knodes: 123456, source: "lichess", verified: true, saved_at: null, imported: true } });
  eq((await at(AFTER_E4_EP + " 0 1")).lichess.evaluation, "-0.22");
  eq((await at(MATE_IN_ONE + " 0 1")).lichess.evaluation, "#1");
  // Asked with next=1, the positions one move away come along, imported rows included.
  const withNext = await (await worker.fetch(new Request("https://chess.example/api/position?next=1&fen=" + encodeURIComponent(START + " 0 1")), env)).json();
  eq([withNext.entries, Object.keys(withNext.next).length], [await at(START + " 0 1"), 20]);
  eq(withNext.next[AFTER_E4].lichess.evaluation, "-0.22");
  // Loading the same files again changes nothing; a deeper row replaces, a shallower one does not.
  load();
  eq(env.DB.db.prepare("SELECT COUNT(*) AS n FROM lichess_db").get().n, 4);
  const again = join(work, "again.jsonl"), againDir = join(work, "again");
  writeFileSync(again, [
    { key: START, depth: 71, knodes: 1, cp: 20, mate: null, pv: "d2d4" },
    { key: ITALIAN, depth: 50, knodes: 1, cp: 99, mate: null, pv: "d2d3" },
  ].map(row => JSON.stringify(row)).join("\n"));
  run("sql", "--in", again, "--out-dir", againDir);
  env.DB.db.exec(readFileSync(join(againDir, "lichess_db_0001.sql"), "utf8"));
  eq([(await at(START + " 0 1")).lichess.move_uci, (await at(ITALIAN + " 0 1")).lichess.depth], ["d2d4", 52]);
  // Anything that is not a position key or a move list never reaches the SQL.
  writeFileSync(again, JSON.stringify({ key: "x'); DROP TABLE lichess_db; --", depth: 50, knodes: 1, cp: 1, mate: null, pv: "e2e4" }));
  assert.throws(() => run("sql", "--in", again, "--out-dir", againDir), /Unexpected content/);
  checks++;

  console.log(`lichess_db: ${checks} checks passed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

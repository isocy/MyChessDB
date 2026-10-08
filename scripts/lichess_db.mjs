// Takes the deep evaluations out of the Lichess evaluation database
// (https://database.lichess.org/#evals, lichess_db_eval.jsonl.zst) and turns
// them into SQL for this site's lichess_db table.
//
//   node scripts/lichess_db.mjs extract lichess_db_eval.jsonl.zst
//       Reads the dump (a .zst or .jsonl file, an https address, or "-" for
//       plain JSON lines on standard input), keeps the positions whose
//       deepest evaluation reaches --min-depth (default 46) and writes them,
//       one compact JSON line each, to --out (default lichess_db.jsonl).
//       Prints how many there are, how they divide by depth, by number of
//       pieces and into forced mates and the rest, and how much room they
//       will take. --limit N stops after N positions have been read, to try
//       it out.
//
//   node scripts/lichess_db.mjs sql
//       Turns --in (default lichess_db.jsonl) into SQL files of
//       --rows-per-file rows (default 50000) in --out-dir (default
//       lichess_db_sql). Each file can be run on its own, in any order, and
//       again: a row only replaces a stored one that is less deep.
//       To take only part of what was extracted: --max-moves N (positions
//       that can be from the first N moves, see below), --min-pieces N
//       (at least N pieces on the board), --no-mates (leave out forced
//       mates), --min-depth N.
//
//   node scripts/lichess_db.mjs count
//       Reads --in (default lichess_db.jsonl) and takes the same options as
//       "sql": the first line it prints is the number of rows "sql" would
//       write with them. Writes nothing. Below that, a table of what a
//       further choice would keep: for a range of N what --max-moves N
//       keeps, or, when --max-moves is given, for a range of P what
//       --min-pieces P keeps.
//
// "The first N moves": the dump does not say at which move a position was
// reached, so this is worked out from the position itself: how many moves
// each side must have made at the very least to get its pieces and pawns
// where they stand. A position passes --max-moves N when that takes no more
// than N moves by White and N by Black. Every position from the first N
// moves of a game passes. Others pass too, because the least a position
// needs can be far less than what it took in a real game: above all
// positions with many pieces gone, which need only one move for each piece
// taken. --min-pieces together with --max-moves keeps those out (in the
// first ten moves of a real game there are seldom fewer than 28 pieces).
//
//   node scripts/lichess_db.mjs load-dev
//       Runs those SQL files on the local development database
//       (.dev/mychessdb.sqlite), to try the result with `npm run dev`.
//
// For the real database, run each file with wrangler (see DEPLOY.md):
//   npx wrangler d1 execute mychessdb --remote --file=lichess_db_sql/lichess_db_0001.sql
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import zlib from "node:zlib";
import { parseFen, toFen, legalMoves, sanitizeUciLine } from "../web/chesslib.js";

const ROWS_PER_STATEMENT = 200;   // keeps a statement well under D1's 100 KB limit

/** How many pieces stand on the board of a position key. */
export function pieceCount(key) {
  let count = 0;
  for (const c of key.slice(0, key.indexOf(" "))) if (c >= "A") count++;   // letters, not digits or "/"
  return count;
}
/**
 * The fewest moves White and Black must each have made to reach a position:
 * { white, black, plies }. A pawn needs as many moves as its rank requires
 * (one for the third or fourth rank, one more for each rank beyond); a piece
 * that is not on a starting square of its kind needs one; castling moves
 * king and rook in one. And every piece that is gone was taken by a move of
 * the other side, so a side has made at least as many moves as the other
 * side has lost pieces (which is what keeps endings out). `plies` is the
 * fewest half-moves of the whole game, given who is to move.
 */
export function fewestMoves(key) {
  const [board, turn] = key.split(" ");
  const need = { w: 0, b: 0 }, left = { w: 0, b: 0 }, at = {};
  board.split("/").forEach((row, index) => {
    const rank = 8 - index;
    let file = 0;
    for (const c of row) {
      if (c >= "1" && c <= "8") { file += Number(c); continue; }
      const side = c < "a" ? "w" : "b", kind = c.toLowerCase(), square = "abcdefgh"[file] + rank;
      file++;
      left[side]++;
      if (kind === "p") {
        const advanced = side === "w" ? rank - 2 : 7 - rank;
        need[side] += advanced <= 0 ? 0 : advanced <= 2 ? 1 : advanced - 1;
        continue;
      }
      const home = side === "w" ? "1" : "8";
      const homes = { k: ["e"], q: ["d"], r: ["a", "h"], b: ["c", "f"], n: ["b", "g"] }[kind].map(f => f + home);
      if (!homes.includes(square)) need[side]++;
      if (kind === "k" || kind === "r") at[side + kind + square] = true;
    }
  });
  // King and rook where castling puts them: counted as two above, one move in fact.
  if ((at.wkg1 && at.wrf1) || (at.wkc1 && at.wrd1)) need.w--;
  if ((at.bkg8 && at.brf8) || (at.bkc8 && at.brd8)) need.b--;
  need.w = Math.max(need.w, 16 - left.b);
  need.b = Math.max(need.b, 16 - left.w);
  // White to move: both have made the same number of moves. Black to move: White one more.
  const plies = turn === "w" ? 2 * Math.max(need.w, need.b) : Math.max(2 * need.w - 1, 2 * need.b + 1);
  return { white: need.w, black: need.b, plies };
}
/** Can the position be from the first `moves` moves of a game (see fewestMoves)? */
const withinMoves = (key, moves) => fewestMoves(key).plies <= 2 * moves;

const pieceBand = count => (count <= 7 ? "2-7" : count <= 15 ? "8-15" : count <= 23 ? "16-23" : count <= 29 ? "24-29" : "30-32");

/**
 * One line of the dump -> the row to keep, or a reason (a string) why not.
 * A row is { key, depth, knodes, cp, mate, pv }: cp and mate from White's
 * side as Lichess gives them, pv with castling as a king move.
 */
export function extractLine(line, minDepth, pvPlies) {
  // Cheap look before parsing: most of the dump is far below the depth asked for.
  let deepest = 0;
  for (const match of line.matchAll(/"depth":\s*(\d+)/g)) deepest = Math.max(deepest, Number(match[1]));
  if (deepest < minDepth) return "shallow";
  let record;
  try { record = JSON.parse(line); } catch (error) { return "unreadable"; }
  if (!record || typeof record.fen !== "string" || !Array.isArray(record.evals)) return "unreadable";
  // "If you only want one PV, we recommend selecting the evaluation with the
  // highest depth, and use its first PV."
  let best = null;
  for (const evaluation of record.evals) {
    if (Number.isInteger(evaluation?.depth) && (!best || evaluation.depth > best.depth)) best = evaluation;
  }
  const first = best?.pvs?.[0];
  if (!best || best.depth < minDepth || !first || typeof first.line !== "string") return "shallow";
  const mate = Number.isInteger(first.mate) ? first.mate : null;
  const cp = mate === null && Number.isInteger(first.cp) ? first.cp : null;
  if (mate === null && cp === null) return "no score";
  let position;
  try { position = parseFen(record.fen); } catch (error) { return "not a position this site can show"; }
  if (!legalMoves(position).length) return "game over";
  // The dump writes castling as king-takes-rook; this gives the king move.
  const pv = sanitizeUciLine(position, first.line.trim().split(/\s+/), pvPlies);
  if (!pv.length) return "line does not fit the position";
  return {
    key: toFen(position).split(" ").slice(0, 4).join(" "),
    depth: best.depth,
    knodes: Number.isFinite(best.knodes) ? Math.round(best.knodes) : null,
    cp, mate,
    pv: pv.join(" "),
  };
}

function option(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

const ZSTD_FRAME = 0xFD2FB528, SKIPPABLE_FRAME = 0x184D2A50;   // skippable frames are 0x184D2A50 to 0x184D2A5F

/**
 * The unpacked contents of a .zst stream, piece by piece.
 *
 * Node's own zstd reader fails on a skippable frame and stops after the
 * first data frame, and the Lichess files consist of thousands of both: they
 * are packed in parallel ("pzstd"), which puts a small skippable frame with
 * the packed size of the next data frame in front of each one. So the frames
 * are taken apart here and every data frame is unpacked on its own.
 * `onRead` is told how many packed bytes have been used so far.
 */
async function* unpackZstd(raw, onRead = () => {}) {
  const chunks = raw[Symbol.asyncIterator]();
  const settings = { params: { [zlib.constants.ZSTD_d_windowLogMax]: 31 } };
  let pending = Buffer.alloc(0), used = 0, frameSize = null;
  // Makes sure `pending` holds at least `size` bytes; false if the input ends first.
  const need = async size => {
    const parts = [pending];
    let length = pending.length;
    while (length < size) {
      const { value, done } = await chunks.next();
      if (done) break;
      parts.push(value);
      length += value.length;
    }
    if (parts.length > 1) pending = Buffer.concat(parts, length);
    return length >= size;
  };
  const take = size => {
    const part = pending.subarray(0, size);
    pending = pending.subarray(size);
    onRead(used += size);
    return part;
  };
  const incomplete = () => new Error("The file ends in the middle of a frame: the download is not complete.");
  while (await need(1)) {
    if (!await need(4)) throw incomplete();
    const magic = pending.readUInt32LE(0);
    if ((magic & 0xFFFFFFF0) >>> 0 === SKIPPABLE_FRAME) {
      if (!await need(8)) throw incomplete();
      const size = pending.readUInt32LE(4);
      if (!await need(8 + size)) throw incomplete();
      const note = take(8 + size).subarray(8);
      frameSize = size === 4 ? note.readUInt32LE(0) : null;
    } else if (magic === ZSTD_FRAME && frameSize) {
      if (!await need(frameSize)) throw incomplete();
      yield zlib.zstdDecompressSync(take(frameSize), settings);
      frameSize = null;
    } else if (magic === ZSTD_FRAME) {
      // No size note: a file packed in one piece, which Node reads by itself.
      const rest = Readable.from((async function* () {
        yield pending;
        for (;;) {
          const { value, done } = await chunks.next();
          if (done) return;
          yield value;
        }
      })());
      const unpacked = zlib.createZstdDecompress(settings);
      rest.on("error", error => unpacked.destroy(error));
      yield* rest.pipe(unpacked);
      return;
    } else {
      throw new Error("This is not a zstd file, or it is damaged.");
    }
  }
}

/** Where the dump comes from -> { pieces: its unpacked contents, size: packed bytes if known, read(): packed bytes used }. */
async function openDump(source) {
  let raw, size = null, used = 0;
  if (source === "-") raw = process.stdin;
  else if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Could not download ${source}: status ${response.status}`);
    size = Number(response.headers.get("content-length")) || null;
    raw = Readable.fromWeb(response.body);
  } else {
    if (!existsSync(source)) throw new Error(`There is no file ${source}`);
    size = statSync(source).size;
    raw = createReadStream(source, { highWaterMark: 4 << 20 });
  }
  if (!/\.zst(\?.*)?$/.test(source)) {
    const counted = (async function* () { for await (const chunk of raw) { used += chunk.length; yield chunk; } })();
    return { pieces: counted, size, read: () => used, close: () => raw.destroy() };
  }
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error("This Node.js cannot read .zst files (it needs 22.15 or newer). Either update Node.js, or unpack with the zstd tool:\n"
      + "  zstd -dc lichess_db_eval.jsonl.zst | node scripts/lichess_db.mjs extract -");
  }
  return { pieces: unpackZstd(raw, total => { used = total; }), size, read: () => used, close: () => raw.destroy() };
}

/** Pieces of text -> arrays of whole lines (a line can be split across two pieces). */
async function* lineBatches(pieces) {
  let rest = "";
  for await (const piece of pieces) {
    const text = rest + piece.toString("latin1");   // the dump is plain ASCII
    const end = text.lastIndexOf("\n");
    if (end < 0) { rest = text; continue; }
    rest = text.slice(end + 1);
    yield text.slice(0, end).split("\n");
  }
  if (rest) yield [rest];
}

/**
 * Reads the dump and writes the positions that are deep enough to `out`.
 * `limit` stops after that many positions have been read (to try it out).
 */
export async function extract(source, { minDepth = 46, pvPlies = 16, out = "lichess_db.jsonl", limit = Infinity, log = console.error } = {}) {
  const dump = await openDump(source);
  // Written under another name until it is complete, so that a run which
  // was interrupted does not leave something that looks like a result.
  const output = createWriteStream(`${out}.part`);
  const skipped = {}, depths = {}, pieces = {};
  let lines = 0, kept = 0, mates = 0, bytes = 0, nextReport = 5000000;
  const started = Date.now();
  try {
    reading: for await (const batch of lineBatches(dump.pieces)) {
      for (const line of batch) {
        if (!line) continue;
        if (lines >= limit) break reading;
        lines++;
        const row = extractLine(line, minDepth, pvPlies);
        if (typeof row === "string") { skipped[row] = (skipped[row] || 0) + 1; continue; }
        kept++;
        bytes += row.key.length + row.pv.length + 24;
        const band = row.depth >= 70 ? "70+" : `${Math.floor(row.depth / 10) * 10}-${Math.floor(row.depth / 10) * 10 + 9}`;
        depths[band] = (depths[band] || 0) + 1;
        // Most deep evaluations are of positions where depth costs nothing:
        // forced mates and endings with a handful of pieces. Count them apart.
        const board = pieces[pieceBand(pieceCount(row.key))] ||= { all: 0, scored: 0 };
        board.all++;
        if (row.mate === null) board.scored++; else mates++;
        if (!output.write(JSON.stringify(row) + "\n")) await new Promise(resolve => output.once("drain", resolve));
      }
      if (lines >= nextReport) {
        nextReport += 5000000;
        const share = dump.size ? `, ${(dump.read() / dump.size * 100).toFixed(1)}% of the file` : "";
        log(`  ${(lines / 1e6).toFixed(0)} million positions read${share}, ${kept} kept (${Math.round((Date.now() - started) / 1000)} s)`);
      }
    }
  } finally {
    dump.close();
    await new Promise(resolve => output.end(resolve));
  }
  renameSync(`${out}.part`, out);
  return { lines, kept, mates, skipped, depths, pieces, megabytes: Math.ceil(bytes / 1e6), out, share: dump.size ? dump.read() / dump.size : null };
}

const sqlText = value => `'${value}'`;
const sqlNumber = value => (value === null ? "NULL" : String(value));

export async function writeSql({ input = "lichess_db.jsonl", outDir = "lichess_db_sql", rowsPerFile = 50000, minPieces = 0, minDepth = 0, mates = true, maxMoves = Infinity } = {}) {
  if (!existsSync(input)) throw new Error(`There is no file ${input}. Run "extract" first.`);
  mkdirSync(outDir, { recursive: true });
  const files = [];
  let statement = [], fileRows = 0, total = 0, leftOut = 0, stream = null;
  const flush = () => {
    if (!statement.length) return;
    stream.write("INSERT INTO lichess_db (position_key, depth, knodes, cp, mate, pv) VALUES\n" + statement.join(",\n")
      + "\nON CONFLICT(position_key) DO UPDATE SET depth = excluded.depth, knodes = excluded.knodes, cp = excluded.cp, mate = excluded.mate, pv = excluded.pv"
      + "\nWHERE excluded.depth > lichess_db.depth;\n");
    statement = [];
  };
  const close = () => new Promise(resolve => { flush(); stream.end(resolve); });
  for await (const line of createInterface({ input: createReadStream(input), crlfDelay: Infinity })) {
    if (!line) continue;
    const row = JSON.parse(line);
    // Nothing but what a position key and a list of moves are made of goes into the SQL text.
    if (!/^[pnbrqkPNBRQK1-8/]+ [wb] (-|[KQkq]+) (-|[a-h][36])$/.test(row.key) || !/^[a-h1-8qrbn ]+$/.test(row.pv)
      || ![row.depth, row.knodes, row.cp, row.mate].every(value => value === null || Number.isInteger(value))) {
      throw new Error(`Unexpected content in ${input}: ${line.slice(0, 200)}`);
    }
    if (row.depth < minDepth || (!mates && row.mate !== null) || pieceCount(row.key) < minPieces
      || (maxMoves !== Infinity && !withinMoves(row.key, maxMoves))) { leftOut++; continue; }
    if (!stream || fileRows >= rowsPerFile) {
      if (stream) await close();
      const name = join(outDir, `lichess_db_${String(files.length + 1).padStart(4, "0")}.sql`);
      files.push(name);
      stream = createWriteStream(name);
      fileRows = 0;
    }
    statement.push(`(${sqlText(row.key)},${row.depth},${sqlNumber(row.knodes)},${sqlNumber(row.cp)},${sqlNumber(row.mate)},${sqlText(row.pv)})`);
    fileRows++; total++;
    if (statement.length >= ROWS_PER_STATEMENT) flush();
  }
  if (stream) await close();
  return { files, total, leftOut };
}

/**
 * How many extracted positions the options keep (as "sql" would), and how
 * the number goes on: by the first N moves they can be from, and by the
 * least number of pieces on the board.
 */
export async function count({ input = "lichess_db.jsonl", minPieces = 0, minDepth = 0, mates = true, maxMoves = Infinity } = {}) {
  if (!existsSync(input)) throw new Error(`There is no file ${input}. Run "extract" first.`);
  const byMoves = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30].filter(moves => moves <= maxMoves).map(moves => ({ moves, all: 0, scored: 0 }));
  const byPieces = [32, 31, 30, 29, 28, 26, 24, 20, 16].filter(pieces => pieces > minPieces).map(pieces => ({ pieces, all: 0, scored: 0 }));
  let total = 0, scored = 0;
  for await (const line of createInterface({ input: createReadStream(input), crlfDelay: Infinity })) {
    if (!line) continue;
    const row = JSON.parse(line), pieces = pieceCount(row.key);
    if (row.depth < minDepth || (!mates && row.mate !== null) || pieces < minPieces) continue;
    const moves = Math.ceil(fewestMoves(row.key).plies / 2);
    if (moves > maxMoves) continue;
    const isScored = row.mate === null;
    total++;
    if (isScored) scored++;
    for (const step of byMoves) if (moves <= step.moves) { step.all++; if (isScored) step.scored++; }
    for (const step of byPieces) if (pieces >= step.pieces) { step.all++; if (isScored) step.scored++; }
  }
  return { total, scored, byMoves, byPieces };
}

/** The options "sql" and "count" share, read from the command line. */
function selection(args) {
  const minPieces = Number(option(args, "min-pieces", 0)), minDepth = Number(option(args, "min-depth", 0));
  if (!Number.isInteger(minPieces) || !Number.isInteger(minDepth)) throw new Error("--min-pieces and --min-depth must be whole numbers");
  const maxMoves = option(args, "max-moves") === undefined ? Infinity : Number(option(args, "max-moves"));
  if (maxMoves !== Infinity && !(Number.isInteger(maxMoves) && maxMoves >= 0)) throw new Error("--max-moves must be a whole number");
  const mates = !args.includes("--no-mates");
  const words = [
    maxMoves !== Infinity ? `can be from the first ${maxMoves} moves` : "",
    minPieces ? `have at least ${minPieces} pieces` : "", minDepth ? `reach depth ${minDepth}` : "", mates ? "" : "are not forced mates",
  ].filter(Boolean).join(", ");
  return { minPieces, minDepth, maxMoves, mates, words };
}

async function main(args) {
  const command = args[0];
  if (command === "extract") {
    const source = args[1];
    if (!source || source.startsWith("--")) throw new Error("Name the dump: a .zst or .jsonl file, an https address, or - for standard input.");
    const minDepth = Number(option(args, "min-depth", 46)), pvPlies = Number(option(args, "pv-plies", 16));
    if (!Number.isInteger(minDepth) || minDepth < 1 || !Number.isInteger(pvPlies) || pvPlies < 1) throw new Error("--min-depth and --pv-plies must be whole numbers");
    const limit = option(args, "limit") === undefined ? Infinity : Number(option(args, "limit"));
    if (!(limit >= 1)) throw new Error("--limit must be a number of positions");
    console.error(`Reading ${source} for evaluations of depth ${minDepth} or more ...`);
    const result = await extract(source, { minDepth, pvPlies, limit, out: option(args, "out", "lichess_db.jsonl") });
    console.log(`${result.lines} positions read, ${result.kept} kept in ${result.out}.`);
    if (result.lines >= limit) {
      const whole = result.share ? ` That was ${(result.share * 100).toFixed(2)}% of the file; at this rate the whole file would give about ${Math.round(result.kept / result.share).toLocaleString("en-US")}.` : "";
      console.log(`Stopped at the limit of ${limit} positions.${whole}`);
    }
    console.log(`By depth: ${Object.entries(result.depths).sort().map(([band, count]) => `${band}: ${count}`).join(", ") || "none"}`);
    const bands = ["2-7", "8-15", "16-23", "24-29", "30-32"].filter(band => result.pieces[band]);
    console.log(`Forced mates among them: ${result.mates}.`);
    console.log(`By pieces on the board (in brackets: without forced mates): ${bands.map(band => `${band}: ${result.pieces[band].all} (${result.pieces[band].scored})`).join(", ") || "none"}`);
    const skipped = Object.entries(result.skipped).filter(([reason]) => reason !== "shallow");
    if (skipped.length) console.log(`Left out although deep enough: ${skipped.map(([reason, count]) => `${count} (${reason})`).join(", ")}`);
    console.log(`In the database they will take roughly ${result.megabytes} MB and ${result.kept} row writes.`);
    console.log("Cloudflare D1 allows 500 MB per database and 100,000 row writes a day on the free plan (10 GB and 50 million a month on the paid one).");
  } else if (command === "sql") {
    const rowsPerFile = Number(option(args, "rows-per-file", 50000));
    if (!Number.isInteger(rowsPerFile) || rowsPerFile < 1) throw new Error("--rows-per-file must be a whole number");
    const { words, ...chosen } = selection(args);
    const result = await writeSql({ input: option(args, "in", "lichess_db.jsonl"), outDir: option(args, "out-dir", "lichess_db_sql"), rowsPerFile, ...chosen });
    console.log(`${result.total} rows written to ${result.files.length} file(s) in ${option(args, "out-dir", "lichess_db_sql")}${result.leftOut ? `; ${result.leftOut} left out by the options` : ""}.`);
    if (result.files.length) console.log(`Run each on the real database with, for example:\n  npx wrangler d1 execute mychessdb --remote --file=${result.files[0]}`);
  } else if (command === "count") {
    const input = option(args, "in", "lichess_db.jsonl");
    const { words, ...chosen } = selection(args);
    const result = await count({ input, ...chosen });
    const column = value => String(value).padStart(12);
    console.log(`${result.total} positions in ${input}${words ? ` that ${words}` : ""}, ${result.scored} of them not forced mates.`);
    if (chosen.maxMoves === Infinity) {
      console.log("Of these, positions that can be from the first N moves (what adding --max-moves N keeps):");
      console.log(`${"N".padStart(4)}${column("positions")}${column("not mates")}`);
      for (const step of result.byMoves) console.log(`${String(step.moves).padStart(4)}${column(step.all)}${column(step.scored)}`);
    } else if (result.byPieces.length) {
      console.log(`Of these, positions with at least P pieces on the board (what ${chosen.minPieces ? "raising --min-pieces to" : "adding --min-pieces"} P keeps):`);
      console.log(`${"P".padStart(4)}${column("positions")}${column("not mates")}`);
      for (const step of result.byPieces) console.log(`${String(step.pieces).padStart(4)}${column(step.all)}${column(step.scored)}`);
    }
  } else if (command === "load-dev") {
    const { LocalD1 } = await import("./d1_local.mjs");
    const root = fileURLToPath(new URL("..", import.meta.url));
    const directory = option(args, "dir", "lichess_db_sql");
    mkdirSync(join(root, ".dev"), { recursive: true });
    const database = new LocalD1(join(root, ".dev", "mychessdb.sqlite")).migrate(join(root, "migrations"));
    const files = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".sql")).sort() : [];
    if (!files.length) throw new Error(`There are no .sql files in ${directory}. Run "sql" first.`);
    for (const name of files) database.db.exec(readFileSync(join(directory, name), "utf8"));
    console.log(`${files.length} file(s) loaded; the development database now has ${database.db.prepare("SELECT COUNT(*) AS n FROM lichess_db").get().n} Lichess database rows.`);
  } else {
    // No command, or an unknown one: print the notes at the top of this file.
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    console.log(source.slice(0, source.findIndex(line => !line.startsWith("//"))).map(line => line.slice(3)).join("\n"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

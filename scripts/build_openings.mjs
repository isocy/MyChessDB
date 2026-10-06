// Convert the Lichess opening catalog (openings/*.tsv, CC0) into the compact
// lookup table the site loads: web/openings.json.
//
//   node scripts/build_openings.mjs
//
// Each key is the position an opening line ends in (see positionKey() in
// web/chesslib.js); each value is [ECO code, opening name]. When two lines
// reach the same position the first one in the catalog wins, as before.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { START_FEN, replaySan } from "../web/chesslib.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const index = {};
let lines = 0;
for (const volume of "abcde") {
  const path = `${root}openings/${volume}.tsv`;
  if (!existsSync(path)) throw new Error(`Missing ${path}`);
  const rows = readFileSync(path, "utf8").split(/\r?\n/);
  rows.slice(1).forEach((row, rowIndex) => {
    if (!row.trim()) return;
    const fields = row.split("\t");
    if (fields.length !== 3) throw new Error(`Malformed opening entry at ${path}:${rowIndex + 2}`);
    const [eco, name, pgn] = fields;
    const moves = pgn.trim().split(/\s+/).filter(token => !/^\d+\.+$/.test(token));
    const replay = replaySan(START_FEN, moves);
    if (!replay.complete || !moves.length) throw new Error(`Invalid opening moves at ${path}:${rowIndex + 2}: ${pgn}`);
    const key = replay.keys[replay.keys.length - 1];
    if (!(key in index)) index[key] = [eco, name];
    lines++;
  });
}
writeFileSync(`${root}web/openings.json`, JSON.stringify(index));
console.log(`openings.json: ${Object.keys(index).length} positions from ${lines} catalog lines`);

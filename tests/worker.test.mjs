// Run: node tests/worker.test.mjs
// Exercises worker/index.js against a local SQLite stand-in for D1 and a
// fake Lichess, covering every write rule.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { LocalD1 } from "../scripts/d1_local.mjs";

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const ADMIN = "test-admin-token-0123456789";
const SITE = "https://chess.example";
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E4_EP_ALWAYS = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const ITALIAN = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
const MATED = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";

let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (value, message) => { assert.ok(value, message); checks++; };

// --- fake Lichess -------------------------------------------------------
let lichess = () => new Response("not found", { status: 404 });
let lichessCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("http://lichess.test/")) { lichessCalls.push(url); return lichess(url, init); }
  return realFetch(input, init);
};
const lichessJson = body => () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

function makeEnv(extra = {}) {
  return {
    DB: new LocalD1().migrate(MIGRATIONS),
    ASSETS: { fetch: async () => new Response("<html>static</html>", { status: 200 }) },
    ADMIN_TOKEN: ADMIN,
    LICHESS_API_BASE: "http://lichess.test",
    ...extra,
  };
}

async function call(env, method, path, { body, key, ip = "203.0.113.5", origin = SITE, type = "application/json" } = {}) {
  const headers = { "CF-Connecting-IP": ip };
  if (key) headers["X-Key"] = key;
  if (method === "POST") { if (origin) headers.Origin = origin; if (type) headers["Content-Type"] = type; }
  const response = await worker.fetch(new Request(SITE + path, {
    method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }), env);
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch (error) { data = text; }
  return { status: response.status, data, headers: response.headers };
}

const sf = (fen, depth, pv = ["e2e4", "e7e5", "g1f3"], evaluation = "+0.32") =>
  ({ fen, source: "stockfish", depth, pv, evaluation });
const history = env => env.DB.db.prepare("SELECT position_key, depth, verified, reason FROM saved_history ORDER BY id").all();
// Everything saved from the site, straight from the table, in the shape the API gives entries.
const list = env => env.DB.db.prepare("SELECT * FROM saved_positions ORDER BY saved_at, position_key, source").all().map(row => ({
  fen: row.fen, move_uci: row.move_uci, pv: row.pv.split(" "), evaluation: row.evaluation, depth: row.depth,
  knodes: row.knodes, source: row.source, verified: row.verified === 1, saved_at: row.saved_at,
}));
// What the page is given for one position: { stockfish?, lichess? }.
const at = async (env, fen) => (await call(env, "GET", "/api/position?fen=" + encodeURIComponent(fen))).data.entries;

// --- session ------------------------------------------------------------
{
  const env = makeEnv();
  eq((await call(env, "GET", "/api/session")).data, { role: null, label: null, min_depth: 21, full_depth: 46, admin_configured: true });
  eq((await call(env, "GET", "/api/session", { key: ADMIN })).data.role, "admin");
  eq((await call(env, "GET", "/api/session", { key: "wrong" })).data.role, null);
  eq((await call(makeEnv({ ADMIN_TOKEN: "short" }), "GET", "/api/session", { key: "short" })).data,
    { role: null, label: null, min_depth: 21, full_depth: 46, admin_configured: false }, "a short admin token is refused");
  const custom = (await call(makeEnv({ MIN_DEPTH: "12", FULL_DEPTH: "30" }), "GET", "/api/session")).data;
  eq([custom.min_depth, custom.full_depth], [12, 30]);
  eq((await call(env, "GET", "/index.html")).data, "<html>static</html>", "non-API paths go to static assets");
  eq((await call(env, "GET", "/api/nope")).status, 404);
  eq((await call(env, "GET", "/api/position?fen=" + encodeURIComponent(START))).data, { entries: {} }, "nothing saved yet");
  eq((await call(env, "GET", "/api/position?fen=nonsense")).status, 400);
  eq((await call(env, "GET", "/api/position")).status, 400);
  eq((await call(env, "GET", "/api/saved")).status, 404, "there is no list of everything any more");
}

// --- input validation ---------------------------------------------------
{
  const env = makeEnv();
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 0) })).status, 400, "depth 0 is not an analysis");
  eq((await call(env, "POST", "/api/saved", { body: sf(START, -3) })).status, 400);
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 46.5) })).status, 400);
  eq((await call(env, "POST", "/api/saved", { body: sf(START, "46") })).status, 400);
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 999) })).status, 400);
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 46, ["e2e5"]) })).status, 400, "illegal best move");
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 46, []) })).status, 400);
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 46, "e2e4") })).status, 400);
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 46, ["e2e4"], "<script>") })).status, 400, "bad evaluation");
  eq((await call(env, "POST", "/api/saved", { body: sf("nonsense", 46) })).status, 400, "bad FEN");
  eq((await call(env, "POST", "/api/saved", { body: sf(START + "\nquit", 46) })).status, 400);
  eq((await call(env, "POST", "/api/saved", { body: sf(MATED, 46, ["a2a3"]) })).status, 400, "game over");
  eq((await call(env, "POST", "/api/saved", { body: { fen: START, source: "other" } })).status, 400);
  eq((await call(env, "POST", "/api/saved", { body: "{not json" })).status, 400);
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 46), type: "text/plain" })).status, 415, "must be JSON");
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 46), origin: "https://evil.example" })).status, 403, "cross-site post");
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 46), key: "not-a-real-key" })).status, 401, "unknown key");
  eq((await call(env, "POST", "/api/saved", { body: { ...sf(START, 46), pv: Array(400).fill("e2e4") } })).status, 400);
  eq(await list(env), [], "nothing was stored by rejected requests");
  eq((await call(env, "POST", "/api/saved/extra", { body: {} })).status, 404);
  const put = await worker.fetch(new Request(SITE + "/api/saved", { method: "PUT" }), env);
  eq(put.status, 405);
}

// --- depth: nothing below 21 is saved; from there on, as far as it got ----
{
  const env = makeEnv();
  const contributor = (await call(env, "POST", "/api/keys", { body: { label: "Sora" }, key: ADMIN })).data.key;
  // Depth 20 is refused for everyone, the admin included.
  for (const key of [undefined, contributor, ADMIN]) {
    const r = await call(env, "POST", "/api/saved", { body: sf(START, 20), key });
    eq([r.status, r.data.code], [400, "DEPTH_TOO_LOW"], `depth 20, ${key === ADMIN ? "admin" : key ? "contributor" : "no key"}`);
    ok(/least is depth 21/.test(r.data.error), r.data.error);
  }
  eq(await list(env), [], "nothing was stored");
  // Depth 21 is the first that is kept, also from a visitor without a key.
  let r = await call(env, "POST", "/api/saved", { body: sf(START, 21, ["e2e4"]) });
  eq([r.status, r.data.saved, r.data.entry.depth, r.data.entry.verified], [200, true, 21, false]);
  r = await call(env, "POST", "/api/saved", { body: sf(START, 39, ["d2d4", "d7d5"]) });
  eq([r.data.saved, r.data.entry.depth, r.data.entry.move_uci], [true, 39, "d2d4"], "a deeper one replaces it");
  r = await call(env, "POST", "/api/saved", { body: sf(START, 25, ["c2c4"]) });
  eq([r.data.saved, r.data.entry.depth], [false, 39], "a shallower one does not");
  ok(/depth 39 is already saved/.test(r.data.reason), r.data.reason);
  r = await call(env, "POST", "/api/saved", { body: sf(START, 46, ["g1f3"]) });
  eq([r.data.saved, r.data.entry.depth], [true, 46]);
  eq(history(env).map(h => [h.depth, h.reason]), [[21, "replaced"], [39, "replaced"]], "the shallow ones are in the history");
  // The limit follows the setting.
  const lower = makeEnv({ MIN_DEPTH: "12" });
  eq((await call(lower, "POST", "/api/saved", { body: sf(START, 11) })).status, 400);
  eq((await call(lower, "POST", "/api/saved", { body: sf(START, 12) })).data.saved, true);
}

// --- the write rules ----------------------------------------------------
{
  const env = makeEnv();
  // anonymous, depth 46 -> stored unverified
  let r = await call(env, "POST", "/api/saved", { body: sf(START, 46) });
  eq([r.status, r.data.saved, r.data.entry.verified, r.data.entry.depth], [200, true, false, 46]);
  eq(r.data.entry.pv, ["e2e4", "e7e5", "g1f3"]);
  eq(r.data.entry.move_uci, "e2e4");
  // PV tail that stops making sense is cut, not stored
  r = await call(env, "POST", "/api/saved", { body: sf(AFTER_E4, 46, ["e7e5", "g1f3", "zzzz", "b8c6"]) });
  eq(r.data.entry.pv, ["e7e5", "g1f3"]);
  // same depth again -> kept
  r = await call(env, "POST", "/api/saved", { body: sf(START, 46, ["d2d4"]) });
  eq([r.status, r.data.saved, r.data.entry.move_uci], [200, false, "e2e4"]);
  ok(/depth 46 is already saved/.test(r.data.reason), r.data.reason);
  // deeper anonymous -> replaces, old one archived
  r = await call(env, "POST", "/api/saved", { body: sf(START, 47, ["d2d4", "d7d5"]) });
  eq([r.data.saved, r.data.entry.move_uci, r.data.entry.depth], [true, "d2d4", 47]);
  eq(history(env).map(h => [h.depth, h.verified, h.reason]), [[46, 0, "replaced"]]);
  // the en passant square written "always" is the same position
  r = await call(env, "POST", "/api/saved", { body: sf(AFTER_E4_EP_ALWAYS, 50, ["c7c5"]) });
  eq([r.data.saved, r.data.entry.fen], [true, AFTER_E4]);
  eq((await list(env)).length, 2, "still two positions");

  // contributor key
  eq((await call(env, "POST", "/api/keys", { body: { label: "Minsu" } })).status, 403, "only admin creates keys");
  eq((await call(env, "POST", "/api/keys", { body: { label: " " }, key: ADMIN })).status, 400);
  const created = (await call(env, "POST", "/api/keys", { body: { label: "Minsu" }, key: ADMIN })).data;
  ok(/^mck_[A-Za-z0-9_-]{32}$/.test(created.key), "key format");
  const stored = env.DB.db.prepare("SELECT key_hash FROM contributor_keys").all();
  ok(stored.length === 1 && !JSON.stringify(stored).includes(created.key), "only the hash is stored");
  eq((await call(env, "GET", "/api/session", { key: created.key })).data, { role: "contributor", label: "Minsu", min_depth: 21, full_depth: 46, admin_configured: true });

  // verified depth 46 replaces unverified depth 47
  r = await call(env, "POST", "/api/saved", { body: sf(START, 46, ["g1f3"]), key: created.key });
  eq([r.data.saved, r.data.entry.verified, r.data.entry.move_uci], [true, true, "g1f3"]);
  // a shallower verified analysis is accepted as a request but does not replace a deeper one
  r = await call(env, "POST", "/api/saved", { body: sf(START, 30, ["b1c3"]), key: created.key });
  eq([r.status, r.data.saved, r.data.entry.move_uci, r.data.entry.depth], [200, false, "g1f3", 46]);
  // anonymous "depth 99" can no longer replace it
  r = await call(env, "POST", "/api/saved", { body: sf(START, 99, ["a2a3"]) });
  eq([r.data.saved, r.data.entry.move_uci], [false, "g1f3"]);
  ok(/verified analysis is already saved/.test(r.data.reason), r.data.reason);
  // verified vs verified: only strictly deeper wins
  r = await call(env, "POST", "/api/saved", { body: sf(START, 46, ["c2c4"]), key: ADMIN });
  eq(r.data.saved, false);
  r = await call(env, "POST", "/api/saved", { body: sf(START, 48, ["c2c4"]), key: ADMIN });
  eq([r.data.saved, r.data.entry.move_uci], [true, "c2c4"]);
  r = await call(env, "POST", "/api/saved", { body: sf(ITALIAN, 21, ["e1g1"], "#-3"), key: ADMIN });
  eq([r.data.saved, r.data.entry.verified, r.data.entry.evaluation], [true, true, "#-3"]);
  eq(history(env).filter(h => h.position_key.startsWith("rnbqkbnr/pppppppp/8/8/8/8")).map(h => [h.depth, h.verified]),
    [[46, 0], [47, 0], [46, 1]], "every replaced entry is in history");

  // --- remove / history / restore ---
  const gone = { fen: START, source: "stockfish" };
  eq((await call(env, "POST", "/api/remove", { body: gone })).status, 403);
  eq((await call(env, "POST", "/api/remove", { body: gone, key: created.key })).status, 403, "contributors cannot remove");
  eq((await call(env, "GET", "/api/history?fen=" + encodeURIComponent(START))).status, 403);
  eq((await call(env, "POST", "/api/remove", { body: { fen: START }, key: ADMIN })).status, 400, "the engine must be named");
  eq((await call(env, "POST", "/api/remove", { body: { fen: START, source: "lichess" }, key: ADMIN })).data.removed, false, "no Lichess entry here");
  eq((await call(env, "POST", "/api/remove", { body: gone, key: ADMIN })).data, { removed: true, entries: {} });
  eq((await call(env, "POST", "/api/remove", { body: gone, key: ADMIN })).data, { removed: false, entries: {} });
  ok(!(await list(env)).some(e => e.fen === START), "removed from the list");
  let h = (await call(env, "GET", "/api/history?fen=" + encodeURIComponent(START), { key: ADMIN })).data.history;
  eq(h.map(x => [x.depth, x.reason, x.move_uci]), [[48, "removed", "c2c4"], [46, "replaced", "g1f3"], [47, "replaced", "d2d4"], [46, "replaced", "e2e4"]]);
  eq((await call(env, "POST", "/api/restore", { body: { id: h[0].id } })).status, 403);
  eq((await call(env, "POST", "/api/restore", { body: { id: 99999 }, key: ADMIN })).status, 404);
  r = await call(env, "POST", "/api/restore", { body: { id: h[0].id }, key: ADMIN });
  eq([r.data.restored, r.data.entry.move_uci, r.data.entry.depth], [true, "c2c4", 48]);
  ok((await list(env)).some(e => e.fen === START && e.depth === 48 && e.verified), "restored");
  // restoring over a live entry archives the live one first
  r = await call(env, "POST", "/api/restore", { body: { id: h[1].id }, key: ADMIN });
  eq(r.data.entry.move_uci, "g1f3");
  h = (await call(env, "GET", "/api/history?fen=" + encodeURIComponent(START), { key: ADMIN })).data.history;
  eq([h[0].reason, h[0].depth], ["restored-over", 48]);

  // --- revoke ---
  const keys = (await call(env, "GET", "/api/keys", { key: ADMIN })).data.keys;
  eq(keys.map(k => [k.label, k.revoked_at, k.entries]), [["Minsu", null, 1]]);
  eq((await call(env, "POST", "/api/keys/revoke", { body: { id: created.id, demote: true }, key: ADMIN })).data, { revoked: true, demoted: 1 });
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 60), key: created.key })).status, 401, "revoked key is refused");
  ok((await list(env)).some(e => e.fen === START && e.verified === false), "its entries were demoted");
  eq((await call(env, "POST", "/api/keys/revoke", { body: { id: created.id }, key: ADMIN })).data, { revoked: false, demoted: 0 });

  // --- export ---
  eq((await call(env, "GET", "/api/export")).status, 403);
  const backup = (await call(env, "GET", "/api/export", { key: ADMIN })).data;
  ok(backup.saved.length === 3 && backup.history.length >= 5 && backup.contributor_keys.length === 1, "export has everything");
  ok(Array.isArray(backup.saved[0].pv) && !JSON.stringify(backup).includes(ADMIN), "export is clean");
}

// --- Lichess entries are fetched by the server --------------------------
{
  const env = makeEnv();
  lichessCalls = [];
  lichess = lichessJson({ fen: ITALIAN, knodes: 123456, depth: 50, pvs: [
    { moves: "e1h1 g8f6 d2d3 d7d6 c2c3", cp: 25 }, { moves: "c2c3 g8f6", cp: 20 }] });
  // whatever the browser claims is ignored
  let r = await call(env, "POST", "/api/saved", { body: { fen: ITALIAN, source: "lichess", depth: 99, pv: ["a2a3"], evaluation: "+9.99" } });
  eq(r.status, 200);
  eq(r.data.entry, { fen: ITALIAN, move_uci: "e1g1", pv: ["e1g1", "g8f6", "d2d3", "d7d6", "c2c3"], evaluation: "+0.25",
    depth: 50, knodes: 123456, source: "lichess", verified: true, saved_at: r.data.entry.saved_at }, "castling normalised, server data used");
  ok(lichessCalls[0].endsWith("&multiPv=1") && lichessCalls[0].includes(encodeURIComponent(ITALIAN)), "asked Lichess for this position");

  // Any depth from 21 on is stored, with or without a key.
  lichess = lichessJson({ depth: 40, knodes: 10, pvs: [{ moves: "e2e4", cp: -31 }] });
  r = await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" } });
  eq([r.data.saved, r.data.entry.evaluation, r.data.entry.depth, r.data.entry.verified], [true, "-0.31", 40, true]);
  // Below depth 21 a Lichess evaluation is not stored, with a key either.
  lichess = lichessJson({ depth: 20, knodes: 10, pvs: [{ moves: "e7e5", cp: 15 }] });
  for (const key of [undefined, ADMIN]) {
    r = await call(env, "POST", "/api/saved", { body: { fen: AFTER_E4, source: "lichess" }, key });
    eq([r.status, r.data.code, r.data.depth], [409, "LICHESS_TOO_SHALLOW", 20]);
    ok(/nothing below depth 21 is saved/.test(r.data.error), r.data.error);
  }
  lichess = lichessJson({ depth: 21, knodes: 10, pvs: [{ moves: "e7e5", cp: 15 }] });
  r = await call(env, "POST", "/api/saved", { body: { fen: AFTER_E4, source: "lichess" } });
  eq([r.data.saved, r.data.entry.depth], [true, 21]);

  lichess = lichessJson({ depth: 60, knodes: 10, pvs: [{ moves: "e7e5", mate: -4 }] });
  r = await call(env, "POST", "/api/saved", { body: { fen: AFTER_E4, source: "lichess" } });
  eq(r.data.entry.evaluation, "#-4");

  lichess = () => new Response("", { status: 404 });
  r = await call(env, "POST", "/api/saved", { body: { fen: MATED.replace("Pq", "P1").replace(" w ", " w "), source: "lichess" } });
  eq([r.status, r.data.code], [404, "LICHESS_NOT_FOUND"]);
  lichess = () => new Response("", { status: 429, headers: { "Retry-After": "60" } });
  r = await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" } });
  eq([r.status, r.data.code, r.data.retry_after], [429, "LICHESS_RATE_LIMIT", 60]);
  lichess = () => new Response("oops", { status: 500 });
  eq((await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" } })).status, 502);
  lichess = () => new Response("<html>", { status: 200 });
  eq((await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" } })).status, 502);
  lichess = lichessJson({ depth: 70, pvs: [{ moves: "e7e5", cp: 1 }] });   // line does not fit START
  eq((await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" } })).status, 502);
  lichess = () => { throw new Error("network down"); };
  eq((await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" } })).status, 502);

}

// --- results are kept per engine -------------------------------------------
{
  const env = makeEnv();
  // A Stockfish 19 entry and a Lichess entry for the same position, side by side.
  await call(env, "POST", "/api/saved", { body: sf(START, 90) });
  lichess = lichessJson({ depth: 55, knodes: 5, pvs: [{ moves: "d2d4 d7d5", cp: 18 }] });
  let r = await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" } });
  eq([r.data.saved, r.data.entry.source, r.data.entry.depth], [true, "lichess", 55], "an unverified Stockfish entry does not stand in Lichess's way");
  eq(Object.keys(r.data.entries).sort(), ["lichess", "stockfish"], "the answer carries everything the position has");
  let both = await at(env, START);
  eq([both.stockfish.depth, both.stockfish.verified, both.stockfish.move_uci], [90, false, "e2e4"]);
  eq([both.lichess.depth, both.lichess.verified, both.lichess.move_uci, both.lichess.knodes], [55, true, "d2d4", 5]);
  eq(history(env), [], "neither replaced the other");
  // The verified Lichess entry does not stop a Stockfish analysis without a key ...
  r = await call(env, "POST", "/api/saved", { body: sf(START, 91, ["g1f3"]) });
  eq([r.data.saved, r.data.entry.depth, r.data.entry.source], [true, 91, "stockfish"]);
  // ... and within one engine the rules are as before.
  r = await call(env, "POST", "/api/saved", { body: sf(START, 56), key: ADMIN });
  eq([r.data.saved, r.data.entry.verified, r.data.entry.depth], [true, true, 56], "verified replaces unverified");
  lichess = lichessJson({ depth: 50, knodes: 5, pvs: [{ moves: "c2c4", cp: 18 }] });
  r = await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" } });
  eq([r.data.saved, r.data.entry.depth, r.data.entry.move_uci], [false, 55, "d2d4"]);
  ok(/A Lichess evaluation at depth 55 is already saved/.test(r.data.reason), r.data.reason);
  lichess = lichessJson({ depth: 60, knodes: 7, pvs: [{ moves: "c2c4", cp: 20 }] });
  r = await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" } });
  eq([r.data.saved, r.data.entry.depth, r.data.entry.move_uci], [true, 60, "c2c4"]);
  both = await at(env, START);
  eq([both.stockfish.depth, both.lichess.depth], [56, 60]);
  eq(env.DB.db.prepare("SELECT source, depth, reason FROM saved_history ORDER BY id").all().map(h => [h.source, h.depth, h.reason]),
    [["stockfish", 90, "replaced"], ["stockfish", 91, "replaced"], ["lichess", 55, "replaced"]], "history says which engine each archived entry is from");
  // Removing one engine's entry leaves the other; restoring puts it back in its own place.
  r = await call(env, "POST", "/api/remove", { body: { fen: START, source: "lichess" }, key: ADMIN });
  eq([r.data.removed, Object.keys(r.data.entries)], [true, ["stockfish"]]);
  const archived = (await call(env, "GET", "/api/history?fen=" + encodeURIComponent(START), { key: ADMIN })).data.history;
  eq([archived[0].source, archived[0].depth, archived[0].reason], ["lichess", 60, "removed"]);
  r = await call(env, "POST", "/api/restore", { body: { id: archived[0].id }, key: ADMIN });
  eq([r.data.restored, r.data.entries.lichess.depth, r.data.entries.stockfish.depth], [true, 60, 56]);
  r = await call(env, "POST", "/api/restore", { body: { id: archived.find(h => h.source === "stockfish" && h.depth === 91).id }, key: ADMIN });
  eq([r.data.entries.stockfish.depth, r.data.entries.lichess.depth], [91, 60], "restoring a Stockfish entry replaces only the Stockfish one");
  eq((await list(env)).length, 2);
}

// --- evaluations imported from the Lichess database -------------------------
{
  const env = makeEnv();
  const add = (fen, depth, knodes, cp, mate, pv) => env.DB.db.prepare("INSERT INTO lichess_db VALUES (?, ?, ?, ?, ?, ?)")
    .run(fen.split(" ").slice(0, 4).join(" "), depth, knodes, cp, mate, pv);
  add(START, 60, 999, 23, null, "e2e4 e7e5 g1f3");
  add(AFTER_E4, 48, 77, null, -3, "e7e5");
  // The page gets it as the position's Lichess entry.
  eq(await at(env, START), { lichess: {
    fen: START, move_uci: "e2e4", pv: ["e2e4", "e7e5", "g1f3"], evaluation: "+0.23", depth: 60, knodes: 999,
    source: "lichess", verified: true, saved_at: null, imported: true } });
  eq((await at(env, AFTER_E4_EP_ALWAYS)).lichess.evaluation, "#-3", "found whichever way the FEN is written");
  eq(await at(env, ITALIAN), {});
  // A Stockfish entry saved from the site stands beside it.
  await call(env, "POST", "/api/saved", { body: sf(START, 30) });
  eq(Object.keys(await at(env, START)).sort(), ["lichess", "stockfish"]);
  // A Lichess evaluation that is not deeper than the imported one is not stored.
  lichess = lichessJson({ depth: 60, knodes: 5, pvs: [{ moves: "d2d4", cp: 18 }] });
  let r = await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" } });
  eq([r.data.saved, r.data.entry.depth, r.data.entry.imported, r.data.entry.move_uci], [false, 60, true, "e2e4"]);
  ok(/Lichess database already gives depth 60/.test(r.data.reason), r.data.reason);
  eq((await list(env)).filter(e => e.source === "lichess"), []);
  // A deeper one is stored and shown in its place.
  lichess = lichessJson({ depth: 61, knodes: 5, pvs: [{ moves: "d2d4", cp: 18 }] });
  r = await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" } });
  eq([r.data.saved, r.data.entry.depth, r.data.entry.imported, r.data.entry.move_uci], [true, 61, undefined, "d2d4"]);
  eq((await at(env, START)).lichess.depth, 61);
  // Removing the saved one brings the imported one back; that one cannot be removed.
  r = await call(env, "POST", "/api/remove", { body: { fen: START, source: "lichess" }, key: ADMIN });
  eq([r.data.removed, r.data.entries.lichess.depth, r.data.entries.lichess.imported], [true, 60, true]);
  r = await call(env, "POST", "/api/remove", { body: { fen: START, source: "lichess" }, key: ADMIN });
  eq([r.data.removed, r.data.entries.lichess.depth], [false, 60]);
  // Imported evaluations are not part of the backup.
  const backup = (await call(env, "GET", "/api/export", { key: ADMIN })).data;
  eq(backup.saved.map(e => [e.source, e.depth]), [["stockfish", 30]]);
}

// --- anonymous write limit ----------------------------------------------
{
  const env = makeEnv({ ANON_WRITES_PER_HOUR: "3" });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await call(env, "POST", "/api/saved", { body: sf(START, 46 + i) })).status);
  eq(statuses, [200, 200, 200, 429, 429], "fourth anonymous save in an hour is refused");
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 0) })).status, 429, "rejected attempts count too");
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 60), ip: "198.51.100.9" })).status, 200, "another visitor is unaffected");
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 61), key: ADMIN })).status, 200, "keys are not limited");
  ok(!JSON.stringify(env.DB.db.prepare("SELECT * FROM rate_limits").all()).includes("203.0.113.5"), "raw IPs are not stored");
}
{
  // Live analysis has a share of the limit of its own; the rest stays free
  // for analyses run with the button.
  const env = makeEnv({ ANON_WRITES_PER_HOUR: "5", ANON_LIVE_WRITES_PER_HOUR: "2" });
  const live = depth => call(env, "POST", "/api/saved", { body: { ...sf(START, depth), live: true } });
  const statuses = [];
  for (let depth = 40; depth < 43; depth++) statuses.push((await live(depth)).status);
  eq(statuses, [200, 200, 429], "the third live save in an hour is refused");
  eq((await live(50)).data.code, "LIVE_WRITE_RATE_LIMIT");
  const r = await call(env, "POST", "/api/saved", { body: sf(START, 60) });
  eq([r.status, r.data.saved], [200, true], "a save from the button still goes through");
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 61) })).status, 200);
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 62) })).status, 200);
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 63) })).data.code, "WRITE_RATE_LIMIT", "the overall limit still holds");
  eq((await call(env, "POST", "/api/saved", { body: { ...sf(START, 70), live: true }, key: ADMIN })).status, 200, "keys are not limited");
  // Without a setting: 600 in all, 500 of them for live analysis.
  const defaults = makeEnv();
  let refused = null;
  for (let i = 0; i < 501 && !refused; i++) {
    const answer = await call(defaults, "POST", "/api/saved", { body: { ...sf(START, 21 + (i % 200)), live: true } });
    if (answer.status === 429) refused = i;
  }
  eq(refused, 500, "live analysis may save 500 times an hour by default");
  for (let i = 0; i < 100; i++) eq((await call(defaults, "POST", "/api/saved", { body: sf(START, 30) })).status, 200);
  eq((await call(defaults, "POST", "/api/saved", { body: sf(START, 30) })).data.code, "WRITE_RATE_LIMIT", "600 in all by default");
}

// --- a position and the ones a move away ---------------------------------
{
  const env = makeEnv();
  eq((await call(env, "POST", "/api/saved", { body: sf(AFTER_E4, 30, ["e7e5"], "+0.30"), key: ADMIN })).status, 200);
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 40), key: ADMIN })).status, 200);
  const r = await call(env, "GET", "/api/position?next=1&fen=" + encodeURIComponent(START));
  eq(r.data.entries.stockfish.depth, 40);
  eq(Object.keys(r.data.next).length, 20, "one entry for each legal move");
  eq(r.data.next["rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"].stockfish.depth, 30, "keyed the way the page keys positions");
  eq(Object.values(r.data.next).filter(entries => Object.keys(entries).length).length, 1, "the others have nothing");
  // More positions than one statement can look up: the 218-move position.
  const MANY = "R6R/3Q4/1Q4Q1/4Q3/2Q4Q/Q4Q2/pp1Q4/kBNN1KB1 w - - 0 1";
  const wide = await call(env, "GET", "/api/position?next=1&fen=" + encodeURIComponent(MANY));
  eq([wide.status, Object.keys(wide.data.next).length, wide.data.entries], [200, 218, {}]);
  eq((await call(env, "GET", "/api/position?next=1&fen=" + encodeURIComponent(MATED))).data, { entries: {}, next: {} }, "no moves, nothing next");
  eq((await call(env, "GET", "/api/position?next=1&fen=nonsense")).status, 400);
  // `also`: further positions in the same request (the moves before a loaded position).
  const also = (await call(env, "GET", `/api/position?fen=${encodeURIComponent(START)}&also=${encodeURIComponent(AFTER_E4)}&also=nonsense`)).data;
  eq(Object.keys(also).sort(), ["also", "entries"]);
  const e4Key = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";
  eq([also.entries.stockfish.depth, Object.keys(also.also), also.also[e4Key].stockfish.depth], [40, [e4Key], 30],
    "the positions named with also come too; one that is not a position is left out");
  const both = (await call(env, "GET", `/api/position?next=1&fen=${encodeURIComponent(START)}&also=${encodeURIComponent(MATED)}`)).data;
  eq([Object.keys(both.next).length, both.also["rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq -"]], [20, {}], "next and also together");
}

// --- import -------------------------------------------------------------
{
  const env = makeEnv();
  const entries = [
    { fen: START, pv: ["e2e4", "e7e5"], evaluation: "Lichess Cloud: +0.19", depth: 75, knodes: 695524, source: "lichess", saved_at: "2026-09-26T17:37:11.158Z" },
    { fen: AFTER_E4_EP_ALWAYS, pv: ["e7e5"], evaluation: "+0.21", depth: 46, source: "stockfish", saved_at: "2026-09-27T01:00:00Z" },
    { fen: "bad", pv: ["e2e4"], evaluation: "+0.1", depth: 46, source: "stockfish" },
    { fen: ITALIAN, pv: ["e1e3"], evaluation: "+0.1", depth: 46, source: "stockfish" },
  ];
  eq((await call(env, "POST", "/api/import", { body: { entries } })).status, 403);
  let r = await call(env, "POST", "/api/import", { body: { entries }, key: ADMIN });
  eq([r.data.stored, r.data.kept_existing, r.data.invalid.map(i => i.index)], [2, 0, [2, 3]]);
  const saved = await list(env);
  eq(saved.map(e => [e.fen, e.depth, e.verified, e.knodes, e.saved_at]).sort(), [
    [AFTER_E4, 46, true, null, "2026-09-27T01:00:00.000Z"],
    [START, 75, true, 695524, "2026-09-26T17:37:11.158Z"],
  ].sort());
  eq((await at(env, START)).lichess.evaluation, "+0.19", "an entry written the old way reads in the shared notation");
  // importing again changes nothing
  r = await call(env, "POST", "/api/import", { body: { entries: entries.slice(0, 2) }, key: ADMIN });
  eq([r.data.stored, r.data.kept_existing], [0, 2]);
  eq(history(env), []);
  // overwrite replaces and archives
  r = await call(env, "POST", "/api/import", { body: { entries: [{ ...entries[0], depth: 60 }], overwrite: true }, key: ADMIN });
  eq(r.data.stored, 1);
  eq(history(env).map(x => [x.depth, x.reason]), [[75, "replaced"]]);
  // A backup's unverified entries stay unverified, and cannot displace a verified one.
  r = await call(env, "POST", "/api/import", { body: { entries: [
    { fen: ITALIAN, pv: ["e1g1"], evaluation: "+0.30", depth: 46, source: "stockfish", verified: false },
    { fen: AFTER_E4, pv: ["c7c5"], evaluation: "+0.20", depth: 99, source: "stockfish", verified: false },
  ] }, key: ADMIN });
  eq([r.data.stored, r.data.kept_existing], [1, 1]);
  let after = await list(env);
  eq(after.find(e => e.fen === ITALIAN).verified, false, "imported as unverified");
  eq(after.find(e => e.fen === AFTER_E4).move_uci, "e7e5", "the verified entry was kept");
  // Entries are imported per engine: a Stockfish entry for a position that has a Lichess one is added beside it.
  r = await call(env, "POST", "/api/import", { body: { entries: [
    { fen: START, pv: ["d2d4"], evaluation: "+0.20", depth: 50, source: "stockfish" }] }, key: ADMIN });
  eq(r.data.stored, 1);
  after = await list(env);
  eq(after.filter(e => e.fen === START).map(e => [e.source, e.depth]).sort(), [["lichess", 60], ["stockfish", 50]]);
  // A backup is restored as it is, entries below depth 21 included.
  const shallow = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
  r = await call(env, "POST", "/api/import", { body: { entries: [{ fen: shallow, pv: ["f1b5"], evaluation: "+0.20", depth: 15, source: "stockfish" }] }, key: ADMIN });
  eq([r.data.stored, (await list(env)).find(e => e.fen === shallow).depth], [1, 15]);
  eq((await call(env, "POST", "/api/import", { body: { entries: Array(101).fill(entries[0]) }, key: ADMIN })).status, 400);
  eq((await call(env, "POST", "/api/import", { body: { entries: [] }, key: ADMIN })).status, 400);
}

// --- configuration problems are reported, not thrown --------------------
{
  const r = await worker.fetch(new Request(SITE + "/api/saved"), {});
  eq(r.status, 500);
  ok((await r.json()).error.includes("DB"), "missing binding is explained");
}

console.log(`worker: ${checks} checks passed`);

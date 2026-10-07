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
const list = async env => (await call(env, "GET", "/api/saved")).data.entries;

// --- session ------------------------------------------------------------
{
  const env = makeEnv();
  eq((await call(env, "GET", "/api/session")).data, { role: null, label: null, min_depth: 46, admin_configured: true });
  eq((await call(env, "GET", "/api/session", { key: ADMIN })).data.role, "admin");
  eq((await call(env, "GET", "/api/session", { key: "wrong" })).data.role, null);
  eq((await call(makeEnv({ ADMIN_TOKEN: "short" }), "GET", "/api/session", { key: "short" })).data,
    { role: null, label: null, min_depth: 46, admin_configured: false }, "a short admin token is refused");
  eq((await call(makeEnv({ MIN_DEPTH: "30" }), "GET", "/api/session")).data.min_depth, 30);
  eq((await call(env, "GET", "/index.html")).data, "<html>static</html>", "non-API paths go to static assets");
  eq((await call(env, "GET", "/api/nope")).status, 404);
  eq((await call(env, "GET", "/api/saved")).data, { entries: [] });
}

// --- input validation ---------------------------------------------------
{
  const env = makeEnv();
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 45) })).status, 400, "below minimum depth");
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 45) })).data.code, "DEPTH_TOO_LOW");
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
  eq((await call(env, "GET", "/api/session", { key: created.key })).data, { role: "contributor", label: "Minsu", min_depth: 46, admin_configured: true });

  // verified depth 46 replaces unverified depth 47
  r = await call(env, "POST", "/api/saved", { body: sf(START, 46, ["g1f3"]), key: created.key });
  eq([r.data.saved, r.data.entry.verified, r.data.entry.move_uci], [true, true, "g1f3"]);
  // a contributor is still held to the minimum depth
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 30), key: created.key })).status, 400);
  // anonymous "depth 99" can no longer replace it
  r = await call(env, "POST", "/api/saved", { body: sf(START, 99, ["a2a3"]) });
  eq([r.data.saved, r.data.entry.move_uci], [false, "g1f3"]);
  ok(/verified analysis is already saved/.test(r.data.reason), r.data.reason);
  // verified vs verified: only strictly deeper wins
  r = await call(env, "POST", "/api/saved", { body: sf(START, 46, ["c2c4"]), key: ADMIN });
  eq(r.data.saved, false);
  r = await call(env, "POST", "/api/saved", { body: sf(START, 48, ["c2c4"]), key: ADMIN });
  eq([r.data.saved, r.data.entry.move_uci], [true, "c2c4"]);
  // the admin may save below the minimum depth
  r = await call(env, "POST", "/api/saved", { body: sf(ITALIAN, 20, ["e1g1"], "#-3"), key: ADMIN });
  eq([r.data.saved, r.data.entry.verified, r.data.entry.evaluation], [true, true, "#-3"]);
  eq(history(env).filter(h => h.position_key.startsWith("rnbqkbnr/pppppppp/8/8/8/8")).map(h => [h.depth, h.verified]),
    [[46, 0], [47, 0], [46, 1]], "every replaced entry is in history");

  // --- remove / history / restore ---
  eq((await call(env, "POST", "/api/remove", { body: { fen: START } })).status, 403);
  eq((await call(env, "POST", "/api/remove", { body: { fen: START }, key: created.key })).status, 403, "contributors cannot remove");
  eq((await call(env, "GET", "/api/history?fen=" + encodeURIComponent(START))).status, 403);
  eq((await call(env, "POST", "/api/remove", { body: { fen: START }, key: ADMIN })).data, { removed: true });
  eq((await call(env, "POST", "/api/remove", { body: { fen: START }, key: ADMIN })).data, { removed: false });
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
  eq(r.data.entry, { fen: ITALIAN, move_uci: "e1g1", pv: ["e1g1", "g8f6", "d2d3", "d7d6", "c2c3"], evaluation: "Lichess Cloud: +0.25",
    depth: 50, knodes: 123456, source: "lichess", verified: true, saved_at: r.data.entry.saved_at }, "castling normalised, server data used");
  ok(lichessCalls[0].endsWith("&multiPv=1") && lichessCalls[0].includes(encodeURIComponent(ITALIAN)), "asked Lichess for this position");

  lichess = lichessJson({ depth: 40, knodes: 10, pvs: [{ moves: "e2e4", cp: -31 }] });
  r = await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" } });
  eq([r.status, r.data.code, r.data.depth], [409, "LICHESS_TOO_SHALLOW", 40]);
  r = await call(env, "POST", "/api/saved", { body: { fen: START, source: "lichess" }, key: ADMIN });
  eq([r.data.saved, r.data.entry.evaluation, r.data.entry.depth], [true, "Lichess Cloud: -0.31", 40], "admin may store shallower");

  lichess = lichessJson({ depth: 60, knodes: 10, pvs: [{ moves: "e7e5", mate: -4 }] });
  r = await call(env, "POST", "/api/saved", { body: { fen: AFTER_E4, source: "lichess" } });
  eq(r.data.entry.evaluation, "Lichess Cloud: mate -4");

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

  // Lichess (verified) replaces an anonymous Stockfish entry of any depth
  const env2 = makeEnv();
  await call(env2, "POST", "/api/saved", { body: sf(START, 90) });
  lichess = lichessJson({ depth: 55, knodes: 5, pvs: [{ moves: "e2e4 e7e5", cp: 18 }] });
  r = await call(env2, "POST", "/api/saved", { body: { fen: START, source: "lichess" } });
  eq([r.data.saved, r.data.entry.source, r.data.entry.depth], [true, "lichess", 55]);
  // and a deeper verified Stockfish entry then replaces Lichess
  r = await call(env2, "POST", "/api/saved", { body: sf(START, 56), key: ADMIN });
  eq([r.data.saved, r.data.entry.source, r.data.entry.knodes], [true, "stockfish", null]);
  // but a shallower Lichess entry does not replace that
  r = await call(env2, "POST", "/api/saved", { body: { fen: START, source: "lichess" } });
  eq(r.data.saved, false);
}

// --- anonymous write limit ----------------------------------------------
{
  const env = makeEnv({ ANON_WRITES_PER_HOUR: "3" });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await call(env, "POST", "/api/saved", { body: sf(START, 46 + i) })).status);
  eq(statuses, [200, 200, 200, 429, 429], "fourth anonymous save in an hour is refused");
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 45) })).status, 429, "rejected attempts count too");
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 60), ip: "198.51.100.9" })).status, 200, "another visitor is unaffected");
  eq((await call(env, "POST", "/api/saved", { body: sf(START, 61), key: ADMIN })).status, 200, "keys are not limited");
  ok(!JSON.stringify(env.DB.db.prepare("SELECT * FROM rate_limits").all()).includes("203.0.113.5"), "raw IPs are not stored");
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
    { fen: START, pv: ["d2d4"], evaluation: "+0.20", depth: 99, source: "stockfish", verified: false },
  ] }, key: ADMIN });
  eq([r.data.stored, r.data.kept_existing], [1, 1]);
  const after = await list(env);
  eq(after.find(e => e.fen === ITALIAN).verified, false, "imported as unverified");
  eq(after.find(e => e.fen === START).verified, true, "the verified entry was kept");
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

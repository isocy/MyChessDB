// My Chess DB API - Cloudflare Worker.
//
// Serves /api/* for the static site in ../web. Data lives in the D1 database
// bound as DB (schema: ../migrations). Secrets and settings:
//
//   ADMIN_TOKEN            secret, at least 16 characters. Whoever sends it in
//                          the X-Key header is the admin.
//   MIN_DEPTH              optional, default 21. Nothing shallower is saved,
//                          whoever asks, and the site does not let a
//                          shallower analysis depth be chosen. (Only the
//                          admin's import of a backup is not held to it.)
//   FULL_DEPTH             optional, default 46. The depth an analysis is
//                          expected to reach. The site shows moves found
//                          below this depth in a paler colour, and starts
//                          new analyses at it.
//   ANON_WRITES_PER_HOUR   optional, default 600. Save attempts allowed per
//                          hour for one visitor without a key.
//   ANON_LIVE_WRITES_PER_HOUR  optional, default 500. How many of those may
//                          come from the page's live analysis, which saves
//                          by itself; the rest stay free for analyses run
//                          with the analyse button.
//   LICHESS_API_BASE       optional, default https://lichess.org (tests point
//                          this at a local stand-in).
//   HEAVY_READS            optional rate limiting binding (wrangler.jsonc)
//                          for lookups of many positions at once; see
//                          heavyReadAllowed.
//
// Results are kept per engine ("source"): a position can have a Stockfish 19
// entry and a Lichess entry, and neither replaces the other. The page shows
// one engine's entries, or for each position the deeper of the two.
//
// Trust model (there are no user accounts):
//   * "lichess" entries: the server fetches the evaluation from Lichess
//     itself, so nothing the browser claims is stored. Always verified.
//   * "stockfish" entries sent with the admin token or a contributor key
//     are verified; without a key they are stored as unverified.
//   * Among the entries of one engine, a verified one is never replaced by
//     an unverified one, and within the same tier only a strictly deeper
//     analysis replaces the stored one.
//   * Nothing below MIN_DEPTH is saved. From there on, an analysis stopped
//     early is saved as far as it got, and a deeper one replaces it later.
//   * Whatever is replaced or removed is copied to saved_history first.
//   * Entries saved without a key carry the visitor's hashed network
//     ("anon:<id>"), so the admin can take back all of one visitor's
//     unverified entries at once (/api/purge).
//
// Besides what visitors save, the lichess_db table can hold evaluations
// taken over in bulk from the Lichess evaluation database
// (scripts/lichess_db.mjs). They are read-only reference data: a position's
// Lichess entry is the deeper of the saved one and the one in lichess_db.

import { parseFen, toFen, positionKey, legalMoves, makeMove, sanitizeUciLine } from "../web/chesslib.js";

const MAX_DEPTH = 245;
const MAX_PV_PLIES = 60;
const IMPORT_BATCH_LIMIT = 100;

const SOURCES = ["stockfish", "lichess"];

const COLUMNS = "position_key, fen, move_uci, pv, evaluation, depth, knodes, source, verified, saved_by, saved_at";

// Copies the stored row of the same engine to history when the incoming
// entry is allowed to replace it. Not when it is the same saver's own entry
// that a deeper one of theirs replaces (live analysis does that every 30
// seconds): that one is worth nothing to restore, since either the deeper one
// is better or, from someone who saves bad moves, everything of theirs goes
// at once (handlePurge). Imports are not one saver, so they are always kept.
// Binds: archived_at, reason, position_key, source, force, verified,
// verified, depth, saved_by.
const ARCHIVE_IF_REPLACEABLE = `
  INSERT INTO saved_history (${COLUMNS}, archived_at, reason)
  SELECT ${COLUMNS}, ?, ? FROM saved_positions
  WHERE position_key = ? AND source = ? AND (? = 1 OR ? > verified OR (? = verified AND ? > depth))
    AND NOT (saved_by = ? AND saved_by <> 'import')`;

// The history keeps at most this many unverified entries per position and
// engine, the newest; verified ones are always kept. More than this only
// comes from many visitors in turn saving ever deeper analyses of one
// position, and the admin's list shows the newest 50 anyway.
const HISTORY_PER_POSITION = 50;
// Binds: position_key, source, position_key, source.
const TRIM_HISTORY = `
  DELETE FROM saved_history
  WHERE position_key = ? AND source = ? AND verified = 0 AND id < (
    SELECT id FROM saved_history WHERE position_key = ? AND source = ? AND verified = 0
    ORDER BY id DESC LIMIT 1 OFFSET ${HISTORY_PER_POSITION - 1})`;

// Inserts, or replaces under the same rule. Binds: the 11 columns, force.
const UPSERT_IF_ALLOWED = `
  INSERT INTO saved_positions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(position_key, source) DO UPDATE SET
    fen = excluded.fen, move_uci = excluded.move_uci, pv = excluded.pv,
    evaluation = excluded.evaluation, depth = excluded.depth, knodes = excluded.knodes,
    verified = excluded.verified,
    saved_by = excluded.saved_by, saved_at = excluded.saved_at
  WHERE ? = 1 OR excluded.verified > saved_positions.verified
     OR (excluded.verified = saved_positions.verified AND excluded.depth > saved_positions.depth)
  RETURNING position_key`;

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", ...headers,
    },
  });
}

function intSetting(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const minDepth = env => intSetting(env.MIN_DEPTH, 21);
const fullDepth = env => intSetting(env.FULL_DEPTH, 46);

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function adminConfigured(env) {
  return typeof env.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN.length >= 16;
}

// The network a visitor writes from. An IPv6 user normally holds a whole /64
// and can pick any address in it, so IPv6 addresses count per /64; otherwise
// one visitor could get a fresh limit with every request.
function visitorNetwork(ip) {
  if (!ip.includes(":")) return ip;
  const lower = ip.toLowerCase();
  const last = lower.slice(lower.lastIndexOf(":") + 1);
  if (last.includes(".")) return last;   // IPv4-mapped (::ffff:192.0.2.1)
  const [head, tail] = lower.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// A salted hash of the visitor's network: the raw IP is never stored.
async function visitorId(request, env) {
  const network = visitorNetwork(request.headers.get("CF-Connecting-IP") || "unknown");
  return (await sha256Hex(`${env.ADMIN_TOKEN || "mychessdb"}|${network}`)).slice(0, 32);
}

// Adds one to a visitor's counter for this hour and returns the new count.
async function countThisHour(env, bucket, hour) {
  return (await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, hour, count) VALUES (?, ?, 1)
     ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count`,
  ).bind(bucket, hour).first()).count;
}

// Wrong keys allowed per hour from one network before keys from it are no
// longer checked at all, so the admin token cannot be guessed at speed.
const BAD_KEYS_PER_HOUR = 20;

/** Who is asking? { role: "admin" | "contributor" | null, ... } */
async function identify(request, env) {
  const key = (request.headers.get("X-Key") || "").trim();
  if (!key) return { role: null, sentKey: false };
  const hour = Math.floor(Date.now() / 3600000);
  const badKeys = `${await visitorId(request, env)}:badkey:${hour}`;
  const failures = await env.DB.prepare("SELECT count FROM rate_limits WHERE bucket = ?").bind(badKeys).first();
  if (failures && failures.count >= BAD_KEYS_PER_HOUR) {
    throw new HttpError(429, "Too many wrong keys from this network in the last hour. Try again later.", { code: "KEY_RATE_LIMIT" });
  }
  const who = await matchKey(env, key);
  if (!who.role) await countThisHour(env, badKeys, hour);
  return who;
}

async function matchKey(env, key) {
  if (key.length > 200) return { role: null, sentKey: true };
  const hash = await sha256Hex(key);
  // Comparing digests instead of the secrets keeps the comparison time
  // independent of how many leading characters match.
  if (adminConfigured(env) && hash === await sha256Hex(env.ADMIN_TOKEN)) {
    return { role: "admin", sentKey: true, savedBy: "admin" };
  }
  const row = await env.DB.prepare(
    "SELECT id, label FROM contributor_keys WHERE key_hash = ? AND revoked_at IS NULL",
  ).bind(hash).first();
  if (row) return { role: "contributor", sentKey: true, id: row.id, label: row.label, savedBy: `key:${row.id}` };
  return { role: null, sentKey: true };
}

async function requireAdmin(request, env) {
  const who = await identify(request, env);
  if (who.role !== "admin") throw new HttpError(403, "Admin only");
  return who;
}

async function readJson(request, maxBytes) {
  const type = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!type.startsWith("application/json")) throw new HttpError(415, "Send JSON (Content-Type: application/json)");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request is too large");
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== "object") throw new Error("not an object");
    return body;
  } catch (error) {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

function publicEntry(row) {
  return {
    fen: row.fen,
    move_uci: row.move_uci,
    pv: row.pv.split(" "),
    evaluation: plainEvaluation(row.evaluation),
    depth: row.depth,
    knodes: row.knodes,
    source: row.source,
    verified: row.verified === 1,
    saved_at: row.saved_at,
  };
}

// How a Lichess score is written in an entry, the same way as a Stockfish
// one: "+0.25" in pawns or "#-4" for a forced mate, always from White's side.
function lichessEvaluation(cp, mate) {
  if (Number.isInteger(mate)) return `#${mate}`;
  return `${cp >= 0 ? "+" : "-"}${(Math.abs(cp) / 100).toFixed(2)}`;
}

// Lichess entries saved before the two engines shared one notation read
// "Lichess Cloud: +0.25" or "Lichess Cloud: mate -4"; they are shown in the
// shared one.
function plainEvaluation(text) {
  const old = /^Lichess Cloud: (?:mate (-?\d+)|([+-]\d+\.\d+))$/.exec(text || "");
  if (!old) return text;
  return old[1] !== undefined ? `#${old[1]}` : old[2];
}

// A row of lichess_db in the shape of an entry. `imported` tells the page
// that it is reference data, not something saved from the site.
function importedEntry(row) {
  const pv = row.pv.split(" ");
  return {
    fen: `${row.position_key} 0 1`,
    move_uci: pv[0],
    pv,
    evaluation: lichessEvaluation(row.cp, row.mate),
    depth: row.depth,
    knodes: row.knodes,
    source: "lichess",
    verified: true,
    saved_at: null,
    imported: true,
  };
}

/**
 * What is stored for one position, by engine: { stockfish?, lichess? }.
 * The Lichess entry is the deeper of the one saved from the site and the one
 * in the imported Lichess database.
 */
async function positionEntries(env, key) {
  return (await entriesFor(env, [key])).get(key);
}

// D1 takes at most 100 bound values in one statement.
const KEYS_PER_STATEMENT = 90;

/** positionEntries for several positions at once: a Map from key to entries. */
async function entriesFor(env, keys) {
  const unique = [...new Set(keys)];
  const statements = [];
  for (let at = 0; at < unique.length; at += KEYS_PER_STATEMENT) {
    const chunk = unique.slice(at, at + KEYS_PER_STATEMENT);
    const marks = chunk.map(() => "?").join(", ");
    statements.push(
      env.DB.prepare(`SELECT ${COLUMNS} FROM saved_positions WHERE position_key IN (${marks})`).bind(...chunk),
      env.DB.prepare(`SELECT position_key, depth, knodes, cp, mate, pv FROM lichess_db WHERE position_key IN (${marks})`).bind(...chunk),
    );
  }
  const results = statements.length ? await env.DB.batch(statements) : [];
  const found = new Map(unique.map(key => [key, {}]));
  const imported = [];
  results.forEach((result, index) => {
    for (const row of result.results || []) {
      if (index % 2 === 0) found.get(row.position_key)[row.source] = publicEntry(row);
      else imported.push(row);
    }
  });
  for (const row of imported) {
    const entries = found.get(row.position_key);
    if (!(entries.lichess && entries.lichess.depth >= row.depth)) entries.lichess = importedEntry(row);
  }
  return found;
}

function parsePosition(fen) {
  try {
    const position = parseFen(fen);
    const normalized = toFen(position);
    return { position, fen: normalized, key: normalized.split(" ").slice(0, 4).join(" ") };
  } catch (error) {
    throw new HttpError(400, `Invalid position: ${error.message}`);
  }
}

// Counts a save attempt by a visitor without a key against the hourly
// limits. Saves from the live analysis (`live`) are also counted on their
// own and have a lower limit, so that live analysis cannot use up the hour
// and leave nothing for an analysis that was run on purpose. Returns the
// visitor's id, which the saved entry carries (see handlePurge).
async function countAnonymousWrite(request, env, live) {
  const limit = intSetting(env.ANON_WRITES_PER_HOUR, 600);
  const liveLimit = Math.min(limit, intSetting(env.ANON_LIVE_WRITES_PER_HOUR, 500));
  const hour = Math.floor(Date.now() / 3600000);
  const visitor = await visitorId(request, env);
  const count = bucket => countThisHour(env, bucket, hour);
  if (live && await count(`${visitor}:live:${hour}`) > liveLimit) {
    throw new HttpError(429, `Live analysis has saved ${liveLimit} times from this network in the last hour, its share of the limit. `
      + "It goes on analysing without saving until the next hour; analyses run with the button can still be saved.",
      { code: "LIVE_WRITE_RATE_LIMIT" });
  }
  const total = await count(`${visitor}:${hour}`);
  if (total === 1) {
    await env.DB.prepare("DELETE FROM rate_limits WHERE hour < ?").bind(hour - 1).run();
  }
  if (total > limit) {
    throw new HttpError(429, `Too many saves from this network in the last hour (limit ${limit}). Try again later.`,
      { code: "WRITE_RATE_LIMIT" });
  }
  return visitor;
}

// ------------------------------------------------------------- Lichess -----

// multiPv=1: Lichess answers with its deepest evaluation that has at least
// the number of lines asked for, and the deepest ones are mostly single-line.
// (The page asks the same way, so both see the same evaluation.)
async function fetchLichessEval(env, fen) {
  const base = (env.LICHESS_API_BASE || "https://lichess.org").replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(`${base}/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=1`, {
      headers: { Accept: "application/json", "User-Agent": "MyChessDB" },
    });
  } catch (error) {
    throw new HttpError(502, "Could not reach Lichess to check the evaluation.", { code: "LICHESS_UNAVAILABLE" });
  }
  if (response.status === 404) {
    throw new HttpError(404, "Lichess has no cloud evaluation for this position.", { code: "LICHESS_NOT_FOUND" });
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    throw new HttpError(429, "Lichess is rate-limiting the server right now.",
      { code: "LICHESS_RATE_LIMIT", retry_after: retryAfter ? Number(retryAfter) : null });
  }
  if (!response.ok) {
    throw new HttpError(502, `Lichess answered with status ${response.status}.`, { code: "LICHESS_UNAVAILABLE" });
  }
  let data;
  try { data = await response.json(); } catch (error) {
    throw new HttpError(502, "Lichess sent an unreadable answer.", { code: "LICHESS_UNAVAILABLE" });
  }
  const first = Array.isArray(data.pvs) ? data.pvs[0] : null;
  const depth = Number(data.depth);
  if (!first || typeof first.moves !== "string" || !Number.isInteger(depth)) {
    throw new HttpError(502, "Lichess sent an incomplete evaluation.", { code: "LICHESS_UNAVAILABLE" });
  }
  if (!Number.isInteger(first.mate) && !Number.isFinite(first.cp)) {
    throw new HttpError(502, "Lichess sent an evaluation without a score.", { code: "LICHESS_UNAVAILABLE" });
  }
  return {
    depth,
    knodes: Number.isFinite(data.knodes) ? Math.round(data.knodes) : null,
    moves: first.moves.trim().split(/\s+/).slice(0, MAX_PV_PLIES),
    evaluation: lichessEvaluation(first.cp, first.mate),
  };
}

// --------------------------------------------------------------- saving ----

// The two statements that store an entry: archive what it replaces, then
// insert or replace. The second one returns a row when the entry was stored.
function storeStatements(env, entry, force, now) {
  return [
    env.DB.prepare(ARCHIVE_IF_REPLACEABLE).bind(
      now, "replaced", entry.position_key, entry.source, force ? 1 : 0, entry.verified, entry.verified, entry.depth,
      entry.saved_by),
    env.DB.prepare(UPSERT_IF_ALLOWED).bind(
      entry.position_key, entry.fen, entry.move_uci, entry.pv, entry.evaluation, entry.depth,
      entry.knodes, entry.source, entry.verified, entry.saved_by, entry.saved_at, force ? 1 : 0),
  ];
}

async function storeEntry(env, entry, force) {
  const results = await env.DB.batch([
    ...storeStatements(env, entry, force, new Date().toISOString()),
    env.DB.prepare(TRIM_HISTORY).bind(entry.position_key, entry.source, entry.position_key, entry.source),
  ]);
  return (results[1].results || []).length === 1;
}

async function handleSave(request, env) {
  const body = await readJson(request, 16 * 1024);
  const who = await identify(request, env);
  if (who.sentKey && !who.role) throw new HttpError(401, "That key is not recognised. Log out or enter a valid key.");
  const visitor = who.role ? null : await countAnonymousWrite(request, env, body.live === true);

  const { position, fen, key } = parsePosition(body.fen);
  if (!legalMoves(position).length) throw new HttpError(400, "The game is already over in this position.");

  const entry = {
    position_key: key, fen, knodes: null,
    // Entries without a key carry the visitor's hashed network, so that the
    // admin can take back everything one visitor saved (handlePurge).
    saved_by: who.savedBy || `anon:${visitor}`,
    saved_at: new Date().toISOString(),
  };

  if (body.source === "lichess") {
    const cloud = await fetchLichessEval(env, fen);
    if (cloud.depth < minDepth(env)) {
      throw new HttpError(409, `Lichess only has depth ${cloud.depth} for this position; nothing below depth ${minDepth(env)} is saved.`,
        { code: "LICHESS_TOO_SHALLOW", depth: cloud.depth });
    }
    // Rewrites Lichess's king-takes-rook castling into the standard form.
    const line = sanitizeUciLine(position, cloud.moves, MAX_PV_PLIES);
    if (!line.length) throw new HttpError(502, "Lichess sent a line that does not fit this position.", { code: "LICHESS_UNAVAILABLE" });
    Object.assign(entry, {
      source: "lichess", verified: 1, depth: cloud.depth, knodes: cloud.knodes,
      evaluation: cloud.evaluation, pv: line.join(" "), move_uci: line[0],
    });
  } else if (body.source === "stockfish") {
    const depth = body.depth;
    if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
      throw new HttpError(400, `depth must be a whole number from 1 to ${MAX_DEPTH}`);
    }
    if (depth < minDepth(env)) {
      throw new HttpError(400, `Depth ${depth} is not saved: the least is depth ${minDepth(env)}.`, { code: "DEPTH_TOO_LOW" });
    }
    if (typeof body.evaluation !== "string" || !/^([+-]\d{1,3}\.\d{2}|#-?\d{1,3})$/.test(body.evaluation)) {
      throw new HttpError(400, "evaluation must look like +0.32 or #-3");
    }
    if (!Array.isArray(body.pv) || !body.pv.length || body.pv.length > 300) throw new HttpError(400, "pv must be a list of UCI moves");
    const line = sanitizeUciLine(position, body.pv, MAX_PV_PLIES);
    if (!line.length) throw new HttpError(400, "The best move is not legal in this position.");
    Object.assign(entry, {
      source: "stockfish", verified: who.role ? 1 : 0, depth,
      evaluation: body.evaluation, pv: line.join(" "), move_uci: line[0],
    });
  } else {
    throw new HttpError(400, "source must be \"stockfish\" or \"lichess\"");
  }

  // `entry` in the answer is what the position now has for this engine,
  // `entries` everything it has, so the page can update itself.
  const before = await positionEntries(env, key);
  if (entry.source === "lichess" && before.lichess?.imported && before.lichess.depth >= entry.depth) {
    return json(200, {
      saved: false, entry: before.lichess, entries: before,
      reason: `The Lichess database already gives depth ${before.lichess.depth} for this position; depth ${entry.depth} does not replace it.`,
    });
  }
  const saved = await storeEntry(env, entry, false);
  const entries = await positionEntries(env, key);
  const current = entries[entry.source];
  if (saved) return json(200, { saved: true, entry: current, entries });
  const what = entry.source === "lichess" ? "A Lichess evaluation" : "An analysis";
  const reason = current.verified && entry.verified === 0
    ? "A verified analysis is already saved for this position; an unverified one cannot replace it."
    : `${what} at depth ${current.depth} is already saved for this position; depth ${entry.depth} does not replace it.`;
  return json(200, { saved: false, reason, entry: current, entries });
}

// GET /api/position?fen=...            -> { entries }
// GET /api/position?fen=...&next=1     -> { entries, next: { key: entries } }
// GET /api/position?fen=...&also=...&also=...  -> { entries, also: { key: entries } }
// With next=1 the answer also covers every position one legal move away,
// keyed like the position itself, so the page has them before a move is played.
// `also` names further positions (at most MAX_ALSO_POSITIONS), such as the
// moves leading to a position the page loads, so that going back through them
// shows their results at once. One that is not a position is left out.
const MAX_ALSO_POSITIONS = 100;

// Looking up many positions at once (next, also) reads many rows, and the
// free plan allows 5 million rows read a day. The optional rate limiting
// binding HEAVY_READS (wrangler.jsonc) counts such lookups per visitor's
// network, one unit per POSITIONS_PER_UNIT positions. Past the limit only the
// position itself is answered, with `limited`, so the page goes on working.
// Without the binding, or if it fails, nothing is limited.
const POSITIONS_PER_UNIT = 40;
async function heavyReadAllowed(request, env, positions) {
  if (!env.HEAVY_READS) return true;
  try {
    const key = await visitorId(request, env);
    for (let unit = 0; unit < Math.ceil(positions / POSITIONS_PER_UNIT); unit++) {
      if (!(await env.HEAVY_READS.limit({ key })).success) return false;
    }
  } catch (error) {
    console.error(error);
  }
  return true;
}

async function handlePosition(request, env, url) {
  const { position, key } = parsePosition(url.searchParams.get("fen"));
  const withNext = url.searchParams.get("next") === "1";
  const alsoKeys = [];
  for (const fen of url.searchParams.getAll("also").slice(0, MAX_ALSO_POSITIONS)) {
    try { alsoKeys.push(parsePosition(fen).key); } catch (error) { /* nothing is saved for it */ }
  }
  if (!withNext && !alsoKeys.length) return json(200, { entries: await positionEntries(env, key) });
  const nextKeys = withNext ? legalMoves(position).map(move => positionKey(toFen(makeMove(position, move)))) : [];
  if (!await heavyReadAllowed(request, env, 1 + nextKeys.length + alsoKeys.length)) {
    return json(200, { entries: await positionEntries(env, key), limited: true });
  }
  const found = await entriesFor(env, [key, ...nextKeys, ...alsoKeys]);
  const answer = { entries: found.get(key) };
  if (withNext) {
    answer.next = {};
    for (const nextKey of nextKeys) answer.next[nextKey] = found.get(nextKey);
  }
  if (alsoKeys.length) {
    answer.also = {};
    for (const alsoKey of alsoKeys) answer.also[alsoKey] = found.get(alsoKey);
  }
  return json(200, answer);
}

// Removes one engine's entry for a position (it stays in the history).
async function handleRemove(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request, 4096);
  if (!SOURCES.includes(body.source)) throw new HttpError(400, "source must be \"stockfish\" or \"lichess\"");
  const key = positionKey(String(body.fen || ""));
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO saved_history (${COLUMNS}, archived_at, reason)
       SELECT ${COLUMNS}, ?, 'removed' FROM saved_positions WHERE position_key = ? AND source = ?`).bind(now, key, body.source),
    env.DB.prepare("DELETE FROM saved_positions WHERE position_key = ? AND source = ? RETURNING position_key").bind(key, body.source),
  ]);
  return json(200, { removed: (results[1].results || []).length === 1, entries: await positionEntries(env, key) });
}

// Puts back, for every position and engine where the purge just removed the
// visitor's entry, the entry that visitor replaced: the newest one in the
// history from someone else, leaving out what earlier purges took back. It is
// put back only if it was replaced; if the admin removed it, or restored
// another over it, the place stays empty. Binds: saved_by, archived_at.
const RESTORE_AFTER_PURGE = `
  INSERT OR IGNORE INTO saved_positions (${COLUMNS})
  SELECT ${COLUMNS} FROM saved_history WHERE reason = 'replaced' AND id IN (
    SELECT MAX(h.id) FROM saved_history h
    JOIN (SELECT DISTINCT position_key, source FROM saved_history
          WHERE saved_by = ?1 AND reason = 'purged' AND archived_at = ?2) p
      ON h.position_key = p.position_key AND h.source = p.source
    WHERE h.saved_by <> ?1 AND h.reason <> 'purged'
    GROUP BY h.position_key, h.source)
  RETURNING position_key`;

// Removes every unverified entry saved by the same visitor (without a key) as
// the entry named by fen and source, for when someone fills the database with
// bad moves, and puts back what they replaced. Everything removed stays in
// the history.
async function handlePurge(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request, 4096);
  if (!SOURCES.includes(body.source)) throw new HttpError(400, "source must be \"stockfish\" or \"lichess\"");
  const key = positionKey(String(body.fen || ""));
  const row = await env.DB.prepare("SELECT saved_by, verified FROM saved_positions WHERE position_key = ? AND source = ?")
    .bind(key, body.source).first();
  if (!row) throw new HttpError(404, "There is no saved entry for this position.");
  if (row.verified !== 0 || !row.saved_by.startsWith("anon:")) {
    throw new HttpError(400, "Only unverified entries saved without a key can be removed by visitor.");
  }
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO saved_history (${COLUMNS}, archived_at, reason)
       SELECT ${COLUMNS}, ?, 'purged' FROM saved_positions WHERE saved_by = ? AND verified = 0`).bind(now, row.saved_by),
    env.DB.prepare("DELETE FROM saved_positions WHERE saved_by = ? AND verified = 0 RETURNING position_key").bind(row.saved_by),
    env.DB.prepare(RESTORE_AFTER_PURGE).bind(row.saved_by, now),
  ]);
  return json(200, {
    purged: (results[1].results || []).length,
    restored: (results[2].results || []).length,
    entries: await positionEntries(env, key),
  });
}

async function handleHistory(request, env, url) {
  await requireAdmin(request, env);
  const key = positionKey(url.searchParams.get("fen") || "");
  const { results } = await env.DB.prepare(
    `SELECT id, ${COLUMNS}, archived_at, reason FROM saved_history
     WHERE position_key = ? ORDER BY id DESC LIMIT 50`).bind(key).all();
  return json(200, {
    history: results.map(row => ({
      id: row.id, ...publicEntry(row), saved_by: row.saved_by, archived_at: row.archived_at, reason: row.reason,
    })),
  });
}

async function handleRestore(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request, 4096);
  if (!Number.isInteger(body.id)) throw new HttpError(400, "id must be a number");
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM saved_history WHERE id = ?`).bind(body.id).first();
  if (!row) throw new HttpError(404, "That history entry does not exist.");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO saved_history (${COLUMNS}, archived_at, reason)
       SELECT ${COLUMNS}, ?, 'restored-over' FROM saved_positions WHERE position_key = ? AND source = ?`).bind(now, row.position_key, row.source),
    env.DB.prepare(
      `INSERT OR REPLACE INTO saved_positions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      row.position_key, row.fen, row.move_uci, row.pv, row.evaluation, row.depth, row.knodes,
      row.source, row.verified, row.saved_by, row.saved_at),
  ]);
  return json(200, { restored: true, entry: publicEntry(row), entries: await positionEntries(env, row.position_key) });
}

// ----------------------------------------------------------------- keys ----

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return "mck_" + btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function handleKeys(request, env) {
  await requireAdmin(request, env);
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT k.id, k.label, k.created_at, k.revoked_at,
              (SELECT COUNT(*) FROM saved_positions s WHERE s.saved_by = 'key:' || k.id) AS entries
       FROM contributor_keys k ORDER BY k.id DESC`).all();
    return json(200, { keys: results });
  }
  const body = await readJson(request, 4096);
  const label = String(body.label || "").trim().slice(0, 80);
  if (!label) throw new HttpError(400, "Give the key a label, such as the person's name.");
  const key = randomKey();
  const row = await env.DB.prepare(
    "INSERT INTO contributor_keys (key_hash, label, created_at) VALUES (?, ?, ?) RETURNING id",
  ).bind(await sha256Hex(key), label, new Date().toISOString()).first();
  // The key itself is shown once and never stored.
  return json(200, { id: row.id, label, key });
}

async function handleRevokeKey(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request, 4096);
  if (!Number.isInteger(body.id)) throw new HttpError(400, "id must be a number");
  const revoked = await env.DB.prepare(
    "UPDATE contributor_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id",
  ).bind(new Date().toISOString(), body.id).first();
  let demoted = 0;
  if (body.demote === true) {
    // Entries saved with this key stop counting as verified, so verified
    // entries from others (or a fresh analysis) can replace them.
    const { results } = await env.DB.prepare(
      "UPDATE saved_positions SET verified = 0 WHERE saved_by = ? AND verified = 1 RETURNING position_key",
    ).bind(`key:${body.id}`).all();
    demoted = results.length;
  }
  return json(200, { revoked: Boolean(revoked), demoted });
}

// ------------------------------------------------------- import / export ---

function cleanImportEntry(raw) {
  if (raw === null || typeof raw !== "object") throw new Error("entry is not an object");
  const position = parseFen(raw.fen);
  const fen = toFen(position);
  if (!Array.isArray(raw.pv) || !raw.pv.length || raw.pv.length > 300) throw new Error("pv is missing");
  const line = sanitizeUciLine(position, raw.pv, MAX_PV_PLIES);
  if (!line.length) throw new Error("best move is not legal in this position");
  if (!Number.isInteger(raw.depth) || raw.depth < 1 || raw.depth > 1000) throw new Error("depth is missing");
  if (raw.source !== "stockfish" && raw.source !== "lichess") throw new Error("unknown source");
  if (typeof raw.evaluation !== "string" || raw.evaluation.length > 60) throw new Error("evaluation is missing");
  const savedAt = typeof raw.saved_at === "string" && !Number.isNaN(Date.parse(raw.saved_at))
    ? new Date(raw.saved_at).toISOString() : new Date().toISOString();
  return {
    position_key: fen.split(" ").slice(0, 4).join(" "),
    fen, move_uci: line[0], pv: line.join(" "), evaluation: raw.evaluation,
    depth: raw.depth, knodes: Number.isInteger(raw.knodes) ? raw.knodes : null,
    // An entry marked unverified (as in a backup) stays unverified; anything
    // else the admin imports counts as verified.
    source: raw.source, verified: raw.verified === false ? 0 : 1, saved_by: "import", saved_at: savedAt,
  };
}

async function handleImport(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request, 512 * 1024);
  if (!Array.isArray(body.entries) || !body.entries.length) throw new HttpError(400, "entries must be a non-empty list");
  if (body.entries.length > IMPORT_BATCH_LIMIT) {
    throw new HttpError(400, `Send at most ${IMPORT_BATCH_LIMIT} entries per request.`);
  }
  const force = body.overwrite === true;
  const now = new Date().toISOString();
  const statements = [], invalid = [];
  body.entries.forEach((raw, index) => {
    let entry;
    try { entry = cleanImportEntry(raw); } catch (error) {
      invalid.push({ index, fen: typeof raw?.fen === "string" ? raw.fen.slice(0, 100) : null, error: error.message });
      return;
    }
    statements.push(...storeStatements(env, entry, force, now));
  });
  let stored = 0;
  if (statements.length) {
    const results = await env.DB.batch(statements);
    for (let i = 1; i < results.length; i += 2) stored += (results[i].results || []).length;
  }
  return json(200, { stored, kept_existing: statements.length / 2 - stored, invalid });
}

async function handleExport(request, env) {
  await requireAdmin(request, env);
  const saved = await env.DB.prepare(`SELECT ${COLUMNS} FROM saved_positions ORDER BY saved_at`).all();
  const history = await env.DB.prepare(`SELECT id, ${COLUMNS}, archived_at, reason FROM saved_history ORDER BY id`).all();
  const keys = await env.DB.prepare("SELECT id, label, created_at, revoked_at FROM contributor_keys ORDER BY id").all();
  const unpack = row => ({ ...row, pv: row.pv.split(" ") });
  return json(200, {
    exported_at: new Date().toISOString(),
    saved: saved.results.map(unpack),
    history: history.results.map(unpack),
    contributor_keys: keys.results,
  }, { "Content-Disposition": "attachment; filename=\"mychessdb-backup.json\"" });
}

// --------------------------------------------------------------- router ----

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/")) {
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  }
  if (!env.DB) throw new HttpError(500, "The database binding DB is not configured.");

  if (method !== "GET" && method !== "POST") throw new HttpError(405, "Method not allowed");
  if (method === "POST") {
    // The API is for this site only: other origins get no CORS headers, and
    // cross-site form posts are refused outright.
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) throw new HttpError(403, "Cross-site requests are not allowed");
  }

  if (path === "/api/session" && method === "GET") {
    const who = await identify(request, env);
    return json(200, {
      role: who.role, label: who.label || null,
      min_depth: minDepth(env), full_depth: fullDepth(env), admin_configured: adminConfigured(env),
    });
  }
  if (path === "/api/position" && method === "GET") return handlePosition(request, env, url);
  if (path === "/api/saved" && method === "POST") return handleSave(request, env);
  if (path === "/api/remove" && method === "POST") return handleRemove(request, env);
  if (path === "/api/purge" && method === "POST") return handlePurge(request, env);
  if (path === "/api/history" && method === "GET") return handleHistory(request, env, url);
  if (path === "/api/restore" && method === "POST") return handleRestore(request, env);
  if (path === "/api/keys") return handleKeys(request, env);
  if (path === "/api/keys/revoke" && method === "POST") return handleRevokeKey(request, env);
  if (path === "/api/import" && method === "POST") return handleImport(request, env);
  if (path === "/api/export" && method === "GET") return handleExport(request, env);
  throw new HttpError(404, "Not found");
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message, ...error.extra });
      console.error(error);
      // D1's free plan allows a fixed number of row writes a day (UTC); past
      // it every save fails until midnight UTC, whoever sends it.
      if (/daily row write limit/i.test(String(error?.message))) {
        const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
        return json(503, {
          error: `The database has used up today's writes (Cloudflare's free plan). Nothing can be saved until ${reset.toISOString().slice(11, 16)} UTC.`,
          code: "DAILY_WRITE_LIMIT", retry_at: reset.toISOString(),
        });
      }
      return json(500, { error: "Something went wrong on the server." });
    }
  },
};

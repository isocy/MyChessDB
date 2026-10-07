// My Chess DB API - Cloudflare Worker.
//
// Serves /api/* for the static site in ../web. Data lives in the D1 database
// bound as DB (schema: ../migrations). Secrets and settings:
//
//   ADMIN_TOKEN            secret, at least 16 characters. Whoever sends it in
//                          the X-Key header is the admin.
//   MIN_DEPTH              optional, default 46. Lowest depth accepted from
//                          anyone who is not the admin.
//   ANON_WRITES_PER_HOUR   optional, default 60. Save attempts allowed per
//                          hour for one visitor without a key.
//   LICHESS_API_BASE       optional, default https://lichess.org (tests point
//                          this at a local stand-in).
//
// Trust model (there are no user accounts):
//   * "lichess" entries: the server fetches the evaluation from Lichess
//     itself, so nothing the browser claims is stored. Always verified.
//   * "stockfish" entries sent with the admin token or a contributor key
//     are verified; without a key they are stored as unverified.
//   * A verified entry is never replaced by an unverified one. Within the
//     same tier only a strictly deeper analysis replaces the stored one.
//   * Whatever is replaced or removed is copied to saved_history first.

import { parseFen, toFen, positionKey, legalMoves, sanitizeUciLine } from "../web/chesslib.js";

const MAX_DEPTH = 245;
const MAX_PV_PLIES = 60;
const IMPORT_BATCH_LIMIT = 100;

const COLUMNS = "position_key, fen, move_uci, pv, evaluation, depth, knodes, source, verified, saved_by, saved_at";

// Copies the stored row to history when the incoming entry is allowed to
// replace it. Binds: archived_at, reason, position_key, force, verified,
// verified, depth.
const ARCHIVE_IF_REPLACEABLE = `
  INSERT INTO saved_history (${COLUMNS}, archived_at, reason)
  SELECT ${COLUMNS}, ?, ? FROM saved_positions
  WHERE position_key = ? AND (? = 1 OR ? > verified OR (? = verified AND ? > depth))`;

// Inserts, or replaces under the same rule. Binds: the 11 columns, force.
const UPSERT_IF_ALLOWED = `
  INSERT INTO saved_positions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(position_key) DO UPDATE SET
    fen = excluded.fen, move_uci = excluded.move_uci, pv = excluded.pv,
    evaluation = excluded.evaluation, depth = excluded.depth, knodes = excluded.knodes,
    source = excluded.source, verified = excluded.verified,
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
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function intSetting(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const minDepth = env => intSetting(env.MIN_DEPTH, 46);

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function adminConfigured(env) {
  return typeof env.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN.length >= 16;
}

/** Who is asking? { role: "admin" | "contributor" | null, ... } */
async function identify(request, env) {
  const key = (request.headers.get("X-Key") || "").trim();
  if (!key) return { role: null, sentKey: false };
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
    evaluation: row.evaluation,
    depth: row.depth,
    knodes: row.knodes,
    source: row.source,
    verified: row.verified === 1,
    saved_at: row.saved_at,
  };
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

async function countAnonymousWrite(request, env) {
  const limit = intSetting(env.ANON_WRITES_PER_HOUR, 60);
  const hour = Math.floor(Date.now() / 3600000);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  // The address is salted and hashed; the raw IP is never stored.
  const visitor = (await sha256Hex(`${env.ADMIN_TOKEN || "mychessdb"}|${ip}`)).slice(0, 32);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, hour, count) VALUES (?, ?, 1)
     ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count`,
  ).bind(`${visitor}:${hour}`, hour).first();
  if (row.count === 1) {
    await env.DB.prepare("DELETE FROM rate_limits WHERE hour < ?").bind(hour - 1).run();
  }
  if (row.count > limit) {
    throw new HttpError(429, `Too many saves from this network in the last hour (limit ${limit}). Try again later.`,
      { code: "WRITE_RATE_LIMIT" });
  }
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
  let evaluation;
  if (Number.isInteger(first.mate)) evaluation = `mate ${first.mate}`;
  else if (Number.isFinite(first.cp)) evaluation = `${first.cp >= 0 ? "+" : "-"}${(Math.abs(first.cp) / 100).toFixed(2)}`;
  else throw new HttpError(502, "Lichess sent an evaluation without a score.", { code: "LICHESS_UNAVAILABLE" });
  return {
    depth,
    knodes: Number.isFinite(data.knodes) ? Math.round(data.knodes) : null,
    moves: first.moves.trim().split(/\s+/).slice(0, MAX_PV_PLIES),
    evaluation: `Lichess Cloud: ${evaluation}`,
  };
}

// --------------------------------------------------------------- saving ----

async function storeEntry(env, entry, force) {
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(ARCHIVE_IF_REPLACEABLE).bind(
      now, "replaced", entry.position_key, force ? 1 : 0, entry.verified, entry.verified, entry.depth),
    env.DB.prepare(UPSERT_IF_ALLOWED).bind(
      entry.position_key, entry.fen, entry.move_uci, entry.pv, entry.evaluation, entry.depth,
      entry.knodes, entry.source, entry.verified, entry.saved_by, entry.saved_at, force ? 1 : 0),
  ]);
  return (results[1].results || []).length === 1;
}

async function handleSave(request, env) {
  const body = await readJson(request, 16 * 1024);
  const who = await identify(request, env);
  if (who.sentKey && !who.role) throw new HttpError(401, "That key is not recognised. Log out or enter a valid key.");
  if (!who.role) await countAnonymousWrite(request, env);

  const { position, fen, key } = parsePosition(body.fen);
  if (!legalMoves(position).length) throw new HttpError(400, "The game is already over in this position.");
  const required = minDepth(env);
  const isAdmin = who.role === "admin";

  const entry = {
    position_key: key, fen, knodes: null,
    saved_by: who.savedBy || "anon",
    saved_at: new Date().toISOString(),
  };

  if (body.source === "lichess") {
    const cloud = await fetchLichessEval(env, fen);
    if (!isAdmin && cloud.depth < required) {
      throw new HttpError(409, `Lichess only has depth ${cloud.depth} for this position; depth ${required} is required.`,
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
    if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) throw new HttpError(400, "depth must be a whole number");
    if (!isAdmin && depth < required) {
      throw new HttpError(400, `Depth ${depth} is below the required depth ${required}.`, { code: "DEPTH_TOO_LOW" });
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

  const saved = await storeEntry(env, entry, false);
  const current = await env.DB.prepare(`SELECT ${COLUMNS} FROM saved_positions WHERE position_key = ?`).bind(key).first();
  if (saved) return json(200, { saved: true, entry: publicEntry(current) });
  const reason = current.verified === 1 && entry.verified === 0
    ? "A verified analysis is already saved for this position; an unverified one cannot replace it."
    : `An analysis at depth ${current.depth} is already saved for this position; depth ${entry.depth} does not replace it.`;
  return json(200, { saved: false, reason, entry: publicEntry(current) });
}

async function handleRemove(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request, 4096);
  const key = positionKey(String(body.fen || ""));
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO saved_history (${COLUMNS}, archived_at, reason)
       SELECT ${COLUMNS}, ?, 'removed' FROM saved_positions WHERE position_key = ?`).bind(now, key),
    env.DB.prepare("DELETE FROM saved_positions WHERE position_key = ? RETURNING position_key").bind(key),
  ]);
  return json(200, { removed: (results[1].results || []).length === 1 });
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
       SELECT ${COLUMNS}, ?, 'restored-over' FROM saved_positions WHERE position_key = ?`).bind(now, row.position_key),
    env.DB.prepare(
      `INSERT OR REPLACE INTO saved_positions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      row.position_key, row.fen, row.move_uci, row.pv, row.evaluation, row.depth, row.knodes,
      row.source, row.verified, row.saved_by, row.saved_at),
  ]);
  return json(200, { restored: true, entry: publicEntry(row) });
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
    statements.push(
      env.DB.prepare(ARCHIVE_IF_REPLACEABLE).bind(
        now, "replaced", entry.position_key, force ? 1 : 0, entry.verified, entry.verified, entry.depth),
      env.DB.prepare(UPSERT_IF_ALLOWED).bind(
        entry.position_key, entry.fen, entry.move_uci, entry.pv, entry.evaluation, entry.depth,
        entry.knodes, entry.source, entry.verified, entry.saved_by, entry.saved_at, force ? 1 : 0),
    );
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
      min_depth: minDepth(env), admin_configured: adminConfigured(env),
    });
  }
  if (path === "/api/saved" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM saved_positions`).all();
    return json(200, { entries: results.map(publicEntry) });
  }
  if (path === "/api/saved" && method === "POST") return handleSave(request, env);
  if (path === "/api/remove" && method === "POST") return handleRemove(request, env);
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
      return json(500, { error: "Something went wrong on the server." });
    }
  },
};

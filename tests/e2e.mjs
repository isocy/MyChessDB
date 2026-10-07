// End-to-end test in a real browser (Linux, needs Go and Playwright):
//
//   node tests/e2e.mjs [path/to/saved_positions.json]
//
// Starts the local dev server, a stand-in Lichess, a stand-in Stockfish
// release server and the real engine bridge (built with test hooks and a
// stand-in engine), then drives the page with Chromium.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { positionKey, replayUci } from "../web/chesslib.js";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch (error) {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright"));
}

const root = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "mychessdb-e2e-"));
const SITE = "http://localhost:8787";
const ADMIN = "e2e-admin-token-0123456789";
const savedPositionsFile = process.argv[2];
const children = [];
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

let passed = 0;
async function step(name, run) {
  process.stdout.write(`- ${name} ... `);
  await run();
  passed++;
  console.log("ok");
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (error) { last = error.message; }
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${what} (last: ${JSON.stringify(last)})`);
}

// --- build the bridge (with test hooks) and the stand-in engine ----------
const bridgeBin = join(work, "bridge");
const engineDir = join(work, "release", "stockfish");
mkdirSync(engineDir, { recursive: true });
const engineBin = join(engineDir, "stockfish-linux-x86-64-universal");
execFileSync("go", ["build", "-tags", "testhooks", "-o", bridgeBin, "."], { cwd: join(root, "bridge"), stdio: "inherit" });
execFileSync("go", ["build", "-o", engineBin, "./testdata/mockengine"], { cwd: join(root, "bridge"), stdio: "inherit" });
copyFileSync(join(root, "openings", "COPYING.txt"), join(engineDir, "AUTHORS"));
const archive = join(work, "stockfish-linux-x86-64-universal.tar.gz");
execFileSync("tar", ["czf", archive, "-C", join(work, "release"), "stockfish"]);
const archiveBytes = readFileSync(archive);
const archiveDigest = createHash("sha256").update(archiveBytes).digest("hex");
const engineDigest = createHash("sha256").update(readFileSync(engineBin)).digest("hex");

// --- stand-ins for Lichess and the Stockfish release (one local server) --
let lichessAnswer = () => ({ status: 404, body: "" });
let lichessServerCalls = 0;
const fake = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/cloud-eval") {
    lichessServerCalls++;
    const answer = lichessAnswer(url.searchParams.get("fen"));
    res.writeHead(answer.status, { "Content-Type": "application/json" });
    res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
  } else if (url.pathname === "/download/stockfish-linux-x86-64-universal.tar.gz") {
    res.writeHead(200, { "Content-Length": archiveBytes.length });
    // Trickle the file so the page has time to show download progress.
    let offset = 0;
    const chunk = Math.ceil(archiveBytes.length / 8);
    const timer = setInterval(() => {
      res.write(archiveBytes.subarray(offset, offset + chunk));
      offset += chunk;
      if (offset >= archiveBytes.length) { clearInterval(timer); res.end(); }
    }, 800);
  } else { res.writeHead(404); res.end(); }
});
await new Promise(resolve => fake.listen(8790, "127.0.0.1", resolve));

function launch(name, command, args, env) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.output = "";
  child.stdout.on("data", data => { child.output += data; });
  child.stderr.on("data", data => { child.output += data; });
  child.label = name;
  children.push(child);
  return child;
}
const devServer = launch("dev server", process.execPath, ["--no-warnings", join(root, "scripts", "dev_server.mjs")], {
  PORT: "8787", DEV_DB: ":memory:", ADMIN_TOKEN: ADMIN, LICHESS_API_BASE: "http://127.0.0.1:8790", ANON_WRITES_PER_HOUR: "1000",
});
await until(async () => (await fetch(SITE + "/api/session")).ok, "dev server");

const bridgeHome = join(work, "bridge-home");
function startBridge() {
  return launch("bridge", bridgeBin, ["-site", SITE, "-no-open"], {
    MYCHESSDB_HOME: bridgeHome, MOCK_DELAY_MS: "60",
    // Test hooks (only in a bridge built with -tags testhooks): fetch the
    // "release" from this script and accept the stand-in engine.
    MYCHESSDB_TEST_RELEASE_BASE: "http://127.0.0.1:8790/download/",
    MYCHESSDB_TEST_ARCHIVE_SHA256: archiveDigest, MYCHESSDB_TEST_TRUST: engineDigest,
  });
}

// --- browser -------------------------------------------------------------
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ acceptDownloads: true });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: SITE });
const problems = [];
const bridgeRequests = [];
let lichessBrowser = () => ({ status: 404, body: "" });
async function newPage() {
  const page = await context.newPage();
  page.on("pageerror", error => problems.push(`page error: ${error.message}`));
  page.on("console", message => {
    const text = message.text();
    // A refused connection to the bridge is expected while it is not running.
    if (message.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(text)) problems.push(`console: ${text}`);
    if (/Content Security Policy/i.test(text)) problems.push(`CSP: ${text}`);
  });
  page.on("request", request => { if (request.url().startsWith("http://127.0.0.1:8765")) bridgeRequests.push(request.url()); });
  await page.route("https://raw.githubusercontent.com/**", route => route.fulfill({
    status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/>" }));
  await page.route("https://lichess.org/**", route => {
    const answer = lichessBrowser(new URL(route.request().url()).searchParams.get("fen"));
    route.fulfill({ status: answer.status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" },
      body: typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body) });
  });
  await page.goto(SITE + "/");
  await page.waitForSelector("#board .square");
  return page;
}
const text = (page, selector) => page.locator(selector).innerText();
const value = (page, selector) => page.locator(selector).inputValue();
const square = name => "abcdefgh".indexOf(name[0]) + (8 - Number(name[1])) * 8;
async function move(page, from, to) {
  await page.click(`#board .square[data-index="${square(from)}"]`);
  await page.click(`#board .square[data-index="${square(to)}"]`);
}
async function toStart(page) {   // back to the first position of the current history
  if (await page.locator("#history-first").isEnabled()) await page.click("#history-first");
}
const savedSquares = page => page.$$eval("#board .square.saved", nodes => nodes.map(node => Number(node.dataset.index)).sort((a, b) => a - b));
const jobTexts = page => page.$$eval("#active-jobs li", nodes => nodes.map(node => node.innerText.replace(/\s+/g, " ")));
const apiSaved = async () => (await (await fetch(SITE + "/api/saved")).json()).entries;

try {
  let page = await newPage();

  await step("page loads cleanly and does not touch the local bridge by itself", async () => {
    await sleep(500);
    assert.deepEqual(problems, []);
    assert.deepEqual(bridgeRequests, [], "no request to 127.0.0.1 before the user asks");
    assert.equal(await text(page, "#bridge-status"), "Engine bridge: not connected");
    assert.equal(await text(page, "#opening-status"), "Opening: Starting position");
    assert.equal(await value(page, "#depth"), "46");
    assert.equal(await page.locator("#depth").isDisabled(), true);
    assert.equal(await page.locator("#remove").isVisible(), false);
    const csp = (await (await fetch(SITE + "/")).headers.get("content-security-policy")) || "";
    assert.ok(csp.includes("script-src 'self';") && csp.includes("frame-ancestors 'none'"), csp);
  });

  await step("moves work and the opening is named in the browser", async () => {
    await move(page, "e2", "e4");
    await until(async () => /1\. e4/.test(await text(page, "#opening-status")), "opening line");
    assert.match(await text(page, "#opening-status"), /^Opening: B00 · King's Pawn Game — 1\. e4$/);
    await move(page, "e7", "e5"); await move(page, "g1", "f3"); await move(page, "b8", "c6"); await move(page, "f1", "c4");
    await until(async () => /Italian Game/.test(await text(page, "#opening-status")), "Italian Game");
    assert.match(await text(page, "#opening-status"), /C50 · Italian Game — 1\. e4 e5 2\. Nf3 Nc6 3\. Bc4$/);
    await move(page, "h7", "h5");   // leaves the catalog: last known name stays, line continues
    await until(async () => /3\.\.\. ?h5|Bc4 h5/.test(await text(page, "#opening-status")), "continuation");
    assert.match(await text(page, "#opening-status"), /C50 · Italian Game — 1\. e4 e5 2\. Nf3 Nc6 3\. Bc4 h5$/);
    await toStart(page);
    await move(page, "e2", "e4");
  });

  await step("without the bridge, analysis explains the setup instead of failing silently", async () => {
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /engine bridge, which is not running/.test(t)), "bridge hint");
    assert.equal(await page.locator("#bridge-setup").isVisible(), true);
    assert.match(await text(page, "#install-windows"), new RegExp(`^\\$env:MYCHESSDB_SITE='${SITE}'; iex \\(New-Object Net\\.WebClient\\)\\.DownloadString\\('${SITE}/install\\.ps1\\?t=\\d+'\\)$`));
    assert.equal(await text(page, "#install-unix"), `curl -fsSL ${SITE}/install.sh | MYCHESSDB_SITE=${SITE} sh`);
    assert.equal(await page.locator("#safari-note").isVisible(), false, "Safari note is only for Safari");
    assert.equal(await text(page, "#start-windows"), `& "$env:LOCALAPPDATA\\MyChessDB\\mychessdb-bridge.exe" -site ${SITE} -no-open`);
    assert.equal(await text(page, "#start-unix"), `~/.mychessdb/mychessdb-bridge -site ${SITE} -no-open`);
    await page.click("#copy-install-unix");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `curl -fsSL ${SITE}/install.sh | MYCHESSDB_SITE=${SITE} sh`);
    assert.deepEqual(await apiSaved(), []);
    await page.click("#active-jobs li button:has-text('Dismiss')");
  });

  let bridge;
  await step("starting the bridge: page connects by itself and shows the Stockfish download", async () => {
    bridge = startBridge();
    const seen = new Set();
    await until(async () => {
      const status = await text(page, "#bridge-status");
      seen.add(status.replace(/\d+%/, "N%"));
      return /Stockfish 19 ready/.test(status);
    }, "engine ready", 30000);
    assert.ok([...seen].some(s => /downloading Stockfish 19\.\.\. N%/.test(s)), `download progress was shown: ${[...seen].join(" | ")}`);
    assert.match(await text(page, "#bridge-status"), /^Engine bridge \d+\.\d+\.\d+ connected · Stockfish 19 ready · up to \d+ threads?, \d+ MB hash$/);
    assert.equal(await page.locator("#bridge-setup").isVisible(), false, "setup panel closes once connected");
    assert.match(bridge.output, /is installed/);
  });

  await step("anonymous Stockfish analysis is saved as unverified and highlighted", async () => {
    await page.click("#analyze");   // position after 1. e4, black to move, depth 46
    await until(async () => (await jobTexts(page)).some(t => /depth \d+\/46/.test(t)), "progress with depth");
    await until(async () => (await jobTexts(page)).some(t => /Analysis complete\. Best move saved \(unverified\)\./.test(t)), "saved", 20000);
    assert.equal(await value(page, "#evaluation"), "-0.32");
    assert.equal(await value(page, "#depth-result"), "Depth 46 · unverified");
    assert.equal(await text(page, "#notation"), "e5 Nf3 Nc6 Bb5");
    assert.deepEqual(await savedSquares(page), [square("e7"), square("e5")].sort((a, b) => a - b));
    const saved = await apiSaved();
    assert.equal(saved.length, 1);
    assert.deepEqual([saved[0].verified, saved[0].depth, saved[0].source, saved[0].move_uci], [false, 46, "stockfish", "e7e5"]);
    assert.match(await jobTexts(page).then(t => t[0]), /B00 · King's Pawn Game/, "job shows its opening");
    await page.click("#active-jobs li button:has-text('Dismiss')");
  });

  await step("the saved move reappears after a reload, and the bridge reconnects by itself", async () => {
    await page.reload();
    await page.waitForSelector("#board .square");
    await until(async () => /Stockfish 19 ready/.test(await text(page, "#bridge-status")), "auto reconnect");
    assert.deepEqual(await savedSquares(page), []);
    await move(page, "e2", "e4");
    await until(async () => (await savedSquares(page)).length === 2, "highlight");
    assert.equal(await value(page, "#depth-result"), "Depth 46 · unverified");
  });

  await step("a second analysis that could not replace the saved one is refused up front", async () => {
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /depth 46 is already saved.*would not replace it/.test(t)), "refusal");
    await page.click("#active-jobs li button:has-text('Dismiss')");
  });

  await step("pause freezes the engine, resume continues, stop ends it", async () => {
    await toStart(page);
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /Analyzing Stockfish\.\.\. depth [1-9]\d*\/46/.test(t)), "running");
    assert.equal(await text(page, "#analyze"), "Stop analysis");
    await page.click("#active-jobs li button:has-text('Pause')");
    await until(async () => (await jobTexts(page)).some(t => /Paused at depth \d+\/46/.test(t)), "paused");
    await sleep(1200);   // let the page's next poll show the depth the engine froze at
    const frozen = (await jobTexts(page))[0];
    await sleep(1200);
    assert.equal((await jobTexts(page))[0], frozen, "no progress while paused");
    await page.click("#active-jobs li button:has-text('Resume')");
    await until(async () => (await jobTexts(page))[0] !== frozen && /Analyzing/.test((await jobTexts(page))[0]), "resumed");
    await page.click("#active-jobs li button:has-text('Stop')");
    await until(async () => (await jobTexts(page)).some(t => /Analysis stopped/.test(t)), "stopped");
    assert.equal((await apiSaved()).length, 1, "a stopped analysis saves nothing");
    await page.click("#active-jobs li button:has-text('Dismiss')");
  });

  await step("an analysis survives a reload and one that finishes while the page is closed is still saved", async () => {
    await move(page, "d2", "d4");
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /depth \d+\/46/.test(t)), "running");
    await page.reload();
    await page.waitForSelector("#board .square");
    await until(async () => (await jobTexts(page)).some(t => /A40 · Queen's Pawn Game.*(depth \d+\/46|Analysis complete)/.test(t)), "restored with its opening");
    await until(async () => (await jobTexts(page)).some(t => /Best move saved/.test(t)), "saved after reload", 20000);
    assert.equal((await apiSaved()).length, 2);
    await page.click("#active-jobs li button:has-text('Dismiss')");
    // now: start, close the page, let it finish, open again
    await move(page, "c2", "c4");
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /depth \d+\/46/.test(t)), "running");
    await page.close();
    await sleep(3500);
    assert.equal((await apiSaved()).length, 2, "nothing can be saved while no page is open");
    page = await newPage();
    await until(async () => (await apiSaved()).length === 3, "collected and saved after reopening", 20000);
    await until(async () => (await jobTexts(page)).some(t => /Best move saved/.test(t)), "shown as complete");
    await page.click("#active-jobs li button:has-text('Dismiss')");
  });

  const afterE4E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  await step("a deep Lichess evaluation is saved as verified, from the server's own fetch", async () => {
    const cloud = { fen: afterE4E5, knodes: 1234, depth: 50, pvs: [{ moves: "g1f3 b8c6 f1b5", cp: 25 }, { moves: "b1c3 g8f6", cp: 20 }] };
    // The browser is shown a tampered copy; what is saved must be the server's.
    lichessBrowser = () => ({ status: 200, body: { ...cloud, depth: 99, pvs: [{ moves: "a2a3 a7a6", cp: 900 }] } });
    lichessAnswer = () => ({ status: 200, body: cloud });
    await move(page, "e2", "e4"); await move(page, "e7", "e5");
    const before = lichessServerCalls;
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /Analysis complete\. Best move saved\./.test(t)), "saved");
    assert.equal(lichessServerCalls, before + 1);
    assert.equal(await value(page, "#evaluation"), "Lichess Cloud: +0.25");
    assert.equal(await value(page, "#depth-result"), "Depth 50 | 1234k nodes");
    assert.equal(await text(page, "#notation"), "Nf3 Nc6 Bb5");
    const entry = (await apiSaved()).find(e => e.source === "lichess");
    assert.deepEqual([entry.verified, entry.depth, entry.move_uci], [true, 50, "g1f3"]);
    await page.click("#active-jobs li button:has-text('Dismiss')");
  });

  await step("Lichess rate limit offers the Stockfish choice without a popup", async () => {
    lichessBrowser = () => ({ status: 429, body: "" });
    await toStart(page);
    await move(page, "g1", "f3");
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /Lichess Cloud rate limit.*Choose whether to continue with Stockfish/.test(t)), "choice");
    await page.click("#active-jobs li button:has-text('Use Stockfish')");
    await until(async () => (await jobTexts(page)).some(t => /Best move saved \(unverified\)/.test(t)), "saved", 20000);
    await page.click("#active-jobs li button:has-text('Dismiss')");
    lichessBrowser = () => ({ status: 404, body: "" });
    // While Lichess's minute-long back-off lasts, the choice is offered at once.
    await toStart(page);
    await move(page, "b1", "c3");
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /Try again in about \d+ seconds.*Choose whether/.test(t)), "back-off remembered");
    await page.click("#active-jobs li button:has-text('Dismiss')");
    assert.match((await jobTexts(page)).join(" "), /Lichess Cloud rate limit/, "dismiss keeps the message, starts nothing");
    await page.click("#active-jobs li button:has-text('Dismiss')");
    await page.reload();   // a fresh page has no back-off
    await page.waitForSelector("#board .square");
  });

  await step("admin login unlocks depth and admin tools; a wrong key does not", async () => {
    await page.fill("#key-input", "not-the-token");
    await page.click("#key-login");
    await until(async () => /not recognised/.test(await text(page, "#status")), "refusal");
    assert.equal(await page.locator("#depth").isDisabled(), true);
    await page.fill("#key-input", ADMIN);
    await page.press("#key-input", "Enter");
    await until(async () => (await text(page, "#key-role")) === "Admin", "admin role");
    assert.equal(await page.locator("#depth").isDisabled(), false);
    await page.click("#advanced-settings summary");
    assert.equal(await page.locator("#admin-tools").isVisible(), true);
    assert.equal(await page.locator("#remove").isVisible(), true);
  });

  let importedCount = 0, castlingChecked = 0;
  if (savedPositionsFile && existsSync(savedPositionsFile)) {
    await step("the real saved_positions.json imports completely", async () => {
      const records = JSON.parse(readFileSync(savedPositionsFile, "utf8"));
      importedCount = records.length;
      await page.setInputFiles("#import-file", savedPositionsFile);
      await until(async () => /Import finished/.test(await text(page, "#admin-note")), "import", 60000);
      const note = await text(page, "#admin-note");
      const numbers = /(\d+) stored, (\d+) already present.*?(\d+) skipped/.exec(note).slice(1).map(Number);
      assert.equal(numbers[0] + numbers[1], records.length, note);
      assert.equal(numbers[2], 0, note);
      const saved = await apiSaved();
      const byKey = new Map(saved.map(e => [positionKey(e.fen), e]));
      const start = byKey.get(positionKey(START));
      const original = records.find(r => r.fen === START);
      assert.ok(start && original, "start position is in the data");
      assert.deepEqual([start.verified, start.evaluation, start.saved_at], [true, original.evaluation, new Date(original.saved_at).toISOString()]);
      // Castling that the old data spelled as "king takes rook" (e1h1) is
      // stored as the standard king move and highlighted as king + rook.
      const rookSpelled = records.filter(r => /^(e1h1|e1a1|e8h8|e8a8)$/.test(r.move_uci) && /^O-O/.test(r.move_san));
      for (const record of rookSpelled) {
        const stored = byKey.get(positionKey(record.fen));
        const expected = { e1h1: "e1g1", e1a1: "e1c1", e8h8: "e8g8", e8a8: "e8c8" }[record.move_uci];
        assert.equal(stored && stored.move_uci, expected, `castling in ${record.fen}`);
      }
      castlingChecked = rookSpelled.length;
      await toStart(page);
      await until(async () => (await savedSquares(page)).length >= 2, "start position highlight");
      assert.equal(await value(page, "#evaluation"), original.evaluation);
      assert.equal(await value(page, "#depth-result"), original.depth);
      assert.equal(await text(page, "#notation"), original.pv.join(" "), "line is shown exactly as before");
      // importing the same file again changes nothing
      await page.setInputFiles("#import-file", savedPositionsFile);
      await until(async () => /Import finished: 0 stored/.test(await text(page, "#admin-note")), "idempotent import", 60000);
      if (rookSpelled.length) {
        const record = rookSpelled[0];
        await page.fill("#fen", record.fen);
        await page.click("#load");
        await until(async () => (await savedSquares(page)).length === 2, "castling highlight");
        assert.deepEqual(await savedSquares(page), [square(record.move_uci.slice(0, 2)), square(record.move_uci.slice(2, 4))].sort((a, b) => a - b),
          "castling is highlighted on the king and the rook");
        assert.equal(await text(page, "#notation"), record.pv.join(" "));
      }
    });
  }

  await step("remove keeps history and restore brings the entry back", async () => {
    await toStart(page);
    await move(page, "e2", "e4"); await move(page, "e7", "e5");
    await until(async () => (await savedSquares(page)).length === 2, "highlight");
    const before = [await value(page, "#evaluation"), await value(page, "#depth-result")];
    await page.click("#remove");
    await until(async () => (await savedSquares(page)).length === 0, "removed");
    await page.click("#history-button");
    await until(async () => (await page.locator("#history-list li").count()) >= 1 && /removed/.test(await text(page, "#history-list")), "history list");
    await page.click("#history-list li button:has-text('Restore')");
    await until(async () => (await savedSquares(page)).length === 2, "restored");
    assert.deepEqual([await value(page, "#evaluation"), await value(page, "#depth-result")], before);
  });

  await step("contributor keys: create, use as verified, revoke", async () => {
    await page.fill("#new-key-label", "Tester");
    await page.click("#new-key-button");
    await until(async () => /mck_[A-Za-z0-9_-]{32}/.test(await text(page, "#admin-note")), "key shown once");
    const key = /mck_[A-Za-z0-9_-]{32}/.exec(await text(page, "#admin-note"))[0];
    assert.match(await text(page, "#key-list"), /Tester · 0 saved · active/);
    const session = await (await fetch(SITE + "/api/session", { headers: { "X-Key": key } })).json();
    assert.equal(session.role, "contributor");
    await page.click("#key-list li button:has-text('Revoke')");
    await until(async () => /Tester · 0 saved · revoked/.test(await text(page, "#key-list")), "revoked");
    assert.equal((await (await fetch(SITE + "/api/session", { headers: { "X-Key": key } })).json()).role, null);
  });

  await step("backup download contains everything", async () => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-button")]);
    const backup = JSON.parse(readFileSync(await download.path(), "utf8"));
    assert.equal(backup.saved.length, (await apiSaved()).length);
    assert.ok(backup.history.length >= 1 && backup.contributor_keys.length === 1);
    assert.ok(!JSON.stringify(backup).includes(ADMIN));
    // Importing the backup into itself changes nothing, and what was
    // unverified is still unverified afterwards.
    const before = await apiSaved();
    assert.ok(before.some(e => !e.verified), "the test database has unverified entries");
    await page.setInputFiles("#import-file", await download.path());
    await until(async () => /Import finished: 0 stored/.test(await text(page, "#admin-note")), "backup re-import", 60000);
    assert.deepEqual(await apiSaved(), before);
    // Remove one unverified and one verified entry, then restore from the backup.
    const byFen = list => new Map(list.map(e => [e.fen, e]));
    const lost = [before.find(e => !e.verified), before.find(e => e.verified)];
    for (const entry of lost) {
      const r = await fetch(SITE + "/api/remove", { method: "POST", headers: { "Content-Type": "application/json", "X-Key": ADMIN, Origin: SITE }, body: JSON.stringify({ fen: entry.fen }) });
      assert.deepEqual(await r.json(), { removed: true });
    }
    await page.setInputFiles("#import-file", await download.path());
    await until(async () => /Import finished: 2 stored/.test(await text(page, "#admin-note")), "restore from backup", 60000);
    const restored = byFen(await apiSaved());
    // (The stand-in engine's lines are not real chess; import keeps the legal
    // part of a line, which for a real engine is all of it.)
    for (const entry of lost) {
      assert.deepEqual(restored.get(entry.fen), { ...entry, pv: replayUci(entry.fen, entry.pv).uci }, "restored, verified flag included");
    }
    assert.equal(restored.get(lost[0].fen).verified, false);
    assert.equal(restored.get(lost[1].fen).verified, true);
  });

  await step("admin can analyse at a custom depth and the result is verified", async () => {
    await page.fill("#fen", START);   // the previous steps may have loaded another position
    await page.click("#load");
    await move(page, "a2", "a3");
    await page.fill("#depth", "12");
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /Analysis complete\. Best move saved\./.test(t)), "saved", 20000);
    assert.equal(await value(page, "#depth-result"), "Depth 12");
    await page.click("#active-jobs li button:has-text('Dismiss')");
    await page.click("#key-login");   // logout
    await until(async () => (await text(page, "#key-role")) === "", "logged out");
    assert.equal(await value(page, "#depth"), "46");
    assert.equal(await page.locator("#admin-tools").isVisible(), false);
  });

  await step("the depth field starts at 46 on every visit, also for the admin", async () => {
    assert.equal(await page.getAttribute("#depth", "autocomplete"), "off", "the browser must not restore an old value");
    await page.fill("#key-input", ADMIN);
    await page.press("#key-input", "Enter");
    await until(async () => (await text(page, "#key-role")) === "Admin", "admin role");
    await page.fill("#depth", "30");
    await page.reload();
    await page.waitForSelector("#board .square");
    await until(async () => (await text(page, "#key-role")) === "Admin", "still admin after reload");
    assert.equal(await value(page, "#depth"), "46");
    assert.equal(await page.locator("#depth").isDisabled(), false);
    await page.click("#key-login");   // logout
    await until(async () => (await text(page, "#key-role")) === "", "logged out");
  });

  const center = async (page, name) => {
    const box = await page.locator(`#board .square[data-index="${square(name)}"]`).boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  async function drawArrow(page, from, to) {
    await page.mouse.move(...await center(page, from));
    await page.mouse.down({ button: "right" });
    await page.mouse.move(...await center(page, to));
    await page.mouse.up({ button: "right" });
  }
  const annotations = page => page.locator("#annotation-layer > *").count();
  const jobItem = (page, index) => page.locator("#active-jobs li").nth(index);

  await step("a fifth analysis waits in the queue and starts by itself; annotations stay with their position", async () => {
    lichessBrowser = () => ({ status: 404, body: "" });
    lichessAnswer = () => ({ status: 404, body: "" });
    const before = (await apiSaved()).length;
    // Four analyses, each paused as soon as it runs: all four slots are taken.
    const openings = [["h2", "h4", "h7", "h5"], ["a2", "a4", "a7", "a5"], ["b1", "a3", "b8", "a6"], ["g1", "h3", "g8", "h6"]];
    for (const [index, [a, b, c, d]] of openings.entries()) {
      await toStart(page);
      await move(page, a, b); await move(page, c, d);
      await page.click("#analyze");
      await until(async () => /Analyzing Stockfish\.\.\. depth \d+\/46/.test(await jobItem(page, index).innerText()), `job ${index + 1} running`);
      await jobItem(page, index).locator("button:has-text('Pause')").click();
      await until(async () => /Paused at depth/.test(await jobItem(page, index).innerText()), `job ${index + 1} paused`);
    }
    // The fifth and sixth are accepted and wait.
    await toStart(page);
    await move(page, "h2", "h3"); await move(page, "h7", "h6");
    await page.click("#analyze");
    await until(async () => /Waiting for a free engine slot \(number 1 in the queue\)/.test(await jobItem(page, 4).innerText()), "fifth job queued");
    assert.equal(await text(page, "#analyze"), "Stop analysis");
    assert.equal(await jobItem(page, 4).locator("button:has-text('Pause')").isDisabled(), true, "a waiting job cannot be paused");
    await toStart(page);
    await move(page, "a2", "a3"); await move(page, "a7", "a6");
    await page.click("#analyze");
    await until(async () => /number 2 in the queue/.test(await jobItem(page, 5).innerText()), "sixth job queued");

    // An arrow drawn here must not show up on another analysis's position.
    await drawArrow(page, "e2", "e4");
    await drawArrow(page, "d2", "d2");
    assert.equal(await annotations(page), 3, "an arrow (line and head) and a circle are drawn");
    await jobItem(page, 0).locator(".job-opening").click();
    await until(async () => /Paused at depth/.test(await text(page, "#status")), "first job's position loaded");
    assert.equal(await annotations(page), 0, "annotations are cleared when another analysis's position is loaded");
    await drawArrow(page, "g1", "f3");
    assert.equal(await annotations(page), 2);
    await page.click("#advanced-settings summary");
    await page.click("#load");
    assert.equal(await annotations(page), 0, "annotations are cleared when a position is loaded from FEN");
    await page.click("#advanced-settings summary");

    // A page opened now shows the same six jobs in the same order.
    const second = await newPage();
    await until(async () => (await jobTexts(second)).length === 6, "jobs restored in a new page");
    const restored = await jobTexts(second);
    assert.ok(restored.slice(0, 4).every(t => /Paused at depth/.test(t)) && /number 1 in the queue/.test(restored[4]) && /number 2 in the queue/.test(restored[5]), restored.join(" | "));
    await second.close();

    // A waiting job can be dropped; the one before it keeps its place.
    await jobItem(page, 5).locator("button:has-text('Stop')").click();
    await until(async () => /Analysis stopped/.test(await jobItem(page, 5).innerText()), "sixth job dropped");
    assert.match(await jobItem(page, 4).innerText(), /number 1 in the queue/);
    // Ending one of the four lets the waiting one start, with nobody clicking.
    await jobItem(page, 0).locator("button:has-text('Stop')").click();
    await until(async () => /Analysis stopped/.test(await jobItem(page, 0).innerText()), "first job stopped");
    await until(async () => /Analyzing Stockfish\.\.\. depth \d+\/46|Best move saved/.test(await jobItem(page, 4).innerText()), "fifth job started by itself");
    await until(async () => /Best move saved \(unverified\)/.test(await jobItem(page, 4).innerText()), "fifth job saved", 20000);
    for (const index of [1, 2, 3]) await jobItem(page, index).locator("button:has-text('Resume')").click();
    await until(async () => (await jobTexts(page)).filter(t => /Best move saved/.test(t)).length === 4, "the paused ones finish too", 30000);
    assert.equal((await apiSaved()).length, before + 4);
    while (await page.locator("#active-jobs li button:has-text('Dismiss')").count()) await page.click("#active-jobs li button:has-text('Dismiss')");
    assert.match(bridge.output, /is waiting for a free slot/);
    assert.match(bridge.output, /starts: depth 46, \d+ threads, \d+ MB hash \(\d+ MB of memory was free\)/);
  });

  await step("another site cannot use the bridge from the browser", async () => {
    const evil = await context.newPage();
    await evil.goto("http://127.0.0.1:8790/nothing");   // a different origin
    const result = await evil.evaluate(async () => {
      const out = {};
      try { const r = await fetch("http://127.0.0.1:8765/api/status"); out.get = r.status; } catch (error) { out.get = "blocked"; }
      try {
        const r = await fetch("http://127.0.0.1:8765/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", depth: 5 }) });
        out.post = r.status;
      } catch (error) { out.post = "blocked"; }
      try {
        await fetch("http://127.0.0.1:8765/api/analyze", { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({ fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", depth: 5 }) });
        out.simple = "sent";
      } catch (error) { out.simple = "blocked"; }
      return out;
    });
    assert.deepEqual([result.get, result.post], ["blocked", "blocked"], JSON.stringify(result));
    const active = await (await fetch("http://127.0.0.1:8765/api/analyze")).json();
    assert.deepEqual(active, [], "no analysis was started by the other site");
    await evil.close();
  });

  await step("no script errors or CSP violations during the whole run", async () => {
    assert.deepEqual(problems, []);
  });

  console.log(`\ne2e: ${passed} steps passed${importedCount ? ` (imported ${importedCount} real positions, ${castlingChecked} castling entries checked)` : ""}`);
} catch (error) {
  console.log("FAILED");
  console.error(error);
  for (const child of children) console.error(`\n--- ${child.label} output ---\n${child.output.slice(-3000)}`);
  if (problems.length) console.error("page problems:", problems);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  for (const child of children) child.kill();
  fake.close();
  rmSync(work, { recursive: true, force: true });
}

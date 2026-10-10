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
// Live analysis is on by default. The steps written before it expect only
// saved and requested analyses on the page, so it starts off here; its own
// step turns it on.
await context.addInitScript(() => {
  try { if (localStorage.getItem("chessdb_live") === null) localStorage.setItem("chessdb_live", "off"); } catch (error) { /* another origin */ }
});
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
const bestSquares = page => page.$$eval("#board .square.best", nodes => nodes.map(node => Number(node.dataset.index)).sort((a, b) => a - b));
const liveSquares = page => page.$$eval("#board .square.live-best", nodes => nodes.map(node => Number(node.dataset.index)).sort((a, b) => a - b));
const FULL_GREEN = "rgb(114, 213, 114)";
// Everything the page shows about the analysis of the position on the board, read in one go.
const shown = page => page.evaluate(() => ({
  evaluation: document.querySelector("#evaluation").value,
  depth: document.querySelector("#depth-result").value,
  line: document.querySelector("#notation").innerText,
  // The progress of the analysis of this position, from its line in the list of analyses.
  job: document.querySelector("#active-jobs li .job-status")?.innerText || "",
  colours: [...document.querySelectorAll("#board .square.best")].map(node => getComputedStyle(node).backgroundColor),
  bar: {
    white: parseFloat(document.querySelector("#eval-bar-white").style.height),
    label: document.querySelector("#eval-bar-label").innerText,
    side: document.querySelector("#eval-bar-label").className,
    empty: document.querySelector("#eval-bar").classList.contains("empty"),
  },
}));
// How far a colour is from the full green, 0..441.
const distanceFromFull = colour => {
  const [r, g, b] = colour.match(/\d+/g).map(Number);
  return Math.hypot(r - 114, g - 213, b - 114);
};
const jobTexts = page => page.$$eval("#active-jobs li", nodes => nodes.map(node => node.innerText.replace(/\s+/g, " ")));
// Everything saved from the site (the admin's backup), in the shape the page is given entries.
const apiSaved = async () => (await (await fetch(SITE + "/api/export", { headers: { "X-Key": ADMIN } })).json()).saved.map(row => ({
  fen: row.fen, move_uci: row.move_uci, pv: row.pv, evaluation: row.evaluation, depth: row.depth, knodes: row.knodes,
  source: row.source, verified: row.verified === 1, saved_at: row.saved_at,
}));
// Which results are shown: "combined", "stockfish" or "lichess".
const showView = (page, name) => page.click(`#view-switch button[data-view="${name}"]`);

try {
  let page = await newPage();

  await step("page loads cleanly and does not touch the local bridge by itself", async () => {
    await sleep(500);
    assert.deepEqual(problems, []);
    assert.deepEqual(bridgeRequests, [], "no request to 127.0.0.1 before the user asks");
    assert.equal(await text(page, "#bridge-status"), "Engine bridge: not connected");
    assert.equal(await text(page, "#opening-status"), "Opening: Starting position");
    assert.equal(await value(page, "#depth"), "46");
    assert.equal(await page.locator("#depth").isDisabled(), false, "anyone may choose the depth");
    assert.equal(await page.getAttribute("#depth", "min"), "21");
    assert.equal(await page.locator("#remove").isVisible(), false);
    const bar = (await shown(page)).bar;
    assert.deepEqual([bar.empty, bar.white, bar.label], [true, 50, ""], "the evaluation bar is neutral without an analysis");
    const board = await page.locator("#board-wrap").boundingBox(), barBox = await page.locator("#eval-bar").boundingBox();
    assert.ok(barBox.x + barBox.width <= board.x && barBox.y === board.y && barBox.height === board.height, "the bar stands left of the board");
    const home = await fetch(SITE + "/"), csp = home.headers.get("content-security-policy") || "";
    assert.ok(csp.includes("script-src 'self' 'wasm-unsafe-eval';") && csp.includes("frame-ancestors 'none'"), csp);
    // Cross-origin isolated, so the browser engine can use several threads.
    assert.deepEqual([home.headers.get("cross-origin-opener-policy"), home.headers.get("cross-origin-embedder-policy")], ["same-origin", "credentialless"]);
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    assert.equal(await page.locator("#browser-engine").isVisible(), true, "the browser engine is offered without the bridge");
    assert.equal(await text(page, "#browser-engine-toggle"), "Use browser engine", "but not started without asking");
    // A first visit shows the combined results.
    assert.equal(await page.getAttribute("#view-switch button[data-view='combined']", "aria-pressed"), "true");
    assert.equal(await text(page, "#analyze"), "Find and save best move", "Combined has the analyse button too");
    assert.match(await text(page, "#view-note"), /the deeper of the Stockfish 19 and Lichess results\. Its button fetches Lichess's evaluation and runs Stockfish 19 at the same time/);
    await showView(page, "stockfish");
    assert.equal(await page.locator("#analyze").isVisible(), true);
    assert.equal(await text(page, "#analyze"), "Find and save best move");
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

  await step("while Stockfish runs the page follows it: best move, evaluation, line and bar", async () => {
    await page.click("#analyze");   // position after 1. e4, black to move, depth 46
    await until(async () => (await jobTexts(page)).some(t => /depth \d+\/46/.test(t)), "progress with depth");
    // One reading of the page while the engine is somewhere below depth 46.
    const live = await until(async () => {
      const now = await shown(page);
      return /^Stockfish 19 · Depth \d+ · still analysing$/.test(now.depth) ? now : null;
    }, "the running analysis on the page");
    const searching = Number(/depth (\d+)\/46/.exec(live.job)[1]), finished = Number(/Depth (\d+)/.exec(live.depth)[1]);
    assert.equal(finished, searching - 1, `searching depth ${searching}: the page shows the last finished depth`);
    assert.deepEqual([live.evaluation, live.line], ["-0.32", "e5 Nf3 Nc6 Bb5"]);
    assert.deepEqual(await bestSquares(page), [square("e7"), square("e5")].sort((a, b) => a - b), "best move so far is highlighted");
    assert.ok(live.colours.length === 2 && live.colours.every(colour => distanceFromFull(colour) > 40), `pale while below depth 46: ${live.colours}`);
    // Black is ahead by 0.32: White's part of the bar is a little under half.
    assert.ok(!live.bar.empty && live.bar.white > 40 && live.bar.white < 50, JSON.stringify(live.bar));
    assert.deepEqual([live.bar.label, live.bar.side], ["0.3", "for-black"]);
    assert.deepEqual(await apiSaved(), [], "nothing is saved while it runs");
  });

  await step("anonymous Stockfish analysis is saved as unverified and highlighted in full colour", async () => {
    await until(async () => (await jobTexts(page)).some(t => /Analysis complete\. Best move saved \(unverified\)\./.test(t)), "saved", 20000);
    assert.equal(await value(page, "#evaluation"), "-0.32");
    assert.equal(await value(page, "#depth-result"), "Stockfish 19 · Depth 46 · unverified");
    assert.equal(await text(page, "#notation"), "e5 Nf3 Nc6 Bb5");
    assert.deepEqual(await bestSquares(page), [square("e7"), square("e5")].sort((a, b) => a - b));
    assert.deepEqual((await shown(page)).colours, [FULL_GREEN, FULL_GREEN], "depth 46 is painted in the full green");
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
    assert.equal(await page.getAttribute("#view-switch button[data-view='stockfish']", "aria-pressed"), "true", "the chosen view is remembered");
    assert.deepEqual(await bestSquares(page), []);
    await move(page, "e2", "e4");
    await until(async () => (await bestSquares(page)).length === 2, "highlight");
    assert.equal(await value(page, "#depth-result"), "Stockfish 19 · Depth 46 · unverified");
  });

  await step("a second analysis that could not replace the saved one is refused up front", async () => {
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /depth 46 is already saved.*would not replace it/.test(t)), "refusal");
    await page.click("#active-jobs li button:has-text('Dismiss')");
  });

  let stoppedDepth;
  await step("pause freezes the engine, resume continues; stop saves the last finished depth", async () => {
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
    await until(async () => (await jobTexts(page)).some(t => /depth (2[3-9]|[34]\d)\/46/.test(t)), "past depth 21, the least that is saved");
    await page.click("#active-jobs li button:has-text('Stop')");
    await until(async () => (await jobTexts(page)).some(t => /Analysis stopped/.test(t)), "stopped");
    // Stopped while searching depth N: the result of depth N-1 is saved.
    const message = /Analysis stopped at depth (\d+)\. Depth (\d+) result saved \(unverified\)\./.exec((await jobTexts(page))[0]);
    assert.ok(message, (await jobTexts(page))[0]);
    stoppedDepth = Number(message[2]);
    assert.equal(stoppedDepth, Number(message[1]) - 1);
    assert.ok(stoppedDepth >= 21 && stoppedDepth < 46);
    const saved = (await apiSaved()).find(e => e.fen === START);
    assert.deepEqual([saved.depth, saved.verified, saved.move_uci, saved.evaluation], [stoppedDepth, false, "e2e4", "+0.32"]);
    assert.equal((await apiSaved()).length, 2);
    const now = await shown(page);
    assert.equal(now.depth, `Stockfish 19 · Depth ${stoppedDepth} · unverified`);
    assert.ok(now.colours.length === 2 && now.colours.every(colour => distanceFromFull(colour) > 40), `a shallow saved move is pale: ${now.colours}`);
    assert.deepEqual([now.bar.label, now.bar.side, now.bar.white > 50], ["0.3", "for-white", true], "White is ahead by 0.32");
    await page.click("#active-jobs li button:has-text('Dismiss')");
  });

  await step("a deeper saved analysis stays on screen until the running one has passed it", async () => {
    // The start position is saved at stoppedDepth. Analysing it again shows
    // the saved one while the engine is at or below that depth.
    await page.click("#analyze");
    const seen = { kept: 0, live: 0, wrong: [] };
    await until(async () => {
      const now = await shown(page);
      const running = /Analyzing Stockfish\.\.\. depth (\d+)\/46/.exec(now.job);
      if (running) {
        const finished = Number(running[1]) - 1;   // the page writes both from the same answer of the bridge
        const kept = finished <= stoppedDepth;
        const expected = kept ? `Stockfish 19 · Depth ${stoppedDepth} · unverified` : `Stockfish 19 · Depth ${finished} · still analysing`;
        if (now.depth !== expected) seen.wrong.push(`engine finished ${finished}: page shows "${now.depth}"`);
        seen[kept ? "kept" : "live"]++;
      }
      return /Best move saved \(unverified\)/.test(now.job);
    }, "second run saved", 20000);
    assert.deepEqual(seen.wrong, []);
    assert.ok(seen.kept >= 1 && seen.live >= 1, `saw both phases: ${JSON.stringify(seen)}`);
    const now = await shown(page);
    assert.equal(now.depth, "Stockfish 19 · Depth 46 · unverified", "the deeper result replaced the shallow one");
    assert.deepEqual(now.colours, [FULL_GREEN, FULL_GREEN]);
    assert.equal((await apiSaved()).length, 2);
    await page.click("#active-jobs li button:has-text('Dismiss')");
  });

  await step("the paler the green, the shallower the analysis; depth 45 is clearly short of depth 46", async () => {
    // Without a key: choose the depth, here 25 and then 45, for two new positions.
    await page.click("#advanced-settings summary");
    // Less than 21 cannot be chosen: the field corrects itself.
    await page.fill("#depth", "20");
    await page.press("#depth", "Tab");
    assert.equal(await value(page, "#depth"), "21");
    await page.fill("#depth", "9999");
    await page.press("#depth", "Tab");
    assert.equal(await value(page, "#depth"), "245");
    const colourAt = async (depth, from, to) => {
      await toStart(page);
      await move(page, from, to);
      await page.fill("#depth", String(depth));
      await page.click("#analyze");
      await until(async () => (await jobTexts(page)).some(t => /Best move saved \(unverified\)/.test(t)), `depth ${depth} saved`, 20000);
      const now = await shown(page);
      assert.equal(now.depth, `Stockfish 19 · Depth ${depth} · unverified`);
      await page.click("#active-jobs li button:has-text('Dismiss')");
      return now.colours;
    };
    const at25 = await colourAt(25, "h2", "h3"), at45 = await colourAt(45, "g2", "g3");
    await page.fill("#depth", "46");
    await page.click("#advanced-settings summary");
    // Both highlighted squares (e7 and e5, dark ones) get greener with depth ...
    for (const index of [0, 1]) {
      const [far, near] = [distanceFromFull(at25[index]), distanceFromFull(at45[index])];
      assert.ok(far > near + 8, `depth 25 (${at25[index]}) is paler than depth 45 (${at45[index]})`);
      // ... and depth 45 is still far from the full green of depth 46.
      assert.ok(near > 40, `depth 45 (${at45[index]}) must not be mistaken for depth 46 (${FULL_GREEN})`);
    }
    assert.equal((await apiSaved()).length, 4);
    await toStart(page);
  });

  await step("an analysis survives a reload and one that finishes while the page is closed is still saved", async () => {
    await move(page, "d2", "d4");
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /depth \d+\/46/.test(t)), "running");
    await page.reload();
    await page.waitForSelector("#board .square");
    await until(async () => (await jobTexts(page)).some(t => /A40 · Queen's Pawn Game.*(depth \d+\/46|Analysis complete)/.test(t)), "restored with its opening");
    await until(async () => (await jobTexts(page)).some(t => /Best move saved/.test(t)), "saved after reload", 20000);
    assert.equal((await apiSaved()).length, 5);
    await page.click("#active-jobs li button:has-text('Dismiss')");
    // now: start, close the page, let it finish, open again
    await move(page, "c2", "c4");
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /depth \d+\/46/.test(t)), "running");
    await page.close();
    await sleep(3500);
    assert.equal((await apiSaved()).length, 5, "nothing can be saved while no page is open");
    page = await newPage();
    await until(async () => (await apiSaved()).length === 6, "collected and saved after reopening", 20000);
    await until(async () => (await jobTexts(page)).some(t => /Best move saved/.test(t)), "shown as complete");
    await page.click("#active-jobs li button:has-text('Dismiss')");
  });

  const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  await step("Lichess view: its evaluation is saved beside the Stockfish result, from the server's own fetch", async () => {
    const cloud = { fen: afterE4, knodes: 1234, depth: 50, pvs: [{ moves: "c7c5 g1f3 d7d6", cp: 25 }, { moves: "e7e5 g1f3", cp: 20 }] };
    // The browser is shown a tampered copy; what is saved must be the server's.
    lichessBrowser = () => ({ status: 200, body: { ...cloud, depth: 99, pvs: [{ moves: "a7a6 a2a3", cp: 900 }] } });
    lichessAnswer = () => ({ status: 200, body: cloud });
    await showView(page, "lichess");
    await move(page, "e2", "e4");   // has a Stockfish result from the first analysis, nothing from Lichess
    await until(async () => (await text(page, "#analyze")) === "Get Lichess evaluation", "Lichess view");
    assert.deepEqual([await bestSquares(page), await value(page, "#depth-result")], [[], ""], "the Stockfish result is not shown in the Lichess view");
    const before = lichessServerCalls, savedBefore = (await apiSaved()).length;
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /Lichess evaluation saved \(depth 50\)\./.test(t)), "saved");
    assert.equal(lichessServerCalls, before + 1);
    assert.deepEqual([await value(page, "#evaluation"), await value(page, "#depth-result"), await text(page, "#notation")],
      ["+0.25", "Lichess · Depth 50 | 1234k nodes", "c5 Nf3 d6"]);
    assert.deepEqual(await bestSquares(page), [square("c7"), square("c5")].sort((a, b) => a - b));
    const both = (await apiSaved()).filter(e => e.fen === afterE4).map(e => [e.source, e.depth, e.verified, e.move_uci]).sort();
    assert.deepEqual(both, [["lichess", 50, true, "c7c5"], ["stockfish", 46, false, "e7e5"]], "one entry per engine for the same position");
    assert.equal((await apiSaved()).length, savedBefore + 1);
    await page.click("#active-jobs li button:has-text('Dismiss')");
    // Asking again: the server's own fetch is no deeper than what is saved.
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /A Lichess evaluation at depth 50 is already saved for this position/.test(t)), "not replaced");
    await page.click("#active-jobs li button:has-text('Dismiss')");
    // The same position in the other views.
    await showView(page, "stockfish");
    assert.deepEqual([await value(page, "#evaluation"), await value(page, "#depth-result"), await text(page, "#notation")],
      ["-0.32", "Stockfish 19 · Depth 46 · unverified", "e5 Nf3 Nc6 Bb5"]);
    assert.deepEqual(await bestSquares(page), [square("e7"), square("e5")].sort((a, b) => a - b));
    await showView(page, "combined");
    assert.equal(await value(page, "#depth-result"), "Lichess · Depth 50 | 1234k nodes", "combined shows the deeper of the two");
    assert.deepEqual(await bestSquares(page), [square("c7"), square("c5")].sort((a, b) => a - b));
    await showView(page, "lichess");
  });

  await step("Lichess view: an evaluation below depth 21 is shown but not saved; with none it says so", async () => {
    const shallow = { knodes: 77, depth: 18, pvs: [{ moves: "g8f6 b1c3", cp: 40 }] };
    lichessBrowser = () => ({ status: 200, body: shallow });
    lichessAnswer = () => ({ status: 200, body: shallow });
    await toStart(page);
    await move(page, "b2", "b3");
    const before = lichessServerCalls, savedBefore = (await apiSaved()).length;
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /Lichess has depth 18 for this position\. It is shown but not saved: the least that is saved is depth 21\./.test(t)), "explained");
    const now = await shown(page);
    assert.deepEqual([now.depth, now.evaluation, now.line], ["Lichess · Depth 18 | 77k nodes · not saved", "+0.40", "Nf6 Nc3"]);
    assert.deepEqual(await bestSquares(page), [square("g8"), square("f6")].sort((a, b) => a - b));
    assert.equal(lichessServerCalls, before, "the server was not asked to store it");
    // Sent straight to the server it is refused too.
    const direct = await fetch(SITE + "/api/saved", { method: "POST", headers: { "Content-Type": "application/json", Origin: SITE },
      body: JSON.stringify({ fen: "rnbqkbnr/pppppppp/8/8/8/1P6/P1PPPPPP/RNBQKBNR b KQkq - 0 1", source: "lichess" }) });
    assert.deepEqual([direct.status, (await direct.json()).code], [409, "LICHESS_TOO_SHALLOW"]);
    assert.equal((await apiSaved()).length, savedBefore);
    await page.click("#active-jobs li button:has-text('Dismiss')");
    assert.equal(await value(page, "#depth-result"), "", "dismissed: nothing is left on screen");
    // A position Lichess knows nothing about.
    lichessBrowser = () => ({ status: 404, body: "" });
    lichessAnswer = () => ({ status: 404, body: "" });
    await toStart(page);
    await move(page, "c2", "c3");
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /Lichess has no evaluation for this position\./.test(t)), "nothing at Lichess");
    await page.click("#active-jobs li button:has-text('Dismiss')");
  });

  await step("Lichess view: a rate limit is reported in the list, without a popup, and remembered", async () => {
    lichessBrowser = () => ({ status: 429, body: "" });
    await toStart(page);
    await move(page, "g1", "f3");
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /Lichess Cloud rate limit/.test(t)), "rate limit shown");
    await page.click("#active-jobs li button:has-text('Dismiss')");
    lichessBrowser = () => ({ status: 404, body: "" });
    // While Lichess's minute-long back-off lasts, it is not asked again.
    await toStart(page);
    await move(page, "b1", "c3");
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /Try again in about \d+ seconds/.test(t)), "back-off remembered");
    await page.click("#active-jobs li button:has-text('Dismiss')");
    await page.reload();   // a fresh page has no back-off
    await page.waitForSelector("#board .square");
    await showView(page, "stockfish");
  });

  await step("admin login unlocks the admin tools; a wrong key does not", async () => {
    await page.fill("#key-input", "not-the-token");
    await page.click("#key-login");
    await until(async () => /not recognised/.test(await text(page, "#status")), "refusal");
    await page.fill("#key-input", ADMIN);
    await page.press("#key-input", "Enter");
    await until(async () => (await text(page, "#key-role")) === "Admin", "admin role");
    await page.click("#advanced-settings summary");
    assert.equal(await page.locator("#admin-tools").isVisible(), true);
    assert.equal(await page.locator("#remove").isVisible(), true);
  });

  let importedCount = 0, castlingChecked = 0;
  if (savedPositionsFile && existsSync(savedPositionsFile)) {
    await step("the real saved_positions.json imports completely", async () => {
      await showView(page, "combined");
      const records = JSON.parse(readFileSync(savedPositionsFile, "utf8"));
      importedCount = records.length;
      await page.setInputFiles("#import-file", savedPositionsFile);
      await until(async () => /Import finished/.test(await text(page, "#admin-note")), "import", 60000);
      const note = await text(page, "#admin-note");
      const numbers = /(\d+) stored, (\d+) already present.*?(\d+) skipped/.exec(note).slice(1).map(Number);
      assert.equal(numbers[0] + numbers[1], records.length, note);
      assert.equal(numbers[2], 0, note);
      const saved = await apiSaved();
      // One entry per position and engine; the old file names the engine in its "source".
      const engineOf = record => /lichess/i.test(record.source) ? "lichess" : "stockfish";
      const byKey = new Map(saved.map(e => [`${e.source}|${positionKey(e.fen)}`, e]));
      const stored = record => byKey.get(`${engineOf(record)}|${positionKey(record.fen)}`);
      const original = records.find(r => r.fen === START);
      const start = stored(original);
      assert.ok(start && original, "start position is in the data");
      assert.deepEqual([start.verified, start.evaluation, start.saved_at], [true, original.evaluation, new Date(original.saved_at).toISOString()]);
      // Castling that the old data spelled as "king takes rook" (e1h1) is
      // stored as the standard king move and highlighted as king + rook.
      const rookSpelled = records.filter(r => /^(e1h1|e1a1|e8h8|e8a8)$/.test(r.move_uci) && /^O-O/.test(r.move_san));
      for (const record of rookSpelled) {
        const expected = { e1h1: "e1g1", e1a1: "e1c1", e8h8: "e8g8", e8a8: "e8c8" }[record.move_uci];
        assert.equal(stored(record)?.move_uci, expected, `castling in ${record.fen}`);
      }
      castlingChecked = rookSpelled.length;
      await toStart(page);
      await until(async () => (await bestSquares(page)).length >= 2, "start position highlight");
      assert.equal(await value(page, "#evaluation"), original.evaluation);
      // (The start position also has the Stockfish result of an earlier step; Lichess's is the deeper one.)
      assert.equal(await value(page, "#depth-result"), `Lichess · ${original.depth}`);
      assert.equal(await text(page, "#notation"), original.pv.join(" "), "line is shown exactly as before");
      // importing the same file again changes nothing
      await page.setInputFiles("#import-file", savedPositionsFile);
      await until(async () => /Import finished: 0 stored/.test(await text(page, "#admin-note")), "idempotent import", 60000);
      if (rookSpelled.length) {
        const record = rookSpelled[0];
        await page.fill("#fen", record.fen);
        await page.click("#load");
        await until(async () => (await bestSquares(page)).length === 2, "castling highlight");
        assert.deepEqual(await bestSquares(page), [square(record.move_uci.slice(0, 2)), square(record.move_uci.slice(2, 4))].sort((a, b) => a - b),
          "castling is highlighted on the king and the rook");
        assert.equal(await text(page, "#notation"), record.pv.join(" "));
      }
    });
  }

  await step("remove takes away one engine's entry and keeps the other; restore brings it back", async () => {
    await showView(page, "combined");
    // This position has a Stockfish result and a deeper Lichess one (from the
    // steps above, or from the imported file where that has a deeper one).
    const label = e => `${e.source === "lichess" ? "Lichess" : "Stockfish 19"} · Depth ${e.depth}${e.knodes ? ` | ${e.knodes}k nodes` : ""}${e.verified ? "" : " · unverified"}`;
    const entries = (await apiSaved()).filter(e => e.fen === afterE4);
    const ofLichess = entries.find(e => e.source === "lichess"), ofStockfish = entries.find(e => e.source === "stockfish");
    assert.ok(entries.length === 2 && ofLichess.depth > ofStockfish.depth, JSON.stringify(entries.map(e => [e.source, e.depth])));
    await page.fill("#fen", afterE4);
    await page.click("#load");
    await until(async () => (await value(page, "#depth-result")) === label(ofLichess), "the deeper one, Lichess's, is shown");
    const before = [await value(page, "#evaluation"), await value(page, "#depth-result"), await bestSquares(page)];
    await page.click("#remove");
    await until(async () => (await value(page, "#depth-result")) === label(ofStockfish), "Lichess's entry is gone, the Stockfish one stays");
    assert.match(await text(page, "#status"), /^Lichess move removed/);
    await page.click("#history-button");
    await until(async () => /^Lichess · \S+ · .* removed/.test(await text(page, "#history-list li >> nth=0")), "history names the engine");
    await page.click("#history-list li button:has-text('Restore') >> nth=0");
    await until(async () => (await value(page, "#depth-result")) === before[1], "restored");
    assert.deepEqual([await value(page, "#evaluation"), await value(page, "#depth-result"), await bestSquares(page)], before);
    assert.deepEqual((await apiSaved()).filter(e => e.fen === afterE4), entries, "both entries are as they were");
  });

  await step("contributor keys: create, use as verified, revoke", async () => {
    await page.fill("#new-key-label", "Tester");
    await page.click("#new-key-button");
    await until(async () => /mck_[A-Za-z0-9_-]{32}/.test(await text(page, "#admin-note")), "key shown once");
    const key = /mck_[A-Za-z0-9_-]{32}/.exec(await text(page, "#admin-note"))[0];
    // The list is fetched after the key is shown, so it can lag a moment behind the note.
    await until(async () => /Tester · 0 saved · active/.test(await text(page, "#key-list")), "new key listed");
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
    const byFen = list => new Map(list.map(e => [`${e.source}|${e.fen}`, e]));
    const lost = [before.find(e => !e.verified), before.find(e => e.verified)];
    for (const entry of lost) {
      const r = await fetch(SITE + "/api/remove", { method: "POST", headers: { "Content-Type": "application/json", "X-Key": ADMIN, Origin: SITE }, body: JSON.stringify({ fen: entry.fen, source: entry.source }) });
      assert.equal((await r.json()).removed, true);
    }
    await page.setInputFiles("#import-file", await download.path());
    await until(async () => /Import finished: 2 stored/.test(await text(page, "#admin-note")), "restore from backup", 60000);
    const restored = byFen(await apiSaved());
    // (The stand-in engine's lines are not real chess; import keeps the legal
    // part of a line, which for a real engine is all of it.)
    for (const entry of lost) {
      assert.deepEqual(restored.get(`${entry.source}|${entry.fen}`), { ...entry, pv: replayUci(entry.fen, entry.pv).uci }, "restored, verified flag and engine included");
    }
    assert.equal(restored.get(`${lost[0].source}|${lost[0].fen}`).verified, false);
    assert.equal(restored.get(`${lost[1].source}|${lost[1].fen}`).verified, true);
  });

  await step("admin can analyse at a custom depth and the result is verified", async () => {
    await showView(page, "stockfish");
    await page.fill("#fen", START);   // the previous steps may have loaded another position
    await page.click("#load");
    await move(page, "a2", "a3");
    await page.fill("#depth", "22");
    await page.click("#analyze");
    await until(async () => (await jobTexts(page)).some(t => /Analysis complete\. Best move saved\./.test(t)), "saved", 20000);
    assert.equal(await value(page, "#depth-result"), "Stockfish 19 · Depth 22");
    // The least depth holds for the admin too, typed or sent straight to the server.
    await page.fill("#depth", "12");
    await page.press("#depth", "Tab");
    assert.equal(await value(page, "#depth"), "21");
    await page.fill("#depth", "22");
    const refused = await fetch(SITE + "/api/saved", { method: "POST", headers: { "Content-Type": "application/json", "X-Key": ADMIN, Origin: SITE },
      body: JSON.stringify({ fen: START, source: "stockfish", depth: 20, pv: ["e2e4"], evaluation: "+0.10" }) });
    assert.deepEqual([refused.status, (await refused.json()).code], [400, "DEPTH_TOO_LOW"]);
    await page.click("#active-jobs li button:has-text('Dismiss')");
    await page.click("#key-login");   // logout
    await until(async () => (await text(page, "#key-role")) === "", "logged out");
    assert.equal(await page.locator("#admin-tools").isVisible(), false);
  });

  await step("the depth field starts at 46 on every visit, whoever is visiting", async () => {
    assert.equal(await page.getAttribute("#depth", "autocomplete"), "off", "the browser must not restore an old value");
    await page.fill("#key-input", ADMIN);
    await page.press("#key-input", "Enter");
    await until(async () => (await text(page, "#key-role")) === "Admin", "admin role");
    await page.fill("#depth", "30");
    await page.reload();
    await page.waitForSelector("#board .square");
    await until(async () => (await text(page, "#key-role")) === "Admin", "still admin after reload");
    assert.equal(await value(page, "#depth"), "46");
    await page.click("#key-login");   // logout
    await until(async () => (await text(page, "#key-role")) === "", "logged out");
    await page.click("#advanced-settings summary");
    await page.fill("#depth", "30");
    await page.reload();
    await page.waitForSelector("#board .square");
    await until(async () => /Stockfish 19 ready/.test(await text(page, "#bridge-status")), "reconnected");
    assert.equal(await value(page, "#depth"), "46");
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

  await step("a piece drag cancelled with the right button leaves the next right-drag working at the first try", async () => {
    await toStart(page);
    const position = await value(page, "#fen");
    // Whichever button is let go first after the cancel.
    for (const rightFirst of [true, false]) {
      await page.mouse.move(...await center(page, "e2"));
      await page.mouse.down();
      await page.mouse.move(...await center(page, "e4"), { steps: 4 });
      await page.mouse.down({ button: "right" });   // cancels the drag
      if (rightFirst) { await page.mouse.up({ button: "right" }); await page.mouse.up(); }
      else { await page.mouse.up(); await page.mouse.up({ button: "right" }); }
      assert.equal(await value(page, "#fen"), position, "the piece went back");
      assert.equal(await annotations(page), 0, "cancelling draws nothing");
      await drawArrow(page, "g1", "f3");
      assert.equal(await annotations(page), 2, `the first right-drag after the cancel draws its arrow (right button released ${rightFirst ? "first" : "last"})`);
      await drawArrow(page, "g1", "f3");   // the same arrow again takes it away
      assert.equal(await annotations(page), 0);
    }
  });

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
      // Depth 2 or more on the page: at least depth 1 has been searched to the end.
      await until(async () => /Analyzing Stockfish\.\.\. depth ([2-9]|\d\d)\/46/.test(await jobItem(page, index).innerText()), `job ${index + 1} running`);
      await jobItem(page, index).locator("button:has-text('Pause')").click();
      await until(async () => /Paused at depth/.test(await jobItem(page, index).innerText()), `job ${index + 1} paused`);
    }
    // The fifth and sixth are accepted and wait.
    await toStart(page);
    await move(page, "h2", "h3"); await move(page, "h7", "h6");
    await page.click("#analyze");
    await until(async () => /Waiting for a free engine slot \(number 1 in the queue\)/.test(await jobItem(page, 4).innerText()), "fifth job queued");
    assert.equal(await text(page, "#analyze"), "Stop analysis");
    await toStart(page);
    await move(page, "a2", "a3"); await move(page, "a7", "a6");
    await page.click("#analyze");
    await until(async () => /number 2 in the queue/.test(await jobItem(page, 5).innerText()), "sixth job queued");
    // Pausing a waiting job holds it: the one behind it moves up.
    await jobItem(page, 4).locator("button:has-text('Pause')").click();
    await until(async () => /Paused while waiting in the queue/.test(await jobItem(page, 4).innerText()), "fifth job held");
    await until(async () => /number 1 in the queue/.test(await jobItem(page, 5).innerText()), "sixth job moved up");
    await jobItem(page, 4).locator("button:has-text('Resume')").click();
    await until(async () => /number 1 in the queue/.test(await jobItem(page, 4).innerText()), "fifth job back in line");
    await until(async () => /number 2 in the queue/.test(await jobItem(page, 5).innerText()), "sixth job second again");

    // An arrow drawn here must not show up on another analysis's position.
    await drawArrow(page, "e2", "e4");
    await drawArrow(page, "d2", "d2");
    assert.equal(await annotations(page), 3, "an arrow (line and head) and a circle are drawn");
    await jobItem(page, 0).locator(".job-opening").click();
    await until(async () => /^Loaded /.test(await text(page, "#status")), "first job's position loaded");
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
    // Four ran to the end. The first was stopped a few depths in: below depth 21 nothing is saved.
    assert.match(await jobItem(page, 0).innerText(), /Analysis stopped at depth \d+\. Nothing was saved: depth \d+ had been finished, and the least that is saved is depth 21\./);
    assert.equal((await apiSaved()).length, before + 4);
    while (await page.locator("#active-jobs li button:has-text('Dismiss')").count()) await page.click("#active-jobs li button:has-text('Dismiss')");
    assert.match(bridge.output, /is waiting for a free slot/);
    assert.match(bridge.output, /starts: depth 46, \d+ threads, \d+ MB hash \(\d+ MB of memory was free\)/);
  });

  await step("the positions one move away come with a position; captures sit beside their side of the board", async () => {
    const AFTER_NC3 = "rnbqkbnr/pppppppp/8/8/8/2N5/PPPPPPPP/R1BQKBNR b KQkq - 1 1";
    const saved = await fetch(SITE + "/api/saved", { method: "POST", headers: { "Content-Type": "application/json", "X-Key": ADMIN, Origin: SITE },
      body: JSON.stringify({ fen: AFTER_NC3, source: "stockfish", depth: 30, pv: ["g8f6", "d2d4"], evaluation: "+0.11" }) });
    assert.equal(saved.status, 200);
    // Wait for the start position to be fetched (with its next positions), then hold back
    // any request about the position after 1. Nc3 itself: what it shows must come from before.
    const startFetched = context.waitForEvent("response", response => /\/api\/position\?next=1/.test(response.url()));
    const fresh = await newPage();
    await startFetched;
    let held = 0;
    await fresh.route(url => url.pathname === "/api/position" && /\/2N5\//.test(url.searchParams.get("fen") || ""), async route => {
      held++;
      await sleep(3000);
      await route.continue().catch(() => {});
    });
    const shownAt = Date.now();
    await move(fresh, "b1", "c3");
    await until(async () => /Stockfish 19 · Depth 30/.test((await shown(fresh)).depth), "result shown at once", 1500);
    assert.ok(Date.now() - shownAt < 1500 && held <= 1, `shown after ${Date.now() - shownAt} ms`);
    await fresh.unrouteAll({ behavior: "ignoreErrors" });
    // White takes a pawn: White's captures are below the board, Black's above; flipped, the other way round.
    await move(fresh, "d7", "d5"); await move(fresh, "c3", "d5");
    const sides = () => fresh.evaluate(() => ["#captured-top", "#captured-bottom"].map(id => {
      const box = document.querySelector(id);
      return `${box.innerText.replace(/\s+/g, " ").trim()}:${box.querySelectorAll("img").length}`;
    }));
    assert.deepEqual(await sides(), ["Black captured:0", "White captured +1:1"]);
    const top = await fresh.locator("#captured-top").boundingBox(), board = await fresh.locator("#board-wrap").boundingBox(),
      bottom = await fresh.locator("#captured-bottom").boundingBox();
    assert.ok(top.y + top.height <= board.y && bottom.y >= board.y + board.height, "one above the board, one below");
    await fresh.click("#flip");
    assert.deepEqual(await sides(), ["White captured +1:1", "Black captured:0"]);
    await fresh.close();
  });

  await step("Combined: the button fetches Lichess's evaluation and runs Stockfish at the same time", async () => {
    const play = (p, uci) => move(p, uci.slice(0, 2), uci.slice(2, 4));
    const keyAfter = uci => positionKey(`${replayUci(START, [uci]).keys[0]} 0 1`);
    const savedKeys = new Set((await apiSaved()).map(e => positionKey(e.fen)));
    const fresh = ["c2c3", "f2f3", "a2a3", "h2h3", "b2b3"].find(uci => !savedKeys.has(keyAfter(uci)));
    const cloud = { knodes: 321, depth: 40, pvs: [{ moves: "d7d5 d2d4", cp: 12 }] };
    lichessBrowser = () => ({ status: 200, body: cloud });
    lichessAnswer = () => ({ status: 200, body: cloud });
    const combined = await newPage();
    await showView(combined, "combined");
    await until(async () => /Stockfish 19 ready/.test(await text(combined, "#bridge-status")), "bridge connected");
    await play(combined, fresh);
    assert.equal(await text(combined, "#analyze"), "Find and save best move");
    await combined.click("#analyze");
    // Both run: one line each in the list, and the button stops them.
    await until(async () => (await jobTexts(combined)).length === 2, "two analyses listed");
    await until(async () => (await jobTexts(combined)).some(t => /Lichess evaluation saved \(depth 40\)\./.test(t)), "Lichess saved");
    await until(async () => (await jobTexts(combined)).some(t => /Analysis complete\. Best move saved/.test(t)), "Stockfish saved", 20000);
    const entries = (await apiSaved()).filter(e => positionKey(e.fen) === keyAfter(fresh)).map(e => [e.source, e.depth]).sort();
    assert.deepEqual(entries, [["lichess", 40], ["stockfish", 46]], "each engine's result is saved under its own engine");
    assert.match(await value(combined, "#depth-result"), /^Stockfish 19 · Depth 46/, "Combined shows the deeper one");
    // Pressed again while both results are still listed: nothing is run twice.
    await combined.click("#analyze");
    assert.match(await text(combined, "#status"), /^Dismiss the finished results before analyzing this position again\.$/);
    while (await combined.locator("#active-jobs li button:has-text('Dismiss')").count()) await combined.click("#active-jobs li button:has-text('Dismiss')");
    // Stop while running stops both.
    await toStart(combined);
    const another = ["g2g3", "d2d3", "e2e3", "b1a3"].find(uci => !savedKeys.has(keyAfter(uci)) && uci !== fresh);
    lichessBrowser = () => ({ status: 404, body: "" });
    lichessAnswer = () => ({ status: 404, body: "" });
    await play(combined, another);
    await combined.click("#analyze");
    await until(async () => (await text(combined, "#analyze")) === "Stop analysis" && (await jobTexts(combined)).some(t => /Analyzing Stockfish/.test(t)), "running");
    await combined.click("#analyze");
    await until(async () => (await jobTexts(combined)).some(t => /Analysis stopped/.test(t)), "stopped");
    assert.equal(await text(combined, "#analyze"), "Find and save best move");
    while (await combined.locator("#active-jobs li button:has-text('Dismiss')").count()) await combined.click("#active-jobs li button:has-text('Dismiss')");
    await combined.close();
  });

  await step("live analysis: each position is analysed while it is shown; the deeper result is shown, and saved once it is deeper than the saved one", async () => {
    const keyAfter = uci => positionKey(`${replayUci(START, [uci]).keys[0]} 0 1`);
    const stockfishAt = async key => (await apiSaved()).find(e => e.source === "stockfish" && positionKey(e.fen) === key);
    const play = (p, uci) => move(p, uci.slice(0, 2), uci.slice(2, 4));
    const stockfishKeys = new Set((await apiSaved()).filter(e => e.source === "stockfish").map(e => positionKey(e.fen)));
    const unsaved = ["a2a3", "h2h3", "a2a4", "h2h4", "b2b3", "g2g3"].find(uci => !stockfishKeys.has(keyAfter(uci)));
    const unsavedKey = keyAfter(unsaved), e4Key = keyAfter("e2e4");
    const e4Before = await stockfishAt(e4Key);
    assert.ok(e4Before, "1. e4 has a saved Stockfish analysis from the steps above");
    const bridgeLive = async () => (await fetch("http://127.0.0.1:8765/api/live")).json();
    const depthOf = label => Number((/Depth (\d+)/.exec(label) || [])[1]);
    const livePage = await newPage();
    await showView(livePage, "stockfish");
    await until(async () => /Stockfish 19 ready/.test(await text(livePage, "#bridge-status")), "bridge connected");
    // With a key the live analysis is saved as verified, as from the analyse button.
    const keyed = (await text(livePage, "#key-role")) !== "";
    assert.equal(await text(livePage, "#live-toggle"), "Live analysis: off");
    await play(livePage, unsaved);
    await sleep(500);
    assert.deepEqual([await liveSquares(livePage), await value(livePage, "#depth-result")], [[], ""], "off: nothing is analysed");

    await livePage.click("#live-toggle");
    assert.equal(await text(livePage, "#live-toggle"), "Live analysis: on");
    const found = await until(async () => {
      const now = await shown(livePage);
      return /^Stockfish 19 · Depth \d+ \| \d+k nodes · live analysis(, saved from depth 21)?$/.test(now.depth) && depthOf(now.depth) >= 3 ? now : null;
    }, "live analysis on the page");
    assert.equal(found.evaluation, "-0.32");
    assert.match(found.line, /^e5 Nf3/);
    assert.deepEqual(await liveSquares(livePage), [square("e7"), square("e5")].sort((a, b) => a - b), "the best move so far is highlighted");
    assert.deepEqual(await bestSquares(livePage), [], "but not in green");
    const purple = await livePage.$$eval("#board .square.live-best", nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
    assert.ok(purple.every(colour => distanceFromFull(colour) > 100), `purple, far from the green: ${purple}`);
    assert.ok(!found.bar.empty && found.bar.side === "for-black", JSON.stringify(found.bar));
    const running = await bridgeLive();
    assert.deepEqual([running.status, positionKey(running.fen)], ["running", unsavedKey]);

    // Saved as soon as it reaches the least depth that is saved ...
    const first = await until(() => stockfishAt(unsavedKey), "saved from depth 21");
    assert.ok(first.depth >= 21 && first.move_uci === "e7e5" && first.verified === keyed, JSON.stringify(first));
    // ... then at most every 30 seconds while the position stays on the board ...
    await sleep(1500);
    assert.equal((await stockfishAt(unsavedKey)).depth, first.depth, "not saved again within 30 seconds");
    const reached = depthOf(await value(livePage, "#depth-result"));
    assert.ok(reached > first.depth, `the search went on: ${reached}`);
    // ... and leaving it saves the deepest result at once.
    await toStart(livePage);
    const flushed = await until(async () => { const entry = await stockfishAt(unsavedKey); return entry.depth > first.depth ? entry : null; }, "saved on leaving");
    assert.ok(flushed.depth >= reached, `${flushed.depth} >= ${reached}`);

    // A position with a deeper saved analysis shows that one, in green, until
    // the live analysis passes it; past it, the live analysis is shown and saved.
    await play(livePage, "e2e4");
    const before = await shown(livePage);
    assert.ok(depthOf(before.depth) === e4Before.depth && !/live analysis/.test(before.depth), before.depth);
    assert.equal((await bestSquares(livePage)).length, 2);
    const passed = await until(async () => {
      const now = await shown(livePage);
      return /live analysis/.test(now.depth) && depthOf(now.depth) > e4Before.depth ? now : null;
    }, "the live analysis passes the saved depth", 20000);
    assert.equal((await liveSquares(livePage)).length, 2);
    if (keyed || !e4Before.verified) {
      await until(async () => (await stockfishAt(e4Key)).depth > e4Before.depth, "saved past the saved depth");
    } else {
      // Without a key a verified analysis is never replaced.
      assert.match(passed.depth, /, not saved$/);
      await sleep(1000);
      assert.equal((await stockfishAt(e4Key)).depth, e4Before.depth);
    }

    // Back again: shown at once, at least as deep as before.
    await toStart(livePage);
    await play(livePage, unsaved);
    assert.ok(depthOf((await shown(livePage)).depth) >= flushed.depth, "shown again at once");
    await until(async () => { const now = await bridgeLive(); return now.status === "running" && positionKey(now.fen) === unsavedKey; }, "searching again");

    // Off: the saved analysis is shown, the search stops, and the choice is remembered.
    await livePage.click("#live-toggle");
    assert.deepEqual(await liveSquares(livePage), []);
    assert.doesNotMatch(await value(livePage, "#depth-result"), /live analysis/);
    await until(async () => (await bridgeLive()).status === "idle", "stopped when turned off");
    await livePage.reload();
    await livePage.waitForSelector("#board .square");
    assert.equal(await text(livePage, "#live-toggle"), "Live analysis: off");
    await livePage.close();
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

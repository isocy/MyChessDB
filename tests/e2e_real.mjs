// Real-engine check (Linux x86-64, needs internet access to github.com):
//
//   node tests/e2e_real.mjs
//
// Uses the exact bridge file users download (web/bridge/...), lets it fetch
// the official Stockfish 19 from GitHub, and analyses with it from the page.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import * as chess from "../web/chesslib.js";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch (error) {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || "/opt/npm-tools/node_modules/playwright"));
}
const root = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "mychessdb-real-"));
const SITE = "http://localhost:8787";
const ADMIN = "real-admin-token-0123456789";
const children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (error) { last = error.message; }
    await sleep(150);
  }
  throw new Error(`timed out waiting for: ${what} (last: ${JSON.stringify(last)})`);
}
let passed = 0;
async function step(name, run) { process.stdout.write(`- ${name} ... `); await run(); passed++; console.log("ok"); }
function launch(label, command, args, env) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.output = ""; child.label = label;
  child.stdout.on("data", d => { child.output += d; });
  child.stderr.on("data", d => { child.output += d; });
  children.push(child);
  return child;
}
const stockfishProcesses = () => readdirSync("/proc").filter(name => /^\d+$/.test(name)).filter(pid => {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(join(work, "home")); } catch (error) { return false; }
}).map(pid => ({ pid, state: readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] }));

launch("dev server", process.execPath, ["--no-warnings", join(root, "scripts", "dev_server.mjs")],
  { PORT: "8787", DEV_DB: ":memory:", ADMIN_TOKEN: ADMIN, MIN_DEPTH: "14", LICHESS_API_BASE: "http://127.0.0.1:9" });
await until(async () => (await fetch(SITE + "/api/session")).ok, "dev server");
const bridgeFile = join(root, "web", "bridge", "mychessdb-bridge-linux-amd64");
assert.ok(existsSync(bridgeFile), "run scripts/build_bridge.sh first");
const startBridge = () => launch("bridge", bridgeFile, ["-site", SITE, "-no-open"], { MYCHESSDB_HOME: join(work, "home") });

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
const problems = [];
page.on("pageerror", error => problems.push(error.message));
await page.route("https://raw.githubusercontent.com/**", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" }));
await page.route("https://lichess.org/**", route => route.fulfill({ status: 404, body: "" }));
const text = selector => page.locator(selector).innerText();
const value = selector => page.locator(selector).inputValue();
const square = name => "abcdefgh".indexOf(name[0]) + (8 - Number(name[1])) * 8;
const move = async (from, to) => { await page.click(`#board .square[data-index="${square(from)}"]`); await page.click(`#board .square[data-index="${square(to)}"]`); };
const jobs = () => page.$$eval("#active-jobs li", nodes => nodes.map(node => node.innerText.replace(/\s+/g, " ")));

let bridge;
try {
  await page.goto(SITE + "/");
  await page.waitForSelector("#board .square");

  await step("released bridge downloads and verifies the official Stockfish 19", async () => {
    await page.click("#bridge-connect");
    await page.waitForSelector("#bridge-setup", { state: "visible" });
    bridge = startBridge();
    await until(async () => /Stockfish 19 ready/.test(await text("#bridge-status")), "engine ready", 180000);
    assert.match(bridge.output, /Stockfish 19 is installed/);
    const settings = JSON.parse(readFileSync(join(work, "home", "bridge.json"), "utf8"));
    assert.match(settings.engine_path, /engines[\\/]sf_19[\\/]stockfish-linux-x86-64-universal$/);
    console.log(`\n    ${await text("#bridge-status")}`);
  });

  await step("a real analysis is run, shown and saved", async () => {
    await move("e2", "e4");
    await page.click("#analyze");
    await until(async () => (await jobs()).some(t => /Best move saved \(unverified\)/.test(t)), "saved", 120000);
    const evaluation = await value("#evaluation"), depth = await value("#depth-result"), line = await text("#notation");
    assert.match(evaluation, /^[+-]\d+\.\d\d$/);
    assert.equal(depth, "Depth 14 · unverified");
    const entry = (await (await fetch(SITE + "/api/saved")).json()).entries[0];
    const replay = chess.replayUci(entry.fen, entry.pv);
    assert.ok(replay.complete && replay.san.length >= 1, "the stored line is fully legal");
    assert.equal(line, replay.san.join(" "));
    assert.equal(entry.depth, 14);
    assert.equal((await page.$$("#board .square.saved")).length, 2);
    console.log(`\n    1. e4 -> ${line}  (${evaluation}, ${depth})`);
    await page.click("#active-jobs li button:has-text('Dismiss')");
    await until(() => stockfishProcesses().length === 0, "engine exits after the analysis");
  });

  await step("pause really freezes Stockfish; resume and stop work", async () => {
    await page.fill("#key-input", ADMIN); await page.press("#key-input", "Enter");
    await until(async () => (await text("#key-role")) === "Admin", "admin");
    await page.click("#advanced-settings summary");
    await page.fill("#depth", "60");
    await move("e7", "e5");
    await page.click("#analyze");
    await until(async () => (await jobs()).some(t => /Analyzing Stockfish\.\.\. depth [1-9]\d*\/60/.test(t)), "running", 60000);
    await until(() => stockfishProcesses().length === 1, "one engine process");
    // Every Stockfish thread runs at lowered priority (nice 10).
    const pid = stockfishProcesses()[0].pid;
    const nices = readdirSync(`/proc/${pid}/task`).map(tid => Number(readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8").split(") ")[1].split(" ")[16]));
    assert.ok(nices.length >= 2 && nices.every(n => n === 10), `nice values: ${nices}`);
    await page.click("#active-jobs li button:has-text('Pause')");
    await until(() => stockfishProcesses().every(p => p.state === "T"), "process stopped (state T)");
    await sleep(1500);
    const frozen = (await jobs())[0];
    await sleep(2000);
    assert.equal((await jobs())[0], frozen, "no progress while paused");
    assert.match(frozen, /Paused at depth \d+\/60/);
    await page.click("#active-jobs li button:has-text('Resume')");
    await until(() => stockfishProcesses().every(p => p.state !== "T"), "process running again");
    await until(async () => /Analyzing/.test((await jobs())[0]), "resumed");
    await page.click("#active-jobs li button:has-text('Stop')");
    await until(async () => (await jobs()).some(t => /Analysis stopped/.test(t)), "stopped");
    await until(() => stockfishProcesses().length === 0, "engine process is gone");
    await page.click("#active-jobs li button:has-text('Dismiss')");
  });

  await step("closing the bridge ends a running (even paused) Stockfish", async () => {
    await page.click("#analyze");
    await until(() => stockfishProcesses().length === 1, "engine running", 30000);
    await page.click("#active-jobs li button:has-text('Pause')");
    await until(() => stockfishProcesses().every(p => p.state === "T"), "paused");
    bridge.kill("SIGTERM");
    await until(() => stockfishProcesses().length === 0, "no Stockfish left behind");
    await until(async () => (await jobs()).some(t => /Lost contact with the engine bridge|not running/.test(t)), "page reports the lost bridge", 15000);
    await until(async () => (await text("#bridge-status")) === "Engine bridge: not connected", "status line notices", 15000);
  });

  assert.deepEqual(problems, []);
  console.log(`\ne2e (real Stockfish 19): ${passed} steps passed`);
} catch (error) {
  console.log("FAILED");
  console.error(error);
  for (const child of children) console.error(`\n--- ${child.label} output ---\n${child.output.slice(-2500)}`);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  for (const child of children) child.kill();
  rmSync(work, { recursive: true, force: true });
}

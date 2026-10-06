// Run the whole site on this computer without Cloudflare or wrangler:
//
//   node scripts/dev_server.mjs            -> http://localhost:8787
//
// It serves web/ and runs worker/index.js against a local SQLite file
// (.dev/mychessdb.sqlite) through the D1 stand-in in d1_local.mjs.
// Environment: PORT, ADMIN_TOKEN, MIN_DEPTH, ANON_WRITES_PER_HOUR,
// LICHESS_API_BASE, DEV_DB (":memory:" for a throwaway database).
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { LocalD1 } from "./d1_local.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const webRoot = join(root, "web");
const port = Number(process.env.PORT || 8787);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".sh": "text/plain; charset=utf-8", ".ps1": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

// Apply web/_headers the way Cloudflare does (exact paths and "/*").
function loadHeaderRules() {
  const file = join(webRoot, "_headers");
  if (!existsSync(file)) return [];
  const rules = [];
  let current = null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { current = { pattern: line.trim(), headers: [] }; rules.push(current); continue; }
    const split = line.indexOf(":");
    if (current && split > 0) current.headers.push([line.slice(0, split).trim(), line.slice(split + 1).trim()]);
  }
  return rules;
}
const headerRules = loadHeaderRules();

async function serveAsset(request) {
  const url = new URL(request.url);
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(webRoot, path));
  if (!file.startsWith(webRoot + sep) || path === "/_headers") return new Response("Not found", { status: 404 });
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
  } catch (error) {
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers({ "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  for (const rule of headerRules) {
    if (rule.pattern === "/*" || rule.pattern === path) for (const [name, value] of rule.headers) headers.set(name, value);
  }
  return new Response(await readFile(file), { status: 200, headers });
}

let databaseFile = process.env.DEV_DB;
if (!databaseFile) {
  await mkdir(join(root, ".dev"), { recursive: true });
  databaseFile = join(root, ".dev", "mychessdb.sqlite");
}
const env = {
  DB: new LocalD1(databaseFile).migrate(join(root, "migrations")),
  ASSETS: { fetch: serveAsset },
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "dev-admin-token-change-me",
  MIN_DEPTH: process.env.MIN_DEPTH,
  ANON_WRITES_PER_HOUR: process.env.ANON_WRITES_PER_HOUR,
  LICHESS_API_BASE: process.env.LICHESS_API_BASE,
};

createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("CF-Connecting-IP", req.socket.remoteAddress || "127.0.0.1");
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`http://${req.headers.host || `localhost:${port}`}${req.url}`, {
      method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    // On Cloudflare, files in web/ are served before the Worker runs.
    const response = new URL(request.url).pathname.startsWith("/api/")
      ? await worker.fetch(request, env)
      : await serveAsset(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("dev server error");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`My Chess DB dev server: http://localhost:${port}  (admin token: ${env.ADMIN_TOKEN})`);
});

// Stockfish 19 in the browser, for live analysis when the engine bridge is
// not there (the way the Lichess analysis board runs its engine).
//
// The engine is stockfish.js 19.0.0 (github.com/nmrugg/stockfish.js, GPLv3):
// the official Stockfish 19 with its full networks, built for WebAssembly.
// The small loaders are in /engine/. The 99 MB WebAssembly files are too
// large for the site's static files (25 MB at most), so they come from the
// same npm package on unpkg, which serves them from nearby caches; they are
// only run if their SHA-256 is the one pinned below.
//
// It reports the search the same way the engine bridge's /api/live does
// ({status, fen, depth, best}), so the page treats both alike.

const UNPKG = "https://unpkg.com/stockfish@19.0.0/bin/";
const FLAVOURS = {
  // Several threads: needs a cross-origin isolated page (see web/_headers).
  threads: { loader: "/engine/stockfish-19.js", wasm: `${UNPKG}stockfish-19.wasm`, size: 99065439,
    sha256: "e0ef90031a310479e5b0c3692a9839118ed785535c306252e68ed3300a45b02d" },
  single: { loader: "/engine/stockfish-19-single.js", wasm: `${UNPKG}stockfish-19-single.wasm`, size: 99102793,
    sha256: "8725c26572762617fd96b2ea83ff130e6640b85815890d682bf8c49db0820721" },
};
export const ENGINE_SIZE_MB = 99;
// An engine not searching for this long is closed, giving back its memory.
const IDLE_CLOSE_MS = 60000;
const HASH_MB = 128;

export function browserEngineSupported() {
  return typeof WebAssembly === "object" && typeof Worker === "function" && !!globalThis.crypto?.subtle;
}

// The multi-threaded engine needs a cross-origin isolated page and workers
// that can start workers. Some browsers (and embedded ones) cannot; checked
// with two small requests before 99 MB are downloaded for nothing.
function canRunThreads() {
  if (!globalThis.crossOriginIsolated) return Promise.resolve(false);
  return new Promise(resolve => {
    let probe;
    const done = answer => { clearTimeout(timer); probe?.terminate(); resolve(answer); };
    const timer = setTimeout(() => done(false), 5000);
    try {
      probe = new Worker("/engine/probe.js");
      probe.onmessage = event => done(event.data === "yes");
      probe.onerror = event => { event.preventDefault(); done(false); };
    } catch (error) { done(false); }
  });
}

// Reads one "info ..." line, like the bridge's parseInfo.
function parseInfo(line) {
  const fields = line.trim().split(/\s+/);
  if (fields[0] !== "info") return null;
  const info = { multipv: 1, bound: false };
  for (let i = 1; i < fields.length; i++) {
    switch (fields[i]) {
      case "depth": info.depth = Number(fields[++i]); break;
      case "multipv": info.multipv = Number(fields[++i]); break;
      case "nodes": info.nodes = Number(fields[++i]); break;
      case "time": info.time = Number(fields[++i]); break;
      case "score":
        if (fields[i + 1] === "cp" || fields[i + 1] === "mate") {
          info.mate = fields[i + 1] === "mate";
          info.score = Number(fields[i + 2]);
          i += 2;
        }
        break;
      case "lowerbound": case "upperbound": info.bound = true; break;
      case "wdl": i += 3; break;
      case "seldepth": case "nps": case "hashfull": case "tbhits": case "currmove": case "currmovenumber": case "cpuload": i++; break;
      case "pv": info.pv = fields.slice(i + 1); return info;
      case "string": case "refutation": case "currline": return info;
    }
  }
  return info;
}
// From White's side, the way the site writes it: "+0.32", "#3", "#-3".
function evaluationText(info, blackToMove) {
  const score = blackToMove ? -info.score : info.score;
  if (info.mate) return `#${score}`;
  return `${score < 0 ? "-" : "+"}${(Math.abs(score) / 100).toFixed(2)}`;
}
function hex(buffer) {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export class BrowserEngine {
  // onChange: called whenever the state shown to the user changes.
  constructor(onChange) {
    this.onChange = onChange;
    this.flavour = null;      // "threads" or "single", decided when it first starts
    this.threads = 1;
    // loading: {percent} while the engine is fetched and started.
    this.state = { loading: null, ready: false, error: null };
    this.worker = null;
    this.blobUrl = null;
    this.starting = null;
    this.target = null;       // the position to search, or null
    this.gen = 0;             // bumped by every set(); older output is dropped
    this.searching = false;   // a "go" is out and its "bestmove" not back
    this.stopping = false;
    this.searchGen = -1;
    this.blackToMove = false;
    this.view = { status: "idle", depth: 0 };
    this.idleTimer = null;
    this.loads = 0;           // bumped by close(): a start still under way gives up
    this.abort = null;        // cancels its download
  }
  get() {
    const view = { ...this.view };
    if (view.best) view.best = { ...view.best };
    return view;
  }
  // Moves the search to fen, starting the engine first if it is not running.
  set(fen) {
    this.target = fen;
    this.gen++;
    this.view = { status: "starting", fen, depth: 0 };
    clearTimeout(this.idleTimer);
    this.start().then(() => this.kick(), () => {});
  }
  stop() {
    this.target = null;
    this.gen++;
    if (this.view.status === "starting" || this.view.status === "running") this.view.status = "idle";
    this.kick();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.target) this.close(); }, IDLE_CLOSE_MS);
  }
  // Ends the engine and gives its memory back; set() starts it again.
  close() {
    clearTimeout(this.idleTimer);
    this.loads++;
    this.abort?.abort();
    this.giveUp?.();
    this.closeWorker();
    this.starting = null;
    this.searching = this.stopping = false;
    this.state = { loading: null, ready: false, error: null };
    if (this.view.status === "running" || this.view.status === "starting") this.view.status = "idle";
    this.onChange();
  }
  start() {
    if (!this.starting) {
      const starting = this.starting = this.chooseAndLoad().catch(error => {
        if (error.cancelled) throw error;   // close() came first: nothing to report
        if (this.starting === starting) this.starting = null;
        this.state = { loading: null, ready: false, error: error.message };
        this.view = { ...this.view, status: "error", error: error.message };
        this.onChange();
        throw error;
      });
    }
    return this.starting;
  }
  async chooseAndLoad() {
    if (!this.flavour) this.flavour = await canRunThreads() ? "threads" : "single";
    try {
      await this.load();
    } catch (error) {
      if (this.flavour !== "threads" || error.downloadFailed || error.cancelled) throw error;
      // The threads would not start after all: one thread then.
      this.closeWorker();
      this.flavour = "single";
      await this.load();
    }
  }
  closeWorker() {
    this.worker?.terminate();
    this.worker = null;
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
  }
  async load() {
    const flavour = FLAVOURS[this.flavour], load = this.loads;
    // After close(), this start stops where it is.
    const cancelled = () => Object.assign(Error("cancelled"), { cancelled: true });
    const current = () => { if (load !== this.loads) throw cancelled(); };
    this.threads = this.flavour === "threads" ? Math.max(1, Math.min((navigator.hardwareConcurrency || 2) - 1, 16)) : 1;
    const downloadError = message => Object.assign(Error(message), { downloadFailed: true });
    const interrupted = "The download of the browser engine was interrupted. Move a piece to try again.";
    this.state = { loading: { percent: 0 }, ready: false, error: null };
    this.onChange();
    // Fetched here rather than by the engine, so that it can be checked
    // before it runs, and its progress shown.
    const abort = this.abort = new AbortController();
    let response;
    try { response = await fetch(flavour.wasm, { signal: abort.signal }); } catch (error) { current(); throw downloadError("Could not download the browser engine. Check your internet connection."); }
    if (!response.ok) throw downloadError(`Could not download the browser engine (HTTP ${response.status}).`);
    const reader = response.body.getReader(), chunks = [];
    let received = 0, shown = -1;
    for (;;) {
      let part;
      try { part = await reader.read(); } catch (error) { current(); throw downloadError(interrupted); }
      current();
      const { done, value } = part;
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      const percent = Math.min(99, Math.floor(received * 100 / flavour.size));
      if (percent !== shown) { shown = percent; this.state = { ...this.state, loading: { percent } }; this.onChange(); }
    }
    if (received !== flavour.size) throw downloadError(interrupted);
    const blob = new Blob(chunks, { type: "application/wasm" });
    const digest = hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    current();
    if (digest !== flavour.sha256) throw downloadError("The downloaded engine is not the expected Stockfish 19 build, so it was not run.");
    this.blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(`${flavour.loader}#${encodeURIComponent(this.blobUrl)}`);
    this.worker = worker;
    const waiters = [];
    const waitFor = token => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("The browser engine did not start.")), 60000);
      waiters.push({ token, resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
    // close() while it starts: stop waiting for it.
    this.giveUp = () => { for (const waiter of waiters.splice(0)) waiter.reject(cancelled()); };
    worker.onmessage = event => {
      if (typeof event.data !== "string") return;
      for (const line of event.data.split("\n")) {
        const at = waiters.findIndex(waiter => line === waiter.token || line.startsWith(`${waiter.token} `));
        if (at >= 0) waiters.splice(at, 1)[0].resolve();
        this.onLine(line);
      }
    };
    worker.onerror = event => {
      event.preventDefault?.();
      const message = "The browser engine stopped.";
      // While starting: load() fails, and the caller decides what next.
      if (waiters.length) { for (const waiter of waiters.splice(0)) waiter.reject(Error(message)); return; }
      this.state = { loading: null, ready: false, error: message };
      this.view = { ...this.view, status: "error", error: message };
      this.worker?.terminate();
      this.worker = null;
      this.starting = null;
      this.onChange();
    };
    const uciok = waitFor("uciok");
    worker.postMessage("uci");
    await uciok;
    worker.postMessage(`setoption name Threads value ${this.threads}`);
    worker.postMessage(`setoption name Hash value ${HASH_MB}`);
    worker.postMessage("ucinewgame");
    const readyok = waitFor("readyok");
    worker.postMessage("isready");
    await readyok;
    current();
    this.giveUp = null;
    this.state = { loading: null, ready: true, error: null };
    this.onChange();
  }
  // Starts the search for the target, after the one before has stopped.
  kick() {
    if (!this.worker || !this.state.ready) return;
    if (this.searching) {
      if (!this.stopping && (this.searchGen !== this.gen || !this.target)) {
        this.stopping = true;
        this.worker.postMessage("stop");
      }
      return;   // "bestmove" comes back, and kick() runs again
    }
    if (!this.target) return;
    const fen = this.target;
    this.blackToMove = fen.split(" ")[1] === "b";
    this.searchGen = this.gen;
    this.searching = true;
    this.worker.postMessage(`position fen ${fen}`);
    this.worker.postMessage("go infinite");
    this.view = { ...this.view, status: "running" };
  }
  onLine(line) {
    if (line.startsWith("bestmove")) {
      const ownSearch = this.searchGen === this.gen && !this.stopping;
      this.searching = this.stopping = false;
      // Only at the deepest depth there is: nothing more to find.
      if (ownSearch && this.target) this.view = { ...this.view, status: "done" };
      this.kick();
      return;
    }
    if (!this.searching || this.stopping || this.searchGen !== this.gen) return;
    const info = parseInfo(line);
    if (!info || !Number.isInteger(info.depth)) return;
    // An exact score with a line: that depth has been searched to the end.
    const finished = Number.isInteger(info.score) && !info.bound && info.multipv === 1 && info.pv?.length;
    let searching = info.depth;
    if (finished) {
      this.view.best = { move_uci: info.pv[0], pv: info.pv, evaluation: evaluationText(info, this.blackToMove),
        depth: info.depth, nodes: info.nodes || 0, time_ms: info.time || 0 };
      searching++;
    }
    if (searching > this.view.depth) this.view.depth = searching;
  }
}

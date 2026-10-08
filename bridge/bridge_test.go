//go:build testhooks

package main

// Run with:  go test -tags testhooks ./...
//
// These tests drive the real bridge code over HTTP with a stand-in engine
// (testdata/mockengine) and a local stand-in for the Stockfish download.

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

const site = "https://chess.example"

var mockEngine string // path of the compiled stand-in engine

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "bridge-test")
	if err != nil {
		panic(err)
	}
	mockEngine = filepath.Join(dir, "stockfish-linux-x86-64-universal")
	if runtime.GOOS == "windows" {
		mockEngine += ".exe"
	}
	build := exec.Command("go", "build", "-o", mockEngine, "./testdata/mockengine")
	if out, err := build.CombinedOutput(); err != nil {
		panic(fmt.Sprintf("building mock engine: %v\n%s", err, out))
	}
	hash, _ := fileSHA256(mockEngine)
	os.Setenv("MYCHESSDB_TEST_TRUST", hash)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

type harness struct {
	t      *testing.T
	srv    *server
	http   *httptest.Server
	dir    string
	origin string
}

func newHarness(t *testing.T, maxJobs int) *harness {
	t.Helper()
	dir := t.TempDir()
	store, err := loadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.update(func(data *config) { data.Sites = []string{site}; data.EnginePath = mockEngine }); err != nil {
		t.Fatal(err)
	}
	verifier := newEngineVerifier(store)
	srv := &server{
		store: store, verifier: verifier,
		installer: &installer{dir: dir, store: store, verifier: verifier, status: installStatus{State: "idle"}},
	}
	srv.jobs = newJobManager(maxJobs, srv.currentEngine)
	ts := httptest.NewServer(srv)
	fmt.Sscanf(ts.URL[strings.LastIndex(ts.URL, ":")+1:], "%d", &srv.port)
	h := &harness{t: t, srv: srv, http: ts, dir: dir, origin: site}
	t.Cleanup(func() { srv.jobs.shutdown(); ts.Close() })
	return h
}

type reply struct {
	status  int
	body    map[string]any
	list    []any
	headers http.Header
}

func (h *harness) do(method, path string, body any, headers map[string]string) reply {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	request, _ := http.NewRequest(method, h.http.URL+path, reader)
	if h.origin != "" {
		request.Header.Set("Origin", h.origin)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		if name == "Host" {
			request.Host = value
		} else if value == "" {
			request.Header.Del(name)
		} else {
			request.Header.Set(name, value)
		}
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	out := reply{status: response.StatusCode, headers: response.Header}
	if len(raw) > 0 && raw[0] == '[' {
		_ = json.Unmarshal(raw, &out.list)
	} else {
		_ = json.Unmarshal(raw, &out.body)
	}
	return out
}

const startFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
const blackFEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"

func (h *harness) start(fen string, depth int) string {
	h.t.Helper()
	r := h.do("POST", "/api/analyze", map[string]any{"fen": fen, "depth": depth, "context": map[string]any{"note": "kept"}}, nil)
	if r.status != 202 {
		h.t.Fatalf("start: status %d %v", r.status, r.body)
	}
	return r.body["job_id"].(string)
}

func (h *harness) waitStatus(id string, want ...string) map[string]any {
	h.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		r := h.do("GET", "/api/analyze/"+id, nil, nil)
		for _, status := range want {
			if r.body["status"] == status {
				return r.body
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.t.Fatalf("job %s never reached %v", id, want)
	return nil
}

func (h *harness) depth(id string) int {
	return int(h.do("GET", "/api/analyze/"+id, nil, nil).body["depth"].(float64))
}

// ---------------------------------------------------------------- units ---

func TestParseInfo(t *testing.T) {
	info, ok := parseInfo("info depth 46 seldepth 61 multipv 1 score cp -32 nodes 123456789 nps 9000000 hashfull 1000 tbhits 0 time 4567 pv e7e5 g1f3 b8c6")
	if !ok || !info.HasDepth || info.Depth != 46 || !info.HasScore || info.IsMate || info.Score != -32 ||
		info.Bound || info.Nodes != 123456789 || info.TimeMs != 4567 || !reflect.DeepEqual(info.PV, []string{"e7e5", "g1f3", "b8c6"}) {
		t.Fatalf("unexpected: %+v", info)
	}
	if info, _ := parseInfo("info depth 30 score mate -4 wdl 0 0 1000 pv a1a2"); !info.IsMate || info.Score != -4 || info.PV[0] != "a1a2" {
		t.Fatalf("mate/wdl: %+v", info)
	}
	if info, _ := parseInfo("info depth 12 multipv 2 score cp 5 lowerbound nodes 9 pv a2a3"); !info.Bound || info.MultiPV != 2 {
		t.Fatalf("bound: %+v", info)
	}
	if info, _ := parseInfo("info string depth 99 score cp 1 pv zzzz"); info.HasDepth || info.HasScore || info.PV != nil {
		t.Fatalf("info string must be ignored: %+v", info)
	}
	if info, _ := parseInfo("info depth 5 currmove e2e4 currmovenumber 3"); info.Depth != 5 || info.HasScore {
		t.Fatalf("currmove: %+v", info)
	}
	if _, ok := parseInfo("bestmove e2e4"); ok {
		t.Fatal("not an info line")
	}
	if _, ok := parseInfo("info depth"); !ok {
		t.Fatal("a truncated line must not panic")
	}
	cases := []struct {
		info  uciInfo
		black bool
		want  string
	}{
		{uciInfo{Score: 32}, false, "+0.32"}, {uciInfo{Score: 32}, true, "-0.32"},
		{uciInfo{Score: 0}, true, "+0.00"}, {uciInfo{Score: -1234}, false, "-12.34"},
		{uciInfo{IsMate: true, Score: 3}, false, "#3"}, {uciInfo{IsMate: true, Score: 3}, true, "#-3"},
		{uciInfo{IsMate: true, Score: -2}, true, "#2"},
	}
	for _, c := range cases {
		if got := formatEvaluation(c.info, c.black); got != c.want {
			t.Errorf("formatEvaluation(%+v, %v) = %q, want %q", c.info, c.black, got, c.want)
		}
	}
}

func TestValidateFEN(t *testing.T) {
	good := []string{startFEN, blackFEN, "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -", "r3k2r/8/8/8/8/8/8/R3K2R b Kq e3 12 40"}
	for _, fen := range good {
		if err := validateFEN(fen); err != nil {
			t.Errorf("%q should be accepted: %v", fen, err)
		}
	}
	bad := []string{
		"", "hello", startFEN + "\nquit", startFEN + "\rsetoption name Debug Log File value C:\\x",
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 extra",
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1",   // 7 squares
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNRR w KQkq - 0 1", // 9 squares
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1",           // 7 ranks
		"rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",  // no black king
		"Pnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR w KQkq - 0 1",  // pawn on rank 8
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1",
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w  - 0 1",
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e5 0 1",
	}
	for _, fen := range bad {
		if err := validateFEN(fen); err == nil {
			t.Errorf("%q should be rejected", fen)
		}
	}
}

func TestNormalizeOrigin(t *testing.T) {
	ok := map[string]string{
		"https://Chess.Example/some/path?x=1": "https://chess.example",
		"https://chess.example:8443":          "https://chess.example:8443",
		"http://localhost:8787/":              "http://localhost:8787",
		"http://127.0.0.1:8787":               "http://127.0.0.1:8787",
	}
	for raw, want := range ok {
		if got, err := normalizeOrigin(raw); err != nil || got != want {
			t.Errorf("normalizeOrigin(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"", "chess.example", "http://chess.example", "ftp://chess.example", "file:///c:/x", "javascript:alert(1)"} {
		if got, err := normalizeOrigin(raw); err == nil {
			t.Errorf("normalizeOrigin(%q) = %q, want an error", raw, got)
		}
	}
}

func TestRememberSite(t *testing.T) {
	local, live := "http://localhost:8787", "https://chess.example"
	cases := []struct {
		have []string
		add  string
		want []string
	}{
		{nil, live, []string{live}},
		{[]string{local}, live, []string{local, live}},
		{[]string{live, local}, live, []string{local, live}}, // named again: becomes the most recent
		{[]string{local, live}, live, []string{local, live}},
	}
	for _, c := range cases {
		if got := rememberSite(c.have, c.add); !reflect.DeepEqual(got, c.want) {
			t.Errorf("rememberSite(%v, %q) = %v, want %v", c.have, c.add, got, c.want)
		}
	}
}

func TestResourceSplit(t *testing.T) {
	totalThreads, totalHash := resourceBudget()
	if totalThreads < 1 || totalThreads > maxTotalThreads || totalHash < 256 || totalHash > maxTotalHashMB {
		t.Fatalf("budget out of range: %d threads, %d MB", totalThreads, totalHash)
	}
	if totalMemoryMB() < 256 {
		t.Fatalf("could not read this machine's memory size: %d MB", totalMemoryMB())
	}
	one, _ := perJobResources(1)
	many, hash := perJobResources(1000)
	if one != totalThreads || many != 1 || hash != 64 {
		t.Fatalf("split wrong: %d %d %d", one, many, hash)
	}
	// A new job's hash never takes more than half of the memory that is free.
	for _, c := range []struct{ hash, free, want int }{
		{8192, 20000, 8192}, {8192, 6000, 3000}, {2048, 4096, 2048}, {2048, 1000, 500},
		{2048, 100, 64}, {64, 10, 64}, {4096, 0, 4096}, {4096, -1, 4096},
	} {
		if got := fitHashToFreeMemory(c.hash, c.free); got != c.want {
			t.Errorf("fitHashToFreeMemory(%d, %d) = %d, want %d", c.hash, c.free, got, c.want)
		}
	}
	if runtime.GOOS == "linux" {
		if free := availableMemoryMB(); free < 1 || free > totalMemoryMB() {
			t.Fatalf("free memory reads as %d MB of %d MB", free, totalMemoryMB())
		}
	}
}

// -------------------------------------------------- who may talk to it ---

func TestOnlyTheSiteMayUseTheBridge(t *testing.T) {
	h := newHarness(t, 4)
	if r := h.do("GET", "/api/status", nil, nil); r.status != 200 || r.body["app"] != appName ||
		r.headers.Get("Access-Control-Allow-Origin") != site || r.headers.Get("Vary") != "Origin" {
		t.Fatalf("allowed site: %d %v %v", r.status, r.body, r.headers)
	}
	for _, origin := range []string{"https://evil.example", "https://chess.example.evil.example", "http://chess.example", "null", "https://CHESS.example"} {
		r := h.do("GET", "/api/status", nil, map[string]string{"Origin": origin})
		if r.status != 403 || r.headers.Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("origin %q: status %d, ACAO %q", origin, r.status, r.headers.Get("Access-Control-Allow-Origin"))
		}
		r = h.do("POST", "/api/analyze", map[string]any{"fen": startFEN, "depth": 5}, map[string]string{"Origin": origin})
		if r.status != 403 {
			t.Errorf("origin %q could start an analysis: %d", origin, r.status)
		}
		r = h.do("OPTIONS", "/api/analyze", nil, map[string]string{"Origin": origin, "Access-Control-Request-Method": "POST"})
		if r.status != 403 || r.headers.Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("origin %q passed preflight: %d", origin, r.status)
		}
	}
	// DNS rebinding: right origin value is irrelevant if Host is not this computer.
	for _, host := range []string{"evil.example", "evil.example:8765", fmt.Sprintf("127.0.0.1.evil.example:%d", h.srv.port)} {
		if r := h.do("GET", "/api/status", nil, map[string]string{"Host": host}); r.status != 403 {
			t.Errorf("Host %q was accepted: %d", host, r.status)
		}
	}
	if r := h.do("GET", "/api/status", nil, map[string]string{"Host": fmt.Sprintf("localhost:%d", h.srv.port)}); r.status != 200 {
		t.Errorf("localhost Host should work: %d", r.status)
	}
	// No Origin at all (not a cross-site browser request): may look, may not act.
	if r := h.do("GET", "/api/status", nil, map[string]string{"Origin": ""}); r.status != 200 {
		t.Errorf("GET without Origin: %d", r.status)
	}
	if r := h.do("POST", "/api/analyze", map[string]any{"fen": startFEN, "depth": 5}, map[string]string{"Origin": ""}); r.status != 403 {
		t.Errorf("POST without Origin must be refused: %d", r.status)
	}
	if r := h.do("POST", "/api/engine/install", nil, map[string]string{"Origin": ""}); r.status != 403 {
		t.Errorf("POST without Origin must be refused: %d", r.status)
	}
	// Preflight for the real site.
	r := h.do("OPTIONS", "/api/analyze", nil, map[string]string{"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
	if r.status != 204 || r.headers.Get("Access-Control-Allow-Origin") != site ||
		!strings.Contains(r.headers.Get("Access-Control-Allow-Methods"), "POST") ||
		r.headers.Get("Access-Control-Allow-Headers") != "Content-Type" ||
		r.headers.Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("preflight: %d %v", r.status, r.headers)
	}
	if len(h.srv.jobs.active()) != 0 {
		t.Fatal("a refused request started an analysis")
	}
}

// ------------------------------------------------------ engine checking ---

func TestEngineMustBeTrusted(t *testing.T) {
	h := newHarness(t, 4)
	if name, err := h.srv.verifier.verify(mockEngine); err != nil || name != "Stockfish 19" {
		t.Fatalf("trusted engine: %q %v", name, err)
	}
	if r := h.do("GET", "/api/status", nil, nil); r.body["engine"].(map[string]any)["ready"] != true {
		t.Fatalf("status should report the engine ready: %v", r.body)
	}
	// Any other executable is refused before it is ever started.
	other := filepath.Join(t.TempDir(), "stockfish-other")
	marker := filepath.Join(t.TempDir(), "ran")
	script := "#!/bin/sh\ntouch " + marker + "\n"
	if err := os.WriteFile(other, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	r := h.do("POST", "/api/engine/path", map[string]any{"engine_path": other}, nil)
	if r.status != 400 || !strings.Contains(r.body["error"].(string), "not an official") {
		t.Fatalf("untrusted file: %d %v", r.status, r.body)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("the untrusted file was executed")
	}
	for _, path := range []string{"", "relative/stockfish", filepath.Join(t.TempDir(), "missing"), t.TempDir()} {
		if r := h.do("POST", "/api/engine/path", map[string]any{"engine_path": path}, nil); r.status != 400 {
			t.Errorf("engine path %q: %d %v", path, r.status, r.body)
		}
	}
	if h.srv.store.get().EnginePath != mockEngine {
		t.Fatal("a refused path replaced the configured engine")
	}
	// Quotes pasted from "Copy as path" are tolerated.
	if r := h.do("POST", "/api/engine/path", map[string]any{"engine_path": ` "` + mockEngine + `" `}, nil); r.status != 200 || r.body["name"] != "Stockfish 19" {
		t.Fatalf("quoted path: %d %v", r.status, r.body)
	}
	// A trusted hash that does not say it is Stockfish 19 is refused too.
	t.Setenv("MOCK_NAME", "Stockfish 18")
	fresh := newEngineVerifier(h.srv.store)
	if _, err := fresh.verify(mockEngine); err == nil || !strings.Contains(err.Error(), "Stockfish 18") {
		t.Fatalf("wrong engine identity accepted: %v", err)
	}
}

// ------------------------------------------------------------ analysis ---

func TestAnalysisLifecycle(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "engine.log")
	t.Setenv("MOCK_LOG", logPath)
	h := newHarness(t, 4)
	id := h.start(startFEN, 12)
	if list := h.do("GET", "/api/analyze", nil, nil).list; len(list) != 1 {
		t.Fatalf("running job should be listed: %v", list)
	} else if ctx := list[0].(map[string]any)["context"].(map[string]any); ctx["note"] != "kept" {
		t.Fatalf("context not returned: %v", list[0])
	}
	job := h.waitStatus(id, "complete", "error")
	result, _ := job["result"].(map[string]any)
	if job["status"] != "complete" || result == nil {
		t.Fatalf("job did not complete: %v", job)
	}
	if result["move_uci"] != "e2e4" || result["evaluation"] != "+0.32" || result["depth"].(float64) != 12 ||
		!reflect.DeepEqual(result["pv"], []any{"e2e4", "e7e5", "g1f3", "b8c6"}) || job["progress"].(float64) != 100 {
		t.Fatalf("result: %v", job)
	}
	if list := h.do("GET", "/api/analyze", nil, nil).list; len(list) != 0 {
		t.Fatalf("a job whose result was fetched should not be listed any more: %v", list)
	}
	raw, _ := os.ReadFile(logPath)
	sent := string(raw)
	threads, fullHash := perJobResources(1)
	hash := int(job["hash"].(float64)) // the share, or less when little memory is free
	if hash < 64 || hash > fullHash || int(job["threads"].(float64)) != threads {
		t.Fatalf("resources: %v threads, %v MB hash (budget %d, %d)", job["threads"], job["hash"], threads, fullHash)
	}
	for _, want := range []string{
		fmt.Sprintf("setoption name Threads value %d", threads), fmt.Sprintf("setoption name Hash value %d", hash),
		"setoption name Syzygy50MoveRule value false", "position fen " + startFEN, "go depth 12", "quit",
	} {
		if !strings.Contains(sent, want+"\n") {
			t.Errorf("engine was not sent %q; it got:\n%s", want, sent)
		}
	}

	// A job that finishes while nobody is watching stays listed until its
	// result has been fetched once.
	id = h.start(startFEN, 2)
	deadline := time.Now().Add(10 * time.Second)
	for {
		list := h.do("GET", "/api/analyze", nil, nil).list
		if len(list) == 1 && list[0].(map[string]any)["status"] == "complete" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("an unfetched finished job should stay listed: %v", list)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if job := h.do("GET", "/api/analyze/"+id, nil, nil).body; job["status"] != "complete" || job["result"] == nil {
		t.Fatalf("fetching the finished job: %v", job)
	}
	if list := h.do("GET", "/api/analyze", nil, nil).list; len(list) != 0 {
		t.Fatalf("once fetched it should leave the list: %v", list)
	}

	// Scores are reported from White's side whoever is to move.
	id = h.start(blackFEN, 3)
	if job := h.waitStatus(id, "complete", "error"); job["result"].(map[string]any)["evaluation"] != "-0.32" ||
		job["result"].(map[string]any)["move_uci"] != "e7e5" {
		t.Fatalf("black to move: %v", job)
	}
	t.Setenv("MOCK_SCORE", "mate 3")
	id = h.start(blackFEN, 3)
	if job := h.waitStatus(id, "complete", "error"); job["result"].(map[string]any)["evaluation"] != "#-3" {
		t.Fatalf("mate score: %v", job)
	}

	// Bad requests never reach an engine.
	for _, body := range []map[string]any{
		{"fen": "nonsense", "depth": 10}, {"fen": startFEN + "\nquit", "depth": 10},
		{"fen": startFEN, "depth": 0}, {"fen": startFEN, "depth": 9999}, {"fen": startFEN},
	} {
		if r := h.do("POST", "/api/analyze", body, nil); r.status != 400 {
			t.Errorf("%v: status %d %v", body, r.status, r.body)
		}
	}
	if r := h.do("GET", "/api/analyze/doesnotexist", nil, nil); r.status != 404 {
		t.Errorf("unknown job: %d", r.status)
	}
	if r := h.do("POST", "/api/analyze/doesnotexist/stop", nil, nil); r.status != 404 {
		t.Errorf("unknown job stop: %d", r.status)
	}
}

func TestPauseResumeStop(t *testing.T) {
	t.Setenv("MOCK_DELAY_MS", "25")
	h := newHarness(t, 4)
	id := h.start(startFEN, 200)
	for h.depth(id) < 3 {
		time.Sleep(10 * time.Millisecond)
	}
	if r := h.do("POST", "/api/analyze/"+id+"/resume", nil, nil); r.status != 409 {
		t.Fatalf("resume while running: %d", r.status)
	}
	if r := h.do("POST", "/api/analyze/"+id+"/pause", nil, nil); r.status != 200 {
		t.Fatalf("pause: %d %v", r.status, r.body)
	}
	time.Sleep(100 * time.Millisecond) // let lines already in the pipe drain
	frozen := h.depth(id)
	time.Sleep(400 * time.Millisecond)
	if now := h.depth(id); now != frozen {
		t.Fatalf("analysis kept running while paused: depth %d -> %d", frozen, now)
	}
	if job := h.do("GET", "/api/analyze/"+id, nil, nil).body; job["status"] != "paused" {
		t.Fatalf("status while paused: %v", job)
	}
	if r := h.do("POST", "/api/analyze/"+id+"/pause", nil, nil); r.status != 409 {
		t.Fatalf("pause while paused: %d", r.status)
	}
	if r := h.do("POST", "/api/analyze/"+id+"/resume", nil, nil); r.status != 200 {
		t.Fatalf("resume: %d %v", r.status, r.body)
	}
	deadline := time.Now().Add(5 * time.Second)
	for h.depth(id) <= frozen+2 {
		if time.Now().After(deadline) {
			t.Fatal("analysis did not continue after resume")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Stop a paused job: it must end, not hang.
	h.do("POST", "/api/analyze/"+id+"/pause", nil, nil)
	if r := h.do("POST", "/api/analyze/"+id+"/stop", nil, nil); r.status != 200 {
		t.Fatalf("stop: %d %v", r.status, r.body)
	}
	if job := h.waitStatus(id, "stopped", "error", "complete"); job["status"] != "stopped" || job["result"] != nil {
		t.Fatalf("after stop: %v", job)
	}
	if r := h.do("POST", "/api/analyze/"+id+"/stop", nil, nil); r.status != 200 {
		t.Fatalf("stopping twice should be harmless: %d", r.status)
	}
}

// While a job runs the site can read the deepest depth searched to the end
// ("best"); stopping keeps it, so the site can save it.
func TestBestFollowsTheSearchAndSurvivesStop(t *testing.T) {
	t.Setenv("MOCK_DELAY_MS", "25")
	h := newHarness(t, 4)
	id := h.start(blackFEN, 200)
	var running map[string]any
	deadline := time.Now().Add(5 * time.Second)
	for {
		running = h.job(id)
		if best, _ := running["best"].(map[string]any); best != nil && best["depth"].(float64) >= 4 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no finished depth was reported while running: %v", running)
		}
		time.Sleep(10 * time.Millisecond)
	}
	best := running["best"].(map[string]any)
	if running["status"] != "running" || running["result"] != nil {
		t.Fatalf("a running job has no result yet: %v", running)
	}
	// The engine is always one depth ahead of the last one it finished.
	if running["depth"].(float64) != best["depth"].(float64)+1 {
		t.Fatalf("searching depth %v, finished depth %v", running["depth"], best["depth"])
	}
	if best["move_uci"] != "e7e5" || best["evaluation"] != "-0.32" ||
		!reflect.DeepEqual(best["pv"], []any{"e7e5", "g1f3", "b8c6", "f1b5"}) {
		t.Fatalf("best while running: %v", best)
	}

	// A paused job still shows what it had found.
	h.do("POST", "/api/analyze/"+id+"/pause", nil, nil)
	time.Sleep(100 * time.Millisecond)
	paused := h.job(id)
	if paused["status"] != "paused" || paused["best"] == nil {
		t.Fatalf("paused job lost its best line: %v", paused)
	}
	h.do("POST", "/api/analyze/"+id+"/resume", nil, nil)

	if r := h.do("POST", "/api/analyze/"+id+"/stop", nil, nil); r.status != 200 {
		t.Fatalf("stop: %d %v", r.status, r.body)
	}
	stopped := h.waitStatus(id, "stopped", "error", "complete")
	kept, _ := stopped["best"].(map[string]any)
	if stopped["status"] != "stopped" || stopped["result"] != nil || kept == nil {
		t.Fatalf("a stopped job keeps its last finished depth, and has no result: %v", stopped)
	}
	if kept["depth"].(float64) < best["depth"].(float64) || kept["depth"].(float64) != stopped["depth"].(float64)-1 {
		t.Fatalf("stopped while searching depth %v, kept depth %v (had %v before)", stopped["depth"], kept["depth"], best["depth"])
	}
	if kept["move_uci"] != "e7e5" || kept["evaluation"] != "-0.32" {
		t.Fatalf("kept: %v", kept)
	}
	if list := h.do("GET", "/api/analyze", nil, nil).list; len(list) != 0 {
		t.Fatalf("a stopped job is not listed as active: %v", list)
	}

	// Stopped before the first depth was finished: nothing to keep.
	t.Setenv("MOCK_DELAY_MS", "2000")
	id = h.start(startFEN, 50)
	h.waitStatus(id, "running")
	h.do("POST", "/api/analyze/"+id+"/stop", nil, nil)
	if job := h.waitStatus(id, "stopped", "error", "complete"); job["status"] != "stopped" || job["best"] != nil || job["result"] != nil {
		t.Fatalf("stopped before any depth was finished: %v", job)
	}

	// A finished job: best and result are the same, at the target depth.
	t.Setenv("MOCK_DELAY_MS", "5")
	id = h.start(startFEN, 6)
	done := h.waitStatus(id, "complete", "error")
	if done["status"] != "complete" || done["depth"].(float64) != 6 || !reflect.DeepEqual(done["best"], done["result"]) ||
		done["result"].(map[string]any)["depth"].(float64) != 6 {
		t.Fatalf("finished job: %v", done)
	}
}

func (h *harness) queue(fen string, depth int) map[string]any {
	h.t.Helper()
	r := h.do("POST", "/api/analyze", map[string]any{"fen": fen, "depth": depth}, nil)
	if r.status != 202 {
		h.t.Fatalf("start: status %d %v", r.status, r.body)
	}
	return r.body
}

func (h *harness) job(id string) map[string]any {
	return h.do("GET", "/api/analyze/"+id, nil, nil).body
}

// More analyses than slots: the extra ones wait and start by themselves, in
// the order they were asked for.
func TestQueue(t *testing.T) {
	t.Setenv("MOCK_DELAY_MS", "50")
	h := newHarness(t, 2)
	first := h.start(startFEN, 200)
	second := h.start(blackFEN, 200)
	third := h.queue(startFEN, 200)
	fourth := h.queue(blackFEN, 200)
	if third["status"] != "queued" || third["queue_position"].(float64) != 1 ||
		fourth["status"] != "queued" || fourth["queue_position"].(float64) != 2 {
		t.Fatalf("the third and fourth job should wait: %v / %v", third, fourth)
	}
	thirdID, fourthID := third["job_id"].(string), fourth["job_id"].(string)
	// The second job started while one was running, so it got half the threads.
	total, _ := resourceBudget()
	half := total / 2
	if half < 1 {
		half = 1
	}
	if a, b := h.job(first), h.job(second); int(a["threads"].(float64)) != total || int(b["threads"].(float64)) != half {
		t.Fatalf("thread split: %v / %v of %d", a["threads"], b["threads"], total)
	}
	// All four are listed, oldest first.
	list := h.do("GET", "/api/analyze", nil, nil).list
	order := []string{}
	for _, item := range list {
		order = append(order, item.(map[string]any)["job_id"].(string))
	}
	if !reflect.DeepEqual(order, []string{first, second, thirdID, fourthID}) {
		t.Fatalf("listing order: %v", list)
	}
	// A waiting job can be dropped (holding one is TestHoldInQueue).
	if r := h.do("POST", "/api/analyze/"+fourthID+"/stop", nil, nil); r.status != 200 {
		t.Fatalf("dropping a waiting job: %d %v", r.status, r.body)
	}
	if job := h.job(fourthID); job["status"] != "stopped" || job["depth"].(float64) != 0 {
		t.Fatalf("a dropped job should read as stopped and never have run: %v", job)
	}
	fifth := h.queue(blackFEN, 200)
	if fifth["queue_position"].(float64) != 2 {
		t.Fatalf("the fifth job should be second in line now: %v", fifth)
	}
	fifthID := fifth["job_id"].(string)
	// A paused job keeps its slot: nothing is promoted.
	for h.depth(first) < 1 || h.depth(second) < 1 {
		time.Sleep(10 * time.Millisecond)
	}
	h.do("POST", "/api/analyze/"+second+"/pause", nil, nil)
	time.Sleep(150 * time.Millisecond)
	if job := h.job(thirdID); job["status"] != "queued" {
		t.Fatalf("pausing must not free a slot: %v", job)
	}
	h.do("POST", "/api/analyze/"+second+"/resume", nil, nil)
	// Ending one lets exactly the oldest waiting job start.
	h.do("POST", "/api/analyze/"+first+"/stop", nil, nil)
	h.waitStatus(first, "stopped")
	promoted := h.waitStatus(thirdID, "running")
	if promoted["queue_position"] != nil || int(promoted["threads"].(float64)) != half || promoted["hash"].(float64) < 64 {
		t.Fatalf("promoted job: %v", promoted)
	}
	if job := h.job(fifthID); job["status"] != "queued" || job["queue_position"].(float64) != 1 {
		t.Fatalf("the fifth job should be next in line: %v", job)
	}
	for h.depth(thirdID) < 1 {
		time.Sleep(10 * time.Millisecond)
	}

	// Shutdown: engines end, and what was still waiting never starts.
	pids := []int{}
	h.srv.jobs.mu.Lock()
	for _, j := range h.srv.jobs.jobs {
		if j.proc != nil {
			pids = append(pids, j.proc.pid())
		}
	}
	h.srv.jobs.mu.Unlock()
	if len(pids) != 2 {
		t.Fatalf("expected two engine processes, found %d", len(pids))
	}
	h.do("POST", "/api/analyze/"+second+"/pause", nil, nil)
	h.srv.jobs.shutdown()
	time.Sleep(200 * time.Millisecond)
	for _, pid := range pids {
		if err := exec.Command("kill", "-0", fmt.Sprint(pid)).Run(); err == nil {
			t.Errorf("engine process %d survived shutdown", pid)
		}
	}
	for _, id := range []string{second, thirdID, fifthID} {
		if job := h.waitStatus(id, "stopped", "error", "complete", "running"); job["status"] != "stopped" {
			t.Fatalf("a job ended by shutdown should read as stopped: %v", job)
		}
	}
	if job := h.job(fifthID); job["depth"].(float64) != 0 || job["threads"].(float64) != 0 {
		t.Fatalf("a waiting job must not start during shutdown: %v", job)
	}
	if r := h.do("POST", "/api/analyze", map[string]any{"fen": startFEN, "depth": 5}, nil); r.status != 503 {
		t.Fatalf("starting during shutdown: %d %v", r.status, r.body)
	}
}

// Pausing a waiting job holds it: it keeps its place in the list but the
// jobs behind it start first, until it is resumed.
func TestHoldInQueue(t *testing.T) {
	t.Setenv("MOCK_DELAY_MS", "50")
	h := newHarness(t, 1)
	first := h.start(startFEN, 200)
	a := h.queue(blackFEN, 200)["job_id"].(string)
	b := h.queue(startFEN, 200)["job_id"].(string)
	post := func(id, action string) string {
		t.Helper()
		r := h.do("POST", "/api/analyze/"+id+"/"+action, nil, nil)
		if r.status != 200 {
			t.Fatalf("%s %s: %d %v", action, id, r.status, r.body)
		}
		return r.body["status"].(string)
	}
	if state := post(a, "pause"); state != "held" {
		t.Fatalf("pausing a waiting job should hold it, got %q", state)
	}
	if job := h.job(a); job["status"] != "queued" || job["held"] != true || job["queue_position"] != nil {
		t.Fatalf("a held job: %v", job)
	}
	if job := h.job(b); job["queue_position"].(float64) != 1 {
		t.Fatalf("the job behind a held one should be next: %v", job)
	}
	if state := post(a, "pause"); state != "held" {
		t.Fatalf("holding twice: %q", state)
	}
	// The slot frees up: the held job is passed over.
	post(first, "stop")
	h.waitStatus(first, "stopped")
	h.waitStatus(b, "running")
	if job := h.job(a); job["status"] != "queued" || job["held"] != true {
		t.Fatalf("a held job must not start: %v", job)
	}
	// Resumed while the slot is taken: back in line, first.
	if state := post(a, "resume"); state != "queued" {
		t.Fatalf("resuming a held job while the slot is busy: %q", state)
	}
	if job := h.job(a); job["held"] != nil || job["queue_position"].(float64) != 1 {
		t.Fatalf("a resumed job: %v", job)
	}
	// Held again, and the slot frees with nothing else waiting: it stays put...
	post(a, "pause")
	post(b, "stop")
	h.waitStatus(b, "stopped")
	time.Sleep(150 * time.Millisecond)
	if job := h.job(a); job["status"] != "queued" {
		t.Fatalf("a held job must wait for resume even with a free slot: %v", job)
	}
	// ...and starts the moment it is resumed.
	if state := post(a, "resume"); state != "running" {
		t.Fatalf("resuming a held job with a free slot: %q", state)
	}
	for h.depth(a) < 1 {
		time.Sleep(10 * time.Millisecond)
	}
	// A held job can still be dropped.
	c := h.queue(startFEN, 200)["job_id"].(string)
	post(c, "pause")
	post(c, "stop")
	if job := h.job(c); job["status"] != "stopped" {
		t.Fatalf("dropping a held job: %v", job)
	}
	post(a, "stop")
	h.waitStatus(a, "stopped")
}

func TestQueueRunsToTheEnd(t *testing.T) {
	t.Setenv("MOCK_DELAY_MS", "10")
	h := newHarness(t, 1)
	ids := []string{h.start(startFEN, 4)}
	for i := 0; i < 3; i++ {
		ids = append(ids, h.queue(blackFEN, 4)["job_id"].(string))
	}
	// Never more than one engine at a time, and every job gets its turn.
	deadline := time.Now().Add(15 * time.Second)
	for {
		list := h.srv.jobs.active()
		running, unfinished := 0, 0
		for _, view := range list {
			if view.Status == "running" {
				running++
			}
			if view.Status != "complete" {
				unfinished++
			}
		}
		if running > 1 {
			t.Fatalf("%d analyses ran at once with one slot", running)
		}
		if unfinished == 0 && len(list) == len(ids) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the queue did not drain: %+v", list)
		}
		time.Sleep(5 * time.Millisecond)
	}
	for _, id := range ids {
		if job := h.job(id); job["status"] != "complete" || job["result"] == nil {
			t.Fatalf("job %s: %v", id, job)
		}
	}
}

func TestQueueLimitAndEngineRecheck(t *testing.T) {
	t.Setenv("MOCK_DELAY_MS", "50")
	h := newHarness(t, 1)
	running := h.start(startFEN, 200)
	waiting := ""
	for i := 0; i < maxQueuedJobs; i++ {
		waiting = h.queue(blackFEN, 5)["job_id"].(string)
	}
	r := h.do("POST", "/api/analyze", map[string]any{"fen": startFEN, "depth": 5}, nil)
	if r.status != 429 || !strings.Contains(r.body["error"].(string), "already waiting") {
		t.Fatalf("a full queue should refuse: %d %v", r.status, r.body)
	}
	if list := h.do("GET", "/api/analyze", nil, nil).list; len(list) != maxQueuedJobs+1 {
		t.Fatalf("listed %d jobs", len(list))
	}
	// Drop all waiting jobs but the last one.
	for _, view := range h.srv.jobs.active() {
		if view.Status == "queued" && view.JobID != waiting {
			h.do("POST", "/api/analyze/"+view.JobID+"/stop", nil, nil)
		}
	}
	if job := h.job(waiting); job["queue_position"].(float64) != 1 {
		t.Fatalf("the remaining job should be first in line: %v", job)
	}
	// The engine file is checked again when a waiting job finally starts: if
	// it is no longer a trusted build by then, nothing is run.
	t.Setenv("MYCHESSDB_TEST_TRUST", "")
	h.do("POST", "/api/analyze/"+running+"/stop", nil, nil)
	job := h.waitStatus(waiting, "error", "complete", "stopped")
	if job["status"] != "error" || !strings.Contains(job["error"].(string), "not an official") || job["depth"].(float64) != 0 {
		t.Fatalf("a job must not start with an untrusted engine: %v", job)
	}
}

// ------------------------------------------------------------- install ---

func tarGz(t *testing.T, files map[string][]byte) []byte {
	var buffer bytes.Buffer
	zipped := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(zipped)
	_ = archive.WriteHeader(&tar.Header{Name: "stockfish/", Typeflag: tar.TypeDir, Mode: 0o755})
	for name, data := range files {
		if err := archive.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(data))}); err != nil {
			t.Fatal(err)
		}
		archive.Write(data)
	}
	archive.Close()
	zipped.Close()
	return buffer.Bytes()
}

func TestInstallFromRelease(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skip("the stand-in release is built for linux/amd64")
	}
	engineBytes, _ := os.ReadFile(mockEngine)
	asset := stockfishAssets["linux/amd64"]
	archive := tarGz(t, map[string][]byte{
		"stockfish/AUTHORS": []byte("authors"), "stockfish/stockfish-linux-x86-64-universal": engineBytes,
		"stockfish/src/main.cpp": bytes.Repeat([]byte("x"), 1000), "stockfish/README.md": []byte("readme"),
	})
	sum := sha256.Sum256(archive)
	release := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/download/" + asset:
			w.Header().Set("Content-Length", fmt.Sprint(len(archive)))
			w.Write(archive)
		default:
			w.WriteHeader(404)
		}
	}))
	defer release.Close()
	t.Setenv("MYCHESSDB_TEST_RELEASE_BASE", release.URL+"/download/")
	t.Setenv("MYCHESSDB_TEST_ARCHIVE_SHA256", hex.EncodeToString(sum[:]))

	install := func(h *harness) map[string]any {
		if r := h.do("POST", "/api/engine/install", nil, nil); r.status != 202 {
			t.Fatalf("install: %d %v", r.status, r.body)
		}
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			state := h.do("GET", "/api/status", nil, nil).body
			if s := state["install"].(map[string]any)["state"]; s == "done" || s == "error" {
				return state
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("install never finished")
		return nil
	}
	fresh := func() *harness {
		h := newHarness(t, 4)
		h.srv.store.update(func(data *config) { data.EnginePath = "" })
		return h
	}

	h := fresh()
	if r := h.do("GET", "/api/status", nil, nil); r.body["engine"].(map[string]any)["ready"] != false || r.body["can_install"] != true {
		t.Fatalf("before install: %v", r.body)
	}
	if r := h.do("POST", "/api/analyze", map[string]any{"fen": startFEN, "depth": 5}, nil); r.status != 400 {
		t.Fatalf("analysis without an engine: %d", r.status)
	}
	state := install(h)
	engine := state["engine"].(map[string]any)
	want := filepath.Join(h.dir, "engines", stockfishTag, "stockfish-linux-x86-64-universal")
	if state["install"].(map[string]any)["state"] != "done" || engine["ready"] != true || engine["path"] != want {
		t.Fatalf("after install: %v", state)
	}
	if entries, _ := os.ReadDir(filepath.Dir(want)); len(entries) != 1 {
		t.Fatalf("only the engine should be left behind, found %v", entries)
	}
	id := h.start(startFEN, 3)
	if job := h.waitStatus(id, "complete", "error"); job["status"] != "complete" {
		t.Fatalf("analysis with the installed engine: %v", job)
	}

	// A download that is not byte-for-byte the pinned release file is refused
	// and nothing from it is kept.
	good := archive
	archive = append(append([]byte(nil), good...), 0)
	h = fresh()
	state = install(h)
	if s := state["install"].(map[string]any); s["state"] != "error" || !strings.Contains(s["error"].(string), "SHA-256") {
		t.Fatalf("checksum mismatch: %v", state)
	}
	if state["engine"].(map[string]any)["ready"] != false || h.srv.store.get().EnginePath != "" {
		t.Fatalf("a bad download must not be used: %v", state)
	}
	if entries, _ := os.ReadDir(filepath.Join(h.dir, "engines", stockfishTag)); len(entries) != 0 {
		t.Fatalf("a refused download left files behind: %v", entries)
	}
	archive = good

	// The right archive holding an executable that is not a pinned build
	// (here: trust for the stand-in engine withdrawn) is refused as well.
	t.Setenv("MYCHESSDB_TEST_TRUST", "")
	h = fresh()
	state = install(h)
	if s := state["install"].(map[string]any); s["state"] != "error" || !strings.Contains(s["error"].(string), "not an official") {
		t.Fatalf("unpinned executable: %v", state)
	}
	if entries, _ := os.ReadDir(filepath.Join(h.dir, "engines", stockfishTag)); len(entries) != 0 {
		t.Fatalf("an unpinned executable was kept: %v", entries)
	}
}

// The pinned checksums must be well-formed and cover every platform the
// bridge is built for.
func TestPinnedReleaseTable(t *testing.T) {
	isSHA256 := func(text string) bool {
		raw, err := hex.DecodeString(text)
		return err == nil && len(raw) == 32 && text == strings.ToLower(text)
	}
	names := map[string]bool{}
	for hash, name := range pinnedEngines {
		if !isSHA256(hash) || names[name] {
			t.Errorf("bad or duplicate pinned engine: %s %s", hash, name)
		}
		names[name] = true
	}
	for platform, asset := range stockfishAssets {
		digest, ok := pinnedArchives[asset]
		if !ok || !isSHA256(digest) {
			t.Errorf("%s: release file %s has no valid pinned checksum", platform, asset)
		}
		engine := strings.TrimSuffix(strings.TrimSuffix(asset, ".zip"), ".tar.gz")
		if strings.HasPrefix(platform, "windows/") {
			engine += ".exe"
		}
		if !names[engine] {
			t.Errorf("%s: no pinned executable named %s", platform, engine)
		}
	}
}

func TestExtractFromZip(t *testing.T) {
	dir := t.TempDir()
	name := "stockfish/stockfish-test-universal"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for file, data := range map[string]string{"stockfish/AUTHORS": "a", name: "ENGINE-BYTES", "stockfish/src/stockfish.cpp": "tiny", "../evil": "x"} {
		entry, _ := writer.Create(file)
		entry.Write([]byte(data))
	}
	writer.Close()
	archive := filepath.Join(dir, "release.zip.download")
	os.WriteFile(archive, buffer.Bytes(), 0o644)
	path, hash, err := extractEngine(archive, dir)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("ENGINE-BYTES"))
	if filepath.Dir(path) != dir || !strings.HasPrefix(filepath.Base(path), "stockfish-test-universal") || hash != hex.EncodeToString(sum[:]) {
		t.Fatalf("extracted %q %q", path, hash)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "evil")); err == nil {
		t.Fatal("an archive entry escaped the engine folder")
	}
	os.WriteFile(archive, []byte("not a zip"), 0o644)
	if _, _, err := extractEngine(archive, dir); err == nil {
		t.Fatal("garbage accepted as a zip")
	}
}

// mychessdb-bridge: runs Stockfish on this computer for the My Chess DB site.
//
// The site is an ordinary web page and cannot start programs. This small
// program listens on 127.0.0.1 only and lets the site(s) named with -site
// start, watch, pause and stop Stockfish analyses here. It never accepts
// requests from other web pages and never runs anything but a verified
// official Stockfish 19 build.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const (
	appName     = "mychessdb-bridge"
	version     = "1.0.5"
	defaultPort = 8765
	maxBody     = 4 << 20
)

func logf(format string, args ...any) {
	log.Printf(format, args...)
}

// normalizeOrigin turns "https://Example.com/path" into "https://example.com".
// Plain http is accepted only for this computer (local development).
func normalizeOrigin(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("%q is not a site address like https://example.com", raw)
	}
	host := strings.ToLower(parsed.Host)
	name := strings.ToLower(parsed.Hostname())
	local := name == "localhost" || name == "127.0.0.1"
	switch strings.ToLower(parsed.Scheme) {
	case "https":
	case "http":
		if !local {
			return "", fmt.Errorf("%q must use https", raw)
		}
	default:
		return "", fmt.Errorf("%q must start with https://", raw)
	}
	return strings.ToLower(parsed.Scheme) + "://" + host, nil
}

type server struct {
	port      int
	store     *configStore
	verifier  *engineVerifier
	installer *installer
	jobs      *jobManager
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, err error) {
	var known *httpError
	if errors.As(err, &known) {
		writeJSON(w, known.status, map[string]string{"error": known.message})
		return
	}
	writeJSON(w, 500, map[string]string{"error": err.Error()})
}

func (s *server) originAllowed(origin string) bool {
	for _, site := range s.store.get().Sites {
		if site == origin {
			return true
		}
	}
	return false
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Only answer when addressed as this computer. A web page that tricks the
	// browser into resolving its own domain to 127.0.0.1 ("DNS rebinding")
	// arrives with that domain in Host and is turned away here.
	if r.Host != fmt.Sprintf("127.0.0.1:%d", s.port) && r.Host != fmt.Sprintf("localhost:%d", s.port) {
		writeJSON(w, 403, map[string]string{"error": "unexpected Host header"})
		return
	}
	origin := r.Header.Get("Origin")
	if origin != "" {
		if !s.originAllowed(origin) {
			writeJSON(w, 403, map[string]string{"error": "this site is not allowed to use the bridge"})
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
	if r.Method == http.MethodOptions {
		if origin == "" {
			writeJSON(w, 403, map[string]string{"error": "missing Origin"})
			return
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(204)
		return
	}
	// Anything that changes state must come from an allowed site. Browsers
	// always attach Origin to cross-site POSTs, so a missing one means the
	// request did not come from the site.
	if r.Method != http.MethodGet && origin == "" {
		writeJSON(w, 403, map[string]string{"error": "requests must come from the My Chess DB site"})
		return
	}
	s.route(w, r)
}

func (s *server) readBody(r *http.Request, into any) error {
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return &httpError{400, "could not read the request"}
	}
	if len(raw) > maxBody {
		return &httpError{413, "request is too large"}
	}
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return &httpError{400, "request body is not valid JSON"}
	}
	return nil
}

func (s *server) statusBody() map[string]any {
	cfg := s.store.get()
	engine := map[string]any{"ready": false, "path": cfg.EnginePath}
	if cfg.EnginePath != "" {
		if name, err := s.verifier.verify(cfg.EnginePath); err == nil {
			engine["ready"], engine["name"] = true, name
		} else {
			engine["error"] = err.Error()
		}
	}
	threads, hash := resourceBudget()
	_, canInstall := stockfishAssets[runtime.GOOS+"/"+runtime.GOARCH]
	return map[string]any{
		"app": appName, "version": version, "os": runtime.GOOS, "arch": runtime.GOARCH,
		"engine": engine, "install": s.installer.current(), "can_install": canInstall,
		"threads": threads, "hash": hash, "max_jobs": s.jobs.maxJobs,
	}
}

// currentEngine returns the configured engine, after checking once more that
// it is a verified official build.
func (s *server) currentEngine() (string, error) {
	path := s.store.get().EnginePath
	if _, err := s.verifier.verify(path); err != nil {
		return "", err
	}
	return path, nil
}

func (s *server) route(w http.ResponseWriter, r *http.Request) {
	path, get, post := r.URL.Path, r.Method == http.MethodGet, r.Method == http.MethodPost
	switch {
	case path == "/" && get:
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		sites := strings.Join(s.store.get().Sites, ", ")
		fmt.Fprintf(w, "My Chess DB engine bridge %s is running.\nOpen the site to use it: %s\n", version, sites)

	case path == "/api/status" && get:
		writeJSON(w, 200, s.statusBody())

	case path == "/api/engine/install" && post:
		if _, ok := stockfishAssets[runtime.GOOS+"/"+runtime.GOARCH]; !ok {
			writeJSON(w, 400, map[string]string{"error": "there is no official Stockfish download for this kind of computer"})
			return
		}
		s.installer.start()
		writeJSON(w, 202, s.installer.current())

	case path == "/api/engine/path" && post:
		var body struct {
			EnginePath string `json:"engine_path"`
		}
		if err := s.readBody(r, &body); err != nil {
			writeError(w, err)
			return
		}
		cleaned := cleanEnginePath(body.EnginePath)
		name, err := s.verifier.verify(cleaned)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		if err := s.store.update(func(data *config) { data.EnginePath = cleaned }); err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "name": name, "path": cleaned})

	case path == "/api/analyze" && get:
		writeJSON(w, 200, s.jobs.active())

	case path == "/api/analyze" && post:
		var body struct {
			Fen     string          `json:"fen"`
			Depth   int             `json:"depth"`
			Context json.RawMessage `json:"context"`
		}
		if err := s.readBody(r, &body); err != nil {
			writeError(w, err)
			return
		}
		if _, err := s.currentEngine(); err != nil {
			writeJSON(w, 400, map[string]string{"error": "Stockfish is not ready: " + err.Error()})
			return
		}
		view, err := s.jobs.start(strings.TrimSpace(body.Fen), body.Depth, body.Context)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 202, view)

	case strings.HasPrefix(path, "/api/analyze/"):
		parts := strings.Split(strings.TrimPrefix(path, "/api/analyze/"), "/")
		id := parts[0]
		switch {
		case len(parts) == 1 && get:
			view, ok := s.jobs.get(id)
			if !ok {
				writeJSON(w, 404, map[string]string{"error": "Analysis job not found"})
				return
			}
			writeJSON(w, 200, view)
		case len(parts) == 2 && post:
			var err error
			var state string
			switch parts[1] {
			case "stop":
				err, state = s.jobs.stop(id), "stopping"
			case "pause":
				err, state = s.jobs.pause(id), "paused"
			case "resume":
				err, state = s.jobs.resume(id), "running"
			default:
				err = &httpError{404, "Not found"}
			}
			if err != nil {
				writeError(w, err)
				return
			}
			if parts[1] != "stop" {
				// A queued job stays queued: held when paused, back in line when resumed.
				if view, ok := s.jobs.get(id); ok && view.Status == "queued" {
					state = "queued"
					if view.Held {
						state = "held"
					}
				}
			}
			writeJSON(w, 200, map[string]string{"status": state})
		default:
			writeJSON(w, 404, map[string]string{"error": "Not found"})
		}

	default:
		writeJSON(w, 404, map[string]string{"error": "Not found"})
	}
}

// alreadyRunning reports whether another copy of the bridge owns the port.
func alreadyRunning(port int) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/status", port))
	if err != nil {
		return false
	}
	defer response.Body.Close()
	var body struct {
		App string `json:"app"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&body)
	return body.App == appName
}

// rememberSite puts origin at the end of the allowed sites (the end is the
// most recently used one), without duplicating it.
func rememberSite(sites []string, origin string) []string {
	out := make([]string, 0, len(sites)+1)
	for _, existing := range sites {
		if existing != origin {
			out = append(out, existing)
		}
	}
	return append(out, origin)
}

type siteList []string

func (l *siteList) String() string     { return strings.Join(*l, ",") }
func (l *siteList) Set(v string) error { *l = append(*l, v); return nil }

func main() {
	log.SetFlags(log.Ltime)
	var sites siteList
	flag.Var(&sites, "site", "address of the My Chess DB site allowed to use this bridge (https://...); remembered for next time")
	port := flag.Int("port", defaultPort, "port to listen on (the site expects 8765)")
	noOpen := flag.Bool("no-open", false, "do not open the site in the browser")
	maxJobs := flag.Int("max-jobs", 4, "how many analyses may run at the same time; more wait in a queue")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	dir, err := configDir()
	if err != nil {
		log.Fatalf("Could not find a settings folder: %v", err)
	}
	store, err := loadConfig(dir)
	if err != nil {
		log.Fatalf("Could not read settings: %v", err)
	}
	for _, raw := range sites {
		origin, err := normalizeOrigin(raw)
		if err != nil {
			log.Fatal(err)
		}
		if err := store.update(func(data *config) { data.Sites = rememberSite(data.Sites, origin) }); err != nil {
			log.Fatalf("Could not save settings: %v", err)
		}
	}
	cfg := store.get()
	if len(cfg.Sites) == 0 {
		log.Fatalf("No site is set. Start once with:  %s -site https://your-site-address", appName)
	}
	// The site to show in the browser: the one named now, or else the one
	// used most recently.
	openSite := cfg.Sites[len(cfg.Sites)-1]
	if *maxJobs < 1 {
		*maxJobs = 1
	}

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		if alreadyRunning(*port) {
			logf("The bridge is already running.")
			if !*noOpen {
				_ = openBrowser(openSite)
			}
			return
		}
		log.Fatalf("Port %d is in use by another program: %v", *port, err)
	}

	verifier := newEngineVerifier(store)
	srv := &server{
		port: *port, store: store, verifier: verifier,
		installer: &installer{dir: dir, store: store, verifier: verifier, status: installStatus{State: "idle"}},
	}
	srv.jobs = newJobManager(*maxJobs, srv.currentEngine)

	logf("My Chess DB engine bridge %s", version)
	logf("Listening on http://127.0.0.1:%d for %s", *port, strings.Join(cfg.Sites, ", "))
	logf("Keep this window open while you analyse. Close it (or press Ctrl+C) to stop.")

	go func() {
		// First run: fetch Stockfish without being asked.
		if _, err := verifier.verify(cfg.EnginePath); err != nil {
			if _, ok := stockfishAssets[runtime.GOOS+"/"+runtime.GOARCH]; ok {
				srv.installer.start()
			} else {
				logf("No official Stockfish download exists for %s/%s.", runtime.GOOS, runtime.GOARCH)
			}
		} else {
			logf("Engine ready: %s", cfg.EnginePath)
		}
	}()
	if !*noOpen {
		_ = openBrowser(openSite)
	}

	httpServer := &http.Server{Handler: srv, ReadHeaderTimeout: 10 * time.Second}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		logf("Stopping ...")
		// Stop answering first, so the site sees the bridge go away instead
		// of a half-finished job state.
		_ = httpServer.Close()
		srv.jobs.shutdown()
	}()
	if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		srv.jobs.shutdown()
		log.Fatal(err)
	}
	srv.jobs.shutdown()
}

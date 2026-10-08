package main

// Live analysis: one Stockfish process that searches whatever position the
// site has on its board, without a depth limit ("go infinite"), the way the
// Lichess analysis board does. Nothing it finds is saved; the site only shows
// it. Every new position replaces the previous one at once, and the process
// stays up between positions so its hash table keeps what it learned.
//
// The site keeps the search going by asking for its progress. When it stops
// asking (the tab was closed or hidden), the search stops; a while later the
// process ends too and its memory is given back.

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const liveMaxHashMB = 1024

var (
	// No request from the site for this long: stop searching.
	liveIdleStop = 10 * time.Second
	// Not searching for this long: end the process.
	liveIdleQuit = 60 * time.Second
	// How often the idle limits are checked.
	liveTick = time.Second
)

// liveView is what the site sees.
type liveView struct {
	// idle (not searching) | starting | running | done (the search ended by
	// itself, at the deepest depth Stockfish knows) | error
	Status string `json:"status"`
	Fen    string `json:"fen,omitempty"`
	// Depth is the depth being searched now; Best is the deepest depth
	// searched to the end, as for an analysis job.
	Depth   int             `json:"depth"`
	Best    *analysisResult `json:"best,omitempty"`
	Threads int             `json:"threads,omitempty"`
	Hash    int             `json:"hash,omitempty"`
	Error   string          `json:"error,omitempty"`
}

type liveRequest struct {
	fen string // "" = stop searching
	gen uint64
}

type liveEngine struct {
	engine  func() (string, error)
	running func() int // analysis jobs running at this moment
	// searching is read by the job manager (under its own lock) to count the
	// live search when it shares out the processor, so it is not under mu.
	searching atomic.Bool

	requests chan liveRequest // holds only the newest request
	done     chan struct{}
	exited   chan struct{}
	stopOnce sync.Once

	mu       sync.Mutex
	view     liveView
	gen      uint64 // bumped by every request; stale engine output is dropped
	lastSeen time.Time
	closing  bool
}

func newLiveEngine(engine func() (string, error), running func() int) *liveEngine {
	l := &liveEngine{
		engine: engine, running: running,
		requests: make(chan liveRequest, 1), done: make(chan struct{}), exited: make(chan struct{}),
		view: liveView{Status: "idle"}, lastSeen: time.Now(),
	}
	go l.loop()
	return l
}

// load is 1 while the live search uses the processor.
func (l *liveEngine) load() int {
	if l.searching.Load() {
		return 1
	}
	return 0
}

func (l *liveEngine) snapshot() liveView {
	view := l.view
	if view.Best != nil {
		best := *view.Best
		view.Best = &best
	}
	return view
}

// get reports the search. Asking also tells the bridge the site is still
// there, which keeps the search going.
func (l *liveEngine) get() liveView {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lastSeen = time.Now()
	return l.snapshot()
}

// set moves the search to fen, or stops it when fen is "".
func (l *liveEngine) set(fen string) (liveView, error) {
	if fen != "" {
		if err := validateFEN(fen); err != nil {
			return liveView{}, &httpError{400, err.Error()}
		}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closing {
		return liveView{}, &httpError{503, "The engine bridge is shutting down."}
	}
	l.lastSeen = time.Now()
	l.gen++
	if fen != "" {
		l.view = liveView{Status: "starting", Fen: fen, Threads: l.view.Threads, Hash: l.view.Hash}
	} else if l.view.Status == "starting" || l.view.Status == "running" {
		l.view.Status = "idle"
	}
	// Only the newest request matters: replace one that is still waiting.
	select {
	case <-l.requests:
	default:
	}
	l.requests <- liveRequest{fen: fen, gen: l.gen}
	return l.snapshot(), nil
}

// change applies an update from the engine if it still belongs to the
// newest request.
func (l *liveEngine) change(gen uint64, update func(view *liveView)) {
	l.mu.Lock()
	if gen == l.gen {
		update(&l.view)
	}
	l.mu.Unlock()
}

// shutdown ends the process; called when the bridge exits.
func (l *liveEngine) shutdown() {
	l.stopOnce.Do(func() {
		l.mu.Lock()
		l.closing = true
		l.mu.Unlock()
		close(l.done)
	})
	select {
	case <-l.exited:
	case <-time.After(5 * time.Second):
	}
}

// loop owns the engine process: only this goroutine talks to it.
func (l *liveEngine) loop() {
	defer close(l.exited)
	var (
		proc        *uciProc
		identity    engineIdentity
		lines       <-chan string // nil while there is no process
		searching   bool
		gen         uint64
		fen         string
		blackToMove bool
		idleSince   = time.Now()
	)
	setSearching := func(on bool) {
		searching = on
		l.searching.Store(on)
		if !on {
			idleSince = time.Now()
		}
	}
	endProcess := func() {
		if proc != nil {
			proc.kill()
		}
		proc, lines = nil, nil
		setSearching(false)
	}
	defer endProcess()
	fail := func(gen uint64, message string) {
		endProcess()
		logf("Live analysis failed: %s", message)
		l.change(gen, func(view *liveView) { view.Status, view.Error = "error", message })
	}
	// stopSearch ends the current search and waits for the engine to confirm,
	// so that its last lines are not taken for the next position's.
	stopSearch := func() {
		if !searching {
			return
		}
		_ = proc.send("stop")
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		for {
			select {
			case line, ok := <-lines:
				if !ok {
					endProcess()
					return
				}
				if strings.HasPrefix(line, "bestmove") {
					setSearching(false)
					return
				}
			case <-timer.C:
				// It did not answer: start a fresh one next time.
				endProcess()
				return
			}
		}
	}
	startProcess := func(gen uint64) bool {
		path, err := l.engine()
		if err != nil {
			fail(gen, "Stockfish is not ready: "+err.Error())
			return false
		}
		started, err := startUCI(path)
		if err != nil {
			fail(gen, "Could not start Stockfish: "+err.Error())
			return false
		}
		proc, lines = started, started.lines
		identity, err = proc.handshake(20 * time.Second)
		if err != nil {
			fail(gen, err.Error())
			return false
		}
		// A share of the machine like one more analysis job, with a smaller
		// hash table: a live search moves on long before a large one fills.
		threads, hash := perJobResources(l.running() + 1)
		if hash > liveMaxHashMB {
			hash = liveMaxHashMB
		}
		hash = fitHashToFreeMemory(hash, availableMemoryMB())
		setOption := func(name string, value any) {
			if identity.Options[name] {
				_ = proc.send(fmt.Sprintf("setoption name %s value %v", name, value))
			}
		}
		setOption("Threads", threads)
		setOption("Hash", hash)
		setOption("Syzygy50MoveRule", "false")
		_ = proc.send("ucinewgame")
		_ = proc.send("isready")
		if err := proc.waitFor("readyok", time.Minute, nil); err != nil {
			fail(gen, err.Error())
			return false
		}
		logf("Live analysis started: %d threads, %d MB hash.", threads, hash)
		l.change(gen, func(view *liveView) { view.Threads, view.Hash = threads, hash })
		return true
	}

	ticker := time.NewTicker(liveTick)
	defer ticker.Stop()
	for {
		select {
		case <-l.done:
			return

		case request := <-l.requests:
			stopSearch()
			if request.fen == "" {
				continue
			}
			if proc == nil && !startProcess(request.gen) {
				continue
			}
			gen, fen = request.gen, request.fen
			blackToMove = strings.Fields(fen)[1] == "b"
			// No "ucinewgame" between positions: what the hash table holds
			// about the position before is mostly still of use.
			_ = proc.send("position fen " + fen)
			_ = proc.send("go infinite")
			setSearching(true)
			l.change(gen, func(view *liveView) { view.Status = "running" })

		case line, ok := <-lines:
			if !ok {
				fail(gen, "Stockfish stopped unexpectedly.")
				continue
			}
			if strings.HasPrefix(line, "bestmove") {
				// Only after the deepest depth there is: nothing more to find.
				setSearching(false)
				l.change(gen, func(view *liveView) { view.Status = "done" })
				continue
			}
			info, isInfo := parseInfo(line)
			if !isInfo || !info.HasDepth {
				continue
			}
			finished := info.HasScore && !info.Bound && info.MultiPV == 1 && len(info.PV) > 0
			searchingDepth := info.Depth
			var latest *analysisResult
			if finished {
				latest = &analysisResult{
					MoveUCI: info.PV[0], PV: info.PV, Evaluation: formatEvaluation(info, blackToMove),
					Depth: info.Depth, Nodes: info.Nodes, TimeMs: info.TimeMs,
				}
				searchingDepth++
			}
			l.change(gen, func(view *liveView) {
				if searchingDepth > view.Depth {
					view.Depth = searchingDepth
				}
				if latest != nil {
					view.Best = latest
				}
			})

		case <-ticker.C:
			l.mu.Lock()
			quiet := time.Since(l.lastSeen)
			l.mu.Unlock()
			if searching && quiet > liveIdleStop {
				stopSearch()
				l.change(gen, func(view *liveView) {
					if view.Status == "running" {
						view.Status = "idle"
					}
				})
				logf("Live analysis paused: the site stopped following it.")
			}
			if !searching && proc != nil && time.Since(idleSince) > liveIdleQuit && quiet > liveIdleQuit {
				proc.quit()
				proc, lines = nil, nil
				logf("Live analysis engine closed (not used for a while).")
			}
		}
	}
}

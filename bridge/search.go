package main

// Searches for the puzzle finder (puzzlegen.go): one Stockfish process that
// runs one limited search at a time (several lines, a node, depth or time
// limit) and answers with the lines it found, the way a UCI library's
// analyse() does. When the search's context is cancelled (Stop, or the
// bridge closing), Stockfish is stopped.
//
// The process stays up between searches, so its hash table keeps what it
// learned about the game, and ends after a minute without one. It gets a
// share of the processor like one more analysis job, and counts as one for
// jobs and live analysis started while it searches.

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	searchMaxHashMB  = 1024
	searchMaxMoves   = 1000
	searchMaxMultiPV = 20
	searchMaxNodes   = 1_000_000_000
	searchMaxTimeMs  = 600_000
)

// Not searching for this long: end the process.
var searchIdleQuit = 60 * time.Second

var uciMoveShape = regexp.MustCompile(`^[a-h][1-8][a-h][1-8][qrbn]?$`)

type searchRequest struct {
	Fen      string   `json:"fen"`
	Moves    []string `json:"moves"`
	Nodes    int64    `json:"nodes"`
	Depth    int      `json:"depth"`
	Movetime int      `json:"movetime"`
	MultiPV  int      `json:"multipv"`
	// NewGame: the search is the first of another game; the engine forgets
	// what it found ("ucinewgame").
	NewGame bool `json:"new_game"`
}

// searchScore is from the side to move: {"cp": 32} or {"mate": -3}.
type searchScore struct {
	Cp   *int `json:"cp,omitempty"`
	Mate *int `json:"mate,omitempty"`
}

type searchLine struct {
	MultiPV int         `json:"multipv"`
	Depth   int         `json:"depth"`
	Nodes   int64       `json:"nodes"`
	Score   searchScore `json:"score"`
	PV      []string    `json:"pv"`
	bound   bool
}

type searchResult struct {
	// Best line first.
	Lines    []searchLine `json:"lines"`
	BestMove string       `json:"bestmove,omitempty"`
	Threads  int          `json:"threads"`
	Hash     int          `json:"hash"`
}

func (r *searchRequest) validate() error {
	r.Fen = strings.TrimSpace(r.Fen)
	if err := validateFEN(r.Fen); err != nil {
		return &httpError{400, err.Error()}
	}
	if len(r.Moves) > searchMaxMoves {
		return &httpError{400, fmt.Sprintf("at most %d moves", searchMaxMoves)}
	}
	for _, move := range r.Moves {
		if !uciMoveShape.MatchString(move) {
			return &httpError{400, fmt.Sprintf("%q is not a move like e2e4", move)}
		}
	}
	if r.MultiPV == 0 {
		r.MultiPV = 1
	}
	switch {
	case r.MultiPV < 1 || r.MultiPV > searchMaxMultiPV:
		return &httpError{400, fmt.Sprintf("multipv must be from 1 to %d", searchMaxMultiPV)}
	case r.Nodes < 0 || r.Nodes > searchMaxNodes:
		return &httpError{400, fmt.Sprintf("nodes must be from 1 to %d", searchMaxNodes)}
	case r.Depth < 0 || r.Depth > maxSearchDepth:
		return &httpError{400, fmt.Sprintf("depth must be from 1 to %d", maxSearchDepth)}
	case r.Movetime < 0 || r.Movetime > searchMaxTimeMs:
		return &httpError{400, fmt.Sprintf("movetime must be from 1 to %d milliseconds", searchMaxTimeMs)}
	case r.Nodes == 0 && r.Depth == 0 && r.Movetime == 0:
		return &httpError{400, "give a limit: nodes, depth or movetime"}
	}
	return nil
}

type searcher struct {
	engine  func() (string, error)
	running func() int // other searches using the processor at this moment
	// searching is read by the job manager and live analysis to count this
	// search when they share out the processor, so it is not under mu.
	searching atomic.Bool

	mu       sync.Mutex // held for the whole of a search: one at a time
	proc     *uciProc
	identity engineIdentity
	threads  int
	hash     int
	multipv  int
	idle     *time.Timer
	lastUsed time.Time
	closing  bool
}

func newSearcher(engine func() (string, error), running func() int) *searcher {
	return &searcher{engine: engine, running: running}
}

// load is 1 while a search uses the processor.
func (s *searcher) load() int {
	if s.searching.Load() {
		return 1
	}
	return 0
}

func (s *searcher) endProcessLocked() {
	if s.proc != nil {
		s.proc.kill()
	}
	s.proc = nil
}

func (s *searcher) startLocked() error {
	path, err := s.engine()
	if err != nil {
		return &httpError{400, "Stockfish is not ready: " + err.Error()}
	}
	proc, err := startUCI(path)
	if err != nil {
		return fmt.Errorf("could not start Stockfish: %w", err)
	}
	s.proc = proc
	if s.identity, err = proc.handshake(20 * time.Second); err != nil {
		s.endProcessLocked()
		return err
	}
	threads, hash := perJobResources(s.running() + 1)
	if hash > searchMaxHashMB {
		hash = searchMaxHashMB
	}
	hash = fitHashToFreeMemory(hash, availableMemoryMB())
	s.setOptionLocked("Threads", threads)
	s.setOptionLocked("Hash", hash)
	s.setOptionLocked("Syzygy50MoveRule", "false")
	s.threads, s.hash, s.multipv = threads, hash, 1
	_ = proc.send("isready")
	if err := proc.waitFor("readyok", time.Minute, nil); err != nil {
		s.endProcessLocked()
		return err
	}
	logf("Puzzle search engine started: %d threads, %d MB hash.", threads, hash)
	return nil
}

func (s *searcher) setOptionLocked(name string, value any) {
	if s.identity.Options[name] {
		_ = s.proc.send(fmt.Sprintf("setoption name %s value %v", name, value))
	}
}

// search runs one search and returns its lines. It waits for a search that
// is already running to end first.
func (s *searcher) search(ctx context.Context, request searchRequest) (searchResult, error) {
	if err := request.validate(); err != nil {
		return searchResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return searchResult{}, &httpError{503, "The engine bridge is shutting down."}
	}
	if err := ctx.Err(); err != nil {
		return searchResult{}, &httpError{499, "the search was cancelled"}
	}
	if s.idle != nil {
		s.idle.Stop()
	}
	defer s.scheduleQuitLocked()
	if s.proc == nil {
		if err := s.startLocked(); err != nil {
			return searchResult{}, err
		}
	}
	proc := s.proc
	if request.MultiPV != s.multipv {
		s.setOptionLocked("MultiPV", request.MultiPV)
		s.multipv = request.MultiPV
	}
	if request.NewGame {
		_ = proc.send("ucinewgame")
	}
	position := "position fen " + request.Fen
	if len(request.Moves) > 0 {
		position += " moves " + strings.Join(request.Moves, " ")
	}
	_ = proc.send(position)
	limits := []string{"go"}
	if request.Depth > 0 {
		limits = append(limits, fmt.Sprintf("depth %d", request.Depth))
	}
	if request.Nodes > 0 {
		limits = append(limits, fmt.Sprintf("nodes %d", request.Nodes))
	}
	if request.Movetime > 0 {
		limits = append(limits, fmt.Sprintf("movetime %d", request.Movetime))
	}
	_ = proc.send(strings.Join(limits, " "))
	s.searching.Store(true)
	defer s.searching.Store(false)

	lines := make([]*searchLine, request.MultiPV)
	var stopped <-chan time.Time
	cancelled := false
	done := ctx.Done()
	for {
		select {
		case <-done:
			// The site gave up on it: stop, and wait for the engine to say so.
			_ = proc.send("stop")
			cancelled, done = true, nil
			stopped = time.After(5 * time.Second)
		case <-stopped:
			s.endProcessLocked()
			return searchResult{}, &httpError{499, "the search was cancelled"}
		case line, ok := <-proc.lines:
			if !ok {
				s.endProcessLocked()
				return searchResult{}, &httpError{500, "Stockfish stopped unexpectedly."}
			}
			if strings.HasPrefix(line, "bestmove") {
				if cancelled {
					return searchResult{}, &httpError{499, "the search was cancelled"}
				}
				result := searchResult{Lines: []searchLine{}, Threads: s.threads, Hash: s.hash}
				if fields := strings.Fields(line); len(fields) > 1 && fields[1] != "(none)" {
					result.BestMove = fields[1]
				}
				for _, found := range lines {
					if found != nil {
						result.Lines = append(result.Lines, *found)
					}
				}
				return result, nil
			}
			info, isInfo := parseInfo(line)
			if !isInfo || !info.HasScore || len(info.PV) == 0 || info.MultiPV < 1 || info.MultiPV > len(lines) {
				continue
			}
			// The newest result of each line; one found inside an aspiration
			// window (a bound) only stands in until an exact one comes.
			slot := info.MultiPV - 1
			if info.Bound && lines[slot] != nil && !lines[slot].bound {
				continue
			}
			score := info.Score
			found := &searchLine{MultiPV: info.MultiPV, Depth: info.Depth, Nodes: info.Nodes, PV: info.PV, bound: info.Bound}
			if info.IsMate {
				found.Score.Mate = &score
			} else {
				found.Score.Cp = &score
			}
			lines[slot] = found
		}
	}
}

// scheduleQuitLocked ends the process once it has not searched for a while.
func (s *searcher) scheduleQuitLocked() {
	s.lastUsed = time.Now()
	if s.proc == nil || s.closing {
		return
	}
	s.idle = time.AfterFunc(searchIdleQuit, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		// A search may have run between the timer firing and getting the lock.
		if s.proc != nil && time.Since(s.lastUsed) >= searchIdleQuit {
			s.proc.quit()
			s.proc = nil
			logf("Puzzle search engine closed (not used for a while).")
		}
	})
}

// shutdown ends the process; called when the bridge exits. A search that is
// running is stopped first.
func (s *searcher) shutdown() {
	s.mu.Lock()
	s.closing = true
	proc := s.proc
	s.mu.Unlock()
	if proc != nil && s.searching.Load() {
		_ = proc.send("stop")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.idle != nil {
		s.idle.Stop()
	}
	s.endProcessLocked()
}

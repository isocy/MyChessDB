package main

// Analysis jobs: each one is its own Stockfish process searching one position
// to a fixed depth. Jobs can be paused (process frozen, memory kept), resumed
// and stopped individually. While a job runs, the site can read the deepest
// depth searched to the end so far; a stopped job keeps it.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxTotalThreads     = 32
	maxTotalHashMB      = 8192
	fallbackTotalHashMB = 2048
	maxSearchDepth      = 245
	minJobHashMB        = 64
	// How many analyses may wait for a free slot.
	maxQueuedJobs = 100
)

// resourceBudget is the total (threads, hash MB) Stockfish may use on this
// machine: all cores but one, and a quarter of the RAM, both capped.
func resourceBudget() (int, int) {
	threads := runtime.NumCPU() - 1
	if threads < 1 {
		threads = 1
	}
	if threads > maxTotalThreads {
		threads = maxTotalThreads
	}
	memory := totalMemoryMB()
	if memory <= 0 {
		memory = fallbackTotalHashMB * 4
	}
	hash := memory / 4
	if hash < 256 {
		hash = 256
	}
	if hash > maxTotalHashMB {
		hash = maxTotalHashMB
	}
	return threads, hash
}

// perJobResources splits the budget across the jobs running at this moment.
func perJobResources(activeJobs int) (int, int) {
	totalThreads, totalHash := resourceBudget()
	if activeJobs < 1 {
		activeJobs = 1
	}
	threads := totalThreads / activeJobs
	if threads < 1 {
		threads = 1
	}
	hash := totalHash / activeJobs
	if hash < minJobHashMB {
		hash = minJobHashMB
	}
	return threads, hash
}

// fitHashToFreeMemory keeps a new job's hash table within half of the memory
// that is free right now. A table larger than what is free makes the system
// push other programs (the browser first of all) out to disk, which freezes
// them for a while. freeMB <= 0 means "unknown": the hash is left as it is.
func fitHashToFreeMemory(hash, freeMB int) int {
	if freeMB <= 0 {
		return hash
	}
	limit := freeMB / 2
	if limit < minJobHashMB {
		limit = minJobHashMB
	}
	if hash > limit {
		return limit
	}
	return hash
}

type analysisResult struct {
	MoveUCI    string   `json:"move_uci"`
	PV         []string `json:"pv"`
	Evaluation string   `json:"evaluation"`
	Depth      int      `json:"depth"`
	Nodes      int64    `json:"nodes"`
	TimeMs     int64    `json:"time_ms"`
}

// jobView is what the site sees.
type jobView struct {
	JobID  string `json:"job_id"`
	Status string `json:"status"` // queued | running | paused | complete | stopped | error
	// Depth is the depth being searched right now (the final depth once the
	// job is complete). The deepest depth already searched to the end is
	// Best.Depth, normally one less.
	Depth       int    `json:"depth"`
	TargetDepth int    `json:"target_depth"`
	Progress    int    `json:"progress"`
	Fen         string `json:"fen"`
	Threads     int    `json:"threads"`
	Hash        int    `json:"hash"`
	// QueuePosition: 1 for the job that starts next; only set while queued
	// and not held.
	QueuePosition int `json:"queue_position,omitempty"`
	// Held: a queued job that was paused. It keeps its place but is passed
	// over when a slot frees up, until it is resumed.
	Held  bool   `json:"held,omitempty"`
	Error string `json:"error,omitempty"`
	// Best is the deepest depth searched to the end so far: its best move,
	// line and evaluation. It follows the search while the job runs, and it
	// is what remains of a job that was stopped before reaching its target.
	Best *analysisResult `json:"best,omitempty"`
	// Result is set once the target depth has been reached.
	Result  *analysisResult `json:"result,omitempty"`
	Context json.RawMessage `json:"context,omitempty"`
}

type job struct {
	view     jobView
	proc     *uciProc
	cancel   chan struct{}
	finished time.Time
	// collected: the site has fetched this job's result. Until then a
	// completed job stays in the active list, so an analysis that finishes
	// while the page is closed is still picked up and saved next time.
	collected bool
	// seq: order of arrival. Queued jobs start in this order.
	seq uint64
}

type jobManager struct {
	mu      sync.Mutex
	jobs    map[string]*job
	maxJobs int
	nextSeq uint64
	closing bool
	// engine names the executable to run. It is asked (and the file checked
	// again) at the moment a job really starts, which for a queued job can be
	// long after it was requested.
	engine func() (string, error)
}

func newJobManager(maxJobs int, engine func() (string, error)) *jobManager {
	return &jobManager{jobs: map[string]*job{}, maxJobs: maxJobs, engine: engine}
}

var fenShape = regexp.MustCompile(`^[1-8pnbrqkPNBRQK/]{15,90} [wb] (-|[KQkq]{1,4}) (-|[a-h][36])( \d{1,4} \d{1,4})?$`)

// validateFEN keeps anything that is not a plain chess position away from the
// engine's stdin (in particular line breaks, which would let a caller inject
// extra UCI commands).
func validateFEN(fen string) error {
	if !fenShape.MatchString(fen) {
		return errors.New("that is not a valid FEN position")
	}
	fields := strings.Fields(fen)
	ranks := strings.Split(fields[0], "/")
	if len(ranks) != 8 {
		return errors.New("a FEN board needs 8 ranks")
	}
	whiteKings, blackKings := 0, 0
	for index, rank := range ranks {
		squares := 0
		for _, c := range rank {
			switch {
			case c >= '1' && c <= '8':
				squares += int(c - '0')
			default:
				squares++
				if c == 'K' {
					whiteKings++
				}
				if c == 'k' {
					blackKings++
				}
				if (c == 'P' || c == 'p') && (index == 0 || index == 7) {
					return errors.New("a pawn cannot stand on the first or last rank")
				}
			}
		}
		if squares != 8 {
			return errors.New("each FEN rank must describe 8 squares")
		}
	}
	if whiteKings != 1 || blackKings != 1 {
		return errors.New("a position needs exactly one king per side")
	}
	return nil
}

func newJobID() string {
	raw := make([]byte, 8)
	_, _ = rand.Read(raw)
	return hex.EncodeToString(raw)
}

// snapshot copies a job's view. The caller holds m.mu.
func (m *jobManager) snapshot(j *job) jobView {
	view := j.view
	if view.Status == "queued" && !view.Held {
		view.QueuePosition = 1
		for _, other := range m.jobs {
			if other.view.Status == "queued" && !other.view.Held && other.seq < j.seq {
				view.QueuePosition++
			}
		}
	}
	if view.Best != nil {
		best := *view.Best
		view.Best = &best
	}
	if view.Result != nil {
		result := *view.Result
		view.Result = &result
	}
	return view
}

// active lists jobs that are waiting, running or paused, plus completed ones
// whose result nobody has fetched yet, in the order they were requested.
func (m *jobManager) active() []jobView {
	m.mu.Lock()
	defer m.mu.Unlock()
	listed := []*job{}
	for _, j := range m.jobs {
		switch j.view.Status {
		case "queued", "running", "paused":
			listed = append(listed, j)
		case "complete":
			if !j.collected {
				listed = append(listed, j)
			}
		}
	}
	sort.Slice(listed, func(a, b int) bool { return listed[a].seq < listed[b].seq })
	out := make([]jobView, 0, len(listed))
	for _, j := range listed {
		out = append(out, m.snapshot(j))
	}
	return out
}

func (m *jobManager) get(id string) (jobView, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok {
		return jobView{}, false
	}
	if j.view.Status == "complete" {
		j.collected = true
	}
	return m.snapshot(j), true
}

type httpError struct {
	status  int
	message string
}

func (e *httpError) Error() string { return e.message }

// start accepts an analysis. It begins at once if fewer than maxJobs are
// running or paused; otherwise it waits in the queue and begins by itself
// when one of them ends.
func (m *jobManager) start(fen string, depth int, context json.RawMessage) (jobView, error) {
	if err := validateFEN(fen); err != nil {
		return jobView{}, &httpError{400, err.Error()}
	}
	if depth < 1 || depth > maxSearchDepth {
		return jobView{}, &httpError{400, fmt.Sprintf("depth must be between 1 and %d", maxSearchDepth)}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return jobView{}, &httpError{503, "The engine bridge is shutting down."}
	}
	queued := 0
	for id, j := range m.jobs {
		switch j.view.Status {
		case "running", "paused":
		case "queued":
			queued++
		default:
			uncollected := j.view.Status == "complete" && !j.collected
			if time.Since(j.finished) > time.Hour && !uncollected {
				delete(m.jobs, id) // forget long-finished jobs
			}
		}
	}
	if queued >= maxQueuedJobs {
		return jobView{}, &httpError{429, fmt.Sprintf(
			"%d analyses are already waiting. Let some finish, or stop some, before adding more.", queued)}
	}
	j := &job{
		view:   jobView{JobID: newJobID(), Status: "queued", TargetDepth: depth, Fen: fen, Context: context},
		cancel: make(chan struct{}),
		seq:    m.nextSeq,
	}
	m.nextSeq++
	m.jobs[j.view.JobID] = j
	m.promoteLocked()
	if j.view.Status == "queued" {
		logf("Analysis %s is waiting for a free slot (%d waiting).", shortID(j), queued+1)
	}
	return m.snapshot(j), nil
}

func shortID(j *job) string { return j.view.JobID[:6] }

// promoteLocked starts waiting jobs, oldest first, while there is a free
// slot. The caller holds m.mu.
func (m *jobManager) promoteLocked() {
	if m.closing {
		return
	}
	for {
		live, running := 0, 0
		var next *job
		for _, j := range m.jobs {
			switch j.view.Status {
			case "running":
				live++
				running++
			case "paused":
				live++
			case "queued":
				if !j.view.Held && (next == nil || j.seq < next.seq) {
					next = j
				}
			}
		}
		if next == nil || live >= m.maxJobs {
			return
		}
		threads, hash := perJobResources(running + 1)
		free := availableMemoryMB()
		hash = fitHashToFreeMemory(hash, free)
		next.view.Status, next.view.Threads, next.view.Hash = "running", threads, hash
		if free > 0 {
			logf("Analysis %s starts: depth %d, %d threads, %d MB hash (%d MB of memory was free).",
				shortID(next), next.view.TargetDepth, threads, hash, free)
		} else {
			logf("Analysis %s starts: depth %d, %d threads, %d MB hash.", shortID(next), next.view.TargetDepth, threads, hash)
		}
		go m.run(next)
	}
}

func (m *jobManager) update(j *job, change func(view *jobView)) {
	m.mu.Lock()
	change(&j.view)
	m.mu.Unlock()
}

func (m *jobManager) finish(j *job, status, message string, result *analysisResult) {
	m.mu.Lock()
	j.view.Status = status
	j.view.Error = message
	j.view.Result = result
	if status == "complete" {
		j.view.Progress = 100
		j.view.Depth = result.Depth
		j.view.Best = result
	}
	j.finished = time.Now()
	j.proc = nil
	switch status {
	case "complete":
		logf("Analysis %s finished at depth %d.", shortID(j), result.Depth)
	case "error":
		logf("Analysis %s failed: %s", shortID(j), message)
	default:
		// j.view.Best stays: the site saves the last finished depth.
		if j.view.Best != nil {
			logf("Analysis %s stopped while searching depth %d; depth %d was finished.", shortID(j), j.view.Depth, j.view.Best.Depth)
		} else {
			logf("Analysis %s stopped.", shortID(j))
		}
	}
	// A slot is free now: let the next waiting analysis begin.
	m.promoteLocked()
	m.mu.Unlock()
}

func (m *jobManager) cancelled(j *job) bool {
	select {
	case <-j.cancel:
		return true
	default:
		return false
	}
}

func (m *jobManager) run(j *job) {
	m.mu.Lock()
	fen, depth := j.view.Fen, j.view.TargetDepth
	threads, hash := j.view.Threads, j.view.Hash
	m.mu.Unlock()
	blackToMove := strings.Fields(fen)[1] == "b"

	enginePath, err := m.engine()
	if err != nil {
		m.finish(j, "error", "Stockfish is not ready: "+err.Error(), nil)
		return
	}
	if m.cancelled(j) {
		m.finish(j, "stopped", "", nil)
		return
	}
	proc, err := startUCI(enginePath)
	if err != nil {
		m.finish(j, "error", "Could not start Stockfish: "+err.Error(), nil)
		return
	}
	m.mu.Lock()
	j.proc = proc
	stopRequested := m.cancelled(j)
	m.mu.Unlock()
	defer proc.kill()
	if stopRequested {
		m.finish(j, "stopped", "", nil)
		return
	}

	fail := func(err error) {
		if m.cancelled(j) {
			m.finish(j, "stopped", "", nil)
			return
		}
		m.finish(j, "error", err.Error(), nil)
	}

	identity, err := proc.handshake(20 * time.Second)
	if err != nil {
		fail(err)
		return
	}
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
	// Clearing a large hash table can take a while on a busy machine.
	if err := proc.waitFor("readyok", 5*time.Minute, nil); err != nil {
		fail(err)
		return
	}
	_ = proc.send("position fen " + fen)
	_ = proc.send(fmt.Sprintf("go depth %d", depth))

	// toResult turns an engine line into what the site is shown.
	toResult := func(info uciInfo) *analysisResult {
		return &analysisResult{
			MoveUCI: info.PV[0], PV: info.PV, Evaluation: formatEvaluation(info, blackToMove),
			Depth: info.Depth, Nodes: info.Nodes, TimeMs: info.TimeMs,
		}
	}
	var best uciInfo
	haveBest := false
	for {
		select {
		case <-j.cancel:
			m.finish(j, "stopped", "", nil)
			return
		case line, ok := <-proc.lines:
			if !ok {
				fail(errEngineExited)
				return
			}
			if strings.HasPrefix(line, "bestmove") {
				if m.cancelled(j) {
					m.finish(j, "stopped", "", nil)
					return
				}
				if !haveBest {
					m.finish(j, "error", "Stockfish returned no analysis result.", nil)
					proc.quit()
					return
				}
				m.finish(j, "complete", "", toResult(best))
				proc.quit()
				return
			}
			info, isInfo := parseInfo(line)
			if !isInfo {
				continue
			}
			if !info.HasDepth {
				continue
			}
			// A line with an exact score (no lowerbound / upperbound) and a
			// move list is what the engine prints when it has searched a
			// depth to the end. From then on it is working on the next one.
			finished := info.HasScore && !info.Bound && info.MultiPV == 1 && len(info.PV) > 0
			searching := info.Depth
			var latest *analysisResult
			if finished {
				best, haveBest = info, true
				latest = toResult(info)
				if searching < depth {
					searching++
				}
			}
			m.update(j, func(view *jobView) {
				if searching > view.Depth {
					view.Depth = searching
				}
				view.Progress = view.Depth * 100 / depth
				if view.Progress > 99 {
					view.Progress = 99
				}
				if latest != nil {
					view.Best = latest
				}
			})
		}
	}
}

func (m *jobManager) find(id string) (*job, error) {
	j, ok := m.jobs[id]
	if !ok {
		return nil, &httpError{404, "Analysis job not found"}
	}
	return j, nil
}

func (m *jobManager) stop(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, err := m.find(id)
	if err != nil {
		return err
	}
	if j.view.Status == "queued" {
		// Never started: just take it out of the queue.
		j.view.Status = "stopped"
		j.finished = time.Now()
		close(j.cancel)
		logf("Analysis %s left the queue.", shortID(j))
		return nil
	}
	if j.view.Status != "running" && j.view.Status != "paused" {
		return nil
	}
	if j.view.Status == "paused" && j.proc != nil {
		// A frozen process cannot be shut down cleanly; thaw it first.
		_ = resumeProcess(j.proc.pid())
	}
	select {
	case <-j.cancel:
	default:
		close(j.cancel)
	}
	if j.proc != nil {
		go j.proc.kill()
	}
	return nil
}

func (m *jobManager) pause(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, err := m.find(id)
	if err != nil {
		return err
	}
	if j.view.Status == "queued" {
		// Not started yet: keep it waiting, but let the jobs behind it go first.
		if !j.view.Held {
			j.view.Held = true
			logf("Analysis %s is held in the queue.", shortID(j))
		}
		return nil
	}
	if j.view.Status != "running" || j.proc == nil {
		return &httpError{409, "Job is not currently running"}
	}
	if err := suspendProcess(j.proc.pid()); err != nil {
		return &httpError{500, "Could not pause Stockfish: " + err.Error()}
	}
	j.view.Status = "paused"
	return nil
}

func (m *jobManager) resume(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, err := m.find(id)
	if err != nil {
		return err
	}
	if j.view.Status == "queued" {
		if j.view.Held {
			// Back in line where it was; it starts now if a slot is free.
			j.view.Held = false
			m.promoteLocked()
		}
		return nil
	}
	if j.view.Status != "paused" || j.proc == nil {
		return &httpError{409, "Job is not currently paused"}
	}
	if err := resumeProcess(j.proc.pid()); err != nil {
		return &httpError{500, "Could not resume Stockfish: " + err.Error()}
	}
	j.view.Status = "running"
	return nil
}

// shutdown stops every engine; called when the bridge exits. Jobs end as
// "stopped", not as an engine failure.
func (m *jobManager) shutdown() {
	m.mu.Lock()
	m.closing = true // nothing waiting may start any more
	procs := []*uciProc{}
	for _, j := range m.jobs {
		if j.view.Status == "queued" {
			j.view.Status = "stopped"
			j.finished = time.Now()
			close(j.cancel)
		}
		if j.view.Status == "running" || j.view.Status == "paused" {
			select {
			case <-j.cancel:
			default:
				close(j.cancel)
			}
		}
		if j.proc != nil {
			if j.view.Status == "paused" {
				_ = resumeProcess(j.proc.pid())
			}
			procs = append(procs, j.proc)
		}
	}
	m.mu.Unlock()
	for _, proc := range procs {
		proc.kill()
	}
}

package main

// Puzzles in the background. For each of the player's accounts ("profile":
// "lichess:name" or "chesscom:name") the bridge checks the rapid rating,
// fetches the rated rapid games (games.go) and analyses the ones played at
// 80% or more of the current rating with the puzzle finder (puzzlegen.go),
// newest first, fetching older games whenever it runs out, until every game
// that counts has been analysed. It does all of it by itself: the site's tab
// can be closed. What it finds waits in puzzles.json next to the settings
// until the site collects it, and the work carries on when the bridge is
// started again.
//
//   POST /api/puzzles/update     {profile, site, username, effort}: check the
//                                rating and the new games, then go on to the end
//   GET  /api/puzzles?profile=   how far it is, and what was found
//   POST /api/puzzles/collected  {profile, games: [id]}: the site has stored these
//   POST /api/puzzles/stop       {profile}: stop (the next update carries on)
//   POST /api/puzzles/forget     {profile}: forget the account
//
// Finding puzzles comes first: its engine always searches with as many
// threads as the bridge may use (all cores but one), whatever else runs; an
// analysis started meanwhile counts it as one more analysis when it takes
// its share. When no update is left, the engine is closed.

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// Games count when the player's rating in them was at least this share
	// of their current rapid rating.
	ratingShare       = 0.8
	maxPuzzleProfiles = 20
)

// How long the worker waits before trying again when Stockfish is not
// ready, Stockfish failed, or a site could not be reached.
var puzzleRetryDelay = 15 * time.Second

type storedGame struct {
	Rating   int         `json:"rating"`
	PlayedAt int64       `json:"played_at"`
	Status   string      `json:"status"`         // "new", "done" or "failed"
	Game     *gameRecord `json:"game,omitempty"` // kept while it waits to be analysed
}

type puzzleResult struct {
	ID         string      `json:"id"`
	Game       gameRecord  `json:"game"`
	Puzzles    []puzzleOut `json:"puzzles"`
	Judgements int         `json:"judgements"`
	Effort     string      `json:"effort"`
	AnalysedAt int64       `json:"analysed_at"`
	Error      string      `json:"error,omitempty"`
}

type puzzleProfile struct {
	Site     string                 `json:"site"`
	Username string                 `json:"username"`
	Effort   string                 `json:"effort"`
	Rating   int                    `json:"rating"`
	RatingAt int64                  `json:"rating_at"`
	Sync     gameSync               `json:"sync"`
	Fetched  bool                   `json:"fetched"` // the first batch has been fetched
	Games    map[string]*storedGame `json:"games"`
	Results  []puzzleResult         `json:"results"`
	// Wanted: an update is under way. Refresh: it starts with the rating and
	// the new games. OlderDone: older games stopped counting (the player's
	// rating was lower then), so this update fetches no further back.
	Wanted    bool   `json:"wanted"`
	Refresh   bool   `json:"refresh"`
	OlderDone bool   `json:"older_done"`
	Problem   string `json:"problem,omitempty"` // why the last update stopped
	UpdatedAt int64  `json:"updated_at"`
}

func (p *puzzleProfile) threshold() int {
	if p.Rating <= 0 {
		return 0
	}
	return int(math.Ceil(float64(p.Rating) * ratingShare))
}

func (p *puzzleProfile) counts(game *storedGame) bool {
	return p.Rating > 0 && game.Rating >= p.threshold()
}

// pending are the games that count and wait, newest first.
func (p *puzzleProfile) pending() []string {
	var ids []string
	for id, game := range p.Games {
		if game.Status == "new" && game.Game != nil && p.counts(game) {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(a, b int) bool { return p.Games[ids[a]].PlayedAt > p.Games[ids[b]].PlayedAt })
	return ids
}

// puzzleTaskView is what the bridge is doing for a profile.
type puzzleTaskView struct {
	Step     string `json:"step"` // "rating", "games", "older" or "analyse"
	GameID   string `json:"game_id,omitempty"`
	Threads  int    `json:"threads,omitempty"` // analyse: the engine's threads
	Opponent string `json:"opponent,omitempty"`
	PlayedAt int64  `json:"played_at,omitempty"`
	Phase    string `json:"phase,omitempty"` // analyse: "scan" or "puzzles"
	Done     int    `json:"done"`
	Total    int    `json:"total"`
	Read     int    `json:"read,omitempty"` // fetching: games read and kept, months
	Kept     int    `json:"kept,omitempty"`
	Months   int    `json:"months,omitempty"`
}

// puzzleView is what the site sees for a profile.
type puzzleView struct {
	Known    bool            `json:"known"`
	Running  bool            `json:"running"`
	Rating   int             `json:"rating"`
	RatingAt int64           `json:"rating_at"`
	Games    int             `json:"games"`
	Counted  int             `json:"counted"`
	Analysed int             `json:"analysed"`
	Pending  int             `json:"pending"`
	Oldest   int64           `json:"oldest"`
	Complete bool            `json:"complete"`
	Task     *puzzleTaskView `json:"task"`
	Results  []puzzleResult  `json:"results"`
	Error    string          `json:"error,omitempty"`
}

type puzzleManager struct {
	path     string
	searcher *searcher
	engine   func() (string, error)

	mu       sync.Mutex
	profiles map[string]*puzzleProfile
	running  string // the profile the worker is busy with
	task     *puzzleTaskView
	cancel   context.CancelFunc
	problem  string // why the worker waits (not saved)
	closing  bool
	// The account whose game was analysed last: the accounts take turns.
	lastAnalysed string

	wake   chan struct{}
	done   chan struct{}
	exited chan struct{}
}

func newPuzzleManager(dir string, searcher *searcher, engine func() (string, error)) *puzzleManager {
	m := &puzzleManager{
		path: filepath.Join(dir, "puzzles.json"), searcher: searcher, engine: engine, profiles: map[string]*puzzleProfile{},
		wake: make(chan struct{}, 1), done: make(chan struct{}), exited: make(chan struct{}),
	}
	if raw, err := os.ReadFile(m.path); err == nil {
		var saved struct {
			Profiles map[string]*puzzleProfile `json:"profiles"`
		}
		if json.Unmarshal(raw, &saved) == nil && saved.Profiles != nil {
			for id, entry := range saved.Profiles {
				if entry.Site == "" { // left by an earlier test build
					continue
				}
				if entry.Games == nil {
					entry.Games = map[string]*storedGame{}
				}
				m.profiles[id] = entry
			}
		} else {
			logf("Could not read %s; starting without it.", m.path)
		}
	}
	go m.loop()
	return m
}

// saveLocked writes puzzles.json. The caller holds m.mu.
func (m *puzzleManager) saveLocked() {
	raw, err := json.Marshal(map[string]any{"profiles": m.profiles})
	if err == nil {
		temporary := m.path + ".tmp"
		if err = os.WriteFile(temporary, raw, 0o600); err == nil {
			err = os.Rename(temporary, m.path)
		}
	}
	if err != nil {
		logf("Could not save the puzzle work: %v", err)
	}
}

func (m *puzzleManager) poke() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// update starts (or restarts) the work for an account: the rating and the
// new games first, then to the end.
func (m *puzzleManager) update(profile, site, username, effort string) (puzzleView, error) {
	if _, ok := siteNames[site]; !ok {
		return puzzleView{}, &httpError{400, `site must be "chesscom" or "lichess"`}
	}
	if !usernameShape.MatchString(username) {
		return puzzleView{}, &httpError{400, "that is not a username"}
	}
	if profile != site+":"+strings.ToLower(username) {
		return puzzleView{}, &httpError{400, "profile must be site:username"}
	}
	if _, ok := puzzleEfforts[effort]; !ok {
		return puzzleView{}, &httpError{400, `effort must be "lichess" or "quick"`}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return puzzleView{}, &httpError{503, "The engine bridge is shutting down."}
	}
	entry := m.profiles[profile]
	if entry == nil {
		if len(m.profiles) >= maxPuzzleProfiles {
			m.forgetOldestLocked()
		}
		entry = &puzzleProfile{Site: site, Games: map[string]*storedGame{}, Results: []puzzleResult{}}
		m.profiles[profile] = entry
	}
	entry.Username, entry.Effort = username, effort
	entry.Wanted, entry.Refresh, entry.OlderDone, entry.Problem = true, true, false, ""
	entry.UpdatedAt = time.Now().UnixMilli()
	m.saveLocked()
	m.poke()
	return m.viewLocked(profile), nil
}

// forgetOldestLocked makes room for another profile: the one used least
// recently goes.
func (m *puzzleManager) forgetOldestLocked() {
	oldest := ""
	for id, entry := range m.profiles {
		if id != m.running && (oldest == "" || entry.UpdatedAt < m.profiles[oldest].UpdatedAt) {
			oldest = id
		}
	}
	if oldest != "" {
		delete(m.profiles, oldest)
	}
}

func (m *puzzleManager) viewLocked(profile string) puzzleView {
	view := puzzleView{Results: []puzzleResult{}}
	entry := m.profiles[profile]
	if entry == nil {
		return view
	}
	view.Known, view.Running, view.Rating, view.RatingAt, view.Complete = true, entry.Wanted, entry.Rating, entry.RatingAt, entry.Sync.Complete
	for _, game := range entry.Games {
		view.Games++
		if view.Oldest == 0 || game.PlayedAt < view.Oldest {
			view.Oldest = game.PlayedAt
		}
		if entry.counts(game) {
			view.Counted++
			if game.Status == "new" {
				view.Pending++
			} else {
				view.Analysed++
			}
		}
	}
	view.Results = append(view.Results, entry.Results...)
	if m.running == profile && m.task != nil {
		task := *m.task
		view.Task = &task
	}
	switch {
	case entry.Wanted && m.problem != "":
		view.Error = m.problem
	case !entry.Wanted && entry.Problem != "":
		view.Error = entry.Problem
	}
	return view
}

func (m *puzzleManager) view(profile string) puzzleView {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.viewLocked(profile)
}

// collected forgets results the site has stored.
func (m *puzzleManager) collected(profile string, ids []string) puzzleView {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entry := m.profiles[profile]; entry != nil {
		gone := map[string]bool{}
		for _, id := range ids {
			gone[id] = true
		}
		kept := entry.Results[:0]
		for _, result := range entry.Results {
			if !gone[result.ID] {
				kept = append(kept, result)
			}
		}
		entry.Results = kept
		m.saveLocked()
	}
	return m.viewLocked(profile)
}

// stop ends the update for an account; what was done is kept (forget: the
// account goes altogether). With no update left, the engine is closed, so
// that the next one starts with its share of the processor worked out again.
func (m *puzzleManager) stop(profile string, forget bool) puzzleView {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entry := m.profiles[profile]; entry != nil {
		entry.Wanted, entry.Refresh = false, false
		if forget {
			delete(m.profiles, profile)
		}
		m.saveLocked()
	}
	if m.running == profile && m.cancel != nil {
		m.cancel()
	}
	if !m.anyWantedLocked() {
		go m.searcher.close()
	}
	return m.viewLocked(profile)
}

func (m *puzzleManager) anyWantedLocked() bool {
	for _, entry := range m.profiles {
		if entry.Wanted {
			return true
		}
	}
	return false
}

// threadsForGame: as many as the bridge may use, whatever else runs.
func (m *puzzleManager) threadsForGame() int {
	threads, _ := resourceBudget()
	return threads
}

// next decides what to do, over the accounts with an update under way:
// first their ratings and new games; then older games for an account that
// has none left waiting; then a game that waits, the accounts taking turns
// (each its newest game first), so that their puzzles come in together. An
// account with nothing left is done.
func (m *puzzleManager) next() (string, string, string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return "", "", "", false
	}
	ids := make([]string, 0, len(m.profiles))
	for id, entry := range m.profiles {
		if entry.Wanted {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		if m.profiles[id].Refresh {
			return id, "games", "", true
		}
	}
	var waiting []string
	for _, id := range ids {
		entry := m.profiles[id]
		if len(entry.pending()) > 0 {
			waiting = append(waiting, id)
			continue
		}
		if !entry.Sync.Complete && !entry.OlderDone {
			return id, "older", "", true
		}
		entry.Wanted = false
		logf("Puzzles: every game of %s that counts has been analysed.", id)
		m.saveLocked()
	}
	if len(waiting) == 0 {
		return "", "", "", false
	}
	// The account after the one analysed last.
	turn := waiting[0]
	for _, id := range waiting {
		if id > m.lastAnalysed {
			turn = id
			break
		}
	}
	m.lastAnalysed = turn
	return turn, "analyse", m.profiles[turn].pending()[0], true
}

// wait sleeps until there is something to do (or delay is over); false when
// the bridge is closing.
func (m *puzzleManager) wait(delay time.Duration) bool {
	var timer <-chan time.Time
	if delay > 0 {
		timer = time.After(delay)
	}
	select {
	case <-m.done:
		return false
	case <-m.wake:
	case <-timer:
	}
	return true
}

func (m *puzzleManager) loop() {
	defer close(m.exited)
	for {
		profile, step, gameID, ok := m.next()
		if !ok {
			if !m.wait(0) {
				return
			}
			continue
		}
		if step == "analyse" {
			if _, err := m.engine(); err != nil {
				// Stockfish is not ready (still being downloaded, say).
				m.mu.Lock()
				m.problem = "Stockfish is not ready: " + err.Error()
				m.mu.Unlock()
				if !m.wait(puzzleRetryDelay) {
					return
				}
				continue
			}
		}
		ctx, cancel := context.WithCancel(context.Background())
		m.mu.Lock()
		m.running, m.cancel, m.task = profile, cancel, &puzzleTaskView{Step: step}
		m.mu.Unlock()
		var retry bool
		if step == "analyse" {
			retry = m.analyse(ctx, profile, gameID)
		} else {
			retry = m.fetch(ctx, profile, step)
		}
		cancel()
		m.mu.Lock()
		m.running, m.task, m.cancel = "", nil, nil
		m.saveLocked()
		m.mu.Unlock()
		if retry && !m.wait(puzzleRetryDelay) {
			return
		}
	}
}

func (m *puzzleManager) setTask(change func(task *puzzleTaskView)) {
	m.mu.Lock()
	if m.task != nil {
		change(m.task)
	}
	m.mu.Unlock()
}

// fetch checks the rating and fetches the new games ("games"), or the next
// older ones ("older"). It returns true to try again later.
func (m *puzzleManager) fetch(ctx context.Context, profile, step string) bool {
	m.mu.Lock()
	entry := m.profiles[profile]
	if entry == nil {
		m.mu.Unlock()
		return false
	}
	site, username, sync, first := entry.Site, entry.Username, entry.Sync, !entry.Fetched
	m.mu.Unlock()
	progress := func(read, kept, months int) {
		m.setTask(func(task *puzzleTaskView) { task.Read, task.Kept, task.Months = read, kept, months })
	}
	var rating int
	var games []gameRecord
	var err error
	if step == "games" {
		m.setTask(func(task *puzzleTaskView) { task.Step = "rating" })
		if rating, err = fetchRapidRating(ctx, site, username); err == nil {
			m.setTask(func(task *puzzleTaskView) { task.Step = "games" })
			games, sync, err = fetchGames(ctx, site, username, sync, first, false, progress)
		}
	} else {
		games, sync, err = fetchGames(ctx, site, username, sync, false, true, progress)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	entry = m.profiles[profile]
	if entry == nil || ctx.Err() != nil {
		return false
	}
	if err != nil {
		if isNotFound(err) {
			// A player who is not there (any more): nothing to do.
			entry.Wanted, entry.Problem, m.problem = false, err.Error(), ""
			return false
		}
		m.problem = err.Error() + " Trying again in a while."
		return true
	}
	m.problem = ""
	if step == "games" {
		entry.Rating, entry.RatingAt, entry.Refresh, entry.Fetched = rating, time.Now().UnixMilli(), false, true
	}
	entry.Sync = sync
	added, counting := 0, 0
	for i := range games {
		game := games[i]
		if _, known := entry.Games[game.ID]; known {
			continue
		}
		stored := &storedGame{Rating: game.Rating, PlayedAt: game.PlayedAt, Status: "new", Game: &game}
		entry.Games[game.ID] = stored
		added++
		if entry.counts(stored) {
			counting++
		}
	}
	if step == "older" && counting == 0 {
		entry.OlderDone = true
	}
	logf("Puzzles: %s: %d new game(s) from %s.", profile, added, siteNames[site])
	return false
}

// analyse finds the puzzles of one game. It returns true to try again later.
func (m *puzzleManager) analyse(ctx context.Context, profile, gameID string) bool {
	m.mu.Lock()
	entry := m.profiles[profile]
	if entry == nil || entry.Games[gameID] == nil || entry.Games[gameID].Game == nil {
		m.mu.Unlock()
		return false
	}
	game := *entry.Games[gameID].Game
	effortName := entry.Effort
	left := len(entry.pending()) - 1
	m.task.GameID, m.task.Opponent, m.task.PlayedAt, m.task.Phase = game.ID, game.Opponent, game.PlayedAt, "scan"
	m.mu.Unlock()
	threads := m.threadsForGame()
	m.setTask(func(task *puzzleTaskView) { task.Threads = threads })
	logf("Puzzles: analysing %s with %d threads (%d more waiting).", game.ID, threads, left)
	// The game's first search sets the engine's threads for it.
	search := func(ctx context.Context, request searchRequest) (searchResult, error) {
		if request.NewGame {
			request.Threads = threads
		}
		return m.searcher.search(ctx, request)
	}
	started := time.Now()
	result, err := analyseGame(ctx, gameInput{Color: game.Color, Moves: game.Moves, Evals: game.Evals},
		search, puzzleEfforts[effortName],
		func(phase string, done, total int) {
			m.setTask(func(task *puzzleTaskView) { task.Phase, task.Done, task.Total = phase, done, total })
		}, nil)
	m.mu.Lock()
	defer m.mu.Unlock()
	entry = m.profiles[profile]
	if entry == nil || entry.Games[gameID] == nil || ctx.Err() != nil {
		return false // stopped: the game waits for the next update
	}
	if err != nil && !errors.Is(err, errGameRejected) {
		m.problem = "Stockfish failed: " + err.Error()
		return true
	}
	m.problem = ""
	stored := entry.Games[gameID]
	stored.Status, stored.Game = "done", nil
	saved := puzzleResult{ID: game.ID, Game: game, Puzzles: result.Puzzles, Judgements: result.Judgements,
		Effort: effortName, AnalysedAt: time.Now().UnixMilli()}
	saved.Game.Evals = nil
	if err != nil {
		stored.Status = "failed"
		saved.Error, saved.Puzzles = err.Error(), []puzzleOut{}
	}
	entry.Results = append(entry.Results, saved)
	logf("Puzzles: %s done in %s, %d puzzle(s).", game.ID, time.Since(started).Round(time.Second), len(saved.Puzzles))
	return false
}

// shutdown stops what runs (it is done again next time) and saves.
func (m *puzzleManager) shutdown() {
	m.mu.Lock()
	m.closing = true
	if m.cancel != nil {
		m.cancel()
	}
	m.mu.Unlock()
	select {
	case <-m.done:
	default:
		close(m.done)
	}
	select {
	case <-m.exited:
	case <-time.After(5 * time.Second):
	}
	m.mu.Lock()
	m.saveLocked()
	m.mu.Unlock()
}

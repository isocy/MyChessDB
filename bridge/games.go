package main

// A player's rated rapid games and current rapid rating, fetched by the
// bridge from chess.com's and Lichess's public APIs, so that the puzzle
// finder can go on without the site's tab (puzzles.go).
//
// Games are fetched newest first, about gamesBatch at a time: the newer ones
// at each update, older ones only when the analysis has caught up with those
// already fetched (a player can have thousands).

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const gamesBatch = 100

// The sites' addresses (tests point them at a stand-in).
var (
	lichessBase  = "https://lichess.org"
	chesscomBase = "https://api.chess.com/pub"
)

var gamesClient = &http.Client{Timeout: 2 * time.Minute, CheckRedirect: sameSiteRedirect}

// sameSiteRedirect follows a site's redirects only on the same scheme and
// host, so that an answer cannot send the bridge anywhere else (another
// site, or a service on this computer or its network).
func sameSiteRedirect(request *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return errors.New("too many redirects")
	}
	if first := via[0].URL; request.URL.Scheme != first.Scheme || request.URL.Host != first.Host {
		return fmt.Errorf("a redirect to %s was not followed", request.URL.Host)
	}
	return nil
}

// A chess.com game's address, whose last part is the game's id, and a
// Lichess game's id (the site builds the game's address from it).
var (
	chesscomGameURL = regexp.MustCompile(`^https://www\.chess\.com/game/(?:live|daily)/([A-Za-z0-9-]{1,40})$`)
	lichessGameID   = regexp.MustCompile(`^[A-Za-z0-9]{1,20}$`)
)

var usernameShape = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$`)

var siteNames = map[string]string{"chesscom": "chess.com", "lichess": "Lichess"}

// gameRecord is a game as the site stores it.
type gameRecord struct {
	ID             string     `json:"id"`
	Site           string     `json:"site"`
	URL            string     `json:"url"`
	PlayedAt       int64      `json:"playedAt"`
	Color          string     `json:"color"` // the player's: "w" or "b"
	Rating         int        `json:"rating"`
	Opponent       string     `json:"opponent"`
	OpponentRating *int       `json:"opponentRating"`
	Result         string     `json:"result"` // "win", "loss" or "draw"
	Moves          []string   `json:"moves"`  // UCI, from the standard starting position
	Evals          []*pzScore `json:"evals,omitempty"`
}

// gameSync is where fetching got to. Lichess: the newest and oldest game
// read (createdAt). chess.com: the months that had ended when they were
// fetched, and the oldest month fetched. Complete: no older games are left.
type gameSync struct {
	Newest      int64           `json:"newest,omitempty"`
	Oldest      int64           `json:"oldest,omitempty"`
	OldestMonth string          `json:"oldest_month,omitempty"`
	Done        map[string]bool `json:"done,omitempty"`
	Complete    bool            `json:"complete"`
}

// fetchError says what went wrong; notFound and retry tell the worker what
// to do about it.
type fetchError struct {
	message  string
	notFound bool
}

func (e *fetchError) Error() string { return e.message }

func siteRequest(ctx context.Context, site, address, accept string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", accept)
	// chess.com turns away a request without a name for its sender.
	request.Header.Set("User-Agent", appName+"/"+version)
	response, err := gamesClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &fetchError{message: fmt.Sprintf("Could not reach %s.", siteNames[site])}
	}
	switch {
	case response.StatusCode == http.StatusNotFound:
		response.Body.Close()
		return nil, &fetchError{message: fmt.Sprintf("%s has no such player.", siteNames[site]), notFound: true}
	case response.StatusCode == http.StatusTooManyRequests:
		response.Body.Close()
		return nil, &fetchError{message: fmt.Sprintf("%s is limiting requests from this computer for a while.", siteNames[site])}
	case response.StatusCode != http.StatusOK:
		response.Body.Close()
		return nil, &fetchError{message: fmt.Sprintf("%s answered with status %d.", siteNames[site], response.StatusCode)}
	}
	return response, nil
}

func siteJSON(ctx context.Context, site, address string, into any) error {
	response, err := siteRequest(ctx, site, address, "application/json")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<20)).Decode(into); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &fetchError{message: fmt.Sprintf("%s sent an unreadable answer.", siteNames[site])}
	}
	return nil
}

// fetchRapidRating is the player's current rapid rating.
func fetchRapidRating(ctx context.Context, site, username string) (int, error) {
	if site == "lichess" {
		var user struct {
			Disabled bool `json:"disabled"`
			Closed   bool `json:"closed"`
			Perfs    struct {
				Rapid *struct {
					Rating float64 `json:"rating"`
					Games  int     `json:"games"`
				} `json:"rapid"`
			} `json:"perfs"`
		}
		if err := siteJSON(ctx, site, lichessBase+"/api/user/"+url.PathEscape(username), &user); err != nil {
			return 0, err
		}
		if user.Disabled || user.Closed {
			return 0, &fetchError{message: "This Lichess account is closed.", notFound: true}
		}
		if user.Perfs.Rapid == nil || user.Perfs.Rapid.Games == 0 {
			return 0, &fetchError{message: "This player has no rapid rating on Lichess.", notFound: true}
		}
		return int(user.Perfs.Rapid.Rating), nil
	}
	var stats struct {
		Rapid *struct {
			Last struct {
				Rating int `json:"rating"`
			} `json:"last"`
		} `json:"chess_rapid"`
	}
	if err := siteJSON(ctx, site, chesscomBase+"/player/"+url.PathEscape(strings.ToLower(username))+"/stats", &stats); err != nil {
		return 0, err
	}
	if stats.Rapid == nil || stats.Rapid.Last.Rating == 0 {
		return 0, &fetchError{message: "This player has no rapid rating on chess.com.", notFound: true}
	}
	return stats.Rapid.Last.Rating, nil
}

// ---------------------------------------------------------------- PGN -----

var (
	pgnHeader    = regexp.MustCompile(`(?m)^\s*\[[^\]]*\]\s*$`)
	pgnComment   = regexp.MustCompile(`\{[^}]*\}|;[^\n]*`)
	pgnVariation = regexp.MustCompile(`\([^()]*\)`)
	pgnNAG       = regexp.MustCompile(`\$\d+`)
	pgnNumber    = regexp.MustCompile(`^\d+\.+`)
)

// sanMovesFromPGN is the SAN moves of a PGN's main line (headers, comments,
// variations and annotations dropped).
func sanMovesFromPGN(pgn string) []string {
	text := pgnComment.ReplaceAllString(pgnHeader.ReplaceAllString(pgn, " "), " ")
	for pgnVariation.MatchString(text) {
		text = pgnVariation.ReplaceAllString(text, " ")
	}
	text = pgnNAG.ReplaceAllString(text, " ")
	var moves []string
	for _, token := range strings.Fields(text) {
		token = pgnNumber.ReplaceAllString(token, "")
		switch token {
		case "", "1-0", "0-1", "1/2-1/2", "*":
			continue
		}
		moves = append(moves, token)
	}
	return moves
}

// --------------------------------------------------------------- games ----

var chesscomDraws = map[string]bool{"agreed": true, "repetition": true, "stalemate": true, "insufficient": true, "50move": true, "timevsinsufficient": true}

type chesscomPlayer struct {
	Username string `json:"username"`
	Rating   *int   `json:"rating"`
	Result   string `json:"result"`
}

type chesscomRaw struct {
	URL          string          `json:"url"`
	PGN          string          `json:"pgn"`
	EndTime      int64           `json:"end_time"`
	Rated        bool            `json:"rated"`
	TimeClass    string          `json:"time_class"`
	Rules        string          `json:"rules"`
	InitialSetup string          `json:"initial_setup"`
	White        *chesscomPlayer `json:"white"`
	Black        *chesscomPlayer `json:"black"`
}

func chesscomGame(raw chesscomRaw, username string) *gameRecord {
	if raw.Rules != "chess" || raw.TimeClass != "rapid" || !raw.Rated || raw.White == nil || raw.Black == nil {
		return nil
	}
	// The site links to the game, and its id is the address's last part.
	address := chesscomGameURL.FindStringSubmatch(raw.URL)
	if address == nil {
		return nil
	}
	if raw.InitialSetup != "" {
		if p, err := parseFEN(raw.InitialSetup); err != nil || p.key() != startKey() {
			return nil
		}
	}
	me, them, color := raw.White, raw.Black, "w"
	if !strings.EqualFold(raw.White.Username, username) {
		if !strings.EqualFold(raw.Black.Username, username) {
			return nil
		}
		me, them, color = raw.Black, raw.White, "b"
	}
	if me.Rating == nil {
		return nil
	}
	moves, ok := replaySAN(sanMovesFromPGN(raw.PGN))
	if !ok || len(moves) == 0 {
		return nil
	}
	result := "loss"
	if me.Result == "win" {
		result = "win"
	} else if chesscomDraws[me.Result] {
		result = "draw"
	}
	opponent := them.Username
	if opponent == "" {
		opponent = "?"
	}
	return &gameRecord{
		ID: "chesscom:" + address[1], Site: "chesscom", URL: raw.URL,
		PlayedAt: raw.EndTime * 1000, Color: color, Rating: *me.Rating, Opponent: opponent, OpponentRating: them.Rating,
		Result: result, Moves: moves,
	}
}

type lichessPlayer struct {
	User *struct {
		Name string `json:"name"`
		ID   string `json:"id"`
	} `json:"user"`
	Rating *int `json:"rating"`
}

type lichessRaw struct {
	ID         string `json:"id"`
	Rated      bool   `json:"rated"`
	Variant    string `json:"variant"`
	Speed      string `json:"speed"`
	Status     string `json:"status"`
	CreatedAt  int64  `json:"createdAt"`
	Winner     string `json:"winner"`
	InitialFen string `json:"initialFen"`
	Players    struct {
		White lichessPlayer `json:"white"`
		Black lichessPlayer `json:"black"`
	} `json:"players"`
	Moves    string `json:"moves"`
	Analysis []struct {
		Eval *int `json:"eval"`
		Mate *int `json:"mate"`
	} `json:"analysis"`
}

var lichessUnplayed = map[string]bool{"created": true, "started": true, "aborted": true, "noStart": true, "unknownFinish": true}

func lichessGame(raw lichessRaw, username string) *gameRecord {
	if raw.Variant != "standard" || raw.Speed != "rapid" || !raw.Rated || lichessUnplayed[raw.Status] || raw.InitialFen != "" ||
		!lichessGameID.MatchString(raw.ID) {
		return nil
	}
	idOf := func(player lichessPlayer) string {
		if player.User == nil {
			return ""
		}
		if player.User.ID != "" {
			return strings.ToLower(player.User.ID)
		}
		return strings.ToLower(player.User.Name)
	}
	lowerName := strings.ToLower(username)
	me, them, color := raw.Players.White, raw.Players.Black, "w"
	if idOf(raw.Players.White) != lowerName {
		if idOf(raw.Players.Black) != lowerName {
			return nil
		}
		me, them, color = raw.Players.Black, raw.Players.White, "b"
	}
	if them.User == nil || me.Rating == nil { // not against the computer
		return nil
	}
	moves, ok := replaySAN(strings.Fields(raw.Moves))
	if !ok || len(moves) == 0 {
		return nil
	}
	result := "draw"
	if raw.Winner != "" {
		result = "loss"
		if (raw.Winner == "white") == (color == "w") {
			result = "win"
		}
	}
	address := lichessBase + "/" + raw.ID
	if color == "b" {
		address += "/black"
	}
	opponent := them.User.Name
	if opponent == "" {
		opponent = them.User.ID
	}
	game := &gameRecord{
		ID: "lichess:" + raw.ID, Site: "lichess", URL: address, PlayedAt: raw.CreatedAt, Color: color,
		Rating: *me.Rating, Opponent: opponent, OpponentRating: them.Rating, Result: result, Moves: moves,
	}
	for i, entry := range raw.Analysis {
		if i >= len(moves) {
			break
		}
		switch {
		case entry.Mate != nil:
			score := mateScore(*entry.Mate)
			game.Evals = append(game.Evals, &score)
		case entry.Eval != nil:
			score := cpScore(*entry.Eval)
			game.Evals = append(game.Evals, &score)
		default:
			game.Evals = append(game.Evals, nil)
		}
	}
	return game
}

func startKey() string {
	p, _ := parseFEN(startFEN)
	return p.key()
}

// fetchProgress reports what has been read so far.
type fetchProgress func(read, kept, months int)

// fetchGames fetches the player's rated rapid games: the first time (an
// empty sync) the newest ones, then the ones played since, or with older the
// next older ones. It returns them with the new sync.
func fetchGames(ctx context.Context, site, username string, sync gameSync, first, older bool, progress fetchProgress) ([]gameRecord, gameSync, error) {
	if progress == nil {
		progress = func(int, int, int) {}
	}
	if site == "lichess" {
		return fetchLichessGames(ctx, username, sync, first, older, progress)
	}
	return fetchChesscomGames(ctx, username, sync, first, older, progress)
}

// Lichess streams the games as NDJSON, newest first.
func fetchLichessGames(ctx context.Context, username string, sync gameSync, first, older bool, progress fetchProgress) ([]gameRecord, gameSync, error) {
	params := url.Values{
		"rated": {"true"}, "perfType": {"rapid"}, "moves": {"true"}, "evals": {"true"}, "clocks": {"false"},
		"opening": {"false"}, "pgnInJson": {"false"}, "sort": {"dateDesc"},
	}
	switch {
	case first:
		params.Set("max", strconv.Itoa(gamesBatch))
	case older:
		params.Set("until", strconv.FormatInt(sync.Oldest-1, 10))
		params.Set("max", strconv.Itoa(gamesBatch))
	default:
		params.Set("since", strconv.FormatInt(sync.Newest+1, 10))
	}
	response, err := siteRequest(ctx, "lichess", lichessBase+"/api/games/user/"+url.PathEscape(username)+"?"+params.Encode(), "application/x-ndjson")
	if err != nil {
		return nil, sync, err
	}
	defer response.Body.Close()
	var games []gameRecord
	newest, oldest, read := sync.Newest, sync.Oldest, 0
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 16<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var raw lichessRaw
		if json.Unmarshal([]byte(line), &raw) != nil {
			continue
		}
		read++
		newest = max(newest, raw.CreatedAt)
		if oldest == 0 || (raw.CreatedAt > 0 && raw.CreatedAt < oldest) {
			oldest = raw.CreatedAt
		}
		if game := lichessGame(raw, username); game != nil {
			games = append(games, *game)
		}
		if read%10 == 0 {
			progress(read, len(games), 0)
		}
	}
	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return nil, sync, ctx.Err()
		}
		return nil, sync, &fetchError{message: "The games from Lichess stopped coming."}
	}
	progress(read, len(games), 0)
	next := gameSync{Newest: newest, Oldest: oldest, Complete: sync.Complete}
	if first || older {
		next.Complete = read < gamesBatch
	}
	return games, next, nil
}

// chess.com keeps a player's games by month. A month that had ended when it
// was fetched is not fetched again.
func fetchChesscomGames(ctx context.Context, username string, sync gameSync, first, older bool, progress fetchProgress) ([]gameRecord, gameSync, error) {
	user := url.PathEscape(strings.ToLower(username))
	var list struct {
		Archives []string `json:"archives"`
	}
	if err := siteJSON(ctx, "chesscom", chesscomBase+"/player/"+user+"/games/archives", &list); err != nil {
		return nil, sync, err
	}
	monthShape := regexp.MustCompile(`/(\d{4})/(\d{2})$`)
	type month struct {
		name string
		end  time.Time
	}
	var all []month
	for _, address := range list.Archives {
		if found := monthShape.FindStringSubmatch(address); found != nil {
			year, _ := strconv.Atoi(found[1])
			number, _ := strconv.Atoi(found[2])
			all = append(all, month{found[1] + "/" + found[2], time.Date(year, time.Month(number)+1, 1, 0, 0, 0, 0, time.UTC)})
		}
	}
	sort.Slice(all, func(a, b int) bool { return all[a].name > all[b].name })
	done := map[string]bool{}
	for name := range sync.Done {
		done[name] = true
	}
	// Newer: every month since the oldest one fetched that is not done. Older
	// (and the first time): months before that, newest first, until about
	// gamesBatch rapid games are found.
	batch := first || older
	var months []month
	for _, m := range all {
		if batch && (sync.OldestMonth == "" || m.name < sync.OldestMonth) {
			months = append(months, m)
		} else if !batch && m.name >= sync.OldestMonth && !done[m.name] {
			months = append(months, m)
		}
	}
	var games []gameRecord
	read, fetched, oldest := 0, 0, sync.OldestMonth
	for _, m := range months {
		if batch && len(games) >= gamesBatch {
			break
		}
		startedAt := time.Now()
		var data struct {
			Games []chesscomRaw `json:"games"`
		}
		if err := siteJSON(ctx, "chesscom", chesscomBase+"/player/"+user+"/games/"+m.name, &data); err != nil {
			if !isNotFound(err) {
				return nil, sync, err
			}
			// chess.com lists the odd month it then cannot find: it is
			// passed over now and asked for again next time.
			fetched++
			continue
		}
		for _, raw := range data.Games {
			read++
			if game := chesscomGame(raw, username); game != nil {
				games = append(games, *game)
			}
		}
		// A game that ends just before midnight can take a while to show up.
		if startedAt.After(m.end.Add(time.Hour)) {
			done[m.name] = true
		}
		if oldest == "" || m.name < oldest {
			oldest = m.name
		}
		fetched++
		progress(read, len(games), fetched)
	}
	next := gameSync{OldestMonth: oldest, Done: done, Complete: sync.Complete}
	if batch {
		next.Complete = true
		for _, m := range all {
			if oldest == "" || m.name < oldest {
				next.Complete = false
				break
			}
		}
	}
	return games, next, nil
}

func isNotFound(err error) bool {
	var known *fetchError
	return errors.As(err, &known) && known.notFound
}

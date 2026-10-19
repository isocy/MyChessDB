package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestPGNAndSAN(t *testing.T) {
	got := sanMovesFromPGN("[Event \"Live Chess\"]\n[White \"a\"]\n\n1. e4 {[%clk 0:09:58]} 1... e5 {[%clk 0:09:57]} 2. Nf3 (2. f4 exf4) 2... Nc6 $1 3. Bb5 a6 1-0")
	if !reflect.DeepEqual(got, []string{"e4", "e5", "Nf3", "Nc6", "Bb5", "a6"}) {
		t.Fatalf("PGN: %v", got)
	}
	moves, ok := replaySAN([]string{"e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "0-0", "b5", "Bb3", "Nd4", "Nxd4", "exd4", "c3", "dxc3", "dxc3"})
	if !ok || moves[8] != "e1g1" || moves[len(moves)-1] != "d2c3" {
		t.Fatalf("SAN: %v %v", ok, moves)
	}
	if _, ok := replaySAN([]string{"e4", "Ke2", "Ke3"}); ok {
		t.Fatal("an illegal move")
	}
	// Two knights that can reach the same square, and a promotion.
	p, _ := parseFEN("4k3/1P6/8/8/8/2N3N1/8/4K3 w - - 0 1")
	if move, ok := p.parseSAN("Nce4", nil); !ok || move.from != squareIndex("c3") {
		t.Fatal("Nce4")
	}
	if move, ok := p.parseSAN("b8=N+", nil); !ok || move.promotion != 'n' {
		t.Fatal("b8=N")
	}
	if _, ok := p.parseSAN("Ne4", nil); ok {
		t.Fatal("an ambiguous move")
	}
}

var chesscomSample = chesscomRaw{
	URL: "https://www.chess.com/game/live/123", Rated: true, TimeClass: "rapid", Rules: "chess", EndTime: 1700000000,
	InitialSetup: startFEN, PGN: "[White \"Me\"]\n\n1. e4 {[%clk 0:09:59]} 1... e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0",
	White: &chesscomPlayer{Username: "Me", Rating: intPointer(1500), Result: "win"},
	Black: &chesscomPlayer{Username: "Them", Rating: intPointer(1480), Result: "checkmated"},
}

func intPointer(n int) *int { return &n }

func TestGameRecords(t *testing.T) {
	game := chesscomGame(chesscomSample, "me")
	if game == nil || game.ID != "chesscom:123" || game.Color != "w" || game.Rating != 1500 || game.Opponent != "Them" ||
		*game.OpponentRating != 1480 || game.Result != "win" || game.PlayedAt != 1700000000000 ||
		!reflect.DeepEqual(game.Moves, []string{"e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"}) {
		t.Fatalf("chess.com game: %+v", game)
	}
	for name, change := range map[string]func(*chesscomRaw){
		"blitz":    func(raw *chesscomRaw) { raw.TimeClass = "blitz" },
		"unrated":  func(raw *chesscomRaw) { raw.Rated = false },
		"chess960": func(raw *chesscomRaw) { raw.Rules = "chess960" },
		"from a position": func(raw *chesscomRaw) {
			raw.InitialSetup = "4k3/8/8/8/8/8/8/4K3 w - - 0 1"
		},
	} {
		raw := chesscomSample
		change(&raw)
		if chesscomGame(raw, "me") != nil {
			t.Fatalf("%s was taken", name)
		}
	}
	if chesscomGame(chesscomSample, "someoneelse") != nil {
		t.Fatal("only the player's games")
	}
	// The page links to the game: only to chess.com, and the id is its last part.
	for _, address := range []string{"https://evil.example/game/live/123", "javascript:alert(1)//www.chess.com/game/live/1",
		"http://www.chess.com/game/live/123", "https://www.chess.com/game/live/12/../../x", "https://www.chess.com/game/live/" + strings.Repeat("1", 50)} {
		raw := chesscomSample
		raw.URL = address
		if chesscomGame(raw, "me") != nil {
			t.Fatalf("a game at %q was taken", address)
		}
	}
	draw := chesscomSample
	draw.Black = &chesscomPlayer{Username: "Them", Rating: intPointer(1480), Result: "agreed"}
	if game := chesscomGame(draw, "them"); game == nil || game.Result != "draw" || game.Color != "b" {
		t.Fatalf("draw: %+v", game)
	}

	var raw lichessRaw
	json.Unmarshal([]byte(lichessSample("abcd1234", 1700000000000)), &raw)
	game = lichessGame(raw, "Me")
	if game == nil || game.ID != "lichess:abcd1234" || game.URL != lichessBase+"/abcd1234/black" || game.Color != "b" ||
		game.Rating != 1550 || game.Result != "win" || game.Opponent != "Opp" || len(game.Evals) != 4 ||
		*game.Evals[2] != mateScore(7) || *game.Evals[0] != cpScore(20) {
		t.Fatalf("Lichess game: %+v", game)
	}
	againstComputer := raw
	againstComputer.Players.White = lichessPlayer{}
	aborted := raw
	aborted.Status = "aborted"
	if lichessGame(againstComputer, "me") != nil || lichessGame(aborted, "me") != nil {
		t.Fatal("not against the computer, not aborted")
	}
	oddID := raw
	oddID.ID = "abc/../../x"
	if lichessGame(oddID, "me") != nil {
		t.Fatal("a game id that is not one")
	}
}

// A site's redirect is followed on the same host only.
func TestRedirects(t *testing.T) {
	var elsewhere int
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { elsewhere++ }))
	defer other.Close()
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/away":
			http.Redirect(w, r, other.URL+"/secret", http.StatusFound)
		case "/here":
			http.Redirect(w, r, "/target", http.StatusFound)
		case "/target":
			fmt.Fprint(w, `{"ok":true}`)
		}
	}))
	defer site.Close()
	var answer struct {
		OK bool `json:"ok"`
	}
	if err := siteJSON(context.Background(), "lichess", site.URL+"/away", &answer); err == nil || elsewhere != 0 {
		t.Fatalf("a redirect to another host was followed: %v, %d", err, elsewhere)
	}
	if err := siteJSON(context.Background(), "lichess", site.URL+"/here", &answer); err != nil || !answer.OK {
		t.Fatalf("a redirect on the same host: %v %+v", err, answer)
	}
}

func lichessSample(id string, createdAt int64) string {
	return `{"id":"` + id + `","rated":true,"variant":"standard","speed":"rapid","status":"resign","createdAt":` + strconv.FormatInt(createdAt, 10) +
		`,"winner":"black","players":{"white":{"user":{"name":"Opp","id":"opp"},"rating":1600},"black":{"user":{"name":"Me","id":"me"},"rating":1550}},` +
		`"moves":"e4 e5 Nf3 Nc6","analysis":[{"eval":20},{"eval":25},{"mate":7},{"eval":30,"judgment":{"name":"Blunder"}}]}`
}

// fakeSites stands in for Lichess and chess.com: games numbered from the
// newest (createdAt 2000) down, and chess.com months 2024/01 to 2024/03.
func fakeSites(t *testing.T, lichessGames int, requests *[]string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*requests = append(*requests, r.URL.String())
		if r.Header.Get("User-Agent") != appName+"/"+version {
			w.WriteHeader(403)
			return
		}
		switch {
		case strings.HasPrefix(r.URL.Path, "/lichess/api/user/nobody"), strings.HasPrefix(r.URL.Path, "/lichess/api/games/user/nobody"):
			w.WriteHeader(404)
		case strings.HasPrefix(r.URL.Path, "/lichess/api/user/"):
			fmt.Fprint(w, `{"username":"Me","perfs":{"rapid":{"rating":1500,"games":40}}}`)
		case strings.HasPrefix(r.URL.Path, "/lichess/api/games/user/"):
			query := r.URL.Query()
			limit, _ := strconv.Atoi(query.Get("max"))
			until, _ := strconv.ParseInt(query.Get("until"), 10, 64)
			since, _ := strconv.ParseInt(query.Get("since"), 10, 64)
			sent := 0
			for i := 0; i < lichessGames; i++ {
				createdAt := int64(2000 - i)
				if (until > 0 && createdAt > until) || createdAt < since || (limit > 0 && sent >= limit) {
					continue
				}
				line := lichessSample(fmt.Sprintf("g%d", i), createdAt)
				if strings.Contains(r.URL.Path, "/slow") { // games without Lichess's analysis: the engine has work
					line = strings.Replace(strings.Replace(line, `"id":"me"`, `"id":"slow"`, 1), `,"analysis":[{"eval":20},{"eval":25},{"mate":7},{"eval":30,"judgment":{"name":"Blunder"}}]`, "", 1)
				}
				fmt.Fprintln(w, line)
				sent++
			}
		case strings.HasSuffix(r.URL.Path, "/stats"):
			fmt.Fprint(w, `{"chess_rapid":{"last":{"rating":1500}}}`)
		case strings.HasSuffix(r.URL.Path, "/games/archives"):
			base := "http://" + r.Host + "/chesscom/player/me/games/"
			fmt.Fprintf(w, `{"archives":["%s2024/01","%s2024/02","%s2024/03"]}`, base, base, base)
		case strings.HasSuffix(r.URL.Path, "/games/2024/02") && strings.Contains(r.URL.Path, "/player/gap/"):
			w.WriteHeader(404) // a month chess.com lists but cannot find
		case strings.Contains(r.URL.Path, "/games/2024/"):
			month := r.URL.Path[len(r.URL.Path)-7:]
			count := 50
			if month == "2024/03" {
				count = 60
			}
			var games []chesscomRaw
			for i := 0; i < count; i++ {
				game := chesscomSample
				game.URL = fmt.Sprintf("https://www.chess.com/game/live/%s-%d", strings.ReplaceAll(month, "/", ""), i)
				games = append(games, game)
			}
			json.NewEncoder(w).Encode(map[string]any{"games": games})
		default:
			w.WriteHeader(404)
		}
	}))
	savedLichess, savedChesscom := lichessBase, chesscomBase
	lichessBase, chesscomBase = server.URL+"/lichess", server.URL+"/chesscom"
	t.Cleanup(func() { server.Close(); lichessBase, chesscomBase = savedLichess, savedChesscom })
}

func TestFetchingGames(t *testing.T) {
	var requests []string
	fakeSites(t, gamesBatch+1, &requests)
	ctx := context.Background()
	if rating, err := fetchRapidRating(ctx, "lichess", "Me"); err != nil || rating != 1500 {
		t.Fatalf("rating: %d %v", rating, err)
	}
	if _, err := fetchRapidRating(ctx, "lichess", "nobody"); !isNotFound(err) {
		t.Fatalf("an unknown player: %v", err)
	}

	games, sync, err := fetchGames(ctx, "lichess", "Me", gameSync{}, true, false, nil)
	if err != nil || len(games) != gamesBatch || sync.Newest != 2000 || sync.Oldest != 2000-gamesBatch+1 || sync.Complete {
		t.Fatalf("first batch: %v %d %+v", err, len(games), sync)
	}
	if !strings.Contains(requests[len(requests)-1], "max=100") || !strings.Contains(requests[len(requests)-1], "perfType=rapid") {
		t.Fatalf("one batch of rapid games: %s", requests[len(requests)-1])
	}
	games, sync, err = fetchGames(ctx, "lichess", "Me", sync, false, true, nil)
	if err != nil || len(games) != 1 || sync.Oldest != 2000-gamesBatch || !sync.Complete || sync.Newest != 2000 {
		t.Fatalf("older: %v %d %+v", err, len(games), sync)
	}
	if !strings.Contains(requests[len(requests)-1], fmt.Sprintf("until=%d", 2000-gamesBatch)) {
		t.Fatalf("older asks before the oldest: %s", requests[len(requests)-1])
	}
	_, _, err = fetchGames(ctx, "lichess", "Me", sync, false, false, nil)
	if err != nil || !strings.Contains(requests[len(requests)-1], "since=2001") || strings.Contains(requests[len(requests)-1], "max=") {
		t.Fatalf("newer: everything since the newest: %v %s", err, requests[len(requests)-1])
	}

	games, sync, err = fetchGames(ctx, "chesscom", "Me", gameSync{}, true, false, nil)
	if err != nil || len(games) != 110 || sync.OldestMonth != "2024/02" || sync.Complete || !sync.Done["2024/03"] {
		t.Fatalf("chess.com, newest months until a batch: %v %d %+v", err, len(games), sync)
	}
	games, sync, err = fetchGames(ctx, "chesscom", "Me", sync, false, true, nil)
	if err != nil || len(games) != 50 || sync.OldestMonth != "2024/01" || !sync.Complete {
		t.Fatalf("chess.com, older: %v %d %+v", err, len(games), sync)
	}
	gap, gapSync, err := fetchGames(ctx, "chesscom", "gap", gameSync{}, true, false, nil)
	if err != nil || len(gap) != 0 || gapSync.Done["2024/02"] {
		t.Fatalf("a month that cannot be found is passed over and asked for again: %v %d %+v", err, len(gap), gapSync)
	}
	before := len(requests)
	games, _, err = fetchGames(ctx, "chesscom", "Me", sync, false, false, nil)
	if err != nil || len(games) != 0 || len(requests) != before+1 {
		t.Fatalf("chess.com, nothing new: months that are over are not fetched again: %v %d %d", err, len(games), len(requests)-before)
	}
}

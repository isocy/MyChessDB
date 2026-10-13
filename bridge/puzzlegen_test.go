package main

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
)

func TestScoresAndJudgements(t *testing.T) {
	if math.Abs(winningChances(cpScore(200))-0.3524) > 0.001 {
		t.Fatal("+2.00 is 0.35 winning chances on Lichess's curve")
	}
	if winningChances(mateScore(0)) != -1 || winningChances(mateScore(0).invert()) != 1 || winningChances(mateScore(-2)) != -1 {
		t.Fatal("mates")
	}
	if compareScores(mateScore(1), mateScore(15)) <= 0 || compareScores(mateScore(-15), mateScore(-1)) <= 0 || compareScores(cpScore(5000), mateScore(15)) >= 0 {
		t.Fatal("score order")
	}
	cases := []struct {
		before, after pzScore
		want          string
	}{
		{cpScore(0), cpScore(-50), ""},
		{cpScore(0), cpScore(-60), "Inaccuracy"},
		{cpScore(0), cpScore(-115), "Mistake"},
		{cpScore(0), cpScore(-170), "Blunder"},
		{cpScore(900), cpScore(700), ""},
		{mateScore(3), cpScore(1200), "Inaccuracy"},
		{mateScore(3), cpScore(800), "Mistake"},
		{mateScore(3), cpScore(100), "Blunder"},
		{mateScore(3), mateScore(-2), "Blunder"},
		{cpScore(0), mateScore(-3), "Blunder"},
		{cpScore(-800), mateScore(-3), "Mistake"},
		{cpScore(-1200), mateScore(-3), "Inaccuracy"},
		{mateScore(2), mateScore(5), ""},
		{mateScore(1), mateScore(0).invert(), ""},
	}
	for _, c := range cases {
		if got := judgement(c.before, c.after); got != c.want {
			t.Fatalf("judgement(%s, %s) = %q, want %q", c.before, c.after, got, c.want)
		}
	}
}

// scripted answers from a table keyed by the moves played and the kind of
// search ("scan": one line at the scan's nodes; "quick": two lines at the
// scan's nodes; "full": the rest); anything else is the first legal move at
// 0.00.
type scriptedLine struct {
	move  string
	score pzScore
}

func scriptedEngine(effort puzzleEffort, table map[string][]scriptedLine, calls *[]string) engineSearch {
	return func(ctx context.Context, request searchRequest) (searchResult, error) {
		if err := ctx.Err(); err != nil {
			return searchResult{}, err
		}
		kind := "full"
		if request.Nodes == effort.scanNodes {
			kind = "quick"
			if request.MultiPV == 1 {
				kind = "scan"
			}
		}
		key := strings.Join(request.Moves, " ") + "|" + kind
		*calls = append(*calls, key)
		lines, ok := table[key]
		if !ok && kind != "scan" {
			lines, ok = table[strings.Join(request.Moves, " ")+"|full"]
		}
		if ok {
			result := searchResult{BestMove: lines[0].move}
			for i, line := range lines {
				if i >= request.MultiPV {
					break
				}
				out := searchLine{MultiPV: i + 1, PV: []string{line.move}}
				value := line.score.Cp
				if line.score.IsMate {
					value = line.score.Mate
					out.Score.Mate = &value
				} else {
					out.Score.Cp = &value
				}
				result.Lines = append(result.Lines, out)
			}
			return result, nil
		}
		game, err := replayGame(request.Fen, request.Moves)
		if err != nil {
			return searchResult{}, err
		}
		p := game.positions[len(game.positions)-1]
		first := p.legalMoves()[0].uci()
		zero := 0
		return searchResult{Lines: []searchLine{{MultiPV: 1, PV: []string{first}, Score: searchScore{Cp: &zero}}}, BestMove: first}, nil
	}
}

const qg5 = "e2e4 e7e5 g1f3 d8g5"

func TestLichessPuzzle(t *testing.T) {
	// 1. e4 e5 2. Nf3 Qg5?? 3. d4?? exd4: White missed Nxg5, which Lichess
	// makes a puzzle of (the opponent's blunder gave +9.00).
	effort := puzzleEfforts["quick"]
	table := map[string][]scriptedLine{
		"e2e4|scan": {{"e7e5", cpScore(-30)}}, "e2e4 e7e5|scan": {{"g1f3", cpScore(30)}}, "e2e4 e7e5 g1f3|scan": {{"b8c6", cpScore(-30)}},
		qg5 + "|scan": {{"f3g5", cpScore(900)}}, qg5 + " d2d4|scan": {{"e5d4", cpScore(20)}}, qg5 + " d2d4 e5d4|scan": {{"d1d4", cpScore(-20)}},
		qg5 + "|full":           {{"f3g5", cpScore(950)}, {"d2d4", cpScore(0)}},
		qg5 + " f3g5|full":      {{"g8f6", cpScore(-950)}, {"b8c6", cpScore(-960)}},
		qg5 + " f3g5 g8f6|full": {{"b1c3", cpScore(950)}, {"d2d3", cpScore(940)}},
	}
	game := gameInput{Color: "w", Moves: strings.Fields(qg5 + " d2d4 e5d4")}
	var calls, traces []string
	result, err := analyseGame(context.Background(), game, scriptedEngine(effort, table, &calls), effort, nil,
		func(ply int, reason string) { traces = append(traces, reason) })
	if err != nil || len(result.Puzzles) != 1 {
		t.Fatalf("one puzzle: %v %+v %v", err, result, traces)
	}
	puzzle := result.Puzzles[0]
	if !reflect.DeepEqual(puzzle.Solution, []string{"f3g5"}) || puzzle.Source != "lichess" || puzzle.Kind != "advantage" ||
		puzzle.Color != "w" || puzzle.Ply != 4 || puzzle.LastMove != "d8g5" || puzzle.Played != "d2d4" ||
		puzzle.Judgement != "Blunder" || puzzle.Score != cpScore(950) || !strings.Contains(puzzle.FenBefore, " b ") {
		t.Fatalf("puzzle: %+v", puzzle)
	}
	if result.Scanned != 6 {
		t.Fatalf("every position after the first is analysed once: %d", result.Scanned)
	}
	seen := map[string]bool{}
	for _, call := range calls {
		if seen[call] {
			t.Fatalf("searched twice: %s", call)
		}
		seen[call] = true
	}

	// Found in the game (the scan's best move was played): no puzzle.
	foundTable := map[string][]scriptedLine{qg5 + " f3g5|scan": {{"g8f6", cpScore(-950)}}}
	for key, lines := range table {
		foundTable[key] = lines
	}
	found, _ := analyseGame(context.Background(), gameInput{Color: "w", Moves: strings.Fields(qg5 + " f3g5 g8f6")},
		scriptedEngine(effort, foundTable, &calls), effort, nil, nil)
	if len(found.Puzzles) != 0 {
		t.Fatal("the player took the queen")
	}
	// Two winning moves: no puzzle.
	twoTable := map[string][]scriptedLine{qg5 + "|full": {{"f3g5", cpScore(950)}, {"f3e5", cpScore(700)}}}
	for key, lines := range table {
		if key != qg5+"|full" {
			twoTable[key] = lines
		}
	}
	two, _ := analyseGame(context.Background(), game, scriptedEngine(effort, twoTable, &calls), effort, nil, nil)
	if len(two.Puzzles) != 0 {
		t.Fatal("two winning moves make no puzzle")
	}
}

func TestOnlyMovePuzzle(t *testing.T) {
	// The same game from Black's side: 2...Qg5?? was a blunder in a quiet
	// position, where ...Nc6 was the only good move.
	effort := puzzleEfforts["quick"]
	table := map[string][]scriptedLine{
		"e2e4|scan": {{"e7e5", cpScore(-30)}}, "e2e4 e7e5|scan": {{"g1f3", cpScore(30)}}, "e2e4 e7e5 g1f3|scan": {{"b8c6", cpScore(-30)}},
		qg5 + "|scan":                   {{"f3g5", cpScore(900)}},
		"e2e4 e7e5 g1f3|quick":          {{"b8c6", cpScore(-30)}, {"g8f6", cpScore(-400)}},
		"e2e4 e7e5 g1f3|full":           {{"b8c6", cpScore(-30)}, {"g8f6", cpScore(-400)}},
		"e2e4 e7e5 g1f3 b8c6|full":      {{"f1b5", cpScore(30)}, {"f1c4", cpScore(25)}},
		"e2e4 e7e5 g1f3 b8c6 f1b5|full": {{"a7a6", cpScore(-30)}, {"g8f6", cpScore(-35)}},
	}
	var calls, traces []string
	game := gameInput{Color: "b", Moves: strings.Fields(qg5)}
	result, err := analyseGame(context.Background(), game, scriptedEngine(effort, table, &calls), effort, nil,
		func(ply int, reason string) { traces = append(traces, reason) })
	if err != nil || len(result.Puzzles) != 1 {
		t.Fatalf("one puzzle: %v %+v %v", err, result, traces)
	}
	puzzle := result.Puzzles[0]
	if puzzle.Source != "only-move" || puzzle.Kind != "only-move" || !reflect.DeepEqual(puzzle.Solution, []string{"b8c6"}) ||
		puzzle.Played != "d8g5" || puzzle.Judgement != "Blunder" {
		t.Fatalf("puzzle: %+v", puzzle)
	}

	// A quick look that shows other good moves stops it before the full search.
	quickTable := map[string][]scriptedLine{"e2e4 e7e5 g1f3|quick": {{"b8c6", cpScore(-30)}, {"g8f6", cpScore(-40)}}}
	for key, lines := range table {
		if key != "e2e4 e7e5 g1f3|quick" {
			quickTable[key] = lines
		}
	}
	calls = nil
	none, _ := analyseGame(context.Background(), game, scriptedEngine(effort, quickTable, &calls), effort, nil, nil)
	if len(none.Puzzles) != 0 {
		t.Fatal("other good moves")
	}
	for _, call := range calls {
		if call == "e2e4 e7e5 g1f3|full" {
			t.Fatal("a full search after the quick one")
		}
	}

	// Cancelled: the context's error comes back.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := analyseGame(ctx, game, scriptedEngine(effort, table, &calls), effort, nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
}

func TestMatePuzzleFromLichessEvaluations(t *testing.T) {
	// 1. f3 e5 2. g4 Nc6?? (2...Qh4# was there) 3. h3, with Lichess's own
	// evaluations: nothing is scanned.
	effort := puzzleEfforts["quick"]
	minus := func(cp int) *pzScore { s := cpScore(cp); return &s }
	mate := mateScore(-1)
	game := gameInput{Color: "b", Moves: strings.Fields("f2f3 e7e5 g2g4 b8c6 h2h3"),
		Evals: []*pzScore{minus(-50), minus(-60), &mate, minus(-40), minus(-50)}}
	table := map[string][]scriptedLine{"f2f3 e7e5 g2g4|full": {{"d8h4", mateScore(1)}, {"b8c6", cpScore(-60)}}}
	var calls []string
	result, err := analyseGame(context.Background(), game, scriptedEngine(effort, table, &calls), effort, nil, nil)
	if err != nil || result.Scanned != 0 || len(result.Puzzles) != 1 {
		t.Fatalf("%v %+v", err, result)
	}
	if puzzle := result.Puzzles[0]; puzzle.Kind != "mate" || !reflect.DeepEqual(puzzle.Solution, []string{"d8h4"}) || puzzle.Score != mateScore(1) {
		t.Fatalf("mate in one: %+v", puzzle)
	}
	if _, err := analyseGame(context.Background(), gameInput{Color: "w", Moves: []string{"e2e5"}}, scriptedEngine(effort, table, &calls), effort, nil, nil); err == nil {
		t.Fatal("an illegal move")
	}
}

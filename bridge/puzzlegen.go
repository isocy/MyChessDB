package main

// The puzzle finder: positions in a player's own games where one move was
// clearly better than every other and the player missed it. It runs here, in
// the bridge, so that it goes on when the site's tab is closed (puzzles.go);
// the site only fetches the games and collects the puzzles.
//
// 1. Game analysis, as Lichess's computer analysis (fishnet) does it: every
//    position of the game is searched by Stockfish to a fixed number of nodes,
//    1,000,000 per position for an analysis asked for on Lichess
//    (lila modules/fishnet Work.scala, Origin.manualRequest). For a Lichess
//    game that Lichess has analysed already, Lichess's own evaluations are
//    used. Each of the player's moves then gets Lichess's judgement
//    (inaccuracy, mistake, blunder: lila modules/tree Advice.scala).
//
// 2. Where the player's move was not the best one found and Lichess marks it,
//    two kinds of puzzle are looked for, the first one first:
//
//    "lichess": a puzzle as Lichess makes them, by the rules of
//    lichess-puzzler (generator/generator.py, version 50):
//    - the position is one where the player has just been given a chance by
//      the opponent's move: the evaluation jumps by more than 0.6 in winning
//      chances (-1..1) to at least +2.00, or there is a mate in 14 or fewer.
//      Not when the player was already ahead by more than +3.00 before (unless
//      it is a mate), or is already up in material, or was given only +2.00 to
//      +3.99 without being down in material;
//    - the solution is Stockfish's line from there (two lines searched at
//      each move: depth 50, at most 25 million nodes or 30 seconds). Every
//      move of the player's must be the only good one: its winning chances
//      more than 0.7 above those of the second-best move (for a mate in one,
//      no other move keeping more than 0.6). An advantage line ends where that
//      stops, must stay at +2.00 or more, and is cut back so that it ends with
//      a move of the player's that had an alternative; a mate line has to go
//      all the way to checkmate (the defender's moves searched to depth 15,
//      8 million nodes or 10 seconds);
//    - a position that repeats an earlier one is skipped until a capture or
//      pawn move.
//    Changed from Lichess: one-move puzzles are kept (Lichess drops them from
//    its public set), every puzzle of a game is kept (Lichess keeps the
//    first), and Lichess's tiers by rating and time control, its endgame
//    tablebase check and its skipping of positions with fewer castling rights
//    than the pieces allow are left out.
//
//    "only-move": Lichess only makes puzzles where the opponent has just
//    blundered, which leaves out most of what a player misses in their own
//    games (in 30 games of a 1365-rated player it found none). So where the
//    player's move was a mistake or a blunder (Lichess's judgement) and no
//    Lichess puzzle is there, the position is a puzzle when its best move is
//    the only good one: every other move loses at least 0.3 in winning
//    chances against it, which is what Lichess calls a blunder. The line goes
//    on while the player's next move is again such an only move (a mate in
//    one always ends it: any checkmate is accepted), and is cut back as above.
//
//    Either way the puzzle is only kept when the player missed it: their move
//    in the game was not the solution's first move, nor another checkmate.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

type searchLimits struct {
	depth    int
	nodes    int64
	movetime int
}

// How hard the engine works. "lichess" is what Lichess uses; "quick" is
// Lichess's lighter background analysis (300,000 nodes per position) with
// shorter puzzle searches.
type puzzleEffort struct {
	scanNodes   int64
	pair        searchLimits
	mateDefense searchLimits
}

var puzzleEfforts = map[string]puzzleEffort{
	"lichess": {scanNodes: 1_000_000, pair: searchLimits{50, 25_000_000, 30_000}, mateDefense: searchLimits{15, 8_000_000, 10_000}},
	"quick":   {scanNodes: 300_000, pair: searchLimits{50, 5_000_000, 10_000}, mateDefense: searchLimits{15, 2_000_000, 5_000}},
}

const (
	// Lines longer than these are given up (Lichess has no limit; its lines
	// are far shorter). An only-move line stops at the limit instead.
	maxAdvantagePlies = 24
	maxMatePlies      = 40
	maxOnlyMovePlies  = 9
	// "only-move": every other move is a blunder (Lichess's 0.3) against the best.
	onlyMoveGap = 0.3
	// A quick two-line search first: when its gap is smaller than this, the
	// full search is not run.
	onlyMoveQuickGap = 0.15
)

// ------------------------------------------------------------- scores -----

// pzScore is from one side's point of view: Mate > 0 means that side mates
// in so many moves, Mate < 0 that it gets mated. A position whose side to
// move is checkmated is Mate 0; seen from the other side, Mate 0 with Given.
type pzScore struct {
	Cp     int
	Mate   int
	IsMate bool
	Given  bool
}

func cpScore(cp int) pzScore     { return pzScore{Cp: cp} }
func mateScore(mate int) pzScore { return pzScore{Mate: mate, IsMate: true} }

func (s pzScore) invert() pzScore {
	switch {
	case !s.IsMate:
		return cpScore(-s.Cp)
	case s.Mate == 0:
		return pzScore{IsMate: true, Given: !s.Given}
	default:
		return mateScore(-s.Mate)
	}
}

// {"cp": 32} or {"mate": -3}, as the site writes them.
func (s pzScore) MarshalJSON() ([]byte, error) {
	if s.IsMate {
		return []byte(`{"mate":` + strconv.Itoa(s.Mate) + `}`), nil
	}
	return []byte(`{"cp":` + strconv.Itoa(s.Cp) + `}`), nil
}

func (s *pzScore) UnmarshalJSON(raw []byte) error {
	var fields struct {
		Cp   *int `json:"cp"`
		Mate *int `json:"mate"`
	}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	switch {
	case fields.Mate != nil:
		*s = mateScore(*fields.Mate)
	case fields.Cp != nil:
		*s = cpScore(*fields.Cp)
	default:
		return errors.New("a score needs cp or mate")
	}
	return nil
}

// Lichess's winning chances, -1..1 (scalachess eval.scala, WinPercent).
func winningChances(s pzScore) float64 {
	if s.IsMate {
		if s.Mate > 0 || (s.Mate == 0 && s.Given) {
			return 1
		}
		return -1
	}
	return math.Max(-1, math.Min(1, 2/(1+math.Exp(-0.00368208*float64(s.Cp)))-1))
}

// Orders scores the way python-chess does: any mate for the side above any
// centipawns, a quicker mate above a slower one, being mated below all.
func scoreValue(s pzScore) int {
	switch {
	case !s.IsMate:
		return max(-99_000, min(99_000, s.Cp))
	case s.Mate == 0 && s.Given:
		return 100_001
	case s.Mate == 0:
		return -100_001
	case s.Mate > 0:
		return 100_000 - s.Mate
	default:
		return -100_000 - s.Mate
	}
}

func compareScores(a, b pzScore) int { return scoreValue(a) - scoreValue(b) }

var mateSoon = mateScore(15)

// "+1.25", "-0.40", "#3", "#-2".
func (s pzScore) String() string {
	if s.IsMate {
		if s.Mate == 0 {
			if s.Given {
				return "#"
			}
			return "#-"
		}
		return "#" + strconv.Itoa(s.Mate)
	}
	sign := "+"
	if s.Cp < 0 {
		sign = "-"
	}
	return fmt.Sprintf("%s%.2f", sign, math.Abs(float64(s.Cp))/100)
}

// judgement is Lichess's judgement of a move (lila Advice.scala):
// "Inaccuracy", "Mistake", "Blunder" or "". Both scores are from the side
// that moved: before for the position it moved in, after for the one it
// moved to.
func judgement(before, after pzScore) string {
	if !before.IsMate && !after.IsMate {
		drop := winningChances(before) - winningChances(after)
		switch {
		case drop >= 0.3:
			return "Blunder"
		case drop >= 0.2:
			return "Mistake"
		case drop >= 0.1:
			return "Inaccuracy"
		}
		return ""
	}
	beforeCp, afterCp := 0, 0
	if !before.IsMate {
		beforeCp = before.Cp
	}
	if !after.IsMate {
		afterCp = after.Cp
	}
	created := !before.IsMate && after.IsMate && after.Mate < 0
	lost := before.IsMate && before.Mate > 0 && (!after.IsMate || after.Mate < 0)
	switch {
	case created && beforeCp < -999, lost && afterCp > 999:
		return "Inaccuracy"
	case created && beforeCp < -700, lost && afterCp > 700:
		return "Mistake"
	case created, lost:
		return "Blunder"
	}
	return ""
}

// ------------------------------------------------------------ positions ----

func materialDiff(p *position, color byte) int {
	values := map[byte]int{'p': 1, 'n': 3, 'b': 3, 'r': 5, 'q': 9}
	diff := 0
	for _, piece := range p.board {
		if piece == 0 {
			continue
		}
		if isWhitePiece(piece) == (color == 'w') {
			diff += values[lower(piece)]
		} else {
			diff -= values[lower(piece)]
		}
	}
	return diff
}

// Captures, pawn moves, moves that lose castling rights and moves made where
// en passant was possible cannot be undone (python-chess is_irreversible).
func irreversible(p *position, move chessMove) bool {
	if lower(move.piece) == 'p' || move.captured != 0 {
		return true
	}
	if p.makeMove(move).castling != p.castling {
		return true
	}
	return p.hasLegalEnPassant()
}

type replayedGame struct {
	positions []position // 0 = before the first move
	keys      []string
	moves     []chessMove
}

func replayGame(initialFEN string, uciMoves []string) (replayedGame, error) {
	start, err := parseFEN(initialFEN)
	if err != nil {
		return replayedGame{}, err
	}
	game := replayedGame{positions: []position{start}, keys: []string{start.key()}}
	for i, text := range uciMoves {
		p := &game.positions[len(game.positions)-1]
		move, ok := p.parseUCI(text, nil)
		if !ok {
			return replayedGame{}, fmt.Errorf("illegal move %s after %d moves", text, i)
		}
		next := p.makeMove(move)
		game.moves = append(game.moves, move)
		game.positions = append(game.positions, next)
		game.keys = append(game.keys, next.key())
	}
	return game, nil
}

// ------------------------------------------------------------- analysis ---

// errGameRejected marks an error in the game itself (an illegal move), as
// against one from the engine.
var errGameRejected = errors.New("the game could not be read")

// engineSearch runs one limited search (the searcher in search.go).
type engineSearch func(ctx context.Context, request searchRequest) (searchResult, error)

// gameInput is a game as the site sends it.
type gameInput struct {
	Color string     `json:"color"` // the player's: "w" or "b"
	Moves []string   `json:"moves"` // UCI, from the standard starting position
	Evals []*pzScore `json:"evals"` // Lichess's own analysis: from White's side after each move, or null
}

// puzzleOut is a puzzle as the site stores it.
type puzzleOut struct {
	ID          string   `json:"id"`
	Ply         int      `json:"ply"`
	Key         string   `json:"key"`
	Color       string   `json:"color"`
	FenBefore   string   `json:"fenBefore"`
	LastMove    string   `json:"lastMove"`
	Solution    []string `json:"solution"`
	Source      string   `json:"source"`
	Kind        string   `json:"kind"`
	Score       pzScore  `json:"score"`
	Played      string   `json:"played"`
	Judgement   string   `json:"judgement"`
	PlayedScore pzScore  `json:"playedScore"`
}

type gameAnalysis struct {
	Puzzles    []puzzleOut `json:"puzzles"`
	Scanned    int         `json:"scanned"`
	Judgements int         `json:"judgements"`
}

type puzzleSearch struct {
	ctx      context.Context
	search   engineSearch
	effort   puzzleEffort
	moves    []string
	game     replayedGame
	color    byte
	evals    []pzScore
	best     []string
	judged   []string
	cache    map[string]searchResult
	newGame  bool
	trace    func(ply int, reason string)
	progress func(phase string, done, total int)
}

// analyseGame finds the player's puzzles in one game.
func analyseGame(ctx context.Context, input gameInput, search engineSearch, effort puzzleEffort,
	progress func(phase string, done, total int), trace func(ply int, reason string)) (gameAnalysis, error) {
	var result gameAnalysis
	if input.Color != "w" && input.Color != "b" {
		return result, fmt.Errorf("%w: the player's color must be w or b", errGameRejected)
	}
	game, err := replayGame(startFEN, input.Moves)
	if err != nil {
		return result, fmt.Errorf("%w: %v", errGameRejected, err)
	}
	if trace == nil {
		trace = func(int, string) {}
	}
	if progress == nil {
		progress = func(string, int, int) {}
	}
	n := len(input.Moves)
	s := &puzzleSearch{
		ctx: ctx, search: search, effort: effort, moves: input.Moves, game: game, color: input.Color[0],
		evals: make([]pzScore, n+1), best: make([]string, n+1), judged: make([]string, n+1),
		cache: map[string]searchResult{}, newGame: true, trace: trace, progress: progress,
	}

	// 1. An evaluation of every position, from its side to move.
	known := make([]bool, n+1)
	s.evals[0], known[0] = cpScore(15), true // lila's starting evaluation
	for ply := 1; ply <= n; ply++ {
		if ply-1 < len(input.Evals) && input.Evals[ply-1] != nil {
			white := *input.Evals[ply-1]
			if game.positions[ply].turn == 'b' {
				white = white.invert()
			}
			s.evals[ply], known[ply] = white, true
		}
	}
	var missing []int
	for ply := 0; ply <= n; ply++ {
		p := &game.positions[ply]
		if moves := p.legalMoves(); len(moves) == 0 {
			if p.isCheckmate(moves) {
				s.evals[ply] = mateScore(0)
			} else {
				s.evals[ply] = cpScore(0)
			}
		} else if !known[ply] {
			missing = append(missing, ply)
		}
	}
	for i, ply := range missing {
		progress("scan", i, len(missing))
		found, err := s.searchAt(ply, nil, searchLimits{nodes: effort.scanNodes}, 1)
		if err != nil {
			return result, err
		}
		s.evals[ply] = cpScore(0)
		if len(found.Lines) > 0 {
			s.evals[ply] = scoreOf(found.Lines[0])
			s.best[ply] = found.Lines[0].PV[0]
		} else {
			s.best[ply] = found.BestMove
		}
		result.Scanned++
	}
	progress("scan", len(missing), len(missing))

	// Lichess's judgement of each of the player's moves.
	for ply := 0; ply < n; ply++ {
		if game.positions[ply].turn != s.color {
			continue
		}
		s.judged[ply] = judgement(s.evals[ply], s.evals[ply+1].invert())
		if s.judged[ply] != "" {
			result.Judgements++
		}
	}

	// 2. The puzzle search (lichess-puzzler's analyze_game).
	prevScore := cpScore(20)
	seen := map[string]bool{}
	skipUntilIrreversible := false
	result.Puzzles = []puzzleOut{}
	for ply := 1; ply <= n; ply++ {
		if skipUntilIrreversible {
			if !irreversible(&game.positions[ply-1], game.moves[ply-1]) {
				continue
			}
			skipUntilIrreversible = false
			seen = map[string]bool{}
		}
		if seen[game.keys[ply]] {
			skipUntilIrreversible = true
			continue
		}
		seen[game.keys[ply]] = true
		score := s.evals[ply]
		if game.positions[ply].turn == s.color {
			progress("puzzles", ply, n)
			puzzle, err := s.analysePosition(ply, prevScore, score)
			if err != nil {
				return result, err
			}
			if puzzle != nil {
				result.Puzzles = append(result.Puzzles, *puzzle)
			}
		}
		prevScore = score.invert()
	}
	return result, nil
}

func scoreOf(line searchLine) pzScore {
	if line.Score.Mate != nil {
		return mateScore(*line.Score.Mate)
	}
	if line.Score.Cp != nil {
		return cpScore(*line.Score.Cp)
	}
	return cpScore(0)
}

// searchAt searches from the game's start through its moves up to ply and
// then line, so that the engine sees repetitions. The same search is not run
// twice for a game.
func (s *puzzleSearch) searchAt(ply int, line []string, limits searchLimits, multipv int) (searchResult, error) {
	if err := s.ctx.Err(); err != nil {
		return searchResult{}, err
	}
	moves := append(append([]string{}, s.moves[:ply]...), line...)
	key := fmt.Sprintf("%s|%d|%d|%d|%d", strings.Join(moves, " "), multipv, limits.depth, limits.nodes, limits.movetime)
	if found, ok := s.cache[key]; ok {
		return found, nil
	}
	found, err := s.search(s.ctx, searchRequest{
		Fen: startFEN, Moves: moves, Nodes: limits.nodes, Depth: limits.depth, Movetime: limits.movetime,
		MultiPV: multipv, NewGame: s.newGame,
	})
	if err != nil {
		return searchResult{}, err
	}
	s.newGame = false
	s.cache[key] = found
	return found, nil
}

// A position where it is the player's move: a puzzle, or nil.
func (s *puzzleSearch) analysePosition(ply int, prevScore, score pzScore) (*puzzleOut, error) {
	p := &s.game.positions[ply]
	moves := p.legalMoves()
	skip := func(reason string) (*puzzleOut, error) { s.trace(ply, reason); return nil, nil }
	if len(moves) < 2 {
		return skip("one legal move")
	}
	// The player has to have missed something: they made a move (the game did
	// not end here), it was not the best one found, and Lichess's analysis
	// marks it.
	if ply >= len(s.moves) {
		return skip("the game ended")
	}
	played := s.moves[ply]
	if s.best[ply] == played {
		return skip("played the best move")
	}
	if s.judged[ply] == "" {
		return skip("move not marked")
	}
	scores := prevScore.String() + " -> " + score.String()
	missed := func(solution []string) bool {
		if solution[0] == played {
			return false
		}
		move, ok := p.parseUCI(played, moves)
		if !ok {
			return true
		}
		next := p.makeMove(move)
		return !next.isCheckmate(next.legalMoves()) // another checkmate counts
	}
	found, err := s.lichessPuzzle(ply, prevScore, score, scores)
	if err != nil {
		return nil, err
	}
	if found != nil && !missed(found.Solution) {
		return skip("found it in the game")
	}
	if found == nil {
		// Only for a mistake or a blunder: the best move has to be at least
		// 0.3 better than any other, so the player's move lost that much.
		if s.judged[ply] == "Inaccuracy" {
			return skip("inaccuracy only (" + scores + ")")
		}
		if found, err = s.onlyMovePuzzle(ply, scores); err != nil || found == nil {
			return nil, err
		}
		if !missed(found.Solution) {
			return skip("found it in the game")
		}
	}
	s.trace(ply, found.Kind+" puzzle ("+scores+")")
	found.ID = strconv.Itoa(ply)
	found.Ply = ply
	found.Key = s.game.keys[ply]
	found.Color = string(p.turn)
	before := s.game.positions[ply-1]
	found.FenBefore = before.fen()
	found.LastMove = s.moves[ply-1]
	if found.Kind == "mate" {
		found.Score = mateScore((len(found.Solution) + 1) / 2)
	}
	found.Played = played
	found.Judgement = s.judged[ply]
	found.PlayedScore = s.evals[ply+1].invert()
	return found, nil
}

// lichess-puzzler's analyze_position.
func (s *puzzleSearch) lichessPuzzle(ply int, prevScore, score pzScore, scores string) (*puzzleOut, error) {
	p := &s.game.positions[ply]
	winner := p.turn
	skip := func(reason string) (*puzzleOut, error) {
		s.trace(ply, "lichess: "+reason+" ("+scores+")")
		return nil, nil
	}
	if compareScores(prevScore, cpScore(300)) > 0 && compareScores(score, mateSoon) < 0 {
		return skip("already winning before")
	}
	if materialDiff(p, winner) > 0 {
		return skip("already up in material")
	}
	if compareScores(score, mateSoon) > 0 {
		solution, err := s.cookMate(ply)
		if err != nil {
			return nil, err
		}
		if solution == nil {
			return skip("mate not unique")
		}
		return &puzzleOut{Solution: solution, Kind: "mate", Source: "lichess"}, nil
	}
	if compareScores(score, cpScore(200)) >= 0 && winningChances(score) > winningChances(prevScore)+0.6 {
		if compareScores(score, cpScore(400)) < 0 && materialDiff(p, winner) > -1 {
			return skip("not clearly winning")
		}
		pairs, err := s.cookAdvantage(ply)
		if err != nil {
			return nil, err
		}
		if pairs == nil {
			return skip("line not winning enough or repeating")
		}
		pairs = trimLine(pairs)
		if len(pairs) == 0 {
			return skip("no only move")
		}
		return &puzzleOut{Solution: pairMoves(pairs), Kind: "advantage", Score: pairs[len(pairs)-1].best.score, Source: "lichess"}, nil
	}
	return skip("no chance given")
}

type engineMove struct {
	move  string
	score pzScore
}

type movePair struct {
	best   engineMove
	second *engineMove
}

func pairMoves(pairs []movePair) []string {
	out := make([]string, len(pairs))
	for i, pair := range pairs {
		out[i] = pair.best.move
	}
	return out
}

// A line ends with a move of the player's that had an alternative.
func trimLine(pairs []movePair) []movePair {
	for len(pairs) > 0 && (len(pairs)%2 == 0 || pairs[len(pairs)-1].second == nil) {
		pairs = pairs[:len(pairs)-1]
	}
	return pairs
}

func gapOf(pair movePair) float64 {
	if pair.second == nil {
		return math.Inf(1)
	}
	return winningChances(pair.best.score) - winningChances(pair.second.score)
}

// The only good move, and the moves after it while the player's are again
// the only good ones.
func (s *puzzleSearch) onlyMovePuzzle(ply int, scores string) (*puzzleOut, error) {
	p := s.game.positions[ply]
	winner := p.turn
	skip := func(reason string) (*puzzleOut, error) {
		s.trace(ply, "only-move: "+reason+" ("+scores+")")
		return nil, nil
	}
	quick, err := s.twoLines(ply, nil, &p, winner, searchLimits{nodes: s.effort.scanNodes})
	if err != nil {
		return nil, err
	}
	if quick == nil || gapOf(*quick) < onlyMoveQuickGap {
		return skip("other good moves")
	}
	keys := append([]string{}, s.game.keys[:ply+1]...)
	var line []string
	var pairs []movePair
	for len(line) < maxOnlyMovePlies {
		if countKey(keys, keys[len(keys)-1]) >= 2 {
			break
		}
		moves := p.legalMoves()
		if len(moves) == 0 {
			break
		}
		pair, err := s.twoLines(ply, line, &p, winner, s.effort.pair)
		if err != nil {
			return nil, err
		}
		if pair == nil {
			break
		}
		mateInOne := pair.best.score.IsMate && pair.best.score.Mate == 1
		if p.turn == winner && gapOf(*pair) < onlyMoveGap && !mateInOne {
			break
		}
		move, ok := p.parseUCI(pair.best.move, moves)
		if !ok {
			break
		}
		pairs = append(pairs, *pair)
		line = append(line, pair.best.move)
		p = p.makeMove(move)
		keys = append(keys, p.key())
		if mateInOne && len(pairs)%2 == 1 {
			break // any checkmate is accepted
		}
	}
	pairs = trimLine(pairs)
	if len(pairs) == 0 {
		return skip("other good moves")
	}
	kind := "only-move"
	if len(pairs) == len(line) && p.isCheckmate(p.legalMoves()) {
		kind = "mate"
	}
	return &puzzleOut{Solution: pairMoves(pairs), Kind: kind, Score: pairs[len(pairs)-1].best.score, Source: "only-move"}, nil
}

func countKey(keys []string, key string) int {
	n := 0
	for _, k := range keys {
		if k == key {
			n++
		}
	}
	return n
}

// The two best moves at p, with scores from the winner's side (second is nil
// with one legal move).
func (s *puzzleSearch) twoLines(ply int, line []string, p *position, winner byte, limits searchLimits) (*movePair, error) {
	found, err := s.searchAt(ply, line, limits, 2)
	if err != nil {
		return nil, err
	}
	var lines []searchLine
	for _, l := range found.Lines {
		if len(l.PV) > 0 {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		return nil, nil
	}
	pov := func(score pzScore) pzScore {
		if p.turn == winner {
			return score
		}
		return score.invert()
	}
	pair := &movePair{best: engineMove{lines[0].PV[0], pov(scoreOf(lines[0]))}}
	if len(lines) > 1 {
		pair.second = &engineMove{lines[1].PV[0], pov(scoreOf(lines[1]))}
	}
	return pair, nil
}

// lichess-puzzler's get_next_pair: the two best moves, or nil where it is
// the winner's move and the best move is not clearly the only good one.
func (s *puzzleSearch) nextPair(ply int, line []string, p *position, winner byte) (*movePair, error) {
	pair, err := s.twoLines(ply, line, p, winner, s.effort.pair)
	if err != nil || pair == nil {
		return nil, err
	}
	if p.turn == winner {
		valid, err := s.validAttack(ply, line, p, *pair)
		if err != nil || !valid {
			return nil, err
		}
	}
	return pair, nil
}

func (s *puzzleSearch) validAttack(ply int, line []string, p *position, pair movePair) (bool, error) {
	if pair.second == nil {
		return true, nil
	}
	mateInOne, err := s.validMateInOne(ply, line, p, pair)
	if err != nil || mateInOne {
		return mateInOne, err
	}
	return winningChances(pair.best.score) > winningChances(pair.second.score)+0.7, nil
}

func (s *puzzleSearch) validMateInOne(ply int, line []string, p *position, pair movePair) (bool, error) {
	if !pair.best.score.IsMate || pair.best.score.Mate != 1 {
		return false, nil
	}
	if pair.second == nil || winningChances(pair.second.score) <= 0.6 {
		return true, nil
	}
	if !pair.second.score.IsMate || pair.second.score.Mate != 1 {
		return false, nil
	}
	// More than one mate in one: the best move that does not mate has to be
	// bad enough.
	mates := 0
	for _, move := range p.legalMoves() {
		next := p.makeMove(move)
		if next.isCheckmate(next.legalMoves()) {
			mates++
		}
	}
	found, err := s.searchAt(ply, line, s.effort.pair, min(mates+1, searchMaxMultiPV))
	if err != nil || len(found.Lines) == 0 {
		return err == nil, err
	}
	last := scoreOf(found.Lines[len(found.Lines)-1])
	return !(compareScores(last, mateScore(1)) < 0 && winningChances(last) > 0.6), nil
}

// The mating line: the winner's moves must each be the only good one and
// keep a mate in 15 or fewer; the defender's are its best (cook_mate).
func (s *puzzleSearch) cookMate(ply int) ([]string, error) {
	p := s.game.positions[ply]
	winner := p.turn
	line := []string{}
	for len(line) < maxMatePlies {
		moves := p.legalMoves()
		if len(moves) == 0 {
			if p.isCheckmate(moves) {
				return line, nil
			}
			return nil, nil
		}
		var text string
		if p.turn == winner {
			pair, err := s.nextPair(ply, line, &p, winner)
			if err != nil || pair == nil || compareScores(pair.best.score, mateSoon) < 0 {
				return nil, err
			}
			text = pair.best.move
		} else {
			found, err := s.searchAt(ply, line, s.effort.mateDefense, 1)
			if err != nil {
				return nil, err
			}
			text = found.BestMove
			if len(found.Lines) > 0 {
				text = found.Lines[0].PV[0]
			}
			if text == "" {
				return nil, nil
			}
		}
		move, ok := p.parseUCI(text, moves)
		if !ok {
			return nil, nil
		}
		line = append(line, text)
		p = p.makeMove(move)
	}
	return nil, nil
}

// The winning line: pairs of moves while the winner's move stays the only
// good one; nil when it stops being winning or repeats (cook_advantage).
func (s *puzzleSearch) cookAdvantage(ply int) ([]movePair, error) {
	p := s.game.positions[ply]
	winner := p.turn
	keys := append([]string{}, s.game.keys[:ply+1]...)
	var line []string
	pairs := []movePair{}
	for len(pairs) < maxAdvantagePlies {
		if countKey(keys, keys[len(keys)-1]) >= 2 {
			return nil, nil
		}
		moves := p.legalMoves()
		if len(moves) == 0 {
			break
		}
		pair, err := s.nextPair(ply, line, &p, winner)
		if err != nil {
			return nil, err
		}
		if pair == nil {
			break
		}
		if compareScores(pair.best.score, cpScore(200)) < 0 {
			return nil, nil
		}
		move, ok := p.parseUCI(pair.best.move, moves)
		if !ok {
			return nil, nil
		}
		pairs = append(pairs, *pair)
		line = append(line, pair.best.move)
		p = p.makeMove(move)
		keys = append(keys, p.key())
	}
	return pairs, nil
}

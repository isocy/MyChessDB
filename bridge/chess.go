package main

// Chess rules for the puzzle finder: a port of web/chesslib.js, with the same
// conventions. Squares are 0..63 with 0 = a8 and 63 = h1 (row * 8 + column,
// row 0 is rank 8); pieces are FEN letters, 0 for an empty square. Checked
// against the same perft counts as chesslib.js (chess_test.go).

import (
	"errors"
	"strconv"
	"strings"
)

const startFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

const files = "abcdefgh"

var (
	knightSteps = [8][2]int{{-2, -1}, {-2, 1}, {-1, -2}, {-1, 2}, {1, -2}, {1, 2}, {2, -1}, {2, 1}}
	kingSteps   = [8][2]int{{-1, -1}, {-1, 0}, {-1, 1}, {0, -1}, {0, 1}, {1, -1}, {1, 0}, {1, 1}}
	rookDirs    = [4][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}}
	bishopDirs  = [4][2]int{{-1, -1}, {-1, 1}, {1, -1}, {1, 1}}
)

type position struct {
	board    [64]byte
	turn     byte   // 'w' or 'b'
	castling string // a subset of "KQkq", or "-"
	ep       int    // en passant target square, or -1
	half     int
	full     int
}

type chessMove struct {
	from, to   int
	piece      byte
	captured   byte
	promotion  byte // 'q', 'r', 'b', 'n' or 0
	castle     byte // 'k', 'q' or 0
	enPassant  bool
	doublePush bool
}

func squareIndex(name string) int {
	return strings.IndexByte(files, name[0]) + (8-int(name[1]-'0'))*8
}

func squareName(index int) string {
	return string(files[index&7]) + strconv.Itoa(8-index>>3)
}

func isWhitePiece(piece byte) bool { return piece != 0 && piece < 'a' }

func lower(piece byte) byte {
	if piece >= 'A' && piece <= 'Z' {
		return piece + 'a' - 'A'
	}
	return piece
}

func otherSide(turn byte) byte {
	if turn == 'w' {
		return 'b'
	}
	return 'w'
}

// ---------------------------------------------------------------- FEN ------

func cleanCastling(board *[64]byte, castling string) string {
	out := ""
	if strings.Contains(castling, "K") && board[60] == 'K' && board[63] == 'R' {
		out += "K"
	}
	if strings.Contains(castling, "Q") && board[60] == 'K' && board[56] == 'R' {
		out += "Q"
	}
	if strings.Contains(castling, "k") && board[4] == 'k' && board[7] == 'r' {
		out += "k"
	}
	if strings.Contains(castling, "q") && board[4] == 'k' && board[0] == 'r' {
		out += "q"
	}
	if out == "" {
		return "-"
	}
	return out
}

// An en passant target only counts when the pawn that just made the double
// step is really there.
func cleanEp(board *[64]byte, turn byte, ep int) int {
	if ep < 0 {
		return -1
	}
	row := ep >> 3
	if turn == 'w' {
		if row != 2 || board[ep] != 0 || board[ep+8] != 'p' || board[ep-8] != 0 {
			return -1
		}
	} else if row != 5 || board[ep] != 0 || board[ep-8] != 'P' || board[ep+8] != 0 {
		return -1
	}
	return ep
}

func parseFEN(fen string) (position, error) {
	var p position
	parts := strings.Fields(fen)
	if len(parts) < 4 || len(parts) > 6 {
		return p, errors.New("FEN needs 4 to 6 fields")
	}
	rows := strings.Split(parts[0], "/")
	if len(rows) != 8 {
		return p, errors.New("FEN board needs 8 ranks")
	}
	index := 0
	for _, row := range rows {
		count := 0
		for i := 0; i < len(row); i++ {
			c := row[i]
			switch {
			case c >= '1' && c <= '8':
				count += int(c - '0')
				if count > 8 {
					return p, errors.New("each FEN rank must describe 8 squares")
				}
				index += int(c - '0')
			case strings.IndexByte("PNBRQKpnbrqk", c) >= 0:
				count++
				if count > 8 {
					return p, errors.New("each FEN rank must describe 8 squares")
				}
				p.board[index] = c
				index++
			default:
				return p, errors.New("FEN has an invalid piece letter")
			}
		}
		if count != 8 {
			return p, errors.New("each FEN rank must describe 8 squares")
		}
	}
	if parts[1] != "w" && parts[1] != "b" {
		return p, errors.New("FEN side to move must be w or b")
	}
	if parts[2] != "-" {
		for _, c := range parts[2] {
			if !strings.ContainsRune("KQkq", c) {
				return p, errors.New("FEN castling field is invalid")
			}
		}
	}
	ep := -1
	if parts[3] != "-" {
		if len(parts[3]) != 2 || parts[3][0] < 'a' || parts[3][0] > 'h' || (parts[3][1] != '3' && parts[3][1] != '6') {
			return p, errors.New("FEN en passant field is invalid")
		}
		ep = squareIndex(parts[3])
	}
	whiteKings, blackKings := 0, 0
	for i, piece := range p.board {
		switch {
		case piece == 'K':
			whiteKings++
		case piece == 'k':
			blackKings++
		case (piece == 'P' || piece == 'p') && (i < 8 || i >= 56):
			return p, errors.New("FEN has a pawn on the first or last rank")
		}
	}
	if whiteKings != 1 || blackKings != 1 {
		return p, errors.New("FEN needs exactly one king per side")
	}
	p.turn = parts[1][0]
	p.castling = cleanCastling(&p.board, parts[2])
	p.ep = cleanEp(&p.board, p.turn, ep)
	p.half, p.full = 0, 1
	if len(parts) > 4 {
		if n, err := strconv.Atoi(parts[4]); err == nil && n >= 0 {
			p.half = n
		}
	}
	if len(parts) > 5 {
		if n, err := strconv.Atoi(parts[5]); err == nil && n >= 1 {
			p.full = n
		}
	}
	if p.inCheck(otherSide(p.turn)) {
		return p, errors.New("FEN is illegal: the side that just moved is still in check")
	}
	return p, nil
}

func (p *position) boardFEN() string {
	var out strings.Builder
	for row := 0; row < 8; row++ {
		empty := 0
		for col := 0; col < 8; col++ {
			piece := p.board[row*8+col]
			if piece == 0 {
				empty++
				continue
			}
			if empty > 0 {
				out.WriteByte(byte('0' + empty))
				empty = 0
			}
			out.WriteByte(piece)
		}
		if empty > 0 {
			out.WriteByte(byte('0' + empty))
		}
		if row < 7 {
			out.WriteByte('/')
		}
	}
	return out.String()
}

// fen writes the en passant square only when a legal en passant capture
// exists (as python-chess, Lichess and chesslib.js do).
func (p *position) fen() string {
	ep := "-"
	if p.hasLegalEnPassant() {
		ep = squareName(p.ep)
	}
	return p.boardFEN() + " " + string(p.turn) + " " + p.castling + " " + ep + " " + strconv.Itoa(p.half) + " " + strconv.Itoa(p.full)
}

// key identifies a position: board, side to move, castling rights and the
// (legal-only) en passant square.
func (p *position) key() string {
	fields := strings.Fields(p.fen())
	return strings.Join(fields[:4], " ")
}

func (p *position) hasLegalEnPassant() bool {
	if p.ep < 0 {
		return false
	}
	for _, move := range p.legalMoves() {
		if move.enPassant {
			return true
		}
	}
	return false
}

// ------------------------------------------------------------ attacks ------

func attacked(board *[64]byte, square int, byWhite bool) bool {
	row, col := square>>3, square&7
	pawn, knight, king, rook, bishop, queen := byte('p'), byte('n'), byte('k'), byte('r'), byte('b'), byte('q')
	pawnRow := row - 1
	if byWhite {
		pawn, knight, king, rook, bishop, queen = 'P', 'N', 'K', 'R', 'B', 'Q'
		pawnRow = row + 1
	}
	if pawnRow >= 0 && pawnRow < 8 {
		if col > 0 && board[pawnRow*8+col-1] == pawn {
			return true
		}
		if col < 7 && board[pawnRow*8+col+1] == pawn {
			return true
		}
	}
	for _, step := range knightSteps {
		r, c := row+step[0], col+step[1]
		if r >= 0 && r < 8 && c >= 0 && c < 8 && board[r*8+c] == knight {
			return true
		}
	}
	for _, step := range kingSteps {
		r, c := row+step[0], col+step[1]
		if r >= 0 && r < 8 && c >= 0 && c < 8 && board[r*8+c] == king {
			return true
		}
	}
	for _, dir := range rookDirs {
		for r, c := row+dir[0], col+dir[1]; r >= 0 && r < 8 && c >= 0 && c < 8; r, c = r+dir[0], c+dir[1] {
			if piece := board[r*8+c]; piece != 0 {
				if piece == rook || piece == queen {
					return true
				}
				break
			}
		}
	}
	for _, dir := range bishopDirs {
		for r, c := row+dir[0], col+dir[1]; r >= 0 && r < 8 && c >= 0 && c < 8; r, c = r+dir[0], c+dir[1] {
			if piece := board[r*8+c]; piece != 0 {
				if piece == bishop || piece == queen {
					return true
				}
				break
			}
		}
	}
	return false
}

func (p *position) inCheck(color byte) bool {
	king := byte('k')
	if color == 'w' {
		king = 'K'
	}
	for i, piece := range p.board {
		if piece == king {
			return attacked(&p.board, i, color != 'w')
		}
	}
	return false
}

// ------------------------------------------------------ move generation ----

func (p *position) pseudoMoves() []chessMove {
	board := &p.board
	whiteToMove := p.turn == 'w'
	moves := make([]chessMove, 0, 48)
	push := func(from, to int, extra chessMove) {
		extra.from, extra.to, extra.piece = from, to, board[from]
		if extra.captured == 0 {
			extra.captured = board[to]
		}
		moves = append(moves, extra)
	}
	for from := 0; from < 64; from++ {
		piece := board[from]
		if piece == 0 || isWhitePiece(piece) != whiteToMove {
			continue
		}
		row, col := from>>3, from&7
		switch lower(piece) {
		case 'p':
			dir, startRow, lastRow := 1, 1, 7
			if whiteToMove {
				dir, startRow, lastRow = -1, 6, 0
			}
			oneRow := row + dir
			addPawn := func(to int, extra chessMove) {
				if to>>3 == lastRow {
					for _, promotion := range []byte{'q', 'r', 'b', 'n'} {
						withPromotion := extra
						withPromotion.promotion = promotion
						push(from, to, withPromotion)
					}
				} else {
					push(from, to, extra)
				}
			}
			if board[oneRow*8+col] == 0 {
				addPawn(oneRow*8+col, chessMove{})
				if row == startRow && board[(row+2*dir)*8+col] == 0 {
					push(from, (row+2*dir)*8+col, chessMove{doublePush: true})
				}
			}
			for _, dc := range []int{-1, 1} {
				c := col + dc
				if c < 0 || c > 7 {
					continue
				}
				to := oneRow*8 + c
				target := board[to]
				if target != 0 && isWhitePiece(target) != whiteToMove {
					addPawn(to, chessMove{})
				} else if target == 0 && to == p.ep {
					captured := byte('p')
					if !whiteToMove {
						captured = 'P'
					}
					push(from, to, chessMove{enPassant: true, captured: captured})
				}
			}
		case 'n', 'k':
			steps := knightSteps
			if lower(piece) == 'k' {
				steps = kingSteps
			}
			for _, step := range steps {
				r, c := row+step[0], col+step[1]
				if r < 0 || r > 7 || c < 0 || c > 7 {
					continue
				}
				if target := board[r*8+c]; target == 0 || isWhitePiece(target) != whiteToMove {
					push(from, r*8+c, chessMove{})
				}
			}
			if lower(piece) == 'k' {
				home := 4
				kingSide, queenSide := "k", "q"
				if whiteToMove {
					home, kingSide, queenSide = 60, "K", "Q"
				}
				if from == home && !attacked(board, home, !whiteToMove) {
					if strings.Contains(p.castling, kingSide) && board[home+1] == 0 && board[home+2] == 0 &&
						!attacked(board, home+1, !whiteToMove) && !attacked(board, home+2, !whiteToMove) {
						push(from, home+2, chessMove{castle: 'k'})
					}
					if strings.Contains(p.castling, queenSide) && board[home-1] == 0 && board[home-2] == 0 && board[home-3] == 0 &&
						!attacked(board, home-1, !whiteToMove) && !attacked(board, home-2, !whiteToMove) {
						push(from, home-2, chessMove{castle: 'q'})
					}
				}
			}
		default:
			var dirs [][2]int
			switch lower(piece) {
			case 'r':
				dirs = rookDirs[:]
			case 'b':
				dirs = bishopDirs[:]
			default:
				dirs = append(append([][2]int{}, rookDirs[:]...), bishopDirs[:]...)
			}
			for _, dir := range dirs {
				for r, c := row+dir[0], col+dir[1]; r >= 0 && r < 8 && c >= 0 && c < 8; r, c = r+dir[0], c+dir[1] {
					target := board[r*8+c]
					if target == 0 {
						push(from, r*8+c, chessMove{})
						continue
					}
					if isWhitePiece(target) != whiteToMove {
						push(from, r*8+c, chessMove{})
					}
					break
				}
			}
		}
	}
	return moves
}

func applyToBoard(board [64]byte, move chessMove) [64]byte {
	piece := board[move.from]
	board[move.from] = 0
	if move.promotion != 0 {
		if isWhitePiece(piece) {
			board[move.to] = move.promotion - 'a' + 'A'
		} else {
			board[move.to] = move.promotion
		}
	} else {
		board[move.to] = piece
	}
	if move.enPassant {
		board[(move.from>>3)*8+(move.to&7)] = 0
	}
	if move.castle != 0 {
		row := move.from >> 3
		rookFrom, rookTo := row*8, row*8+3
		if move.castle == 'k' {
			rookFrom, rookTo = row*8+7, row*8+5
		}
		board[rookTo] = board[rookFrom]
		board[rookFrom] = 0
	}
	return board
}

func (p *position) legalMoves() []chessMove {
	king := byte('k')
	if p.turn == 'w' {
		king = 'K'
	}
	legal := make([]chessMove, 0, 48)
	for _, move := range p.pseudoMoves() {
		board := applyToBoard(p.board, move)
		for square, piece := range board {
			if piece == king {
				if !attacked(&board, square, p.turn != 'w') {
					legal = append(legal, move)
				}
				break
			}
		}
	}
	return legal
}

func (p *position) makeMove(move chessMove) position {
	next := position{board: applyToBoard(p.board, move), turn: otherSide(p.turn), ep: -1, full: p.full}
	rights := p.castling
	if rights == "-" {
		rights = ""
	}
	drop := func(letters string) {
		for _, letter := range letters {
			rights = strings.ReplaceAll(rights, string(letter), "")
		}
	}
	if move.piece == 'K' {
		drop("KQ")
	}
	if move.piece == 'k' {
		drop("kq")
	}
	for _, square := range []int{move.from, move.to} {
		switch square {
		case 63:
			drop("K")
		case 56:
			drop("Q")
		case 7:
			drop("k")
		case 0:
			drop("q")
		}
	}
	if rights == "" {
		rights = "-"
	}
	next.castling = rights
	if move.doublePush {
		next.ep = (move.from + move.to) / 2
	}
	if lower(move.piece) == 'p' || move.captured != 0 {
		next.half = 0
	} else {
		next.half = p.half + 1
	}
	if p.turn == 'b' {
		next.full++
	}
	return next
}

// uci writes a move the way the engine does; castling as the king's two-square move.
func (m chessMove) uci() string {
	out := squareName(m.from) + squareName(m.to)
	if m.promotion != 0 {
		out += string(m.promotion)
	}
	return out
}

// parseUCI finds the legal move a UCI string names. It also takes the
// "king takes own rook" castling spelling.
func (p *position) parseUCI(text string, moves []chessMove) (chessMove, bool) {
	if !uciMoveShape.MatchString(text) {
		return chessMove{}, false
	}
	from, to := squareIndex(text[0:2]), squareIndex(text[2:4])
	var promotion byte
	if len(text) == 5 {
		promotion = text[4]
	}
	piece := p.board[from]
	if (piece == 'K' || piece == 'k') && (from == 60 || from == 4) {
		rook := byte('r')
		if piece == 'K' {
			rook = 'R'
		}
		if p.board[to] == rook && to>>3 == from>>3 {
			if to > from {
				to = from + 2
			} else {
				to = from - 2
			}
		}
	}
	if moves == nil {
		moves = p.legalMoves()
	}
	for _, move := range moves {
		if move.from == from && move.to == to && move.promotion == promotion {
			return move, true
		}
	}
	return chessMove{}, false
}

func (p *position) isCheckmate(moves []chessMove) bool {
	return len(moves) == 0 && p.inCheck(p.turn)
}

func perft(p position, depth int) int {
	if depth == 0 {
		return 1
	}
	moves := p.legalMoves()
	if depth == 1 {
		return len(moves)
	}
	nodes := 0
	for _, move := range moves {
		nodes += perft(p.makeMove(move), depth-1)
	}
	return nodes
}

func upper(piece byte) byte {
	if piece >= 'a' && piece <= 'z' {
		return piece - 'a' + 'A'
	}
	return piece
}

// sanWithoutSuffix writes a move in standard algebraic notation, without
// the + or # (chesslib.js sanWithoutSuffix).
func (p *position) sanWithoutSuffix(move chessMove, moves []chessMove) string {
	switch move.castle {
	case 'k':
		return "O-O"
	case 'q':
		return "O-O-O"
	}
	destination := squareName(move.to)
	if lower(move.piece) == 'p' {
		out := ""
		if move.captured != 0 {
			out = string(files[move.from&7]) + "x"
		}
		out += destination
		if move.promotion != 0 {
			out += "=" + string(upper(move.promotion))
		}
		return out
	}
	sameFile, sameRank, ambiguous := false, false, false
	for _, other := range moves {
		if other.from == move.from || other.to != move.to || other.piece != move.piece {
			continue
		}
		ambiguous = true
		if other.from&7 == move.from&7 {
			sameFile = true
		}
		if other.from>>3 == move.from>>3 {
			sameRank = true
		}
	}
	origin := ""
	if ambiguous {
		switch {
		case !sameFile:
			origin = string(files[move.from&7])
		case !sameRank:
			origin = strconv.Itoa(8 - move.from>>3)
		default:
			origin = squareName(move.from)
		}
	}
	capture := ""
	if move.captured != 0 {
		capture = "x"
	}
	return string(upper(move.piece)) + origin + capture + destination
}

// parseSAN finds the legal move a SAN string names ("0-0" and a trailing
// +, #, ! or ? are taken too).
func (p *position) parseSAN(text string, moves []chessMove) (chessMove, bool) {
	wanted := strings.TrimRight(strings.ReplaceAll(strings.TrimSpace(text), "0", "O"), "+#!?")
	if wanted == "" {
		return chessMove{}, false
	}
	if moves == nil {
		moves = p.legalMoves()
	}
	for _, move := range moves {
		if p.sanWithoutSuffix(move, moves) == wanted {
			return move, true
		}
	}
	return chessMove{}, false
}

// replaySAN turns SAN moves from the starting position into UCI moves; ok
// is false at the first move that is not legal.
func replaySAN(sanMoves []string) ([]string, bool) {
	p, _ := parseFEN(startFEN)
	out := make([]string, 0, len(sanMoves))
	for _, text := range sanMoves {
		moves := p.legalMoves()
		move, ok := p.parseSAN(text, moves)
		if !ok {
			return out, false
		}
		out = append(out, move.uci())
		p = p.makeMove(move)
	}
	return out, true
}

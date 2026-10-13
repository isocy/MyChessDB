package main

import "testing"

// The same published perft counts web/chesslib.js is checked against.
func TestPerft(t *testing.T) {
	cases := []struct {
		fen    string
		counts []int
	}{
		{startFEN, []int{20, 400, 8902, 197281}},
		{"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", []int{48, 2039, 97862}},
		{"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", []int{14, 191, 2812, 43238}},
		{"r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", []int{6, 264, 9467}},
		{"rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", []int{44, 1486, 62379}},
		{"r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", []int{46, 2079, 89890}},
	}
	for _, c := range cases {
		p, err := parseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: %v", c.fen, err)
		}
		for depth, want := range c.counts {
			if got := perft(p, depth+1); got != want {
				t.Fatalf("perft(%d) of %s = %d, want %d", depth+1, c.fen, got, want)
			}
		}
	}
}

func TestFENAndMoves(t *testing.T) {
	p, _ := parseFEN(startFEN)
	if p.fen() != startFEN {
		t.Fatalf("round trip: %s", p.fen())
	}
	// The en passant square is only written when the capture is legal.
	after, _ := parseFEN("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1")
	if after.key() != "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -" {
		t.Fatalf("key: %s", after.key())
	}
	withCapture, _ := parseFEN("rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3")
	if withCapture.key() != "rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3" {
		t.Fatalf("key with a legal capture: %s", withCapture.key())
	}
	for _, bad := range []string{"", "8/8/8/8/8/8/8/8 w - - 0 1", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1",
		"4k3/8/8/8/8/8/4R3/4K3 w - - 0 1", "Pnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR w KQkq - 0 1"} {
		if _, err := parseFEN(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	// Castling, also written as king takes rook, and promotion.
	castle, _ := parseFEN("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
	for _, text := range []string{"e1g1", "e1h1"} {
		move, ok := castle.parseUCI(text, nil)
		if !ok || move.castle != 'k' || move.uci() != "e1g1" {
			t.Fatalf("%s: %+v", text, move)
		}
	}
	promote, _ := parseFEN("8/P5k1/8/8/8/8/6K1/8 w - - 0 1")
	if move, ok := promote.parseUCI("a7a8n", nil); !ok || promote.makeMove(move).board[0] != 'N' {
		t.Fatal("underpromotion")
	}
	if _, ok := promote.parseUCI("a7a8", nil); ok {
		t.Fatal("a promotion needs its piece")
	}
	mate, _ := parseFEN("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")
	if !mate.isCheckmate(mate.legalMoves()) {
		t.Fatal("fool's mate")
	}
}

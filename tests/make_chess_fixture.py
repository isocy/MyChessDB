"""Generate reference data from python-chess for tests/chesslib.test.mjs.

Dev-only. Needs python-chess (the same library the original app.py used):

    python tests/make_chess_fixture.py > tests/chess_fixture.json
"""
import json
import random
import sys

import chess


def key(board: chess.Board) -> str:
    return " ".join(board.fen().split()[:4])


def main() -> None:
    rng = random.Random(20261005)
    plies = []
    starts = [
        chess.STARTING_FEN,
        "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
        "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
        "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
        "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
        "4k3/1P4P1/8/8/8/8/1p4p1/4K3 w - - 0 1",
    ]
    for game in range(400):
        board = chess.Board(starts[game % len(starts)] if game % 3 else chess.STARTING_FEN)
        for _ in range(rng.randint(10, 140)):
            moves = list(board.legal_moves)
            if not moves:
                break
            # Bias towards the interesting cases so they are well covered.
            special = [m for m in moves if board.is_castling(m) or board.is_en_passant(m) or m.promotion]
            move = rng.choice(special) if special and rng.random() < 0.5 else rng.choice(moves)
            record = {
                "fen": board.fen(),
                # Same position written with the "always show the en passant
                # square" convention the board UI uses.
                "fen_ep_always": board.fen(en_passant="fen"),
                "uci": move.uci(),
                # Lichess spells castling as king-takes-rook.
                "uci960": board.uci(move, chess960=True),
                "san": board.san(move),
                "legal": sorted(m.uci() for m in moves),
                "key": key(board),
            }
            board.push(move)
            record["fen_after"] = board.fen()
            record["key_after"] = key(board)
            plies.append(record)
    json.dump(plies, sys.stdout)


if __name__ == "__main__":
    main()

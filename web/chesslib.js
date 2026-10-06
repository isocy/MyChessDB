// chesslib.js - dependency-free chess rules shared by the site and the API.
//
// Squares are indexed 0..63 with 0 = a8 and 63 = h1 (row * 8 + column, row 0
// is rank 8), the same convention the board in index.html uses. Pieces are
// FEN letters ("P" white pawn, "k" black king, "" empty).
//
// Everything here is a pure function of its arguments so the same file can be
// loaded by the browser (<script type="module">) and imported by the Worker.

const FILES = "abcdefgh";
const KNIGHT_STEPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING_STEPS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const ROOK_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function squareIndex(name) {
  return FILES.indexOf(name[0]) + (8 - Number(name[1])) * 8;
}

export function squareName(index) {
  return FILES[index & 7] + (8 - (index >> 3));
}

function isWhite(piece) {
  return piece !== "" && piece < "a";
}

function colorOf(piece) {
  return isWhite(piece) ? "w" : "b";
}

// ---------------------------------------------------------------- FEN ------

function cleanCastling(board, castling) {
  let out = "";
  if (castling.includes("K") && board[60] === "K" && board[63] === "R") out += "K";
  if (castling.includes("Q") && board[60] === "K" && board[56] === "R") out += "Q";
  if (castling.includes("k") && board[4] === "k" && board[7] === "r") out += "k";
  if (castling.includes("q") && board[4] === "k" && board[0] === "r") out += "q";
  return out || "-";
}

// An en passant target only means something when the pawn that just made the
// double step is really there. Anything else is treated as "no target".
function cleanEp(board, turn, ep) {
  if (ep < 0) return -1;
  const row = ep >> 3;
  if (turn === "w") {
    if (row !== 2 || board[ep] !== "" || board[ep + 8] !== "p" || board[ep - 8] !== "") return -1;
  } else {
    if (row !== 5 || board[ep] !== "" || board[ep - 8] !== "P" || board[ep + 8] !== "") return -1;
  }
  return ep;
}

/** Parse a FEN string. Throws an Error describing the first problem found. */
export function parseFen(fen) {
  if (typeof fen !== "string") throw new Error("FEN must be text");
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4 || parts.length > 6) throw new Error("FEN needs 4 to 6 fields");
  const rows = parts[0].split("/");
  if (rows.length !== 8) throw new Error("FEN board needs 8 ranks");
  const board = [];
  for (const row of rows) {
    let count = 0;
    for (const c of row) {
      if (c >= "1" && c <= "8") {
        for (let k = 0; k < Number(c); k++) board.push("");
        count += Number(c);
      } else if ("PNBRQKpnbrqk".includes(c)) {
        board.push(c);
        count++;
      } else {
        throw new Error(`FEN has an invalid piece letter: ${c}`);
      }
    }
    if (count !== 8) throw new Error("Each FEN rank must describe 8 squares");
  }
  if (parts[1] !== "w" && parts[1] !== "b") throw new Error("FEN side to move must be w or b");
  if (parts[2] !== "-" && !/^K?Q?k?q?$/.test(parts[2])) throw new Error("FEN castling field is invalid");
  if (parts[2] === "") throw new Error("FEN castling field is invalid");
  if (!/^(-|[a-h][36])$/.test(parts[3])) throw new Error("FEN en passant field is invalid");
  let whiteKings = 0, blackKings = 0;
  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (piece === "K") whiteKings++;
    else if (piece === "k") blackKings++;
    else if ((piece === "P" || piece === "p") && (i < 8 || i >= 56)) {
      throw new Error("FEN has a pawn on the first or last rank");
    }
  }
  if (whiteKings !== 1 || blackKings !== 1) throw new Error("FEN needs exactly one king per side");
  const half = /^\d+$/.test(parts[4] || "") ? Number(parts[4]) : 0;
  const full = /^\d+$/.test(parts[5] || "") ? Math.max(1, Number(parts[5])) : 1;
  const turn = parts[1];
  const position = {
    board,
    turn,
    castling: cleanCastling(board, parts[2]),
    ep: cleanEp(board, turn, parts[3] === "-" ? -1 : squareIndex(parts[3])),
    half,
    full,
  };
  if (inCheck(position, turn === "w" ? "b" : "w")) {
    throw new Error("FEN is illegal: the side that just moved is still in check");
  }
  return position;
}

function boardFen(board) {
  let out = "";
  for (let row = 0; row < 8; row++) {
    let empty = 0;
    for (let col = 0; col < 8; col++) {
      const piece = board[row * 8 + col];
      if (!piece) { empty++; continue; }
      if (empty) { out += empty; empty = 0; }
      out += piece;
    }
    if (empty) out += empty;
    if (row < 7) out += "/";
  }
  return out;
}

/** True when the side to move has a fully legal en passant capture. */
function hasLegalEnPassant(position) {
  if (position.ep < 0) return false;
  return legalMoves(position).some(move => move.enPassant);
}

/**
 * Serialise a position. The en passant square is only written when a legal
 * en passant capture exists (the convention python-chess and Lichess use), so
 * the same position always produces the same text.
 */
export function toFen(position) {
  const ep = hasLegalEnPassant(position) ? squareName(position.ep) : "-";
  return `${boardFen(position.board)} ${position.turn} ${position.castling} ${ep} ${position.half} ${position.full}`;
}

/**
 * Identity of a position for storage and lookup: board, side to move,
 * castling rights and (legal-only) en passant square. Move counters are
 * ignored. Falls back to the raw first four fields for text that is not a
 * valid position, so callers never throw.
 */
export function positionKey(fen) {
  try {
    return toFen(parseFen(fen)).split(" ").slice(0, 4).join(" ");
  } catch (error) {
    return String(fen).trim().split(/\s+/).slice(0, 4).join(" ");
  }
}

// ------------------------------------------------------------ attacks ------

function attacked(board, square, byWhite) {
  const row = square >> 3, col = square & 7;
  const pawn = byWhite ? "P" : "p", knight = byWhite ? "N" : "n", king = byWhite ? "K" : "k";
  const rook = byWhite ? "R" : "r", bishop = byWhite ? "B" : "b", queen = byWhite ? "Q" : "q";
  const pawnRow = row + (byWhite ? 1 : -1);
  if (pawnRow >= 0 && pawnRow < 8) {
    if (col > 0 && board[pawnRow * 8 + col - 1] === pawn) return true;
    if (col < 7 && board[pawnRow * 8 + col + 1] === pawn) return true;
  }
  for (const [dr, dc] of KNIGHT_STEPS) {
    const r = row + dr, c = col + dc;
    if (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r * 8 + c] === knight) return true;
  }
  for (const [dr, dc] of KING_STEPS) {
    const r = row + dr, c = col + dc;
    if (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r * 8 + c] === king) return true;
  }
  for (const [dr, dc] of ROOK_DIRS) {
    for (let r = row + dr, c = col + dc; r >= 0 && r < 8 && c >= 0 && c < 8; r += dr, c += dc) {
      const piece = board[r * 8 + c];
      if (piece) { if (piece === rook || piece === queen) return true; break; }
    }
  }
  for (const [dr, dc] of BISHOP_DIRS) {
    for (let r = row + dr, c = col + dc; r >= 0 && r < 8 && c >= 0 && c < 8; r += dr, c += dc) {
      const piece = board[r * 8 + c];
      if (piece) { if (piece === bishop || piece === queen) return true; break; }
    }
  }
  return false;
}

/** Is `color`'s king attacked in this position? */
export function inCheck(position, color = position.turn) {
  const king = position.board.indexOf(color === "w" ? "K" : "k");
  return king >= 0 && attacked(position.board, king, color !== "w");
}

// ------------------------------------------------------ move generation ----

function pseudoMoves(position) {
  const { board, turn } = position;
  const whiteToMove = turn === "w";
  const moves = [];
  const push = (from, to, extra) => moves.push({ from, to, piece: board[from], captured: board[to], ...extra });
  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (!piece || isWhite(piece) !== whiteToMove) continue;
    const row = from >> 3, col = from & 7;
    const type = piece.toLowerCase();
    if (type === "p") {
      const dir = whiteToMove ? -1 : 1, startRow = whiteToMove ? 6 : 1, lastRow = whiteToMove ? 0 : 7;
      const oneRow = row + dir;
      const addPawn = (to, extra) => {
        if ((to >> 3) === lastRow) {
          for (const promotion of ["q", "r", "b", "n"]) push(from, to, { ...extra, promotion });
        } else {
          push(from, to, extra);
        }
      };
      if (!board[oneRow * 8 + col]) {
        addPawn(oneRow * 8 + col);
        if (row === startRow && !board[(row + 2 * dir) * 8 + col]) push(from, (row + 2 * dir) * 8 + col, { doublePush: true });
      }
      for (const dc of [-1, 1]) {
        const c = col + dc;
        if (c < 0 || c > 7) continue;
        const to = oneRow * 8 + c;
        const target = board[to];
        if (target && isWhite(target) !== whiteToMove) addPawn(to);
        else if (!target && to === position.ep) push(from, to, { enPassant: true, captured: whiteToMove ? "p" : "P" });
      }
      continue;
    }
    if (type === "n" || type === "k") {
      for (const [dr, dc] of type === "n" ? KNIGHT_STEPS : KING_STEPS) {
        const r = row + dr, c = col + dc;
        if (r < 0 || r > 7 || c < 0 || c > 7) continue;
        const target = board[r * 8 + c];
        if (!target || isWhite(target) !== whiteToMove) push(from, r * 8 + c);
      }
      if (type === "k") {
        const home = whiteToMove ? 60 : 4;
        if (from === home && !attacked(board, home, !whiteToMove)) {
          const kingSide = whiteToMove ? "K" : "k", queenSide = whiteToMove ? "Q" : "q";
          if (position.castling.includes(kingSide) && !board[home + 1] && !board[home + 2] &&
              !attacked(board, home + 1, !whiteToMove) && !attacked(board, home + 2, !whiteToMove)) {
            push(from, home + 2, { castle: "k" });
          }
          if (position.castling.includes(queenSide) && !board[home - 1] && !board[home - 2] && !board[home - 3] &&
              !attacked(board, home - 1, !whiteToMove) && !attacked(board, home - 2, !whiteToMove)) {
            push(from, home - 2, { castle: "q" });
          }
        }
      }
      continue;
    }
    const dirs = type === "r" ? ROOK_DIRS : type === "b" ? BISHOP_DIRS : ROOK_DIRS.concat(BISHOP_DIRS);
    for (const [dr, dc] of dirs) {
      for (let r = row + dr, c = col + dc; r >= 0 && r < 8 && c >= 0 && c < 8; r += dr, c += dc) {
        const target = board[r * 8 + c];
        if (!target) { push(from, r * 8 + c); continue; }
        if (isWhite(target) !== whiteToMove) push(from, r * 8 + c);
        break;
      }
    }
  }
  return moves;
}

function applyToBoard(board, move) {
  const next = board.slice();
  const piece = next[move.from];
  next[move.from] = "";
  next[move.to] = move.promotion
    ? (isWhite(piece) ? move.promotion.toUpperCase() : move.promotion)
    : piece;
  if (move.enPassant) next[(move.from >> 3) * 8 + (move.to & 7)] = "";
  if (move.castle) {
    const row = move.from >> 3;
    const rookFrom = row * 8 + (move.castle === "k" ? 7 : 0);
    const rookTo = row * 8 + (move.castle === "k" ? 5 : 3);
    next[rookTo] = next[rookFrom];
    next[rookFrom] = "";
  }
  return next;
}

/** All legal moves for the side to move. */
export function legalMoves(position) {
  const color = position.turn;
  const kingPiece = color === "w" ? "K" : "k";
  return pseudoMoves(position).filter(move => {
    const board = applyToBoard(position.board, move);
    const king = board.indexOf(kingPiece);
    return king >= 0 && !attacked(board, king, color !== "w");
  });
}

/** Return the position after `move` (one of the objects from legalMoves). */
export function makeMove(position, move) {
  const board = applyToBoard(position.board, move);
  let rights = position.castling === "-" ? "" : position.castling;
  const drop = letters => { for (const letter of letters) rights = rights.replace(letter, ""); };
  if (move.piece === "K") drop("KQ");
  if (move.piece === "k") drop("kq");
  for (const square of [move.from, move.to]) {
    if (square === 63) drop("K");
    else if (square === 56) drop("Q");
    else if (square === 7) drop("k");
    else if (square === 0) drop("q");
  }
  const pawnMove = move.piece === "P" || move.piece === "p";
  return {
    board,
    turn: position.turn === "w" ? "b" : "w",
    castling: rights || "-",
    ep: move.doublePush ? (move.from + move.to) / 2 : -1,
    half: pawnMove || move.captured ? 0 : position.half + 1,
    full: position.full + (position.turn === "b" ? 1 : 0),
  };
}

// ----------------------------------------------------------- notation ------

/** UCI text for a move. Castling is always written as the king's two-square move. */
export function moveToUci(move) {
  return squareName(move.from) + squareName(move.to) + (move.promotion || "");
}

/**
 * Find the legal move a UCI string refers to, or null. Also accepts the
 * "king takes own rook" castling spelling (e1h1) that Lichess uses.
 */
export function parseUci(position, uci, moves = legalMoves(position)) {
  if (typeof uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  const from = squareIndex(uci.slice(0, 2));
  let to = squareIndex(uci.slice(2, 4));
  const promotion = uci[4] || undefined;
  const piece = position.board[from];
  if ((piece === "K" || piece === "k") && (from === 60 || from === 4)) {
    const rook = piece === "K" ? "R" : "r";
    if (position.board[to] === rook && (to >> 3) === (from >> 3)) to = from + (to > from ? 2 : -2);
  }
  return moves.find(move => move.from === from && move.to === to && move.promotion === promotion) || null;
}

function sanWithoutSuffix(position, move, moves) {
  if (move.castle) return move.castle === "k" ? "O-O" : "O-O-O";
  const type = move.piece.toUpperCase();
  const destination = squareName(move.to);
  if (type === "P") {
    const prefix = move.captured ? FILES[move.from & 7] + "x" : "";
    return prefix + destination + (move.promotion ? "=" + move.promotion.toUpperCase() : "");
  }
  let sameFile = false, sameRank = false, ambiguous = false;
  for (const other of moves) {
    if (other.from === move.from || other.to !== move.to || other.piece !== move.piece) continue;
    ambiguous = true;
    if ((other.from & 7) === (move.from & 7)) sameFile = true;
    if ((other.from >> 3) === (move.from >> 3)) sameRank = true;
  }
  let origin = "";
  if (ambiguous) {
    if (!sameFile) origin = FILES[move.from & 7];
    else if (!sameRank) origin = String(8 - (move.from >> 3));
    else origin = squareName(move.from);
  }
  return type + origin + (move.captured ? "x" : "") + destination;
}

/** Standard algebraic notation for a legal move, including + or #. */
export function moveToSan(position, move, moves = legalMoves(position)) {
  const base = sanWithoutSuffix(position, move, moves);
  const next = makeMove(position, move);
  if (!inCheck(next)) return base;
  return base + (legalMoves(next).length ? "+" : "#");
}

/** Find the legal move a SAN string refers to, or null. */
export function parseSan(position, san, moves = legalMoves(position)) {
  if (typeof san !== "string") return null;
  const wanted = san.trim().replace(/0/g, "O").replace(/[+#!?]+$/g, "");
  if (!wanted) return null;
  return moves.find(move => sanWithoutSuffix(position, move, moves) === wanted) || null;
}

/**
 * Replay UCI moves from `fen`. Stops at the first move that is not legal.
 * Returns the SAN and normalised UCI of the moves that were legal, the
 * position reached, and whether every move was accepted.
 */
export function replayUci(fen, uciMoves) {
  let position = parseFen(fen);
  const san = [], uci = [], keys = [];
  let complete = true;
  for (const text of uciMoves) {
    const moves = legalMoves(position);
    const move = parseUci(position, text, moves);
    if (!move) { complete = false; break; }
    san.push(moveToSan(position, move, moves));
    uci.push(moveToUci(move));
    position = makeMove(position, move);
    keys.push(toFen(position).split(" ").slice(0, 4).join(" "));
  }
  return { san, uci, keys, position, complete };
}

/** Replay SAN moves from `fen`; same result shape as replayUci. */
export function replaySan(fen, sanMoves) {
  let position = parseFen(fen);
  const san = [], uci = [], keys = [];
  let complete = true;
  for (const text of sanMoves) {
    const moves = legalMoves(position);
    const move = parseSan(position, text, moves);
    if (!move) { complete = false; break; }
    san.push(moveToSan(position, move, moves));
    uci.push(moveToUci(move));
    position = makeMove(position, move);
    keys.push(toFen(position).split(" ").slice(0, 4).join(" "));
  }
  return { san, uci, keys, position, complete };
}

// A move that looks right without proving it is legal: the mover owns the
// piece and is not landing on its own piece or a king. Used only for the tail
// of a principal variation, where full legality checking would cost too much
// CPU on the server. Readers still replay the line with replayUci(), which
// stops at the first illegal move.
function plausibleMove(position, uci) {
  if (typeof uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  const { board, turn } = position;
  const from = squareIndex(uci.slice(0, 2));
  let to = squareIndex(uci.slice(2, 4));
  const promotion = uci[4] || undefined;
  const piece = board[from];
  if (!piece || colorOf(piece) !== turn || from === to) return null;
  const type = piece.toLowerCase();
  const move = { from, to, piece, captured: "" };
  if (type === "k" && (from === 60 || from === 4) && (to >> 3) === (from >> 3)) {
    const ownRook = turn === "w" ? "R" : "r";
    const corner = (to & 7) === 0 || (to & 7) === 7;
    const side = (corner && board[to] === ownRook) || Math.abs(to - from) === 2
      ? (to > from ? "k" : "q") : null;
    if (side) {
      const rookFrom = (from >> 3) * 8 + (side === "k" ? 7 : 0);
      if (board[rookFrom] !== ownRook) return null;
      to = from + (side === "k" ? 2 : -2);
      if (board[to]) return null;
      return promotion ? null : { ...move, to, castle: side };
    }
  }
  const target = board[to];
  if (target && (colorOf(target) === turn || target.toLowerCase() === "k")) return null;
  move.captured = target;
  if (type === "p") {
    const lastRow = turn === "w" ? 0 : 7;
    if (((to >> 3) === lastRow) !== Boolean(promotion)) return null;
    if (promotion) move.promotion = promotion;
    if ((from & 7) !== (to & 7) && !target) {
      if (to !== position.ep) return null;
      move.enPassant = true;
      move.captured = turn === "w" ? "p" : "P";
    }
    if (Math.abs((to >> 3) - (from >> 3)) === 2) move.doublePush = true;
  } else if (promotion) {
    return null;
  }
  return move;
}

/**
 * Clean a principal variation cheaply. The first move must be fully legal
 * (otherwise the result is empty); later moves are kept while they stay
 * plausible. Castling is rewritten to the standard king-two-squares form.
 */
export function sanitizeUciLine(position, uciMoves, maxPlies = 60) {
  const out = [];
  if (!Array.isArray(uciMoves) || !uciMoves.length) return out;
  const first = parseUci(position, uciMoves[0]);
  if (!first) return out;
  out.push(moveToUci(first));
  let current = makeMove(position, first);
  for (let i = 1; i < uciMoves.length && out.length < maxPlies; i++) {
    const move = plausibleMove(current, uciMoves[i]);
    if (!move) break;
    out.push(moveToUci(move));
    current = makeMove(current, move);
  }
  return out;
}

/** "1. e4 e5 2. Nf3" for SAN moves that start from the initial position. */
export function formatSanLine(sanMoves) {
  const out = [];
  for (let ply = 0; ply < sanMoves.length; ply += 2) {
    const number = ply / 2 + 1;
    out.push(ply + 1 < sanMoves.length
      ? `${number}. ${sanMoves[ply]} ${sanMoves[ply + 1]}`
      : `${number}. ${sanMoves[ply]}`);
  }
  return out.join(" ");
}

/** Count leaf positions `depth` plies deep; used by the tests to prove the rules. */
export function perft(position, depth) {
  if (depth === 0) return 1;
  const moves = legalMoves(position);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const move of moves) nodes += perft(makeMove(position, move), depth - 1);
  return nodes;
}

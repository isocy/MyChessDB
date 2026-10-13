// puzzleboard.js - the board of the puzzle view. It looks and handles like
// the best-move board in app.js (the same squares, move marks, dragging and
// right-click arrows and circles), but only proposes a move (onMove): the
// puzzle decides what is shown. Squares are numbered as in chesslib.js
// (0 = a8, 63 = h1).
import { legalMoves, moveToUci, inCheck, squareName } from "./chesslib.js";

export function pieceImageUrl(piece) {
  return `https://raw.githubusercontent.com/lichess-org/lila/master/public/piece/cburnett/${piece < "a" ? "w" : "b"}${piece.toUpperCase()}.svg`;
}

// How long a piece slides (as on the best-move board).
export const MOVE_ANIMATION_MS = 180;
const DRAG_THRESHOLD_PX = 6;
const GREEN = "#24a148", RED = "#e5534b";

export class PuzzleBoard {
  // onMove(uci, {slide}): a legal move the user made (with its promotion piece).
  constructor(element, annotationLayer, { onMove }) {
    this.el = element;
    this.layer = annotationLayer;
    this.onMove = onMove;
    this.position = null;
    this.orientation = "w";
    this.lastMove = null;
    this.mark = null;          // {square, kind: "good" | "bad"}
    this.movable = false;
    this.selected = null;
    this.pointer = null;       // a press on a piece: {from, x, y, dragging, wasSelected}
    this.preview = null;
    this.promotion = null;     // {from, to, slide} while the promotion piece is chosen
    this.rendered = null;
    this.annotations = [];     // {type: "arrow" | "circle", from, to, color}
    this.annotationStart = null;
    this.el.addEventListener("pointerdown", event => this.pointerDown(event));
    this.el.addEventListener("contextmenu", event => event.preventDefault());
    window.addEventListener("pointermove", event => this.pointerMove(event));
    window.addEventListener("pointerup", event => this.pointerUp(event));
    window.addEventListener("pointercancel", () => this.cancelDrag());
    new ResizeObserver(() => this.placePromotion()).observe(this.el);
  }

  /**
   * Shows a position. animate: the pieces that moved slide from where they
   * were drawn. Arrows and circles belong to the position they were drawn
   * on, so they go.
   */
  set(position, { lastMove = null, mark = null, animate = false, movable = this.movable } = {}) {
    this.position = position;
    this.lastMove = lastMove;
    this.mark = mark;
    this.movable = movable;
    this.selected = null;
    this.promotion = null;
    this.annotations = [];
    this.annotationStart = null;
    this.cancelDrag(false);
    this.render(animate);
  }
  setOrientation(color) {
    if (color === this.orientation) return;
    this.orientation = color;
    this.render(false);
  }
  // Without drawing the board again, so that a piece that is sliding goes on.
  setMovable(movable) {
    this.movable = movable;
    if (!movable) {
      this.selected = null;
      if (this.promotion) { this.promotion = null; this.el.querySelector(".promotion")?.remove(); }
      this.cancelDrag(false);
    }
    this.updateHighlights();
  }

  ownPiece(index) {
    const piece = this.position?.board[index];
    return !!piece && (piece < "a") === (this.position.turn === "w");
  }
  movesFrom(from) {
    return this.position ? legalMoves(this.position).filter(move => move.from === from) : [];
  }
  displayIndex(index) {
    return this.orientation === "w" ? index : 63 - index;
  }

  // What the selected piece can do, the way the best-move board shows it:
  // a dot on an empty square, a ring on a piece it takes, and for castling
  // the king's and the rook's squares.
  highlights() {
    const moves = this.selected === null ? [] : this.movesFrom(this.selected);
    const castle = new Set(), legal = new Set();
    for (const move of moves) {
      if (move.castle) {
        castle.add(move.to);
        castle.add((move.to >> 3) * 8 + (move.castle === "k" ? 5 : 3));
      } else {
        legal.add(move.to);
      }
    }
    return { castle, legal };
  }

  render(animate) {
    if (!this.position) return;
    const before = this.rendered, board = this.position.board;
    this.el.replaceChildren();
    for (let display = 0; display < 64; display++) {
      const row = display >> 3, col = display & 7;
      const index = this.displayIndex(display);
      const piece = board[index], name = squareName(index);
      const square = document.createElement("button");
      square.type = "button";
      square.className = `square ${(row + col) % 2 ? "dark" : "light"}`;
      square.dataset.index = String(index);
      square.setAttribute("aria-label", `${name}${piece ? ` ${piece}` : ""}`);
      square.draggable = false;
      if (piece) {
        const image = document.createElement("img");
        image.className = "piece-image";
        image.src = pieceImageUrl(piece);
        image.alt = piece;
        image.draggable = false;
        square.appendChild(image);
      }
      if (this.mark?.square === name) {
        const badge = document.createElement("span");
        badge.className = `mark ${this.mark.kind}`;
        badge.textContent = this.mark.kind === "good" ? "✓" : "✗";
        square.appendChild(badge);
      }
      if (col === 0) square.appendChild(coordinate("rank", name[1]));
      if (row === 7) square.appendChild(coordinate("file", name[0]));
      this.el.appendChild(square);
    }
    this.updateHighlights();
    if (this.promotion) this.showPromotion();
    this.renderAnnotations();
    this.rendered = { board: board.slice(), orientation: this.orientation };
    if (animate && before && before.orientation === this.orientation) {
      this.animate(before.board, board, MOVE_ANIMATION_MS);
    }
  }

  // The marks on the squares, without drawing the board again.
  updateHighlights() {
    if (!this.position) return;
    const { castle, legal } = this.highlights();
    const last = this.lastMove ? [this.lastMove.slice(0, 2), this.lastMove.slice(2, 4)] : [];
    const checked = inCheck(this.position) ? this.position.board.indexOf(this.position.turn === "w" ? "K" : "k") : -1;
    for (const square of this.el.querySelectorAll(".square")) {
      const index = Number(square.dataset.index), piece = this.position.board[index];
      const isCastle = castle.has(index);
      square.classList.toggle("last", last.includes(squareName(index)) && !isCastle);
      square.classList.toggle("selected", this.selected === index);
      square.classList.toggle("check", index === checked);
      square.classList.toggle("legal-castle", isCastle);
      square.classList.toggle("legal-move", legal.has(index) && !piece && !isCastle);
      square.classList.toggle("legal-capture", legal.has(index) && !!piece && !isCastle);
    }
  }

  // The pieces that changed squares slide there (as on the best-move board).
  animate(before, after, duration) {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const gone = [], came = [];
    for (let i = 0; i < 64; i++) {
      if (before[i] === after[i]) continue;
      if (before[i]) gone.push({ i, piece: before[i] });
      if (after[i]) came.push({ i, piece: after[i] });
    }
    const distance = (a, b) => Math.hypot((a >> 3) - (b >> 3), (a & 7) - (b & 7));
    const take = (arrived, fits) => {
      let best = null;
      for (const left of gone) {
        if (!left.used && fits(left.piece, arrived.piece) && (!best || distance(left.i, arrived.i) < distance(best.i, arrived.i))) best = left;
      }
      if (best) best.used = true;
      return best;
    };
    const slides = [];
    for (const arrived of came) {
      const left = take(arrived, (a, b) => a === b)
        || take(arrived, (a, b) => (a < "a") === (b < "a") && (a.toLowerCase() === "p" || b.toLowerCase() === "p"));
      if (left) slides.push([left.i, arrived.i]);
    }
    const squares = new Map([...this.el.querySelectorAll(".square")].map(square => [Number(square.dataset.index), square]));
    for (const [from, to] of slides) {
      const square = squares.get(to), image = square?.querySelector(".piece-image");
      if (!image || !squares.has(from)) continue;
      const start = squares.get(from).getBoundingClientRect(), end = square.getBoundingClientRect();
      square.style.zIndex = "3";   // above the squares it passes
      image.animate([{ transform: `translate(${start.left - end.left}px,${start.top - end.top}px)` }, { transform: "none" }],
        { duration, easing: "ease-out" })
        .finished.then(() => { square.style.zIndex = ""; }, () => {});
    }
  }

  // -------------------------------------------------------- annotations ----
  // Right-click a square for a circle, right-drag for an arrow; with Ctrl
  // they are red. The same again takes it away; a left click clears them.
  annotationPoint(index) {
    const display = this.displayIndex(index);
    return { x: (display & 7) * 70 + 35, y: (display >> 3) * 70 + 35 };
  }
  renderAnnotations() {
    const layer = this.layer;
    if (!layer) return;
    layer.innerHTML = "";
    layer.setAttribute("viewBox", "0 0 560 560");
    layer.setAttribute("preserveAspectRatio", "none");
    const ns = "http://www.w3.org/2000/svg";
    for (const annotation of this.annotations) {
      const start = this.annotationPoint(annotation.from);
      const color = annotation.color || GREEN;
      if (annotation.type === "circle") {
        const circle = document.createElementNS(ns, "circle");
        circle.setAttribute("class", "annotation-circle");
        circle.setAttribute("cx", start.x); circle.setAttribute("cy", start.y); circle.setAttribute("r", "27");
        circle.setAttribute("fill", color); circle.setAttribute("fill-opacity", "0.2");
        circle.setAttribute("stroke", color);
        layer.appendChild(circle);
        continue;
      }
      const end = this.annotationPoint(annotation.to);
      const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
      if (!length) continue;
      const ux = dx / length, uy = dy / length, px = -uy, py = ux;
      // Two arrows between the same squares in opposite directions curve apart.
      const reverse = this.annotations.some(other => other.type === "arrow" && other.from === annotation.to && other.to === annotation.from);
      const bend = reverse ? 12 : 0;
      const control = { x: (start.x + end.x) / 2 + px * bend, y: (start.y + end.y) / 2 + py * bend };
      const headLength = 23, headWidth = 11;
      const lineEnd = { x: end.x - ux * headLength, y: end.y - uy * headLength };
      const path = document.createElementNS(ns, "path");
      path.setAttribute("class", "annotation-arrow");
      path.setAttribute("d", `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${lineEnd.x} ${lineEnd.y}`);
      path.setAttribute("stroke", color);
      layer.appendChild(path);
      const head = document.createElementNS(ns, "polygon");
      head.setAttribute("class", "annotation-arrowhead");
      head.setAttribute("points", `${end.x},${end.y} ${lineEnd.x + px * headWidth},${lineEnd.y + py * headWidth} ${lineEnd.x - px * headWidth},${lineEnd.y - py * headWidth}`);
      head.setAttribute("fill", color);
      head.setAttribute("opacity", ".84");
      layer.appendChild(head);
    }
  }
  toggleAnnotation(from, to, red) {
    const color = red ? RED : GREEN;
    const existing = this.annotations.findIndex(annotation => annotation.from === from
      && (annotation.type === "circle" ? from === to : annotation.to === to));
    if (existing >= 0) this.annotations.splice(existing, 1);
    else this.annotations.push(from === to ? { type: "circle", from, color } : { type: "arrow", from, to, color });
    this.renderAnnotations();
  }
  clearAnnotations() {
    if (!this.annotations.length) return;
    this.annotations = [];
    this.renderAnnotations();
  }

  // ------------------------------------------------------------ pointer ----
  squareAt(x, y) {
    const square = document.elementFromPoint(x, y)?.closest(".square");
    return square && this.el.contains(square) ? Number(square.dataset.index) : null;
  }

  pointerDown(event) {
    const square = event.target.closest(".square");
    if (event.button === 2) {
      event.preventDefault();
      // The right button while a piece is held puts it back.
      if (this.pointer) { this.cancelDrag(); this.annotationStart = null; return; }
      if (square) this.annotationStart = Number(square.dataset.index);
      return;
    }
    if (event.button !== 0 || this.promotion) return;
    event.preventDefault();
    this.clearAnnotations();
    if (!this.movable || !square) return;
    const index = Number(square.dataset.index);
    if (this.selected !== null && this.selected !== index && this.movesFrom(this.selected).some(move => move.to === index)) {
      this.tryMove(this.selected, index);
      return;
    }
    if (!this.ownPiece(index)) {
      this.selected = null;
      this.updateHighlights();
      return;
    }
    this.pointer = { from: index, x: event.clientX, y: event.clientY, dragging: false, wasSelected: this.selected === index };
    this.selected = index;
    this.updateHighlights();
  }
  pointerMove(event) {
    const pointer = this.pointer;
    if (!pointer) return;
    if (event.buttons & 2) { this.cancelDrag(); return; }
    if (!pointer.dragging) {
      if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < DRAG_THRESHOLD_PX) return;
      pointer.dragging = true;
      // As large as a piece on the board (the best-move board's drag preview).
      const size = this.el.querySelector(".square")?.getBoundingClientRect().width || 70;
      this.preview = document.createElement("img");
      this.preview.className = "drag-preview";
      this.preview.src = pieceImageUrl(this.position.board[pointer.from]);
      this.preview.style.width = this.preview.style.height = `${size * 62 / 70}px`;
      document.body.appendChild(this.preview);
    }
    this.preview.style.left = `${event.clientX}px`;
    this.preview.style.top = `${event.clientY}px`;
  }
  pointerUp(event) {
    if (event.button === 2) {
      if (this.annotationStart !== null) {
        const to = this.squareAt(event.clientX, event.clientY);
        if (to !== null) this.toggleAnnotation(this.annotationStart, to, event.ctrlKey);
        this.annotationStart = null;
      }
      return;
    }
    const pointer = this.pointer;
    if (!pointer || event.button !== 0) return;
    this.cancelDrag(false);
    if (pointer.dragging) {
      const to = this.squareAt(event.clientX, event.clientY);
      if (to !== null && to !== pointer.from && this.movesFrom(pointer.from).some(move => move.to === to)) {
        this.tryMove(pointer.from, to, false);
        return;
      }
      this.updateHighlights();
    } else if (pointer.wasSelected) {
      this.selected = null;
      this.updateHighlights();
    }
  }
  cancelDrag(redraw = true) {
    const had = !!this.pointer;
    this.pointer = null;
    this.preview?.remove();
    this.preview = null;
    if (redraw && had) { this.selected = null; this.updateHighlights(); }
  }

  // A pawn reaching the last rank asks for its piece first.
  tryMove(from, to, slide = true) {
    const moves = this.movesFrom(from).filter(move => move.to === to);
    if (!moves.length) return;
    this.selected = null;
    this.updateHighlights();
    if (moves.length > 1) {
      this.promotion = { from, to, slide };
      this.showPromotion();
      return;
    }
    this.onMove(moveToUci(moves[0]), { slide });
  }
  showPromotion() {
    this.el.querySelector(".promotion")?.remove();
    const { from, to } = this.promotion;
    const white = this.position.board[from] < "a";
    const chooser = document.createElement("div");
    chooser.className = "promotion";
    for (const letter of ["q", "n", "r", "b"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.title = { q: "Queen", n: "Knight", r: "Rook", b: "Bishop" }[letter];
      const image = document.createElement("img");
      image.src = pieceImageUrl(white ? letter.toUpperCase() : letter);
      image.alt = button.title;
      button.appendChild(image);
      button.onclick = event => {
        event.stopPropagation();
        const slide = this.promotion.slide;
        this.promotion = null;
        chooser.remove();
        this.onMove(`${squareName(from)}${squareName(to)}${letter}`, { slide });
      };
      chooser.appendChild(button);
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "×";
    cancel.title = "Cancel";
    cancel.onclick = event => { event.stopPropagation(); this.promotion = null; chooser.remove(); };
    chooser.appendChild(cancel);
    chooser.addEventListener("pointerdown", event => event.stopPropagation());
    this.el.appendChild(chooser);
    this.placePromotion();
  }
  // Over the promotion square's file, from the edge the pawn arrives at.
  placePromotion() {
    const chooser = this.el.querySelector(".promotion");
    if (!chooser || !this.promotion) return;
    const display = this.displayIndex(this.promotion.to);
    const top = display >> 3 === 0;
    chooser.style.left = `${(display & 7) * 12.5}%`;
    chooser.style.top = top ? "0" : "auto";
    chooser.style.bottom = top ? "auto" : "0";
    chooser.style.flexDirection = top ? "column" : "column-reverse";
  }
}

function coordinate(kind, text) {
  const label = document.createElement("span");
  label.className = `coordinate ${kind}`;
  label.textContent = text;
  return label;
}

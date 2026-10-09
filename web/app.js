// My Chess DB - page logic.
//
// Saved best moves come from this site's API (/api/*), which keeps them per
// engine: Stockfish 19 and Lichess. The page shows one engine's results or,
// combined, the deeper of the two. Opening names are looked up in the
// browser. Lichess is asked directly. Stockfish runs on the user's own
// computer through the engine bridge at http://127.0.0.1:8765.
import * as chess from "./chesslib.js";

const BRIDGE_URL = "http://127.0.0.1:8765";
const BRIDGE_MIN_VERSION = "1.0.6";

const symbols = {K:"♔",Q:"♕",R:"♖",B:"♗",N:"♘",P:"♙",k:"♚",q:"♛",r:"♜",b:"♝",n:"♞",p:"♟"};
const boardEl = document.querySelector("#board"), annotationLayer = document.querySelector("#annotation-layer"), fenEl = document.querySelector("#fen");
const notationEl = document.querySelector("#notation");
let state = { board: [], turn:"w", castling:"-", ep:"-", selected:null, last:null, lastSound:"move", captured:{w:[],b:[]}, shown:null, shownMove:null, analysis:null, history:[], historyIndex:0, openingMoves:[], openingTracking:false, flipped:false, annotations:[], annotationStart:null, suppressRightAnnotation:false, lichessRetryUntil:0, dragging:false, pointerStart:null, pointerCurrent:null, dragPreview:null, ignoreNextClick:false, positions:new Map(), view:"combined", key: localStorage.getItem("chessdb_key")||"", role:null, roleLabel:null, minDepth:21, fullDepth:46 };
// The engines results are kept for, with the names shown for them.
const ENGINES = {stockfish:"Stockfish 19",lichess:"Lichess"};
// Analyses started from this page (or picked up from the bridge), by engine
// and position (see jobKey).
const activeJobs = new Map();
let audioContext=null;
function status(text) { document.querySelector("#status").textContent=text; }
function playMoveSound(kind) {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if(audioContext.state==="suspended") audioContext.resume();
    const now=audioContext.currentTime;
    const patterns={
      move:[[440,0.06,0.04,0]],
      capture:[[330,0.08,0.06,0],[220,0.12,0.07,0]],
      castle:[[392,0.07,0.04,0],[523,0.13,0.07,0]],
      check:[[660,0.08,0.05,0],[880,0.14,0.08,0]],
      mate:[[660,0.08,0.06,0],[523,0.08,0.06,0],[330,0.2,0.1,0]],
      ui:[[520,0.05,0.035,0]],
      complete:[[523,0.16,0.05,0],[659,0.16,0.05,0.14],[784,0.18,0.06,0.28],[1047,0.6,0.07,0.44]]
    };
    for(const [frequency,duration,volume,offset] of patterns[kind]||patterns.move) {
      const start=now+(offset||0);
      const oscillator=audioContext.createOscillator();
      const gain=audioContext.createGain();
      oscillator.type=kind==="capture"?"square":"sine";
      oscillator.frequency.value=frequency;
      gain.gain.setValueAtTime(volume,start);
      gain.gain.exponentialRampToValueAtTime(0.001,start+duration);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start); oscillator.stop(start+duration);
    }
  } catch(error) {
    console.warn("Move sound unavailable",error);
  }
}
// Same position => same key, however the en passant square was written.
function positionKey(fen) { return chess.positionKey(fen); }
function jobKey(source, fen) { return `${source}|${positionKey(fen)}`; }
// What is saved for a position, by engine: {stockfish?, lichess?}. Each
// position is fetched when it is first shown (state.positions) and then kept
// up to date from the answers to this page's own saves.
function entryFor(fen, source) { return state.positions.get(positionKey(fen))?.[source]||null; }
// Pending fetches: positionRequests by position key (also set for the
// positions a pending expansion will bring), expansions by the position asked.
const positionRequests=new Map(), expansions=new Map();
// Positions fetched together with every position one legal move away, so a
// move shows its result at once. Kept until reloadPositions.
const expandedPositions=new Set();
// A fetch answers for how things were when it was sent. What this page set
// itself since then (after a save, say) is newer and is kept.
let positionWrites=0, positionsEpoch=0;
const positionWrittenAt=new Map();
function nextPositionKeys(fen) {
  try {
    const position=chess.parseFen(fen);
    return chess.legalMoves(position).map(move=>positionKey(chess.toFen(chess.makeMove(position,move))));
  } catch(error) { return []; }
}
// Fetches a position and the positions one move away, in one request.
function expandPosition(fen) {
  const key=positionKey(fen);
  if(expansions.has(key)) return expansions.get(key);
  const sentAt=positionWrites, epoch=positionsEpoch, covered=[key,...nextPositionKeys(fen)];
  const take=(at,entries)=>{
    if(entries && !((positionWrittenAt.get(at)||0)>sentAt)) state.positions.set(at,entries);
  };
  const request=api(`/api/position?next=1&fen=${encodeURIComponent(fen)}`)
    .catch(error=>{
      // A board that is not a legal position has nothing saved for it.
      if(error.status===400) return {entries:{},next:{}};
      throw error;
    })
    .then(data=>{
      if(epoch!==positionsEpoch) return;   // everything was reloaded meanwhile
      take(key,data.entries||{});
      for(const [at,entries] of Object.entries(data.next||{})) take(at,entries);
      expandedPositions.add(key);
    })
    .finally(()=>{
      if(expansions.get(key)===request) expansions.delete(key);
      for(const at of covered) if(positionRequests.get(at)===request) positionRequests.delete(at);
    });
  expansions.set(key,request);
  for(const at of covered) if(!state.positions.has(at) && !positionRequests.has(at)) positionRequests.set(at,request);
  return request;
}
// Fetches what is saved for positions that are not known yet, such as the
// moves before a position loaded with its history, so that going back through
// them shows their results at once. One request per 100 positions.
function prefetchPositions(fens) {
  const wanted=new Map();
  for(const fen of fens) {
    const key=positionKey(fen);
    if(!state.positions.has(key) && !positionRequests.has(key)) wanted.set(key,fen);
  }
  const all=[...wanted];
  for(let at=0;at<all.length;at+=100) {
    const chunk=all.slice(at,at+100), sentAt=positionWrites, epoch=positionsEpoch;
    const query=chunk.slice(1).map(([,fen])=>`&also=${encodeURIComponent(fen)}`).join("");
    const request=api(`/api/position?fen=${encodeURIComponent(chunk[0][1])}${query}`)
      .then(data=>{
        if(epoch!==positionsEpoch) return;
        const answers=[[chunk[0][0],data.entries],...Object.entries(data.also||{})];
        for(const [key,entries] of answers)
          if(entries && !state.positions.has(key) && !((positionWrittenAt.get(key)||0)>sentAt)) state.positions.set(key,entries);
        if(chunk.some(([key])=>key===positionKey(currentFen()))) refreshShownAnalysis();
      })
      .catch(()=>{})   // they are fetched one by one when shown instead
      .finally(()=>{ for(const [key] of chunk) if(positionRequests.get(key)===request) positionRequests.delete(key); });
    for(const [key] of chunk) positionRequests.set(key,request);
  }
}
// Resolves once the position's entries are known. Also fetches the positions
// one move away if that has not been done for this position yet.
function loadPosition(fen) {
  const key=positionKey(fen);
  const own=expandedPositions.has(key)?null:expandPosition(fen);
  if(state.positions.has(key)) {
    own?.catch(()=>{});   // a failed look-ahead is not worth a message
    return Promise.resolve();
  }
  const first=positionRequests.get(key)||own||Promise.resolve();
  return first.then(()=>state.positions.has(key)||!own||first===own?undefined:own);
}
function setPosition(fen, entries) {
  const key=positionKey(fen);
  positionWrittenAt.set(key,++positionWrites);
  state.positions.set(key,entries);
  if(key===positionKey(currentFen())) { applyShownAnalysis(currentFen()); render(); }
}
// After something that may have changed many positions (an import, a key
// being unverified): forget what was fetched and look again.
function reloadPositions() {
  positionsEpoch++;
  state.positions.clear();
  expandedPositions.clear();
  positionRequests.clear();
  expansions.clear();
  applyShownAnalysis(currentFen());
  render();
}
// The saved analysis the chosen view shows for a position: one engine's, or,
// combined, the deeper of the two (Stockfish 19 when they are equally deep).
function savedMatch(fen) {
  const entries=state.positions.get(positionKey(fen));
  if(!entries) return null;
  if(state.view!=="combined") return entries[state.view]||null;
  const {stockfish,lichess}=entries;
  return lichess&&(!stockfish||lichess.depth>stockfish.depth)?lichess:stockfish||null;
}
function pvSan(entry) {
  if(!entry.pv_san) {
    try { entry.pv_san=chess.replayUci(entry.fen,entry.pv).san; } catch(error) { entry.pv_san=[]; }
  }
  return entry.pv_san;
}
function depthLabel(entry) {
  const depth=`${ENGINES[entry.source]} · Depth ${entry.depth}${entry.knodes?` | ${entry.knodes}k nodes`:""}`;
  if(entry.liveAnalysis) {
    const stored=entryFor(entry.fen,"stockfish");
    if(stored && stored.depth===entry.depth && stored.move_uci===entry.move_uci) return `${depth} · live analysis, saved`;
    const blocked=state.positions.has(positionKey(entry.fen))&&liveSaveBlocked(entry);
    return `${depth} · live analysis${blocked&&entry.depth<state.minDepth?`, saved from depth ${state.minDepth}`:blocked?", not saved":""}`;
  }
  if(entry.live) return `${depth} · ${entry.source==="lichess"?"not saved":"still analysing"}`;
  return `${depth}${entry.imported?" · Lichess database":""}${entry.verified?"":" · unverified"}`;
}
// What the page shows for a position: its saved analysis in the chosen view,
// or what a job of that view's engine (job.live) or the live analysis has
// found so far, once that is deeper than the saved one. While the live
// analysis is still searching the position it also stays on screen when it
// is only as deep as the saved one, which is what happens each time it has
// been saved: it turns to the saved (green) one when the search stops. Seen
// again later, a saved live analysis is green like any saved analysis, until
// the new search has gone deeper (see liveState.search).
function shownAnalysis(fen) {
  const saved=savedMatch(fen);
  let live=liveAnalysisFor(fen);
  for(const source of state.view==="combined"?Object.keys(ENGINES):[state.view]) {
    const job=activeJobs.get(jobKey(source,fen));
    const found=job&&(!job.finished||job.unsaved)?job.live:null;
    if(found&&(!live||found.depth>live.depth)) live=found;
  }
  if(!live || !saved) return live||saved;
  if(live.depth>saved.depth) return live;
  return live.depth===saved.depth && live.liveAnalysis && live.search===liveState.search && liveSearching(fen) ? live : saved;
}
function applyShownAnalysis(fen) {
  const key=positionKey(fen);
  if(!state.positions.has(key)) {
    // Not fetched yet: show it as soon as it is here, if this is still the position on the board.
    loadPosition(fen).then(()=>{ if(key===positionKey(currentFen())) refreshShownAnalysis(); },error=>status(error.message));
  } else if(!expandedPositions.has(key) && !expansions.has(key)) {
    // Known already (fetched with the position before): look one move further
    // ahead now, and show what is newest for this one when it comes.
    expandPosition(fen).then(()=>{ if(key===positionKey(currentFen())) refreshShownAnalysis(); },()=>{});
  }
  const shown=shownAnalysis(fen);
  state.shown=shown;
  state.shownMove=shown?.move_uci||null;
  notationEl.textContent=shown?pvSan(shown).join(" "):"";
  document.querySelector("#evaluation").value=shown?.evaluation||"";
  document.querySelector("#depth-result").value=shown?depthLabel(shown):"";
  syncLiveAnalysis();
}
// The same without rebuilding the board, so it is safe while a piece is
// being dragged. Used when a running analysis reports a new depth.
function refreshShownAnalysis() {
  applyShownAnalysis(currentFen());
  updateSelectionVisual();
  renderEvalBar();
}
// How strongly the best move is painted, 0..1. From the site's full depth
// (46) on: 1, the full green. Below it: from 0.12 at depth 1 up to 0.5 just
// under the full depth, so that depth 45 still cannot be mistaken for 46.
function depthStrength(depth) {
  const full=state.fullDepth;
  if(!(depth<full)) return 1;
  return 0.12+0.38*Math.max(0,Math.min(1,(depth-1)/Math.max(1,full-2)));
}
const BEST_MOVE_COLOUR=[0x72,0xd5,0x72];
function cssColour(name) {
  const hex=getComputedStyle(document.documentElement).getPropertyValue(name).trim().slice(1);
  return [0,2,4].map(start=>parseInt(hex.slice(start,start+2),16));
}
const SQUARE_COLOURS={light:cssColour("--light"),dark:cssColour("--dark")};
function applyBestMoveColour() {
  const strength=state.shown?depthStrength(state.shown.depth):1;
  for(const [shade,base] of Object.entries(SQUARE_COLOURS)) {
    const mixed=base.map((channel,i)=>Math.round(channel+(BEST_MOVE_COLOUR[i]-channel)*strength));
    boardEl.style.setProperty(`--best-${shade}`,`rgb(${mixed.join(",")})`);
  }
}
// Reads "+0.32", "#-3", "Lichess Cloud: -0.31" or "Lichess Cloud: mate 4"
// (always from White's side). Returns White's share of the evaluation bar in
// percent and a short label, or null when the text holds no score.
function parseEvaluation(text) {
  const mate=/(?:#|mate )(-?)(\d+)/.exec(text||"");
  if(mate) return {white:mate[1]?0:100,label:`M${mate[2]}`};
  const score=/[+-]?\d+\.\d+/.exec(text||"");
  if(!score) return null;
  const pawns=Number(score[0]), size=Math.abs(pawns);
  // The usual winning-chances curve: +1 is about 59%, +3 about 75%.
  const white=Math.max(4,Math.min(96,100/(1+Math.exp(-0.368208*pawns))));
  return {white,label:size<100?size.toFixed(1):String(Math.round(size))};
}
function renderEvalBar() {
  const bar=document.querySelector("#eval-bar"), label=document.querySelector("#eval-bar-label");
  const score=parseEvaluation(state.shown?.evaluation);
  bar.classList.toggle("flipped",state.flipped);
  bar.classList.toggle("empty",!score);
  document.querySelector("#eval-bar-white").style.height=`${score?score.white:50}%`;
  label.textContent=score?score.label:"";
  // The number sits at the end of the side that is ahead.
  label.className=score&&score.white<50?"for-black":"for-white";
  const description=score?`Evaluation ${state.shown.evaluation} at depth ${state.shown.depth}`:"No evaluation for this position";
  bar.title=description;
  bar.setAttribute("aria-label",description);
}
function currentFen() {
  const rows=state.board.map(row=>{let s="", empty=0; for(const p of row){if(!p) empty++; else {if(empty){s+=empty;empty=0} s+=p}} if(empty)s+=empty; return s}).join("/");
  return `${rows} ${state.turn} ${state.castling} ${state.ep} 0 1`;
}
function squareName(index) { return "abcdefgh"[index%8] + (8-Math.floor(index/8)); }
function positionSnapshot() {
  return {
    board:state.board.map(row=>row.slice()),
    turn:state.turn,
    castling:state.castling,
    ep:state.ep,
    last:state.last,
    lastSound:state.lastSound,
    captured:{w:[...state.captured.w],b:[...state.captured.b]},
    flipped:state.flipped,
    openingTracking:state.openingTracking,
    openingMoves:state.openingMoves.slice()
  };
}
function flipPreferenceKey() { return "chessdb_flipped_positions"; }
function flipPreferences() {
  try {
    const preferences=JSON.parse(localStorage.getItem(flipPreferenceKey())||"{}");
    return preferences&&typeof preferences==="object"&&!Array.isArray(preferences)?preferences:{};
  }
  catch(error) { console.warn("Could not read saved board orientations",error); return {}; }
}
function rememberFlipForPosition(fen=currentFen()) {
  try {
    const preferences=flipPreferences();
    const key=positionKey(fen);
    delete preferences[key];
    preferences[key]=state.flipped;
    while(Object.keys(preferences).length>256) delete preferences[Object.keys(preferences)[0]];
    localStorage.setItem(flipPreferenceKey(),JSON.stringify(preferences));
  } catch(error) { console.warn("Could not save board orientation",error); }
}
function snapshotFen(position) {
  const rows=position.board.map(row=>{let s="",empty=0;for(const piece of row){if(!piece) empty++;else{if(empty){s+=empty;empty=0;}s+=piece;}}if(empty)s+=empty;return s;}).join("/");
  return `${rows} ${position.turn} ${position.castling} ${position.ep} 0 1`;
}
function updateHistoryControls() {
  document.querySelector("#history-first").disabled=state.historyIndex<=0;
  document.querySelector("#history-back").disabled=state.historyIndex<=0;
  document.querySelector("#history-forward").disabled=state.historyIndex>=state.history.length-1;
  document.querySelector("#history-last").disabled=state.historyIndex>=state.history.length-1;
}
function showHistoryPosition(index) {
  if(index<0||index>=state.history.length) return;
  if(index===state.historyIndex) return;
  const previousIndex=state.historyIndex;
  const previousPosition=state.history[previousIndex];
  state.historyIndex=index;
  const position=state.history[index];
  state.board=position.board.map(row=>row.slice());
  state.turn=position.turn;
  state.castling=position.castling;
  state.ep=position.ep;
  state.last=position.last;
  state.lastSound=position.lastSound||"move";
  state.captured=position.captured
    ? {w:[...position.captured.w],b:[...position.captured.b]}
    : {w:[],b:[]};
  if(typeof position.flipped==="boolean") state.flipped=position.flipped;
  state.openingTracking=position.openingTracking;
  state.openingMoves=position.openingMoves.slice();
  state.selected=null;
  state.annotations=[];
  state.annotationStart=null;
  state.pointerStart=null;
  state.pointerCurrent=null;
  state.dragging=false;
  if(state.dragPreview){state.dragPreview.remove();state.dragPreview=null;}
  fenEl.value=currentFen();
  applyShownAnalysis(fenEl.value);
  render();
  updateHistoryControls();
  playMoveSound(index>previousIndex?position.lastSound||"move":previousPosition?.lastSound||"move");
  void updateOpeningDisplay();
}
function parseFen(fen, openingMoves=null, positionHistory=null) {
  const parts=fen.trim().split(/\s+/);
  if(parts.length<4) throw Error("Invalid FEN");
  const rows=parts[0].split("/");
  if(rows.length!==8) throw Error("Invalid FEN board");
  const board=[];
  for(const row of rows) {
    const out=[];
    for(const c of row) c>="1"&&c<="8"?out.push(...Array(+c).fill("")):out.push(c);
    if(out.length!==8) throw Error("Invalid FEN row");
    board.push(out);
  }
  state.board=board; state.turn=parts[1]; state.castling=parts[2]; state.ep=parts[3]; state.selected=null; state.last=null; state.lastSound="move"; state.captured={w:[],b:[]}; state.analysis=null; state.shown=null; state.shownMove=null; state.history=[];
  // Arrows and circles belong to the position they were drawn on.
  state.annotations=[]; state.annotationStart=null;
  const preferences=flipPreferences(), savedFlip=preferences[positionKey(fen)];
  if(typeof savedFlip==="boolean") state.flipped=savedFlip;
  state.openingTracking=Array.isArray(openingMoves)||positionKey(fen)===positionKey("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  state.openingMoves=Array.isArray(openingMoves)?openingMoves.slice():[];
  const current=positionSnapshot();
  state.history=Array.isArray(positionHistory)&&positionHistory.length
    ? positionHistory.map(position=>({...position,board:position.board.map(row=>row.slice()),openingMoves:Array.isArray(position.openingMoves)?[...position.openingMoves]:[],captured:position.captured?{w:[...position.captured.w],b:[...position.captured.b]}:{w:[],b:[]}}))
    : [current];
  const last=state.history[state.history.length-1];
  if(positionKey(snapshotFen(last))===positionKey(fen)) {
    last.board=current.board.map(row=>row.slice());
    last.turn=current.turn; last.castling=current.castling; last.ep=current.ep;
    last.openingTracking=current.openingTracking; last.openingMoves=current.openingMoves.slice();
    state.captured=last.captured?{w:[...last.captured.w],b:[...last.captured.b]}:{w:[],b:[]};
    if(typeof last.flipped==="boolean") state.flipped=last.flipped;
    state.last=last.last||null;
    current.last=state.last;
    current.lastSound=last.lastSound||"move";
    current.captured={w:[...state.captured.w],b:[...state.captured.b]};
    current.flipped=state.flipped;
    Object.assign(last,current);
  } else {
    state.history.push(current);
  }
  state.historyIndex=state.history.length-1;
  fenEl.value=fen; applyShownAnalysis(fen); render(); updateHistoryControls(); void updateOpeningDisplay();
  // A position loaded with the moves before it: have their results ready too.
  if(state.history.length>1) prefetchPositions(state.history.slice(0,-1).map(snapshotFen));
}
function moveSquares(uci) { return uci ? [("abcdefgh".indexOf(uci[0]) + (8-+uci[1])*8), ("abcdefgh".indexOf(uci[2]) + (8-+uci[3])*8)] : []; }
function bestMoveSquares(uci) {
  const squares=moveSquares(uci);
  if(squares.length!==2) return squares;
  const [from,to]=squares, fr=Math.floor(from/8), ff=from%8, tr=Math.floor(to/8), tf=to%8;
  const piece=state.board[fr][ff];
  if((piece!=="K" && piece!=="k") || fr!==tr || Math.abs(tf-ff)!==2) return squares;
  // Castling is shown as the king and the rook it castles with.
  return [from,fr*8+(tf>ff?7:0)];
}
function pieceImageUrl(piece) {
  return `https://raw.githubusercontent.com/lichess-org/lila/master/public/piece/cburnett/${piece===piece.toUpperCase()?"w":"b"}${piece.toUpperCase()}.svg`;
}
function createDragPreview(piece) {
  const preview=document.createElement("img");
  preview.className="drag-preview";
  preview.src=pieceImageUrl(piece);
  document.body.appendChild(preview);
  return preview;
}
function displaySquare(index) {
  const row=Math.floor(index/8), col=index%8;
  return state.flipped ? {row:7-row,col:7-col} : {row,col};
}
function annotationPoint(index) {
  const square=displaySquare(index);
  return {x:square.col*70+35,y:square.row*70+35};
}
function renderAnnotations() {
  annotationLayer.innerHTML="";
  annotationLayer.setAttribute("viewBox","0 0 560 560");
  annotationLayer.setAttribute("preserveAspectRatio","none");
  const ns="http://www.w3.org/2000/svg";
  for(const annotation of state.annotations) {
    const start=annotationPoint(annotation.from);
    const color=annotation.color||"#24a148";
    if(annotation.type==="circle") {
      const circle=document.createElementNS(ns,"circle");
      circle.setAttribute("class","annotation-circle");
      circle.setAttribute("cx",start.x); circle.setAttribute("cy",start.y); circle.setAttribute("r","27");
      circle.setAttribute("fill",color); circle.setAttribute("fill-opacity","0.2");
      circle.setAttribute("stroke",color);
      annotationLayer.appendChild(circle);
      continue;
    }
    const end=annotationPoint(annotation.to);
    const dx=end.x-start.x, dy=end.y-start.y, length=Math.hypot(dx,dy);
    if(!length) continue;
    const ux=dx/length, uy=dy/length, px=-uy, py=ux;
    const reverse=state.annotations.some(x=>x.type==="arrow" && x.from===annotation.to && x.to===annotation.from);
    const bend=reverse ? 12 : 0;
    const control={x:(start.x+end.x)/2+px*bend,y:(start.y+end.y)/2+py*bend};
    const headLength=23, headWidth=11;
    const lineStart=start;
    const lineEnd={x:end.x-ux*headLength,y:end.y-uy*headLength};
    const path=document.createElementNS(ns,"path");
    path.setAttribute("class","annotation-arrow");
    path.setAttribute("d",`M ${lineStart.x} ${lineStart.y} Q ${control.x} ${control.y} ${lineEnd.x} ${lineEnd.y}`);
    path.setAttribute("stroke",color);
    annotationLayer.appendChild(path);
    const head=document.createElementNS(ns,"polygon");
    const base={x:end.x-ux*headLength,y:end.y-uy*headLength};
    head.setAttribute("class","annotation-arrowhead");
    head.setAttribute("points",`${end.x},${end.y} ${base.x+px*headWidth},${base.y+py*headWidth} ${base.x-px*headWidth},${base.y-py*headWidth}`);
    head.setAttribute("fill",color);
    head.setAttribute("opacity",".84");
    annotationLayer.appendChild(head);
  }
}
// Each side's captures go next to that side of the board: the side at the
// bottom (White, unless the board is flipped) below it, the other above.
function renderMaterialStatus() {
  const top=document.querySelector("#captured-top"), bottom=document.querySelector("#captured-bottom");
  const scoreOf=piece=>({p:1,n:3,b:3,r:5,q:9}[piece.toLowerCase()]||0);
  const material={w:0,b:0};
  for(const piece of state.board.flat()) {
    if(piece) material[piece===piece.toUpperCase()?"w":"b"]+=scoreOf(piece);
  }
  const difference=material.w-material.b;
  const advantagedColor=difference>0?"w":difference<0?"b":null;
  const advantage=Math.abs(difference);
  top.innerHTML=""; bottom.innerHTML="";
  for(const [color,label] of [["w","White captured"],["b","Black captured"]]) {
    const row=document.createElement("div");
    row.className="captured-row";
    const name=document.createElement("span"); name.className="captured-label"; name.textContent=label;
    row.appendChild(name);
    const pieces=document.createElement("span");
    pieces.className="captured-pieces";
    // The pieces themselves sit on a tile in the colour of a light square,
    // so that captured black pieces stand out from the dark panel.
    const set=document.createElement("span");
    set.className="captured-set";
    for(const type of ["p","n","b","r","q"]) {
      const sameType=[...state.captured[color]].filter(piece=>piece.toLowerCase()===type);
      if(!sameType.length) continue;
      const group=document.createElement("span");
      group.className="captured-piece-group";
      group.setAttribute("aria-label",`${sameType.length} captured ${type}`);
      for(const piece of sameType) {
        const image=document.createElement("img");
        image.className="captured-piece";
        image.src=pieceImageUrl(piece);
        image.alt=`Captured ${piece}`;
        image.title=`Captured ${piece}`;
        group.appendChild(image);
      }
      set.appendChild(group);
    }
    if(set.childElementCount) pieces.appendChild(set);
    row.appendChild(pieces);
    if(color===advantagedColor) {
      const points=document.createElement("span");
      points.className="material-advantage";
      points.textContent=`+${advantage}`;
      row.appendChild(points);
    }
    ((color==="w")!==state.flipped?bottom:top).appendChild(row);
  }
}
function render() {
  boardEl.innerHTML=""; const best=bestMoveSquares(state.shownMove), last=moveSquares(state.last);
  applyBestMoveColour();
  const legalMoves=state.selected===null ? [] : getLegalDestinations(state.selected);
  const castleMoves=state.selected===null ? [] : getCastleHighlights(state.selected);
  for(let display=0;display<64;display++){
    const displayRow=Math.floor(display/8), displayCol=display%8;
    const i=state.flipped?(7-displayRow)*8+(7-displayCol):display;
    const piece=state.board.flat()[i], castle=castleMoves.includes(i);
    const b=document.createElement("button");
    b.dataset.index=String(i);
    b.className="square "+(((displayRow+displayCol)%2)?"dark":"light");
    b.setAttribute("aria-label",`${squareName(i)}${piece?` ${piece}`:""}`);
    if(best.includes(i))b.classList.add(state.shown?.liveAnalysis?"live-best":"best");
    if(last.includes(i)&&!castle)b.classList.add("last");
    if(state.selected===i)b.classList.add("selected");
    if(castle)b.classList.add("legal-castle");
    else if(legalMoves.includes(i))b.classList.add(piece?"legal-capture":"legal-move");
    if(piece){
      const image=document.createElement("img");
      image.className="piece-image"; image.src=pieceImageUrl(piece); image.alt=piece;
      b.appendChild(image);
    }
    if(displayCol===0){
      const rank=document.createElement("span");
      rank.className="coordinate rank";
      rank.textContent=String(8-Math.floor(i/8));
      b.appendChild(rank);
    }
    if(displayRow===7){
      const file=document.createElement("span");
      file.className="coordinate file";
      file.textContent="abcdefgh"[i%8];
      b.appendChild(file);
    }
    b.draggable=false; b.onclick=e=>{e.preventDefault();handleSquareClick(i);};
    b.oncontextmenu=e=>e.preventDefault(); b.onpointerdown=e=>pointerDownSquare(e,i,piece);
    b.onpointermove=e=>pointerMoveSquare(e,i); b.onpointerup=e=>pointerUpSquare(e,i);
    b.onpointercancel=cancelPieceDrag; boardEl.appendChild(b);
  }
  renderAnnotations();
  renderMaterialStatus();
  renderEvalBar();
  setAnalyzeButtonLabel();
  syncAnalysisProgressForCurrentPosition();
}
function getLegalDestinations(from) {
  const fr=Math.floor(from/8), ff=from%8, piece=state.board[fr][ff];
  if(!piece || !isCurrentTurnPiece(piece)) return [];
  const destinations=[];
  for(let to=0;to<64;to++) {
    if(to===from) continue;
    const tr=Math.floor(to/8), tf=to%8;
    const castling=legalCastle(piece,fr,ff,tr,tf);
    if((castling || legalShape(piece,fr,ff,tr,tf)) &&
       moveKeepsKingSafe(piece,fr,ff,tr,tf,castling)) {
      destinations.push(to);
    }
  }
  return destinations;
}
function isCurrentTurnPiece(piece) {
  return state.turn==="w" ? piece===piece.toUpperCase() : piece===piece.toLowerCase();
}
function getCastleHighlights(from) {
  const fr=Math.floor(from/8), ff=from%8, piece=state.board[fr][ff], result=[];
  if(!piece || !isCurrentTurnPiece(piece)) return result;
  for(const to of [from-2,from+2]) {
    if(to>=0 && to<64 && legalCastle(piece,fr,ff,Math.floor(to/8),to%8)) {
      result.push(to);
      result.push(Math.floor(to/8)*8+(to%8>ff ? 5 : 3));
    }
  }
  return result;
}
function moveKeepsKingSafe(piece,fr,ff,tr,tf,castling=false) {
  const enPassant=legalEnPassant(piece,fr,ff,tr,tf);
  const captured=state.board[tr][tf];
  const enPassantCaptured=enPassant?state.board[fr][tf]:"";
  const rookFrom=castling?(tf>ff?7:0):-1, rookTo=castling?(tf>ff?5:3):-1;
  const rookPiece=castling?state.board[tr][rookFrom]:"";
  const rookDestination=castling?state.board[tr][rookTo]:"";
  state.board[tr][tf]=piece;
  state.board[fr][ff]="";
  if(enPassant) state.board[fr][tf]="";
  if(castling) {
    state.board[tr][rookTo]=rookPiece;
    state.board[tr][rookFrom]="";
  }
  const safe=!isKingInCheck(piece===piece.toUpperCase()?"w":"b");
  state.board[fr][ff]=piece;
  state.board[tr][tf]=captured;
  if(enPassant) state.board[fr][tf]=enPassantCaptured;
  if(castling) {
    state.board[tr][rookFrom]=rookPiece;
    state.board[tr][rookTo]=rookDestination;
  }
  return safe;
}
function kingIndex(color) {
  const king=color==="w"?"K":"k";
  for(let i=0;i<64;i++) if(state.board[Math.floor(i/8)][i%8]===king) return i;
  return -1;
}
function isKingInCheck(color) {
  const index=kingIndex(color);
  return index>=0 && isSquareAttacked(Math.floor(index/8),index%8,color!=="w");
}
function hasAnyLegalMove(color) {
  for(let i=0;i<64;i++) {
    const piece=state.board[Math.floor(i/8)][i%8];
    if(piece && (color==="w" ? piece===piece.toUpperCase() : piece===piece.toLowerCase()) &&
       getLegalDestinations(i).length) return true;
  }
  return false;
}
function updateSelectionVisual() {
  const legalMoves=state.selected===null ? [] : getLegalDestinations(state.selected);
  const castleMoves=state.selected===null ? [] : getCastleHighlights(state.selected);
  const best=bestMoveSquares(state.shownMove), liveBest=!!state.shown?.liveAnalysis;
  applyBestMoveColour();
  document.querySelectorAll("#board .square").forEach(square=>{
    const index=Number(square.dataset.index), piece=state.board[Math.floor(index/8)][index%8];
    const castle=castleMoves.includes(index);
    square.classList.toggle("best",best.includes(index)&&!liveBest);
    square.classList.toggle("live-best",best.includes(index)&&liveBest);
    square.classList.toggle("last",state.last && moveSquares(state.last).includes(index) && !castle);
    square.classList.toggle("selected",state.selected===index);
    square.classList.toggle("legal-castle",castle);
    square.classList.toggle("legal-move",legalMoves.includes(index) && !piece && !castle);
    square.classList.toggle("legal-capture",legalMoves.includes(index) && !!piece && !castle);
  });
}
function cancelPieceDrag() {
  if(!state.dragging && !state.pointerStart) return;
  state.dragging=false; state.pointerStart=null; state.pointerCurrent=null; state.annotationStart=null;
  if(state.dragPreview){state.dragPreview.remove();state.dragPreview=null;}
  state.selected=null; state.ignoreNextClick=false; render();
}
function cancelOnRightButton(e) {
  if((e.buttons & 2) && (state.dragging || state.pointerStart)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    state.suppressRightAnnotation=true;
    cancelPieceDrag();
    return true;
  }
  return false;
}
function pointerDownSquare(e,i,piece) {
  e.preventDefault();
  if(e.button===2) {
    if(state.dragging || state.pointerStart) {
      state.suppressRightAnnotation=true;
      cancelPieceDrag();
    }
    else state.annotationStart=i;
    return;
  }
  if(e.button!==0) return;
  state.annotations=[];
  renderAnnotations();
  if(state.selected!==null && state.selected!==i && getLegalDestinations(state.selected).includes(i)) {
    state.pointerStart={index:state.selected,x:e.clientX,y:e.clientY,wasSelected:false,target:i};
    state.pointerCurrent={x:e.clientX,y:e.clientY};
    return;
  }
  if(!piece) {
    state.selected=null;
    state.pointerStart=null;
    state.pointerCurrent=null;
    render();
    return;
  }
  if(!isCurrentTurnPiece(piece)) {
    state.selected=null;
    state.pointerStart=null;
    state.pointerCurrent=null;
    render();
    return;
  }
  state.pointerStart={index:i,x:e.clientX,y:e.clientY,wasSelected:state.selected===i};
  state.pointerCurrent={x:e.clientX,y:e.clientY};
  state.selected=i;
  updateSelectionVisual();
}
function pointerMoveSquare(e,i) {
  if(!state.pointerStart) return;
  state.pointerCurrent={x:e.clientX,y:e.clientY};
  const distance=Math.hypot(e.clientX-state.pointerStart.x,e.clientY-state.pointerStart.y);
  if(!state.dragging && distance>=6 && !state.pointerStart.target) {
    state.dragging=true;
    state.dragPreview=createDragPreview(state.board.flat()[state.pointerStart.index]);
  }
  if(state.dragging && state.dragPreview) {
    state.dragPreview.style.left=`${e.clientX}px`;
    state.dragPreview.style.top=`${e.clientY}px`;
  }
}
function pointerUpSquare(e,i) {
  if(e.button===2 && state.suppressRightAnnotation) {
    state.suppressRightAnnotation=false;
    state.annotationStart=null;
    return;
  }
  if(e.button===2 && state.annotationStart!==null) {
    const from=state.annotationStart;
    state.annotationStart=null;
    const to=i;
    const existing=state.annotations.findIndex(x=>x.from===from && (x.type==="circle" ? from===to : x.to===to));
    if(existing>=0) state.annotations.splice(existing,1);
    else state.annotations.push(from===to
      ? {type:"circle",from,color:e.ctrlKey?"#e5534b":"#24a148"}
      : {type:"arrow",from,to,color:e.ctrlKey?"#e5534b":"#24a148"});
    renderAnnotations();
    return;
  }
  if(e.button!==0 || !state.pointerStart) return;
  const from=state.pointerStart.index, wasDragging=state.dragging, wasSelected=state.pointerStart.wasSelected, clickTarget=state.pointerStart.target;
  const target=document.elementFromPoint(e.clientX,e.clientY)?.closest(".square");
  const to=target ? Number(target.dataset.index) : from;
  state.pointerStart=null; state.pointerCurrent=null; state.dragging=false;
  if(state.dragPreview){state.dragPreview.remove();state.dragPreview=null;}
  if(clickTarget!==undefined) movePiece(from,clickTarget);
  else if(wasDragging && Number.isInteger(to)) movePiece(from,to);
  else if(!wasDragging && wasSelected) {
    state.selected=null;
    updateSelectionVisual();
  }
  state.ignoreNextClick=true;
  setTimeout(()=>{state.ignoreNextClick=false;},0);
}
function handleSquareClick(i) {
  if(state.ignoreNextClick) { state.ignoreNextClick=false; return; }
  state.annotations=[];
  const piece=state.board[Math.floor(i/8)][i%8];
  if(state.selected!==null && getLegalDestinations(state.selected).includes(i)) {
    movePiece(state.selected,i);
    return;
  }
  if(piece && isCurrentTurnPiece(piece)) state.selected=state.selected===i ? null : i;
  else state.selected=null;
  render();
}
boardEl.oncontextmenu=e=>{e.preventDefault();};
boardEl.onpointerdown=e=>{
  if(e.button===2 && state.dragging) { e.preventDefault(); cancelPieceDrag(); }
};
boardEl.onpointerup=e=>{
  if(e.button===2 && state.annotationStart!==null && !e.target.closest(".square")) state.annotationStart=null;
};
document.addEventListener("contextmenu",e=>{
  if(state.dragging || state.pointerStart) {
    e.preventDefault();
    cancelPieceDrag();
  }
});
document.addEventListener("pointermove",e=>{
  if(cancelOnRightButton(e)) return;
  // The right button that cancelled a piece drag has been let go. While the
  // left button is still down that arrives as a pointermove, not a pointerup,
  // so without this the flag stayed set and swallowed the next right-drag.
  if(!(e.buttons & 2)) state.suppressRightAnnotation=false;
  if(!state.pointerStart) return;
  const square=document.elementFromPoint(e.clientX,e.clientY)?.closest(".square");
  pointerMoveSquare(e,square ? Number(square.dataset.index) : -1);
}, true);
document.addEventListener("mousemove",e=>{
  if(cancelOnRightButton(e)) return;
}, true);
document.addEventListener("pointerup",e=>{
  if(e.button===2 && state.dragging) {
    e.preventDefault();
    cancelPieceDrag();
    return;
  }
  if(e.button===2 && state.suppressRightAnnotation) {
    state.suppressRightAnnotation=false;
    state.annotationStart=null;
    e.preventDefault();
    return;
  }
  if(e.button===0 && state.pointerStart) {
    const square=document.elementFromPoint(e.clientX,e.clientY)?.closest(".square");
    pointerUpSquare(e,square ? Number(square.dataset.index) : -1);
  }
});
document.addEventListener("pointerdown",e=>{
  if(e.button===2 && (state.dragging || state.pointerStart)) {
    e.preventDefault();
    cancelPieceDrag();
    state.suppressRightAnnotation=true;
    e.stopImmediatePropagation();
  }
}, true);
document.addEventListener("mousedown",e=>{
  if(e.button===2 && (state.dragging || state.pointerStart)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    state.suppressRightAnnotation=true;
    cancelPieceDrag();
  }
}, true);
window.addEventListener("mousedown",e=>{
  if(e.button===2 && (state.dragging || state.pointerStart)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    state.suppressRightAnnotation=true;
    cancelPieceDrag();
  }
}, true);
window.addEventListener("pointerdown",e=>{
  if(e.button===2 && (state.dragging || state.pointerStart)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    state.suppressRightAnnotation=true;
    cancelPieceDrag();
  }
}, true);
document.addEventListener("auxclick",e=>{
  if(e.button===2) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);
function movePiece(from,to) {
  const fr=Math.floor(from/8), ff=from%8, tr=Math.floor(to/8), tf=to%8, piece=state.board[fr][ff];
  if(!piece || !getLegalDestinations(from).includes(to)){state.selected=null;render();return;}
  state.history=state.history.slice(0,state.historyIndex+1);
  if(state.openingTracking) state.openingMoves.push(squareName(from)+squareName(to));
  const castling=legalCastle(piece,fr,ff,tr,tf);
  const enPassant=legalEnPassant(piece,fr,ff,tr,tf);
  const capturedPiece=enPassant?state.board[fr][tf]:state.board[tr][tf];
  const capture=!!capturedPiece;
  if(capturedPiece) state.captured[state.turn].push(capturedPiece);
  updateCastlingRights(piece,fr,ff,tr,tf);
  state.board[tr][tf]=piece; state.board[fr][ff]="";
  if(enPassant) state.board[fr][tf]="";
  if(castling){
    const rookFrom=tf>ff?7:0, rookTo=tf>ff?5:3;
    state.board[tr][rookTo]=state.board[tr][rookFrom]; state.board[tr][rookFrom]="";
  }
  state.ep=(piece.toLowerCase()==="p" && Math.abs(tr-fr)===2)
    ? squareName(from + (tr>fr?8:-8)) : "-";
  state.last=squareName(from)+squareName(to); state.turn=state.turn==="w"?"b":"w";
  const check=isKingInCheck(state.turn);
  const mate=check && !hasAnyLegalMove(state.turn);
  state.lastSound=mate?"mate":check?"check":castling?"castle":capture?"capture":"move";
  playMoveSound(state.lastSound);
  state.history.push(positionSnapshot());
  state.historyIndex=state.history.length-1;
  fenEl.value=currentFen(); applyShownAnalysis(fenEl.value); state.selected=null; render(); updateHistoryControls(); void updateOpeningDisplay();
}
function undoMove() {
  if(state.historyIndex<=0){status("Already at the first position");return;}
  showHistoryPosition(state.historyIndex-1);
  status("Moved back one position");
}
function updateCastlingRights(piece,fr,ff,tr,tf) {
  let rights=state.castling==="-"?"":state.castling;
  const remove=r=>{rights=rights.replace(r,"");};
  if(piece==="K"){remove("K");remove("Q");}
  if(piece==="k"){remove("k");remove("q");}
  if(piece==="R"&&fr===7&&ff===0)remove("Q");
  if(piece==="R"&&fr===7&&ff===7)remove("K");
  if(piece==="r"&&fr===0&&ff===0)remove("q");
  if(piece==="r"&&fr===0&&ff===7)remove("k");
  const captured=state.board[tr][tf];
  if(captured==="R"&&tr===7&&tf===0)remove("Q");
  if(captured==="R"&&tr===7&&tf===7)remove("K");
  if(captured==="r"&&tr===0&&tf===0)remove("q");
  if(captured==="r"&&tr===0&&tf===7)remove("k");
  state.castling=rights||"-";
}
function legalCastle(p,fr,ff,tr,tf) {
  if(!"Kk".includes(p) || fr!==tr || Math.abs(tf-ff)!==2 || state.board[tr][tf]) return false;
  const white=p==="K", home=white?7:0, rights=white?["K","Q"]:["k","q"];
  if(fr!==home || ff!==4) return false;
  const kingSide=tf>ff, right=kingSide?rights[0]:rights[1], rookFile=kingSide?7:0;
  if(!state.castling.includes(right) || state.board[home][rookFile]!== (white?"R":"r")) return false;
  const step=kingSide?1:-1;
  for(let c=ff+step;c!==rookFile;c+=step) if(state.board[home][c]) return false;
  if(isSquareAttacked(home,ff,!white)) return false;
  if(isSquareAttacked(home,ff+step,!white)) return false;
  if(isSquareAttacked(home,tf,!white)) return false;
  return true;
}
function legalEnPassant(p,fr,ff,tr,tf) {
  if(!"Pp".includes(p) || state.ep==="-" || state.board[tr][tf]) return false;
  const direction=p==="P"?-1:1;
  if(tr-fr!==direction || Math.abs(tf-ff)!==1 || squareName(tr*8+tf)!==state.ep) return false;
  return state.board[fr][tf] === (p==="P"?"p":"P");
}
function isSquareAttacked(row,col,byWhite) {
  const enemy=byWhite?["P","N","B","R","Q","K"]:["p","n","b","r","q","k"];
  const pawn=byWhite?"P":"p", pawnRow=row+(byWhite?1:-1);
  for(const dc of [-1,1]) if(state.board[pawnRow]?.[col+dc]===pawn) return true;
  for(const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])
    if(enemy[1]===state.board[row+dr]?.[col+dc]) return true;
  for(const [dr,dc,types] of [[-1,0,"RQ"],[1,0,"RQ"],[0,-1,"RQ"],[0,1,"RQ"],[-1,-1,"BQ"],[-1,1,"BQ"],[1,-1,"BQ"],[1,1,"BQ"]]) {
    for(let r=row+dr,c=col+dc;r>=0&&r<8&&c>=0&&c<8;r+=dr,c+=dc) {
      const piece=state.board[r][c];
      if(piece) { if(types.includes(piece.toUpperCase()) && (byWhite?piece===piece.toUpperCase():piece===piece.toLowerCase())) return true; break; }
    }
  }
  for(const dr of [-1,0,1]) for(const dc of [-1,0,1]) if((dr||dc)&&enemy[5]===state.board[row+dr]?.[col+dc]) return true;
  return false;
}
function legalShape(p,fr,ff,tr,tf) {
  const dr=tr-fr, dc=tf-ff, ad=Math.abs(dr), ac=Math.abs(dc), target=state.board[tr][tf];
  if(target && ((p===p.toUpperCase()) === (target===target.toUpperCase()))) return false;
  if(target && target.toLowerCase()==="k") return false;
  if("Nn".includes(p)) return (ad===2&&ac===1)||(ad===1&&ac===2);
  if("Kk".includes(p)) return ad<=1&&ac<=1;
  if("Rr".includes(p) && !(dr===0||dc===0) || "Bb".includes(p) && ad!==ac || "Qq".includes(p) && !(dr===0||dc===0||ad===ac)) return false;
  if("Pp".includes(p)) {
    const direction=p==="P"?-1:1, startRow=p==="P"?6:1;
    if(dc===0 && !target && dr===direction) return true;
    if(dc===0 && !target && fr===startRow && dr===2*direction && !state.board[fr+direction][ff]) return true;
    if(Math.abs(dc)===1 && dr===direction && !!target) {
      return (p==="P" && target===target.toLowerCase()) || (p==="p" && target===target.toUpperCase());
    }
    return legalEnPassant(p,fr,ff,tr,tf);
  }
  const stepR=Math.sign(dr),stepC=Math.sign(dc); for(let r=fr+stepR,c=ff+stepC;r!==tr||c!==tf;r+=stepR,c+=stepC) if(state.board[r][c]) return false; return true;
}
// ===========================================================================
// Cloud API (same origin): saved best moves, keys, admin tools.
// ===========================================================================
async function api(path, options={}) {
  const headers={};
  if(state.key) headers["X-Key"]=state.key;
  if(options.body!==undefined) headers["Content-Type"]="application/json";
  let response;
  try {
    response=await fetch(path,{
      method:options.method||(options.body!==undefined?"POST":"GET"),
      headers,
      body:options.body!==undefined?JSON.stringify(options.body):undefined
    });
  } catch(error) {
    throw Error("Could not reach the My Chess DB server. Check your internet connection.");
  }
  let data=null;
  try { data=await response.json(); } catch(error) { /* not JSON */ }
  if(!response.ok) {
    const failure=Error(data?.error||`The server answered with status ${response.status}`);
    failure.status=response.status; failure.code=data?.code; failure.data=data;
    throw failure;
  }
  return data;
}
function setRoleUI() {
  const admin=state.role==="admin";
  document.querySelector("#remove").style.display=admin?"":"none";
  document.querySelector("#admin-tools").style.display=admin?"":"none";
  document.querySelector("#key-input").style.display=state.role?"none":"";
  document.querySelector("#key-login").textContent=state.role?"🔓 Logout":"Login";
  document.querySelector("#key-role").textContent=admin?"Admin":state.role==="contributor"?`Contributor: ${state.roleLabel||""}`:"";
  document.querySelector("#depth").min=state.minDepth;
  document.querySelector("#depth-label").textContent=`Stockfish analysis depth (${state.minDepth} or more; ${state.fullDepth} is the full depth)`;
  document.querySelector("#best-move-hint").textContent=`Green squares show the best move: full colour from depth ${state.fullDepth}, paler the shallower the analysis.`;
}
async function loadSession() {
  const session=await api("/api/session");
  state.minDepth=session.min_depth; state.fullDepth=session.full_depth;
  if(state.key && !session.role) {
    state.key="";
    localStorage.removeItem("chessdb_key");
    status("Your saved key is no longer valid; you are logged out.");
  }
  state.role=session.role; state.roleLabel=session.label;
  // Every visit starts at the site's full depth, whatever was typed last time.
  document.querySelector("#depth").value=state.fullDepth;
  setRoleUI();
  return session;
}
document.querySelector("#key-login").onclick=async()=>{
  if(state.role){
    state.key=""; state.role=null; state.roleLabel=null;
    localStorage.removeItem("chessdb_key");
    setRoleUI();
    status("Logged out");
    return;
  }
  const input=document.querySelector("#key-input");
  const key=input.value.trim();
  if(!key){ status("Enter your admin token or contributor key first"); return; }
  state.key=key;
  try {
    const session=await api("/api/session");
    if(!session.role){
      state.key="";
      status(session.admin_configured?"That key is not recognised":"That key is not recognised (the site's admin token has not been set up yet)");
      return;
    }
    localStorage.setItem("chessdb_key",key);
    input.value="";
    state.role=session.role; state.roleLabel=session.label; state.minDepth=session.min_depth; state.fullDepth=session.full_depth;
    setRoleUI();
    status(session.role==="admin"?"Admin mode enabled":"Contributor key accepted: your analyses are saved as verified");
  } catch(error) { state.key=""; status(error.message); }
};
document.querySelector("#key-input").addEventListener("keydown",e=>{ if(e.key==="Enter") document.querySelector("#key-login").click(); });
// The depth an analysis is asked to reach: what is typed, kept between the
// least depth the site saves and the most the engine takes. The field is
// corrected to match, so a depth that would not be saved cannot be chosen.
function chosenDepth() {
  const input=document.querySelector("#depth");
  const depth=Math.min(245,Math.max(state.minDepth,Math.floor(+input.value)||state.fullDepth));
  input.value=depth;
  return depth;
}
document.querySelector("#depth").addEventListener("change",chosenDepth);

// Sends an analysis to the server, which decides whether it replaces what is
// stored for that engine. Returns {saved, reason, entry, entries}.
async function saveAnalysisFor(fen, analysis) {
  const body=analysis.source==="lichess"
    // The server fetches the evaluation from Lichess itself.
    ? {fen,source:"lichess"}
    : {fen,source:"stockfish",depth:analysis.depth,pv:analysis.pv,evaluation:analysis.evaluation};
  const outcome=await api("/api/saved",{body});
  setPosition(fen,outcome.entries);
  if(!analysis.partial) playMoveSound("complete");
  return outcome;
}
// Would an analysis of this kind replace what is already saved? Mirrors the
// server's rule so a long Stockfish run is not started for nothing.
function blockedByExisting(fen, source, verified, depth, beforeStarting=true) {
  const existing=entryFor(fen,source);
  if(!existing) return null;
  if(existing.verified && !verified)
    return `A verified analysis (depth ${existing.depth}) is already saved for this position; an unverified one cannot replace it.`;
  if(existing.verified!==verified || existing.depth<depth) return null;
  if(source==="lichess")
    return `Lichess's evaluation at depth ${existing.depth} is already here for this position; depth ${depth} would not replace it.`;
  return `An analysis at depth ${existing.depth} is already saved for this position; depth ${depth} would not replace it.`
    +(beforeStarting&&state.role==="admin"?" Remove the saved move first to analyse it again.":"");
}

// ===========================================================================
// Opening names: looked up in the browser from /openings.json.
// ===========================================================================
let openingCatalog=null;
function loadOpeningCatalog() {
  if(!openingCatalog) {
    openingCatalog=fetch("/openings.json")
      .then(response=>{ if(!response.ok) throw Error("Could not load the opening names"); return response.json(); })
      .catch(error=>{ openingCatalog=null; throw error; });
  }
  return openingCatalog;
}
async function lookupOpening(fen, moves) {
  const catalog=await loadOpeningCatalog();
  const pick=key=>Object.hasOwn(catalog,key)?{eco:catalog[key][0],name:catalog[key][1]}:null;
  if(!Array.isArray(moves)) {
    const hit=pick(positionKey(fen));
    return {eco:hit?.eco||null,name:hit?.name||null,line:"",continuation:[]};
  }
  const replay=chess.replayUci(chess.START_FEN,moves);
  let latest=null, latestPly=0;
  replay.keys.forEach((key,index)=>{ const hit=pick(key); if(hit){ latest=hit; latestPly=index+1; } });
  return {eco:latest?.eco||null,name:latest?.name||null,line:chess.formatSanLine(replay.san),continuation:replay.san.slice(latestPly)};
}
let openingRequestId=0;
async function updateOpeningDisplay() {
  const panel=document.querySelector("#opening-status");
  const requestId=++openingRequestId;
  if(!state.openingTracking){
    panel.style.display="none";
    return;
  }
  panel.style.display="block";
  if(!state.openingMoves.length){
    panel.textContent="Opening: Starting position";
    return;
  }
  try {
    const result=await lookupOpening(currentFen(),state.openingMoves);
    if(requestId!==openingRequestId) return;
    const opening=result.name
      ? `${result.eco} · ${result.name}`
      : "Unclassified opening";
    panel.textContent=`Opening: ${opening}${result.line?` — ${result.line}`:""}`;
  } catch(error) {
    if(requestId===openingRequestId) panel.textContent=`Opening lookup failed: ${error.message}`;
  }
}

// ===========================================================================
// Engine bridge: the small program on the user's own computer that runs
// Stockfish. The page only talks to it after the user has asked for it, so
// visitors who just browse saved moves never see a local-network prompt.
// ===========================================================================
const bridgeState={connected:false,status:null,waiting:false,timer:null};
const INSTALL_BUSY=["checking","downloading","unpacking","verifying"];
async function bridge(path, options={}) {
  let response;
  try {
    response=await fetch(BRIDGE_URL+path,{
      method:options.method||(options.body!==undefined?"POST":"GET"),
      headers:options.body!==undefined?{"Content-Type":"application/json"}:{},
      body:options.body!==undefined?JSON.stringify(options.body):undefined
    });
  } catch(error) {
    if(bridgeState.connected){ bridgeState.connected=false; bridgeState.status=null; renderBridge(); }
    const failure=Error("The engine bridge is not running on this computer.");
    failure.code="BRIDGE_OFFLINE";
    throw failure;
  }
  let data=null;
  try { data=await response.json(); } catch(error) { /* not JSON */ }
  if(!response.ok) {
    const failure=Error(data?.error||`The engine bridge answered with status ${response.status}`);
    failure.status=response.status;
    throw failure;
  }
  return data;
}
function versionAtLeast(version, minimum) {
  const a=String(version).split(".").map(Number), b=minimum.split(".").map(Number);
  for(let i=0;i<3;i++){ if((a[i]||0)!==(b[i]||0)) return (a[i]||0)>(b[i]||0); }
  return true;
}
function bridgeOutdated() {
  return bridgeState.connected && !!bridgeState.status && !versionAtLeast(bridgeState.status.version,BRIDGE_MIN_VERSION);
}
function installCommands() {
  const origin=location.origin;
  return {
    // The ?t= value only makes sure a stale cached copy of the script is never used.
    windows:`$env:MYCHESSDB_SITE='${origin}'; iex (New-Object Net.WebClient).DownloadString('${origin}/install.ps1?t=${Date.now()}')`,
    unix:`curl -fsSL ${origin}/install.sh | MYCHESSDB_SITE=${origin} sh`,
    // Starting an installed bridge again.
    startWindows:`& "$env:LOCALAPPDATA\\MyChessDB\\mychessdb-bridge.exe" -site ${origin} -no-open`,
    startUnix:`~/.mychessdb/mychessdb-bridge -site ${origin} -no-open`
  };
}
function renderBridge() {
  const text=document.querySelector("#bridge-status"), connect=document.querySelector("#bridge-connect");
  const install=document.querySelector("#bridge-install"), engineInput=document.querySelector("#engine");
  const info=bridgeState.status;
  install.style.display="none";
  if(!bridgeState.connected || !info) {
    text.textContent="Engine bridge: not connected";
    connect.style.display="";
    connect.textContent=bridgeState.waiting?"Hide setup":"Connect";
    engineInput.disabled=true;
    return;
  }
  // An out-of-date bridge keeps working, but the button stays so the install
  // command is one click away.
  const outdated=bridgeOutdated();
  connect.style.display=outdated?"":"none";
  connect.textContent=bridgeState.waiting?"Hide setup":"Update";
  engineInput.disabled=false;
  if(document.activeElement!==engineInput) engineInput.value=info.engine.path||"";
  const state_=info.install.state;
  let message;
  if(info.engine.ready) message=`${info.engine.name} ready · up to ${info.threads} thread${info.threads===1?"":"s"}, ${info.hash} MB hash`;
  else if(INSTALL_BUSY.includes(state_)) {
    message=state_==="downloading"?`downloading Stockfish 19... ${info.install.progress}%`:"preparing Stockfish 19...";
  } else {
    message=`Stockfish is not installed${info.install.error?` (${info.install.error})`:""}`;
    if(info.can_install) install.style.display="";
  }
  if(outdated) message+=" · this bridge is out of date: run the install command again (Update)";
  text.textContent=`Engine bridge ${info.version} connected · ${message}`;
  if(bridgeState.waiting && !outdated){ bridgeState.waiting=false; document.querySelector("#bridge-setup").style.display="none"; }
}
function scheduleBridgeCheck() {
  clearTimeout(bridgeState.timer);
  const installing=bridgeState.connected && INSTALL_BUSY.includes(bridgeState.status?.install.state);
  if(installing || (!bridgeState.connected && bridgeState.waiting)) bridgeState.timer=setTimeout(checkBridge,2500);
  // While connected, look again now and then so the status line notices when
  // the bridge has been closed.
  else if(bridgeState.connected) bridgeState.timer=setTimeout(checkBridge,10000);
}
async function checkBridge() {
  const wasConnected=bridgeState.connected;
  try {
    bridgeState.status=await bridge("/api/status");
    bridgeState.connected=true;
    localStorage.setItem("chessdb_bridge_used","1");
  } catch(error) {
    bridgeState.connected=false; bridgeState.status=null;
  }
  renderBridge();
  scheduleBridgeCheck();
  if(bridgeState.connected && !wasConnected) {
    void restoreActiveAnalyses().catch(error=>status(error.message));
    liveLost();   // whatever the bridge was told before, tell it again
  }
  if(!bridgeState.connected) liveLost();
  syncLiveAnalysis();
  return bridgeState.connected;
}
function showBridgeSetup(show=true) {
  const panel=document.querySelector("#bridge-setup"), commands=installCommands();
  bridgeState.waiting=show;
  panel.style.display=show?"block":"none";
  document.querySelector("#install-windows").textContent=commands.windows;
  document.querySelector("#install-unix").textContent=commands.unix;
  document.querySelector("#start-windows").textContent=commands.startWindows;
  document.querySelector("#start-unix").textContent=commands.startUnix;
  const windows=/win/i.test(navigator.userAgentData?.platform||navigator.platform||"");
  document.querySelector("#install-windows-box").style.order=windows?"0":"1";
  // Safari refuses to let a secure page talk to a program on the same
  // computer, so analysing needs another browser there.
  const safari=/Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Firefox|FxiOS|CriOS/.test(navigator.userAgent);
  document.querySelector("#safari-note").style.display=safari?"block":"none";
  renderBridge();
  scheduleBridgeCheck();
}
document.querySelector("#bridge-connect").onclick=async()=>{
  if(bridgeState.waiting){ showBridgeSetup(false); return; }
  document.querySelector("#bridge-status").textContent="Engine bridge: looking for it...";
  if(!await checkBridge() || bridgeOutdated()) showBridgeSetup(true);
};
document.querySelector("#bridge-install").onclick=async()=>{
  try { await bridge("/api/engine/install",{method:"POST"}); } catch(error) { status(error.message); }
  await checkBridge();
};
for(const [button,source] of [["#copy-install-windows","#install-windows"],["#copy-install-unix","#install-unix"],["#copy-start-windows","#start-windows"],["#copy-start-unix","#start-unix"]]) {
  document.querySelector(button).onclick=async()=>{
    try {
      await navigator.clipboard.writeText(document.querySelector(source).textContent);
      status("Command copied");
    } catch(error) { status(`Could not copy: ${error.message}`); }
  };
}
document.querySelector("#engine").addEventListener("change",async()=>{
  const engineStatus=document.querySelector("#engine-status");
  const path=document.querySelector("#engine").value.trim();
  if(!path){ engineStatus.textContent=""; return; }
  engineStatus.textContent="Checking executable...";
  try {
    const result=await bridge("/api/engine/path",{body:{engine_path:path}});
    engineStatus.textContent=`✅ Verified: ${result.name}`;
  } catch(error) { engineStatus.textContent=`❌ ${error.message}`; }
  await checkBridge();
});
// Makes sure Stockfish can run here; explains what to do when it cannot.
async function requireEngine() {
  if(!await checkBridge()) {
    showBridgeSetup(true);
    throw Error("Stockfish runs on your own computer through the engine bridge, which is not running. See \"Engine bridge\" below.");
  }
  const info=bridgeState.status;
  if(info.engine.ready) return;
  if(INSTALL_BUSY.includes(info.install.state)) throw Error("The engine bridge is still downloading Stockfish 19. Try again when it is ready.");
  throw Error("Stockfish 19 is not installed in the engine bridge yet. Use \"Install Stockfish 19\" below.");
}


// ===========================================================================
// Live analysis: the position on the board is analysed while it is there, the
// way the Lichess analysis board does it. The engine bridge searches it
// without a depth limit and moves on with every move. The page shows whichever
// is deeper, the live analysis or the saved one, and once the live analysis is
// deeper than the saved Stockfish 19 analysis it is saved like any other
// Stockfish result (see saveLiveAnalysis). What was found is also kept for as
// long as this page is open, so going back to a position shows it again at
// once (and the search carries on from there).
// ===========================================================================
const LIVE_POLL_MS=250, LIVE_CACHE_SIZE=2000;
// While a position stays on the board, its live analysis is saved at most
// this often; leaving it saves the deepest result at once.
const LIVE_SAVE_EVERY_MS=30000;
const liveState={
  enabled:true,
  key:null,          // the position the bridge is searching for this page
  timer:null,
  sending:Promise.resolve(),   // the request to the bridge last sent
  failed:null,       // why the bridge could not search it
  elsewhere:false,   // another tab has taken the live analysis over
  cache:new Map(),   // position key -> the deepest result found
  search:0,          // counts the searches: a result keeps the one it came from
  saves:new Map(),   // position key -> {depth, at, timer, busy}: what was sent to be saved
  saveNote:null,     // the outcome of the last save, for the button's tooltip
  savePausedUntil:0  // after "too many saves": no saving before then
};
try { liveState.enabled=localStorage.getItem("chessdb_live")!=="off"; } catch(error) { /* on, the default */ }
// What the live analysis has found for a position. shownAnalysis() shows it
// when it is deeper than what is saved. Not in the Lichess view, which shows
// Lichess's evaluations only.
function liveAnalysisFor(fen) {
  if(!liveState.enabled || state.view==="lichess") return null;
  // Not before what is saved is known: a deeper saved result would replace it a moment later.
  const key=positionKey(fen);
  return state.positions.has(key)&&liveState.cache.get(key)||null;
}
// Why a live result would not be saved now, or null when it would be.
function liveSaveBlocked(entry) {
  if(entry.depth<state.minDepth) return `it is saved from depth ${state.minDepth} on`;
  if(Date.now()<liveState.savePausedUntil) return "too many saves in the last hour";
  if(!state.positions.has(positionKey(entry.fen))) return "what is saved for this position is not known yet";
  return blockedByExisting(entry.fen,"stockfish",!!state.role,entry.depth,false);
}
// Saves the live analysis of a position once it is deeper than its saved
// Stockfish 19 analysis, the same way an analysis from the button is saved
// (verified with a key, unverified without). To stay well within the site's
// limits it is saved at most every LIVE_SAVE_EVERY_MS while the position stays
// on the board; `now` (the search is leaving the position) saves at once.
function saveLiveAnalysis(key, now=false) {
  const entry=liveState.cache.get(key);
  if(!entry || !liveState.enabled) return;
  let record=liveState.saves.get(key);
  if(!record) liveState.saves.set(key,record={depth:0,at:0,timer:null,busy:false});
  // busy: looked at again when the request in flight returns.
  if(record.busy || entry.depth<=record.depth || liveSaveBlocked(entry)) return;
  const wait=record.at+LIVE_SAVE_EVERY_MS-Date.now();
  if(!now && wait>0) {
    record.timer||=setTimeout(()=>{ record.timer=null; saveLiveAnalysis(key,true); },wait);
    return;
  }
  clearTimeout(record.timer); record.timer=null;
  record.busy=true; record.depth=entry.depth; record.at=Date.now();
  // live: counted against the live analysis's own share of the hourly limit.
  api("/api/saved",{body:{fen:entry.fen,source:"stockfish",depth:entry.depth,pv:entry.pv,evaluation:entry.evaluation,live:true}})
    .then(outcome=>{
      setPosition(entry.fen,outcome.entries);
      liveState.saveNote=outcome.saved
        ? `Depth ${entry.depth} was saved${outcome.entry.verified?"":" (unverified)"}.`
        : `Depth ${entry.depth} was not saved: ${outcome.reason}`;
    },error=>{
      if(error.code==="WRITE_RATE_LIMIT"||error.code==="LIVE_WRITE_RATE_LIMIT") liveState.savePausedUntil=Math.ceil(Date.now()/3600000)*3600000;
      liveState.saveNote=`Depth ${entry.depth} was not saved: ${error.message}`;
    })
    .finally(()=>{
      record.busy=false;
      renderLiveToggle();
      saveLiveAnalysis(key);   // it may have gone deeper meanwhile
    });
}
// Is the live analysis searching this position for this page right now?
function liveSearching(fen) {
  return liveState.key===positionKey(fen) && !liveState.elsewhere && !liveState.failed;
}
function liveAvailable() {
  return bridgeState.connected && !!bridgeState.status?.live && !!bridgeState.status.engine.ready;
}
// The position the bridge should be searching now, or null for none.
function liveTarget() {
  if(!liveState.enabled || state.view==="lichess" || document.hidden || !liveAvailable()) return null;
  const fen=currentFen();
  // A Stockfish analysis of this position is running: it shows its own progress.
  const job=activeJobs.get(jobKey("stockfish",fen));
  if(job && !job.finished) return null;
  try { if(!chess.legalMoves(chess.parseFen(fen)).length) return null; } catch(error) { return null; }
  return fen;
}
function renderLiveToggle() {
  const button=document.querySelector("#live-toggle");
  button.setAttribute("aria-pressed",String(liveState.enabled));
  button.classList.toggle("unavailable",!liveAvailable() || state.view==="lichess");
  button.textContent=liveState.enabled?"Live analysis: on":"Live analysis: off";
  let note;
  if(!liveState.enabled) note="Live analysis is off. Click to analyse each position while it is on the board.";
  else if(state.view==="lichess") note="Live analysis is not used in the Lichess view.";
  else if(!bridgeState.connected) note="Live analysis runs Stockfish on this computer through the engine bridge, which is not connected (see \"Engine bridge\" below the analyse button).";
  else if(!bridgeState.status?.live) note="This engine bridge is too old for live analysis: run the install command again (Update).";
  else if(!bridgeState.status.engine.ready) note="Live analysis starts once Stockfish 19 is ready in the engine bridge.";
  else if(liveState.failed) note=`Live analysis failed: ${liveState.failed}`;
  else if(liveState.elsewhere) note="Live analysis is following another tab of this site. Click this page to bring it back.";
  else if(liveState.key) note="Live analysis is running for this position. It is shown in purple while it is deeper than the saved analysis, and saved once it is deeper than the saved Stockfish 19 analysis.";
  else note="Live analysis is on: each position is analysed while it is on the board. Click to turn it off.";
  if(liveState.enabled && liveState.saveNote) note+=`\nLast save: ${liveState.saveNote}`;
  button.title=note;
}
// Points the bridge at the position that should be searched, or stops it.
// Safe to call whenever anything changes: it only acts on a change.
function syncLiveAnalysis() {
  const fen=liveTarget(), key=fen?positionKey(fen):null;
  if(key!==liveState.key) {
    const wasSearching=liveState.key!==null;
    // Leaving a position: save the deepest it got to without waiting.
    if(wasSearching) saveLiveAnalysis(liveState.key,true);
    clearTimeout(liveState.timer);
    liveState.key=key; liveState.failed=null; liveState.elsewhere=false;
    if(key) liveState.search++;
    // One request at a time, so they reach the bridge in order; one that has
    // been overtaken by a newer position before it was sent is left out.
    if(fen) liveState.sending=liveState.sending.then(()=>{
      if(liveState.key!==key) return;
      return bridge("/api/live",{body:{fen}}).then(
        ()=>{ if(liveState.key===key) pollLiveAnalysis(key); },
        error=>{ if(liveState.key===key){ liveState.failed=error.message; syncLiveAnalysis(); } });
    });
    else if(wasSearching && bridgeState.connected) liveState.sending=liveState.sending.then(()=>{
      if(liveState.key!==null) return;
      return bridge("/api/live/stop",{method:"POST"}).catch(()=>{});
    });
  }
  renderLiveToggle();
  // The search started, stopped or failed: a result as deep as the saved one
  // turns purple or back to green.
  if(shownAnalysis(currentFen())!==state.shown) refreshShownAnalysis();
}
// Forgets which position the bridge was given, so the next sync gives it again.
function liveLost() {
  clearTimeout(liveState.timer);
  liveState.key=null; liveState.failed=null; liveState.elsewhere=false;
}
async function pollLiveAnalysis(key) {
  let view;
  try { view=await bridge("/api/live"); }
  catch(error) {
    // The bridge has gone; checkBridge picks it up again when it is back.
    if(liveState.key===key){ liveLost(); renderBridge(); syncLiveAnalysis(); }
    return;
  }
  takeLiveAnalysis(view);
  if(liveState.key!==key) return;   // moved on: the new position has its own loop
  if(!view.fen || positionKey(view.fen)!==key) {
    // Another tab gave the bridge its own position. Leave it to that tab
    // until this page is used again, so that two tabs do not take turns.
    liveState.elsewhere=true;
    syncLiveAnalysis();
    return;
  }
  if(view.status==="error") { liveState.failed=view.error||"Stockfish stopped."; syncLiveAnalysis(); return; }
  if(view.status==="done") return;   // searched as deep as Stockfish goes
  if(view.status==="idle") {
    // The bridge stopped it (this page had been quiet too long): start again.
    liveLost();
    syncLiveAnalysis();
    return;
  }
  liveState.timer=setTimeout(()=>pollLiveAnalysis(key),LIVE_POLL_MS);
}
// Keeps the deepest result the bridge has reported for each position, shows
// it if that position is on the board, and saves it if it is this page's.
function takeLiveAnalysis(view) {
  const best=view.best;
  if(!view.fen || !best || !Array.isArray(best.pv) || !best.pv.length) return;
  const key=positionKey(view.fen), cached=liveState.cache.get(key);
  if(cached && (cached.depth>best.depth || cached.depth===best.depth && cached.pv.join(" ")===best.pv.join(" ") && cached.evaluation===best.evaluation)) return;
  liveState.cache.delete(key);   // re-added at the end: the least recently found go first
  liveState.cache.set(key,{live:true,liveAnalysis:true,source:"stockfish",search:key===liveState.key?liveState.search:0,fen:view.fen,depth:best.depth,move_uci:best.pv[0],pv:best.pv,evaluation:best.evaluation,knodes:best.nodes?Math.round(best.nodes/1000):null});
  while(liveState.cache.size>LIVE_CACHE_SIZE) liveState.cache.delete(liveState.cache.keys().next().value);
  if(key===positionKey(currentFen())) refreshShownAnalysis();
  // Another tab's search is saved by that tab.
  if(key===liveState.key) saveLiveAnalysis(key);
}
document.querySelector("#live-toggle").onclick=()=>{
  playMoveSound("ui");
  liveState.enabled=!liveState.enabled;
  try { localStorage.setItem("chessdb_live",liveState.enabled?"on":"off"); } catch(error) { /* just not remembered */ }
  applyShownAnalysis(currentFen());
  render();
  if(!liveState.enabled) status("Live analysis is off");
  else if(!liveAvailable()) status("Live analysis is on. It runs Stockfish through the engine bridge: see \"Engine bridge\" below the analyse button.");
  else status("Live analysis is on");
};
// A hidden tab does not keep the engine busy, and coming back starts it
// again. Using a tab after another one had taken the analysis over takes it back.
document.addEventListener("visibilitychange",()=>{
  if(!document.hidden && liveState.elsewhere) liveLost();
  syncLiveAnalysis();
});
window.addEventListener("focus",()=>{
  if(liveState.elsewhere){ liveLost(); syncLiveAnalysis(); }
});

const openingLookups = new Map();
function jobMatchesCurrent(job) { return positionKey(job.fen)===positionKey(currentFen()); }
// The job the analyse button and the progress bar belong to: the one of the
// chosen view's engine for the position on the board.
function currentJob() {
  const fen=currentFen();
  if(state.view!=="combined") return activeJobs.get(jobKey(state.view,fen))||null;
  return activeJobs.get(jobKey("stockfish",fen))||activeJobs.get(jobKey("lichess",fen))||null;
}
// The engines the analyse button runs in the chosen view: in Combined both,
// Lichess's evaluation and Stockfish 19, at the same time.
function viewSources() { return state.view==="combined"?["lichess","stockfish"]:[state.view]; }
function setAnalyzeButtonLabel() {
  const fen=currentFen();
  const busy=viewSources().some(source=>{ const job=activeJobs.get(jobKey(source,fen)); return job&&!job.finished; });
  document.querySelector("#analyze").textContent=busy?"Stop analysis":state.view==="lichess"?"Get Lichess evaluation":"Find and save best move";
}
// The view decides what is shown and what the analyse button does:
// "stockfish" runs Stockfish 19, "lichess" fetches Lichess's evaluation, and
// "combined" shows, for each position, the deeper of the two and does both.
function setView(view) {
  state.view=Object.hasOwn(ENGINES,view)?view:"combined";
  try { localStorage.setItem("chessdb_view",state.view); } catch(error) { /* the choice just is not remembered */ }
  for(const button of document.querySelectorAll("#view-switch button"))
    button.setAttribute("aria-pressed",String(button.dataset.view===state.view));
  const combined=state.view==="combined";
  document.querySelector("#view-note").textContent=combined
    ? "Combined shows, for each position, the deeper of the Stockfish 19 and Lichess results. Its button fetches Lichess's evaluation and runs Stockfish 19 at the same time; each result is saved under its own engine."
    : state.view==="lichess"
      ? "Lichess's stored evaluation is fetched as it is; depth is not chosen here."
      : "";
  applyShownAnalysis(currentFen());
  render();
}
for(const button of document.querySelectorAll("#view-switch button"))
  button.onclick=()=>{ playMoveSound("ui"); setView(button.dataset.view); };
function loadJobPosition(job) {
  parseFen(job.fen,job.openingMoves,job.positionHistory);
  state.flipped=!!job.flipped;
  if(state.history[state.historyIndex]) state.history[state.historyIndex].flipped=state.flipped;
  rememberFlipForPosition(job.fen);
  render();
  status(job.openingName?`Loaded ${job.openingName}`:"Loaded analyzed position");
}
function dismissAnalysisJob(job) {
  if(activeJobs.get(job.key)===job) activeJobs.delete(job.key);
  renderActiveJobs();
  setAnalyzeButtonLabel();
  syncAnalysisProgressForCurrentPosition();
}
function completeAnalysisJob(job, outcome) {
  job.completed=true;
  job.finished=true;
  job.progress=100;
  job.statusText=job.source==="lichess"
    ? outcome.saved?`Lichess evaluation saved (depth ${outcome.entry.depth}).`:outcome.reason
    : outcome.saved
      ? `Analysis complete. Best move saved${outcome.entry.verified?"":" (unverified)"}.`
      : `Analysis complete. ${outcome.reason}`;
  updateJobProgressUI(job);
}
function renderActiveJobs() {
  const list=document.querySelector("#active-jobs"), label=document.querySelector("#active-jobs-label");
  const currentKeys=new Set();
  for(const job of activeJobs.values()){
    const key=job.key;
    currentKeys.add(key);
    let elements=job.elements;
    if(!elements) {
      const li=document.createElement("li");
      li.dataset.jobKey=key;
      const openingButton=document.createElement("button");
      openingButton.className="job-opening";
      openingButton.onclick=()=>{
        playMoveSound("ui");
        loadJobPosition(job);
      };
      const statusSpan=document.createElement("span");
      statusSpan.className="job-status";
      li.append(openingButton,statusSpan);
      list.appendChild(li);
      elements=job.elements={li,openingButton,statusSpan,actionMode:null};
    }
    const openingText=job.openingName
      ? `${job.openingEco} · ${job.openingName}${job.openingLine?` — ${job.openingLine}`:""}`
      : job.openingLookupPending
        ? "Looking up opening..."
        : job.openingError
          ? "Opening lookup failed"
          : "Unclassified opening";
    const openingTitle=`${job.openingError?`${job.openingError}\n`:""}${job.fen}`;
    if(elements.openingButton.textContent!==openingText) elements.openingButton.textContent=openingText;
    if(elements.openingButton.title!==openingTitle) elements.openingButton.title=openingTitle;
    const openingLabel=`Load analyzed position: ${openingText}`;
    if(elements.openingButton.getAttribute("aria-label")!==openingLabel)
      elements.openingButton.setAttribute("aria-label",openingLabel);
    const statusText=job.statusText||"Queued...";
    if(elements.statusSpan.textContent!==statusText) elements.statusSpan.textContent=statusText;
    const actionMode=job.finished?"finished":"running";
    if(elements.actionMode!==actionMode) {
      elements.li.querySelector(".job-actions, .job-dismiss, .job-running-actions")?.remove();
      elements.actionMode=actionMode;
    }
    if(actionMode==="finished" && !elements.li.querySelector(".job-dismiss")) {
      const dismissBtn=document.createElement("button");
      dismissBtn.className="job-dismiss";
      dismissBtn.textContent="Dismiss";
      dismissBtn.setAttribute("aria-label","Dismiss completed analysis");
      dismissBtn.onclick=()=>dismissAnalysisJob(job);
      elements.li.appendChild(dismissBtn);
    } else if(actionMode==="running") {
      let actions=elements.li.querySelector(".job-running-actions");
      if(!actions) {
        actions=document.createElement("span");
        actions.className="job-actions job-running-actions";
        const pauseBtn=document.createElement("button");
        pauseBtn.onclick=()=>job.paused?resumeAnalysisJob(job):pauseAnalysisJob(job);
        const stopBtn=document.createElement("button");
        stopBtn.textContent="Stop";
        stopBtn.onclick=()=>stopAnalysisJob(job);
        actions.append(pauseBtn,stopBtn);
        elements.li.appendChild(actions);
      }
      const pauseBtn=actions.children[0];
      const pauseLabel=job.paused?"Resume":"Pause";
      if(pauseBtn.textContent!==pauseLabel) pauseBtn.textContent=pauseLabel;
      pauseBtn.disabled=!job.stockfishJobId||job.cancelled||(!!job.queued&&!bridgeCanHold());
    }
  }
  for(const li of [...list.children])
    if(!currentKeys.has(li.dataset.jobKey)) li.remove();
  const hasJobs=activeJobs.size>0;
  list.style.display=hasJobs?"block":"none";
  label.style.display=hasJobs?"block":"none";
}
function syncAnalysisProgressForCurrentPosition() {
  const fen=currentFen(), job=currentJob();
  const progress=document.querySelector("#analysis-progress");
  // The job's own text is in the list of analyses; only the bar is shown here.
  if(job){
    progress.style.display="block";
    progress.value=job.progress||0;
  } else {
    progress.style.display="none";
  }
  // A job that found a new depth, or ended, changes what this position shows.
  if(shownAnalysis(fen)!==state.shown) refreshShownAnalysis();
  // A job for this position started or ended: the live analysis gives way to it, or takes over.
  else syncLiveAnalysis();
}
function updateJobProgressUI(job) {
  renderActiveJobs();
  if(jobMatchesCurrent(job)) syncAnalysisProgressForCurrentPosition();
}
// Keeps what a job's analysis has found so far; shownAnalysis() puts it on
// the page while the job runs. `found` is {depth, pv, evaluation, knodes?}.
function setLiveAnalysis(job, source, found) {
  job.live={live:true,source,fen:job.fen,depth:found.depth,move_uci:found.pv[0],pv:found.pv,evaluation:found.evaluation,knodes:found.knodes||null};
}
// `best` is the bridge's report of the deepest depth Stockfish has searched
// to the end (absent until depth 1 is done, and from a bridge before 1.0.4).
function noteEngineBest(job, best) {
  if(!best || !Array.isArray(best.pv) || !best.pv.length) return;
  if(job.live?.source==="stockfish" && job.live.depth===best.depth) return;
  setLiveAnalysis(job,"stockfish",best);
}
// Sends what a Stockfish run produced to the server and reports the outcome
// on the job. For a run that was stopped, that is the deepest depth it had
// searched to the end: stopped while on depth 40, depth 39 is saved. Nothing
// is saved below the site's least depth (21).
async function saveStockfishAnalysis(job, analysis) {
  if(!analysis.partial) {
    completeAnalysisJob(job,await saveAnalysisFor(job.fen,analysis));
    return;
  }
  let result=analysis.depth<state.minDepth
    ? `Nothing was saved: depth ${analysis.depth} had been finished, and the least that is saved is depth ${state.minDepth}.`
    : blockedByExisting(job.fen,"stockfish",!!state.role,analysis.depth,false);
  if(!result) {
    const outcome=await saveAnalysisFor(job.fen,analysis);
    result=outcome.saved?`Depth ${analysis.depth} result saved${outcome.entry.verified?"":" (unverified)"}.`:outcome.reason;
  }
  job.finished=true;
  job.statusText=`Analysis stopped at depth ${analysis.stoppedAt}. ${result}`;
  updateJobProgressUI(job);
}
// Runs Stockfish through the bridge and sends the result to the server.
async function runStockfishAndSave(job, target) {
  const blocked=blockedByExisting(job.fen,"stockfish",!!state.role,target);
  if(blocked) {
    job.statusText=blocked;
    job.finished=true;
    updateJobProgressUI(job);
    return;
  }
  await requireEngine();
  const analysis=await analyzeWithStockfish(job,job.fen,target);
  if(analysis) await saveStockfishAnalysis(job,analysis);
}
// Lichess view: asks Lichess for the evaluation it has stored and has the
// server save it. Below the least depth it is only shown, for as long as the
// job stays in the list.
async function fetchLichessAndSave(job) {
  const remaining=Math.ceil((state.lichessRetryUntil-Date.now())/1000);
  if(remaining>0) throw Error(`Lichess Cloud rate limit. Try again in about ${remaining} seconds.`);
  job.statusText="Asking Lichess for its evaluation...";
  updateJobProgressUI(job);
  const cloud=await cloudEval(job.fen);
  if(job.cancelled) return;
  const end=text=>{ job.statusText=text; job.finished=true; updateJobProgressUI(job); };
  if(!cloud.lines.length) {
    end(cloud.unreachable?"Lichess could not be reached.":"Lichess has no evaluation for this position.");
    return;
  }
  setLiveAnalysis(job,"lichess",{depth:cloud.depth,knodes:cloud.knodes,pv:cloud.lines[0].pv,evaluation:cloud.lines[0].evaluation});
  if(cloud.depth<state.minDepth) {
    job.unsaved=true;
    end(`Lichess has depth ${cloud.depth} for this position. It is shown but not saved: the least that is saved is depth ${state.minDepth}.`);
    return;
  }
  const blocked=blockedByExisting(job.fen,"lichess",true,cloud.depth);
  if(blocked) { end(blocked); return; }
  completeAnalysisJob(job,await saveAnalysisFor(job.fen,{source:"lichess"}));
}
async function lookupOpeningForJob(job) {
  const key=`${positionKey(job.fen)}|${job.openingMoves?.join(" ")||""}`;
  let lookup=openingLookups.get(key);
  if(!lookup){
    lookup=lookupOpening(job.fen,job.openingMoves)
      .then(result=>({name:result.name,eco:result.eco,line:result.line}))
      .catch(error=>({error:error.message}));
    openingLookups.set(key,lookup);
  }
  job.openingLookupPending=true;
  updateJobProgressUI(job);
  const result=await lookup;
  job.openingLookupPending=false;
  if(result.error) {
    if(openingLookups.get(key)===lookup) openingLookups.delete(key);
    job.openingError=result.error;
  }
  else { job.openingName=result.name; job.openingEco=result.eco; job.openingLine=result.line; }
  updateJobProgressUI(job);
}
async function stopAnalysisJob(job) {
  if(!job || job.cancelled) return;
  job.cancelled=true;
  job.cancelledAt=Date.now();
  job.statusText="Stopping analysis...";
  updateJobProgressUI(job);
  if(job.stockfishJobId) {
    try { await bridge(`/api/analyze/${job.stockfishJobId}/stop`,{method:"POST"}); } catch(e) {}
  }
}
// Bridges from 1.0.5 on can hold a job that is still waiting in the queue.
function bridgeCanHold() {
  return !!bridgeState.status && versionAtLeast(bridgeState.status.version,"1.0.5");
}
async function pauseAnalysisJob(job) {
  if(!job || job.cancelled || !job.stockfishJobId || job.paused) return;
  if(job.queued && !bridgeCanHold()) return;
  try {
    const answer=await bridge(`/api/analyze/${job.stockfishJobId}/pause`,{method:"POST"});
    job.paused=true;
    if(answer?.status==="held") { job.queued=true; job.statusText=queuedText({held:true}); }
    else { job.queued=false; job.statusText=`Paused at depth ${job.depth||0}/${job.target||"?"}`; }
  } catch(e) { job.statusText=e.message; }
  updateJobProgressUI(job);
}
async function resumeAnalysisJob(job) {
  if(!job || job.cancelled || !job.stockfishJobId || !job.paused) return;
  try {
    const answer=await bridge(`/api/analyze/${job.stockfishJobId}/resume`,{method:"POST"});
    job.paused=false;
    if(answer?.status==="queued") { job.queued=true; job.statusText=queuedText({}); }
    else { job.queued=false; job.statusText=`Analyzing Stockfish... depth ${job.depth||0}/${job.target||"?"}`; }
  } catch(e) { job.statusText=e.message; }
  updateJobProgressUI(job);
}
async function analyzeWithStockfish(job, fen, target) {
  job.target=target;
  job.statusText=`Analyzing Stockfish... depth 0/${target}`;
  updateJobProgressUI(job);
  const started=await bridge("/api/analyze",{body:{
    fen,
    depth:target,
    // Kept by the bridge so a reloaded page can show the job as it was.
    context:{openingMoves:job.openingMoves,positionHistory:job.positionHistory,flipped:job.flipped}
  }});
  job.stockfishJobId=started.job_id;
  if(started.status==="queued") showQueued(job,started);
  if(job.cancelled) {
    try { await bridge(`/api/analyze/${started.job_id}/stop`,{method:"POST"}); } catch(e) {}
    job.statusText="Analysis stopped"; updateJobProgressUI(job);
    return null;
  }
  return pollStockfishJob(job,started.job_id);
}
function queuedText(view) {
  if(view.held) return "Paused while waiting in the queue. Analyses behind it start first; press Resume to put it back in line.";
  return `Waiting for a free engine slot${view.queue_position?` (number ${view.queue_position} in the queue)`:""}; it starts by itself.`;
}
function showQueued(job, view) {
  job.queued=true;
  job.paused=!!view.held;
  job.depth=0;
  job.progress=0;
  job.statusText=queuedText(view);
  updateJobProgressUI(job);
}
// Follows a job on the bridge to its end. Returns the analysis to save: the
// full result, or, for a job that was stopped, the deepest depth it had
// finished ({partial:true}). Returns null when there is nothing to save.
async function pollStockfishJob(job, jobId) {
  const LIMIT_MS=12*60*60*1000, STOP_WAIT_MS=5000;
  let d, failures=0, worked=0, last=Date.now();
  for(;;){
    // A waiting job changes rarely; look at it less often. After Stop the
    // bridge reports the job as stopped within moments.
    await new Promise(r=>setTimeout(r,job.cancelled?150:job.queued?1500:500));
    try {
      d=await bridge(`/api/analyze/${jobId}`);
      failures=0;
    } catch(error) {
      if(job.cancelled) { d=null; break; }
      // Ride out a short hiccup; give up if the bridge is really gone.
      if(error.status || ++failures>=6) throw error.status?error:Error("Lost contact with the engine bridge. If it is still running, reconnect to pick the analysis up again.");
      continue;
    }
    const now=Date.now();
    // Time spent waiting in the queue does not count towards the limit.
    if(d.status!=="queued") worked+=now-last;
    last=now;
    if(!["queued","running","paused"].includes(d.status)) break;
    if(job.cancelled) {
      // Stop was pressed: wait for the bridge to confirm it, because the
      // stopped job then holds the last depth it finished.
      if(now-job.cancelledAt>STOP_WAIT_MS) break;
      continue;
    }
    if(d.status==="queued"){
      showQueued(job,d);
      continue;
    }
    job.queued=false;
    if(worked>LIMIT_MS) break;
    noteEngineBest(job,d.best);
    if(d.status==="running"){
      job.paused=false;
      job.depth=d.depth||0;
      job.progress=d.progress||0;
      job.statusText=`Analyzing Stockfish... depth ${job.depth}/${d.target_depth}`;
      updateJobProgressUI(job);
      continue;
    }
    if(d.status==="paused"){
      job.paused=true;
      job.depth=d.depth||0;
      job.statusText=`Paused at depth ${job.depth}/${d.target_depth}`;
      updateJobProgressUI(job);
      continue;
    }
  }
  job.queued=false;
  if(d?.status==="complete" && d.result) {
    job.progress=100;
    updateJobProgressUI(job);
    return {source:"stockfish",depth:d.result.depth,pv:d.result.pv,evaluation:d.result.evaluation};
  }
  if(job.cancelled || d?.status==="stopped") {
    const best=d?.status==="stopped"?d.best:null;
    if(best && Array.isArray(best.pv) && best.pv.length)
      return {source:"stockfish",depth:best.depth,pv:best.pv,evaluation:best.evaluation,partial:true,stoppedAt:d.depth};
    job.finished=true;
    job.statusText="Analysis stopped";
    updateJobProgressUI(job);
    return null;
  }
  if(!d||d.status==="running"||d.status==="paused") throw Error("Stockfish analysis did not finish within 12 hours");
  if(d.status==="error") throw Error(d.error);
  throw Error("Stockfish returned an invalid analysis status.");
}
function clonePosition(position) {
  return {
    ...position,
    board:Array.isArray(position.board)?position.board.map(row=>[...row]):[],
    openingMoves:Array.isArray(position.openingMoves)?[...position.openingMoves]:[],
    captured:position.captured
      ? {w:[...(position.captured.w||[])],b:[...(position.captured.b||[])]}
      : {w:[],b:[]}
  };
}
// Picks up analyses the bridge is still running (or finished while this page
// was closed) and carries them through to saving.
async function restoreActiveAnalyses() {
  const jobs=await bridge("/api/analyze");
  for(const savedJob of jobs) {
    if(!savedJob.job_id || !savedJob.fen) continue;
    const key=jobKey("stockfish",savedJob.fen);
    const existing=activeJobs.get(key);
    if(existing) {
      if(!existing.finished || existing.completed) continue;
      existing.elements?.li.remove();   // a job that lost contact earlier is replaced
    }
    const context=savedJob.context&&typeof savedJob.context==="object"?savedJob.context:{};
    const target=savedJob.target_depth||state.fullDepth;
    const depth=savedJob.depth||0;
    const job={
      key,
      source:"stockfish",
      fen:savedJob.fen,
      flipped:!!context.flipped,
      cancelled:false,
      finished:false,
      completed:false,
      stockfishJobId:savedJob.job_id,
      depth,
      progress:savedJob.progress||0,
      target,
      statusText:savedJob.status==="paused"
        ? `Paused at depth ${depth}/${target}`
        : savedJob.status==="complete"
          ? "Collecting the finished analysis..."
          : savedJob.status==="queued"
            ? queuedText(savedJob)
            : `Analyzing Stockfish... depth ${depth}/${target}`,
      paused:savedJob.status==="paused"||!!savedJob.held,
      queued:savedJob.status==="queued",
      openingMoves:Array.isArray(context.openingMoves)?[...context.openingMoves]:null,
      positionHistory:Array.isArray(context.positionHistory)&&context.positionHistory.length
        ? context.positionHistory.map(clonePosition)
        : null
    };
    noteEngineBest(job,savedJob.best);
    activeJobs.set(key,job);
    void lookupOpeningForJob(job);
    void (async()=>{
      try {
        const analysis=await pollStockfishJob(job,job.stockfishJobId);
        if(analysis) await saveStockfishAnalysis(job,analysis);
      } catch(error) {
        job.statusText=error.message;
        job.finished=true;
        updateJobProgressUI(job);
      } finally {
        renderActiveJobs();
        setAnalyzeButtonLabel();
        if(jobMatchesCurrent(job)) syncAnalysisProgressForCurrentPosition();
      }
    })();
  }
  renderActiveJobs();
  setAnalyzeButtonLabel();
  syncAnalysisProgressForCurrentPosition();
}
document.querySelector("#load").onclick=()=>{playMoveSound("ui");try{parseFen(fenEl.value);status("Position loaded")}catch(e){status(e.message)}};
document.querySelector("#copy-fen").onclick=async()=>{
  try {
    await navigator.clipboard.writeText(currentFen());
    status("Current position FEN copied");
  } catch(error) {
    status(`Could not copy FEN: ${error.message}`);
  }
};
document.querySelector("#history-first").onclick=()=>{showHistoryPosition(0);status("Moved to the first position");};
document.querySelector("#history-back").onclick=()=>undoMove();
document.querySelector("#history-forward").onclick=()=>{if(state.historyIndex<state.history.length-1){showHistoryPosition(state.historyIndex+1);status("Moved forward one position");}};
document.querySelector("#history-last").onclick=()=>{showHistoryPosition(state.history.length-1);status("Moved to the latest position");};
document.querySelector("#board-wrap").addEventListener("wheel",e=>{
  if(!state.history.length || !e.deltaY) return;
  e.preventDefault();
  const next=state.historyIndex+(e.deltaY>0?1:-1);
  if(next!==state.historyIndex) {
    showHistoryPosition(next);
    status(e.deltaY>0?"Moved forward one position":"Moved back one position");
  }
},{passive:false});
document.querySelector("#flip").onclick=()=>{
  playMoveSound("ui");
  state.flipped=!state.flipped;
  const current=state.history[state.historyIndex];
  if(current) current.flipped=state.flipped;
  rememberFlipForPosition();
  render();
  status(state.flipped?"Board flipped":"Board restored");
};
// Asks Lichess for its cached evaluation straight from the browser (shown to
// the user and used to decide whether Stockfish is needed). What gets saved
// is fetched again by the server, so nothing here has to be trusted.
//
// multiPv=1 on purpose. Lichess keeps several evaluations per position and
// answers with the deepest one that has at least the number of lines asked
// for. Its deepest evaluations are mostly single-line ones (that is what the
// Lichess analysis board shows), so asking for more lines gets a shallower
// answer.
async function cloudEval(fen) {
  const nothing={depth:0,knodes:null,lines:[]};
  let response;
  try {
    response=await fetch(`https://lichess.org/api/cloud-eval?${new URLSearchParams({fen,multiPv:"1"})}`,{headers:{Accept:"application/json"}});
  } catch(error) {
    return {...nothing,unreachable:true};
  }
  if(response.status===429) {
    const retryAfter=Number(response.headers.get("Retry-After"));
    const seconds=retryAfter>0?retryAfter:60;
    state.lichessRetryUntil=Date.now()+seconds*1000;
    const failure=Error(retryAfter>0
      ? `Lichess Cloud rate limit. Try again in about ${seconds} seconds.`
      : "Lichess Cloud rate limit. Lichess asks to wait about a minute before trying again.");
    failure.code="LICHESS_RATE_LIMIT";
    throw failure;
  }
  if(!response.ok) return response.status===404?nothing:{...nothing,unreachable:true};
  let data;
  try { data=await response.json(); } catch(error) { return {...nothing,unreachable:true}; }
  const lines=[];
  for(const pv of Array.isArray(data.pvs)?data.pvs:[]) {
    const replay=chess.replayUci(fen,String(pv.moves||"").split(/\s+/).filter(Boolean));
    if(!replay.uci.length) continue;
    const cp=Number(pv.cp)||0;
    lines.push({
      pv:replay.uci,
      // Written like a Stockfish score: "+0.32" or "#-3", from White's side.
      evaluation:Number.isInteger(pv.mate)?`#${pv.mate}`:`${cp>=0?"+":"-"}${(Math.abs(cp)/100).toFixed(2)}`
    });
  }
  return {depth:Number(data.depth)||0,knodes:data.knodes,lines};
}
// Runs the analyses of the chosen view for the position on the board: one
// engine's, or in Combined both at once. Pressed while one of them runs, it
// stops them.
document.querySelector("#analyze").onclick=async()=>{
  playMoveSound("ui");
  const fen=currentFen(), sources=viewSources();
  const existing=sources.map(source=>activeJobs.get(jobKey(source,fen))).filter(Boolean);
  const running=existing.filter(job=>!job.finished);
  if(running.length) { await Promise.all(running.map(stopAnalysisJob)); return; }
  // An engine whose finished result is still in the list is not run again.
  const free=sources.filter(source=>!activeJobs.has(jobKey(source,fen)));
  if(!free.length) {
    status(`Dismiss the finished result${existing.length>1?"s":""} before analyzing this position again.`);
    return;
  }
  try {
    if(!chess.legalMoves(chess.parseFen(fen)).length){ status("The game is already over in this position."); return; }
  } catch(error) {
    status(`This position cannot be analysed: ${error.message}`);
    return;
  }
  rememberFlipForPosition(fen);
  await Promise.all(free.map(source=>runAnalysisJob(source,fen)));
};
// One engine's analysis of a position, from the list entry to the save.
async function runAnalysisJob(source, fen) {
  const key=jobKey(source,fen);
  const target=source==="stockfish"?chosenDepth():0;
  const job={key,source,fen,flipped:state.flipped,cancelled:false,finished:false,completed:false,stockfishJobId:null,depth:0,progress:0,target,statusText:"Queued...",openingMoves:state.openingTracking?[...state.openingMoves]:null,positionHistory:state.history.slice(0,state.historyIndex+1).map(clonePosition)};
  activeJobs.set(key,job);
  setAnalyzeButtonLabel();
  updateJobProgressUI(job);
  void lookupOpeningForJob(job);
  try{
    // What is already saved decides whether a new analysis could replace it.
    await loadPosition(fen);
    if(job.cancelled) return;
    if(source==="lichess") await fetchLichessAndSave(job);
    else await runStockfishAndSave(job,target);
  }catch(e){
    job.statusText=e.message;
    job.finished=true;
    updateJobProgressUI(job);
  }
  finally{
    if(!job.finished) {
      job.finished=true;
      if(job.cancelled) job.statusText="Analysis stopped.";
    }
    renderActiveJobs();
    setAnalyzeButtonLabel();
    if(jobMatchesCurrent(job)) syncAnalysisProgressForCurrentPosition();
  }
}
// Removes the saved entry that is on screen (one engine's; the other stays).
document.querySelector("#remove").onclick=async()=>{
  const fen=currentFen(), shown=savedMatch(fen);
  if(!shown) { status("There is no saved move for this position in this view"); return; }
  if(shown.imported) { status("This evaluation comes from the imported Lichess database and cannot be removed here"); return; }
  try {
    const result=await api("/api/remove",{body:{fen,source:shown.source}});
    setPosition(fen,result.entries);
    status(result.removed?`${ENGINES[shown.source]} move removed (it stays in the history and can be restored)`:"There is no saved move for this position");
  } catch(e) { status(e.message); }
};

// ===========================================================================
// Admin tools: import, backup, contributor keys, history.
// ===========================================================================
function adminNote(text) { document.querySelector("#admin-note").textContent=text; }
// Accepts the old app's saved_positions.json (SAN lines, text depth) as well
// as a backup downloaded from this site, and turns either into what the
// server stores.
function toImportEntry(raw) {
  if(!raw || typeof raw.fen!=="string") throw Error("no FEN");
  let pv=[];
  if(Array.isArray(raw.pv) && raw.pv.length) {
    pv=/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(raw.pv[0])
      ? chess.replayUci(raw.fen,raw.pv).uci
      : chess.replaySan(raw.fen,raw.pv).uci;
  }
  if(!pv.length && typeof raw.move_uci==="string") pv=chess.replayUci(raw.fen,[raw.move_uci]).uci;
  if(!pv.length) throw Error("the saved move is not legal in its position");
  const depthText=String(raw.depth??"");
  const depth=Number.isInteger(raw.depth)?raw.depth:Number((/(\d+)/.exec(depthText)||[])[1]);
  if(!Number.isInteger(depth) || depth<1) throw Error("no depth");
  const knodesMatch=/(\d+)k nodes/.exec(depthText);
  const knodes=Number.isInteger(raw.knodes)?raw.knodes:knodesMatch?Number(knodesMatch[1]):null;
  const source=/lichess/i.test(String(raw.source||""))?"lichess":"stockfish";
  // A backup marks unverified entries (false or 0); they stay unverified.
  // The old saved_positions.json has no such mark and imports as verified.
  const verified=!(raw.verified===false || raw.verified===0);
  return {fen:raw.fen,pv,evaluation:String(raw.evaluation??""),depth,knodes,source,verified,saved_at:raw.saved_at};
}
document.querySelector("#import-file").addEventListener("change",async e=>{
  const file=e.target.files[0];
  e.target.value="";
  if(!file) return;
  try {
    const parsed=JSON.parse(await file.text());
    const records=Array.isArray(parsed)?parsed:Array.isArray(parsed.saved)?parsed.saved:null;
    if(!records) throw Error("This file is not a saved_positions.json or a My Chess DB backup.");
    const entries=[], skipped=[];
    records.forEach((raw,index)=>{
      try { entries.push(toImportEntry(raw)); }
      catch(error) { skipped.push(`#${index+1} ${String(raw?.fen||"").split(" ")[0]}: ${error.message}`); }
    });
    let stored=0, kept=0;
    for(let start=0;start<entries.length;start+=100) {
      adminNote(`Importing... ${start}/${entries.length}`);
      const result=await api("/api/import",{body:{entries:entries.slice(start,start+100)}});
      stored+=result.stored; kept+=result.kept_existing;
      for(const item of result.invalid) skipped.push(`#${start+item.index+1} ${String(item.fen||"").split(" ")[0]}: ${item.error}`);
    }
    reloadPositions();
    adminNote(`Import finished: ${stored} stored, ${kept} already present with equal or deeper analysis, ${skipped.length} skipped.`
      +(skipped.length?`\nSkipped:\n${skipped.join("\n")}`:""));
  } catch(error) { adminNote(`Import failed: ${error.message}`); }
});
document.querySelector("#import-button").onclick=()=>document.querySelector("#import-file").click();
document.querySelector("#export-button").onclick=async()=>{
  try {
    const backup=await api("/api/export");
    const link=document.createElement("a");
    link.href=URL.createObjectURL(new Blob([JSON.stringify(backup,null,1)],{type:"application/json"}));
    link.download=`mychessdb-backup-${new Date().toISOString().slice(0,10)}.json`;
    link.click();
    setTimeout(()=>URL.revokeObjectURL(link.href),1000);
    adminNote(`Backup downloaded: ${backup.saved.length} saved positions, ${backup.history.length} history entries.`);
  } catch(error) { adminNote(error.message); }
};
async function renderKeys() {
  const list=document.querySelector("#key-list");
  const {keys}=await api("/api/keys");
  list.innerHTML="";
  if(!keys.length) { const li=document.createElement("li"); li.textContent="No contributor keys yet."; list.appendChild(li); }
  for(const key of keys) {
    const li=document.createElement("li");
    const label=document.createElement("span");
    label.className="admin-item-text";
    label.textContent=`${key.label} · ${key.entries} saved · ${key.revoked_at?"revoked":"active"}`;
    li.appendChild(label);
    if(!key.revoked_at) {
      for(const [text,demote] of [["Revoke",false],["Revoke + unverify entries",true]]) {
        const button=document.createElement("button");
        button.textContent=text;
        button.onclick=async()=>{
          try {
            const result=await api("/api/keys/revoke",{body:{id:key.id,demote}});
            adminNote(`Key "${key.label}" revoked${demote?`; ${result.demoted} of its entries are now unverified`:""}.`);
            await renderKeys(); reloadPositions();
          } catch(error) { adminNote(error.message); }
        };
        li.appendChild(button);
      }
    }
    list.appendChild(li);
  }
}
document.querySelector("#keys-button").onclick=()=>renderKeys().catch(error=>adminNote(error.message));
document.querySelector("#new-key-button").onclick=async()=>{
  const input=document.querySelector("#new-key-label");
  try {
    const created=await api("/api/keys",{body:{label:input.value}});
    input.value="";
    adminNote(`Key for "${created.label}" (shown only once, copy it now):\n${created.key}`);
    await renderKeys();
  } catch(error) { adminNote(error.message); }
};
document.querySelector("#history-button").onclick=async()=>{
  const list=document.querySelector("#history-list");
  try {
    const fen=currentFen();
    const {history}=await api(`/api/history?fen=${encodeURIComponent(fen)}`);
    list.innerHTML="";
    if(!history.length) { const li=document.createElement("li"); li.textContent="No history for this position."; list.appendChild(li); }
    for(const item of history) {
      const li=document.createElement("li");
      const label=document.createElement("span");
      label.className="admin-item-text";
      let san=item.move_uci;
      try { san=chess.replayUci(item.fen,item.pv).san[0]||item.move_uci; } catch(error) { /* keep UCI */ }
      label.textContent=`${ENGINES[item.source]||item.source} · ${san} · ${item.evaluation} · depth ${item.depth}${item.verified?"":" · unverified"} · ${item.reason} ${item.archived_at.slice(0,16).replace("T"," ")}`;
      const button=document.createElement("button");
      button.textContent="Restore";
      button.onclick=async()=>{
        try {
          const result=await api("/api/restore",{body:{id:item.id}});
          setPosition(fen,result.entries);
          adminNote(`Restored ${san} (${ENGINES[item.source]||item.source}, depth ${item.depth}) for this position.`);
          document.querySelector("#history-button").click();
        } catch(error) { adminNote(error.message); }
      };
      li.append(label,button);
      list.appendChild(li);
    }
  } catch(error) { adminNote(error.message); }
};

(async()=>{
  let view="combined";
  try { view=localStorage.getItem("chessdb_view")||view; } catch(error) { /* start with the combined view */ }
  parseFen(chess.START_FEN);
  setView(view);
  try {
    await loadSession();
  } catch(e) { status(e.message); }
  // Only look for the bridge by ourselves if this browser has used it before.
  if(localStorage.getItem("chessdb_bridge_used")) await checkBridge();
})();

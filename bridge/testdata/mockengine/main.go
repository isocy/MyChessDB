// mockengine: a stand-in for Stockfish used only by the automated tests.
// It speaks just enough UCI to exercise the bridge and knows nothing about
// chess: it "searches" by counting up to the requested depth.
//
// Environment:
//
//	MOCK_NAME      engine name to report (default "Stockfish 19")
//	MOCK_DELAY_MS  pause between depths (default 15)
//	MOCK_SCORE     score to report, e.g. "cp 32" or "mate 3" (default "cp 32")
//	MOCK_PV_WHITE / MOCK_PV_BLACK  principal variation by side to move
//	MOCK_LOG       file that receives every command the engine was sent
package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func main() {
	out := bufio.NewWriter(os.Stdout)
	var outMu sync.Mutex
	say := func(format string, args ...any) {
		outMu.Lock()
		fmt.Fprintf(out, format+"\n", args...)
		out.Flush()
		outMu.Unlock()
	}
	var logFile *os.File
	if path := os.Getenv("MOCK_LOG"); path != "" {
		logFile, _ = os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	}
	delay, _ := strconv.Atoi(env("MOCK_DELAY_MS", "15"))
	score := env("MOCK_SCORE", "cp 32")
	blackToMove := false
	var stop chan struct{}
	var done sync.WaitGroup

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if logFile != nil {
			fmt.Fprintln(logFile, line)
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "uci":
			say("id name %s", env("MOCK_NAME", "Stockfish 19"))
			say("id author the Stockfish developers (see AUTHORS file)")
			say("")
			say("option name Threads type spin default 1 min 1 max 1024")
			say("option name Hash type spin default 16 min 1 max 33554432")
			say("option name MultiPV type spin default 1 min 1 max 256")
			say("option name Syzygy50MoveRule type check default true")
			say("option name Debug Log File type string default <empty>")
			say("uciok")
		case "isready":
			say("readyok")
		case "position":
			blackToMove = len(fields) > 3 && fields[1] == "fen" && fields[3] == "b"
		case "go":
			depth := 10
			for i := 1; i+1 < len(fields); i++ {
				if fields[i] == "depth" {
					depth, _ = strconv.Atoi(fields[i+1])
				}
			}
			pv := env("MOCK_PV_WHITE", "e2e4 e7e5 g1f3 b8c6")
			if blackToMove {
				pv = env("MOCK_PV_BLACK", "e7e5 g1f3 b8c6 f1b5")
			}
			stop = make(chan struct{})
			done.Add(1)
			go func(stop chan struct{}) {
				defer done.Done()
				say("info string NNUE evaluation using nn-mock.nnue")
				for d := 1; d <= depth; d++ {
					select {
					case <-stop:
						say("bestmove %s", strings.Fields(pv)[0])
						return
					case <-time.After(time.Duration(delay) * time.Millisecond):
					}
					say("info depth %d currmove e2e4 currmovenumber 1", d)
					say("info depth %d seldepth %d multipv 1 score cp 999 upperbound nodes %d nps 1000 hashfull 5 tbhits 0 time %d pv a2a3", d, d+3, d*900, d*delay)
					say("info depth %d seldepth %d multipv 1 score %s nodes %d nps 1000 hashfull 5 tbhits 0 time %d pv %s", d, d+3, score, d*1000, d*delay, pv)
				}
				say("bestmove %s ponder %s", strings.Fields(pv)[0], strings.Fields(pv)[len(strings.Fields(pv))-1])
			}(stop)
		case "stop":
			if stop != nil {
				close(stop)
				stop = nil
			}
		case "quit":
			if stop != nil {
				close(stop)
			}
			done.Wait()
			return
		}
	}
}

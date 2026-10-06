package main

// Minimal UCI (Universal Chess Interface) driver: start an engine process,
// talk to it over stdin/stdout, and parse its "info" lines.

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

type uciProc struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	lines chan string // closed when the engine's stdout ends

	killOnce sync.Once
}

// startUCI launches the engine. The caller must eventually call kill().
func startUCI(path string) (*uciProc, error) {
	cmd := exec.Command(path)
	configureChild(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	adoptChild(cmd)
	p := &uciProc{cmd: cmd, stdin: stdin, lines: make(chan string, 256)}
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for scanner.Scan() {
			p.lines <- strings.TrimRight(scanner.Text(), "\r")
		}
		close(p.lines)
	}()
	return p, nil
}

func (p *uciProc) pid() int {
	if p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

func (p *uciProc) send(command string) error {
	_, err := io.WriteString(p.stdin, command+"\n")
	return err
}

var errEngineExited = errors.New("the engine process exited unexpectedly")

// waitFor reads lines until one equals `token` (or starts with `token `).
// Every line read, including the matching one, is passed to onLine.
func (p *uciProc) waitFor(token string, timeout time.Duration, onLine func(string)) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case line, ok := <-p.lines:
			if !ok {
				return errEngineExited
			}
			if onLine != nil {
				onLine(line)
			}
			if line == token || strings.HasPrefix(line, token+" ") {
				return nil
			}
		case <-timer.C:
			return fmt.Errorf("the engine did not answer %q within %s", token, timeout)
		}
	}
}

// kill ends the process and reaps it. Safe to call more than once.
func (p *uciProc) kill() {
	p.killOnce.Do(func() {
		_ = p.stdin.Close()
		if p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
		go func() {
			for range p.lines { // let the reader goroutine finish
			}
		}()
		_ = p.cmd.Wait()
	})
}

// quit asks the engine to exit, then makes sure it is gone.
func (p *uciProc) quit() {
	_ = p.send("quit")
	done := make(chan struct{})
	go func() {
		for range p.lines {
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
	p.kill()
}

type engineIdentity struct {
	Name    string
	Author  string
	Options map[string]bool
}

// handshake performs "uci" ... "uciok" and reports what the engine says it is.
func (p *uciProc) handshake(timeout time.Duration) (engineIdentity, error) {
	id := engineIdentity{Options: map[string]bool{}}
	if err := p.send("uci"); err != nil {
		return id, err
	}
	err := p.waitFor("uciok", timeout, func(line string) {
		switch {
		case strings.HasPrefix(line, "id name "):
			id.Name = strings.TrimSpace(strings.TrimPrefix(line, "id name "))
		case strings.HasPrefix(line, "id author "):
			id.Author = strings.TrimSpace(strings.TrimPrefix(line, "id author "))
		case strings.HasPrefix(line, "option name "):
			rest := strings.TrimPrefix(line, "option name ")
			if i := strings.Index(rest, " type "); i >= 0 {
				rest = rest[:i]
			}
			id.Options[strings.TrimSpace(rest)] = true
		}
	})
	return id, err
}

// uciInfo is one parsed "info ..." line.
type uciInfo struct {
	HasDepth bool
	Depth    int
	MultiPV  int
	HasScore bool
	IsMate   bool
	Score    int  // centipawns, or moves to mate; from the side to move's view
	Bound    bool // lowerbound / upperbound: not an exact score
	Nodes    int64
	TimeMs   int64
	PV       []string
}

func parseInfo(line string) (uciInfo, bool) {
	fields := strings.Fields(line)
	info := uciInfo{MultiPV: 1}
	if len(fields) == 0 || fields[0] != "info" {
		return info, false
	}
	atoi := func(i int) (int64, bool) {
		if i >= len(fields) {
			return 0, false
		}
		n, err := strconv.ParseInt(fields[i], 10, 64)
		return n, err == nil
	}
	for i := 1; i < len(fields); i++ {
		switch fields[i] {
		case "depth":
			if n, ok := atoi(i + 1); ok {
				info.Depth, info.HasDepth = int(n), true
			}
			i++
		case "multipv":
			if n, ok := atoi(i + 1); ok {
				info.MultiPV = int(n)
			}
			i++
		case "nodes":
			if n, ok := atoi(i + 1); ok {
				info.Nodes = n
			}
			i++
		case "time":
			if n, ok := atoi(i + 1); ok {
				info.TimeMs = n
			}
			i++
		case "seldepth", "nps", "hashfull", "tbhits", "currmovenumber", "cpuload", "currmove":
			i++
		case "wdl":
			i += 3
		case "score":
			if i+2 < len(fields) && (fields[i+1] == "cp" || fields[i+1] == "mate") {
				if n, ok := atoi(i + 2); ok {
					info.HasScore, info.IsMate, info.Score = true, fields[i+1] == "mate", int(n)
				}
				i += 2
			}
		case "lowerbound", "upperbound":
			info.Bound = true
		case "pv":
			info.PV = append([]string(nil), fields[i+1:]...)
			return info, true
		case "string", "refutation", "currline":
			return info, true
		}
	}
	return info, true
}

// formatEvaluation renders a score from White's point of view the way the
// site shows it: "+0.32" in pawns, or "#3" / "#-3" for forced mates.
func formatEvaluation(info uciInfo, blackToMove bool) string {
	score := info.Score
	if blackToMove {
		score = -score
	}
	if info.IsMate {
		return fmt.Sprintf("#%d", score)
	}
	return fmt.Sprintf("%+.2f", float64(score)/100)
}

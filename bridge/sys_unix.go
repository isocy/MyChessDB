//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// suspendProcess freezes a process so it uses no CPU but keeps its memory.
func suspendProcess(pid int) error {
	return syscall.Kill(pid, syscall.SIGSTOP)
}

func resumeProcess(pid int) error {
	return syscall.Kill(pid, syscall.SIGCONT)
}

// adoptChild lowers the engine's priority ("nice") right after it starts, so
// the browser and other programs get the processor first. The search threads
// Stockfish creates later inherit it.
func adoptChild(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Setpriority(syscall.PRIO_PROCESS, cmd.Process.Pid, 10)
	}
}

const engineExeSuffix = ""

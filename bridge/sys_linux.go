//go:build linux

package main

import (
	"os/exec"
	"syscall"
)

func totalMemoryMB() int {
	var info syscall.Sysinfo_t
	if err := syscall.Sysinfo(&info); err != nil {
		return 0
	}
	return int(uint64(info.Totalram) * uint64(info.Unit) / (1024 * 1024))
}

// configureChild makes the kernel kill the engine if the bridge dies, so a
// crashed bridge never leaves Stockfish running (or frozen) in the background.
func configureChild(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}

func openBrowser(url string) error {
	return exec.Command("xdg-open", url).Start()
}

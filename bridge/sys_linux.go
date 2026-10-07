//go:build linux

package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func totalMemoryMB() int {
	var info syscall.Sysinfo_t
	if err := syscall.Sysinfo(&info); err != nil {
		return 0
	}
	return int(uint64(info.Totalram) * uint64(info.Unit) / (1024 * 1024))
}

// availableMemoryMB is the memory programs can still take without anything
// being pushed out to disk (the kernel's MemAvailable estimate). 0 = unknown.
func availableMemoryMB() int {
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "MemAvailable:" {
			if kb, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
				return int(kb / 1024)
			}
		}
	}
	return 0
}

// configureChild makes the kernel kill the engine if the bridge dies, so a
// crashed bridge never leaves Stockfish running (or frozen) in the background.
func configureChild(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}

func openBrowser(url string) error {
	return exec.Command("xdg-open", url).Start()
}

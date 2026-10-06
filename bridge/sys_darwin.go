//go:build darwin

package main

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func totalMemoryMB() int {
	// hw.memsize is a 64-bit integer; syscall.Sysctl returns its raw bytes
	// (little-endian) with trailing zero bytes possibly trimmed.
	if raw, err := syscall.Sysctl("hw.memsize"); err == nil && len(raw) > 0 && len(raw) <= 8 {
		var bytes uint64
		for i := 0; i < len(raw); i++ {
			bytes |= uint64(raw[i]) << (8 * uint(i))
		}
		if bytes > 0 {
			return int(bytes / (1024 * 1024))
		}
	}
	if out, err := exec.Command("sysctl", "-n", "hw.memsize").Output(); err == nil {
		if bytes, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64); err == nil {
			return int(bytes / (1024 * 1024))
		}
	}
	return 0
}

func configureChild(cmd *exec.Cmd) {}

func openBrowser(url string) error {
	return exec.Command("open", url).Start()
}

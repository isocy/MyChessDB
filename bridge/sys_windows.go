//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"
)

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	ntdll    = syscall.NewLazyDLL("ntdll.dll")

	procGlobalMemoryStatusEx     = kernel32.NewProc("GlobalMemoryStatusEx")
	procCreateJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	procNtSuspendProcess         = ntdll.NewProc("NtSuspendProcess")
	procNtResumeProcess          = ntdll.NewProc("NtResumeProcess")
)

const engineExeSuffix = ".exe"

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

func totalMemoryMB() int {
	var status memoryStatusEx
	status.Length = uint32(unsafe.Sizeof(status))
	if ok, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status))); ok == 0 {
		return 0
	}
	return int(status.TotalPhys / (1024 * 1024))
}

const (
	processSuspendResume = 0x0800
	processSetQuota      = 0x0100
	processTerminate     = 0x0001
	createNoWindow       = 0x08000000
	belowNormalPriority  = 0x00004000
)

func withProcess(pid int, access uint32, action func(handle syscall.Handle) error) error {
	handle, err := syscall.OpenProcess(access, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("could not open the Stockfish process: %w", err)
	}
	defer syscall.CloseHandle(handle)
	return action(handle)
}

// suspendProcess freezes every thread of the process (it keeps its memory,
// including the hash table) so a paused analysis uses no CPU.
func suspendProcess(pid int) error {
	return withProcess(pid, processSuspendResume, func(handle syscall.Handle) error {
		if status, _, _ := procNtSuspendProcess.Call(uintptr(handle)); status != 0 {
			return fmt.Errorf("NtSuspendProcess failed (NTSTATUS %#x)", status)
		}
		return nil
	})
}

func resumeProcess(pid int) error {
	return withProcess(pid, processSuspendResume, func(handle syscall.Handle) error {
		if status, _, _ := procNtResumeProcess.Call(uintptr(handle)); status != 0 {
			return fmt.Errorf("NtResumeProcess failed (NTSTATUS %#x)", status)
		}
		return nil
	})
}

// configureChild keeps Stockfish from opening its own console window and
// starts it below normal priority: the browser and other programs get the
// processor first whenever they want it, and Stockfish uses what is left.
func configureChild(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow | belowNormalPriority}
}

// A job object with "kill on close": when the bridge exits for any reason,
// Windows ends every engine process that was put in the job, so Stockfish is
// never left running (or frozen) in the background.
type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

const (
	jobObjectLimitKillOnJobClose        = 0x00002000
	jobObjectExtendedLimitInformationID = 9
)

var (
	engineJob     uintptr
	engineJobOnce sync.Once
)

func engineJobHandle() uintptr {
	engineJobOnce.Do(func() {
		handle, _, _ := procCreateJobObjectW.Call(0, 0)
		if handle == 0 {
			return
		}
		var info jobObjectExtendedLimitInformation
		info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
		ok, _, _ := procSetInformationJobObject.Call(
			handle, jobObjectExtendedLimitInformationID,
			uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
		if ok == 0 {
			return
		}
		engineJob = handle // kept open for the life of the bridge on purpose
	})
	return engineJob
}

// adoptChild puts a freshly started engine into the kill-on-close job. It is
// best effort: without it the engine still exits when its stdin closes.
func adoptChild(cmd *exec.Cmd) {
	job := engineJobHandle()
	if job == 0 || cmd.Process == nil {
		return
	}
	_ = withProcess(cmd.Process.Pid, processSetQuota|processTerminate, func(handle syscall.Handle) error {
		procAssignProcessToJobObject.Call(job, uintptr(handle))
		return nil
	})
}

func openBrowser(url string) error {
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

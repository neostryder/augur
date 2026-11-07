// jobhost: runs a command inside a Windows Job Object with kill-on-close and no breakaway,
// forwards stdio, exits with the child's code. Killing jobhost kills the whole tree, including detached descendants.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func main() {
	if len(os.Args) == 3 && os.Args[1] == "--process-info" {
		pid, err := strconv.ParseUint(os.Args[2], 10, 32)
		if err != nil {
			os.Exit(64)
		}
		snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
		if err != nil {
			os.Exit(1)
		}
		defer windows.CloseHandle(snapshot)
		entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
		for err := windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
			if entry.ProcessID == uint32(pid) {
				json.NewEncoder(os.Stdout).Encode(map[string]any{"ProcessId": entry.ProcessID, "ParentProcessId": entry.ParentProcessID, "Name": windows.UTF16ToString(entry.ExeFile[:])})
				return
			}
		}
		os.Exit(1)
	}
	if len(os.Args) == 2 && os.Args[1] == "--peer-pid" {
		var pid uint32
		proc := syscall.NewLazyDLL("kernel32.dll").NewProc("GetNamedPipeClientProcessId")
		if result, _, _ := proc.Call(os.Stdin.Fd(), uintptr(unsafe.Pointer(&pid))); result == 0 {
			os.Exit(1)
		}
		fmt.Print(pid)
		return
	}
	if len(os.Args) < 2 {
		os.Exit(64)
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		os.Exit(70)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		os.Exit(71)
	}
	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		os.Exit(72)
	}
	cmd := exec.Command(os.Args[1], os.Args[2:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		os.Exit(73)
	}
}

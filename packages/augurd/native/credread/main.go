// credread: prints one generic credential from the Windows Credential Manager on standard output and nothing else.
// The desktop app stores each secret as UTF-16 text, so the blob is decoded the same way; anything else is refused rather than guessed at.
// Exit codes: 0 found, 1 not found, 2 unreadable, 64 wrong arguments. With --exists first it prints nothing at all.
package main

import (
	"fmt"
	"os"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

const credTypeGeneric = 1

type credential struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        syscall.Filetime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

func main() {
	// `credread --exists <target>` says whether the credential is there through the exit code alone, so a caller that only needs to know never holds the value.
	existsOnly := len(os.Args) == 3 && os.Args[1] == "--exists"
	name := ""
	if existsOnly {
		name = os.Args[2]
	} else if len(os.Args) == 2 {
		name = os.Args[1]
	}
	if name == "" {
		os.Exit(64)
	}
	target, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		os.Exit(64)
	}
	advapi := syscall.NewLazyDLL("advapi32.dll")
	read, free := advapi.NewProc("CredReadW"), advapi.NewProc("CredFree")
	var out *credential
	if r, _, e := read.Call(uintptr(unsafe.Pointer(target)), credTypeGeneric, 0, uintptr(unsafe.Pointer(&out))); r == 0 {
		if e == syscall.Errno(1168) { // ERROR_NOT_FOUND
			os.Exit(1)
		}
		os.Exit(2)
	}
	defer free.Call(uintptr(unsafe.Pointer(out)))
	if existsOnly {
		os.Exit(0)
	}
	size := int(out.CredentialBlobSize)
	if size == 0 || size%2 != 0 {
		os.Exit(2)
	}
	blob := unsafe.Slice(out.CredentialBlob, size)
	u := make([]uint16, size/2)
	for i := range u {
		u[i] = uint16(blob[2*i]) | uint16(blob[2*i+1])<<8
	}
	fmt.Print(string(utf16.Decode(u)))
}

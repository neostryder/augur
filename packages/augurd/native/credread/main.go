// credread: reads, writes or deletes one generic credential in the Windows Credential Manager.
// The desktop app stores each secret as UTF-16 text, so the blob is encoded and decoded the same way; anything else is refused rather than guessed at.
//
//	credread <target>            prints the value on standard output and nothing else
//	credread --exists <target>   prints nothing; the exit code says whether it is there
//	credread --set <target>      stores standard input as the value (the value never appears on the command line)
//	credread --delete <target>   removes it; a missing credential counts as removed
//
// Exit codes: 0 done or found, 1 not found, 2 unreadable or not written, 64 wrong arguments.
package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

const (
	credTypeGeneric       = 1
	credPersistEnterprise = 3
	errorNotFound         = syscall.Errno(1168)
	maxBlob               = 2560 // CRED_MAX_CREDENTIAL_BLOB_SIZE
)

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

var advapi = syscall.NewLazyDLL("advapi32.dll")

func main() {
	mode, name := "read", ""
	switch {
	case len(os.Args) == 3 && strings.HasPrefix(os.Args[1], "--"):
		mode, name = strings.TrimPrefix(os.Args[1], "--"), os.Args[2]
	case len(os.Args) == 2:
		name = os.Args[1]
	}
	target, err := syscall.UTF16PtrFromString(name)
	if name == "" || err != nil {
		os.Exit(64)
	}
	switch mode {
	case "read", "exists":
		os.Exit(read(target, mode == "exists"))
	case "set":
		os.Exit(write(target, name))
	case "delete":
		os.Exit(remove(target))
	}
	os.Exit(64)
}

func read(target *uint16, existsOnly bool) int {
	var out *credential
	if r, _, e := advapi.NewProc("CredReadW").Call(uintptr(unsafe.Pointer(target)), credTypeGeneric, 0, uintptr(unsafe.Pointer(&out))); r == 0 {
		if e == errorNotFound {
			return 1
		}
		return 2
	}
	defer advapi.NewProc("CredFree").Call(uintptr(unsafe.Pointer(out)))
	if existsOnly {
		return 0
	}
	size := int(out.CredentialBlobSize)
	if size == 0 || size%2 != 0 {
		return 2
	}
	blob := unsafe.Slice(out.CredentialBlob, size)
	u := make([]uint16, size/2)
	for i := range u {
		u[i] = uint16(blob[2*i]) | uint16(blob[2*i+1])<<8
	}
	fmt.Print(string(utf16.Decode(u)))
	return 0
}

// write stores the value the way the desktop app's key store does: the account name is the part of the target before ".augur", and the blob is UTF-16 with no terminator.
func write(target *uint16, name string) int {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, maxBlob+1))
	value := strings.TrimRight(string(raw), "\r\n")
	if err != nil || value == "" {
		return 64
	}
	u := utf16.Encode([]rune(value))
	if len(u)*2 > maxBlob {
		return 2
	}
	blob := make([]byte, len(u)*2)
	for i, c := range u {
		blob[2*i], blob[2*i+1] = byte(c), byte(c>>8)
	}
	user, _ := syscall.UTF16PtrFromString(strings.TrimSuffix(name, ".augur"))
	empty, _ := syscall.UTF16PtrFromString("")
	cred := credential{
		Type:               credTypeGeneric,
		TargetName:         target,
		Comment:            empty,
		CredentialBlobSize: uint32(len(blob)),
		CredentialBlob:     &blob[0],
		Persist:            credPersistEnterprise,
		TargetAlias:        empty,
		UserName:           user,
	}
	r, _, _ := advapi.NewProc("CredWriteW").Call(uintptr(unsafe.Pointer(&cred)), 0)
	for i := range blob {
		blob[i] = 0
	}
	if r == 0 {
		return 2
	}
	return 0
}

func remove(target *uint16) int {
	if r, _, e := advapi.NewProc("CredDeleteW").Call(uintptr(unsafe.Pointer(target)), credTypeGeneric, 0); r == 0 && e != errorNotFound {
		return 2
	}
	return 0
}

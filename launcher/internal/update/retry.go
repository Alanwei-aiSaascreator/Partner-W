package update

import (
	"errors"
	"syscall"
	"time"
)

const (
	// How long the swap waits for whatever still holds the program directory.
	// Measured on a real disk: the app's own shutdown, its gateway child and
	// the virus scanner all release the tree within seconds, but the launcher
	// used to give up on the very first attempt.
	renameRetryBudget = 90 * time.Second
	// The launcher calls this with the app already gone in the common case;
	// half a second keeps a real lock from burning the deadline in two tries.
	renameRetryInterval = 500 * time.Millisecond
)

// The only Win32 codes that mean "wait and it may clear":
// ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION.
//
// The numbers are spelled out rather than referencing syscall.ERROR_* so the
// package still builds off Windows, where those constants do not exist; the
// codes themselves can only come from a Windows rename.
var retryableLockErrnos = [...]syscall.Errno{5, 32, 33}

func isRetryableLockError(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	for _, candidate := range retryableLockErrnos {
		if errno == candidate {
			return true
		}
	}
	return false
}

// renameWithRetry retries a directory rename while the failure says the tree is
// still held, and returns anything else on the first attempt. It never waits
// past renameRetryBudget, so a genuinely stuck tree still fails the update
// instead of hanging the launcher behind its "do not unplug" screen forever.
func renameWithRetry(ops Ops, oldPath, newPath string) error {
	deadline := ops.Now().Add(renameRetryBudget)
	for {
		err := ops.Rename(oldPath, newPath)
		if err == nil || !isRetryableLockError(err) || !ops.Now().Before(deadline) {
			return err
		}
		ops.Sleep(renameRetryInterval)
	}
}

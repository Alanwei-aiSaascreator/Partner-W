package update

import (
	"errors"
	"os"
	"syscall"
	"testing"
	"time"
)

// The three Win32 codes a directory rename can return while somebody still
// holds the tree: ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION,
// ERROR_LOCK_VIOLATION. Measured on a real disk: with the app running the
// rename fails with 32, seconds after it exits the same call succeeds.
func lockError(t *testing.T, code int) error {
	t.Helper()
	return &os.LinkError{Op: "rename", Old: `E:\old`, New: `E:\new`, Err: syscall.Errno(code)}
}

type retryProbe struct {
	SystemOps
	now      time.Time
	attempts int
	sleeps   int
	slept    time.Duration
	failures int
	failure  error
}

func newRetryProbe(failures int, failure error) *retryProbe {
	return &retryProbe{
		now:      time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC),
		failures: failures,
		failure:  failure,
	}
}

func (probe *retryProbe) Rename(_, _ string) error {
	probe.attempts++
	if probe.attempts <= probe.failures {
		return probe.failure
	}
	return nil
}

func (probe *retryProbe) Now() time.Time { return probe.now }

func (probe *retryProbe) Sleep(duration time.Duration) {
	probe.sleeps++
	probe.slept += duration
	probe.now = probe.now.Add(duration)
}

func TestRenameWithRetryWaitsOutEveryLockError(t *testing.T) {
	for _, code := range []int{5, 32, 33} {
		t.Run(syscall.Errno(code).Error(), func(t *testing.T) {
			probe := newRetryProbe(3, lockError(t, code))

			if err := renameWithRetry(probe, "old", "new"); err != nil {
				t.Fatalf("a lock error must be waited out, got %v", err)
			}
			if probe.attempts != 4 {
				t.Fatalf("attempts = %d, want 4 (three lock errors then success)", probe.attempts)
			}
			if probe.sleeps != 3 || probe.slept != 1500*time.Millisecond {
				t.Fatalf("sleeps = %d / %s, want 3 / 1.5s", probe.sleeps, probe.slept)
			}
		})
	}
}

func TestRenameWithRetryDoesNotWaitOnAnyOtherError(t *testing.T) {
	for _, failure := range []error{
		errors.New("the destination does not exist"),
		&os.LinkError{Op: "rename", Old: "old", New: "new", Err: syscall.Errno(2)},
		&os.LinkError{Op: "rename", Old: "old", New: "new", Err: syscall.Errno(17)},
	} {
		probe := newRetryProbe(1, failure)

		err := renameWithRetry(probe, "old", "new")
		if !errors.Is(err, failure) {
			t.Fatalf("err = %v, want %v", err, failure)
		}
		if probe.attempts != 1 {
			t.Fatalf("attempts = %d, want 1: only lock errors are worth retrying", probe.attempts)
		}
		if probe.sleeps != 0 {
			t.Fatalf("sleeps = %d, want 0", probe.sleeps)
		}
	}
}

func TestRenameWithRetryGivesUpAfterTheBudget(t *testing.T) {
	probe := newRetryProbe(1<<30, lockError(t, 32))

	err := renameWithRetry(probe, "old", "new")
	if err == nil {
		t.Fatalf("a lock that never clears must surface an error")
	}
	if !isRetryableLockError(err) {
		t.Fatalf("the timeout must report the lock error itself, got %v", err)
	}
	if probe.slept != 90*time.Second {
		t.Fatalf("slept = %s, want the full 90s budget", probe.slept)
	}
	if probe.sleeps != 180 {
		t.Fatalf("sleeps = %d, want 180 (90s / 500ms)", probe.sleeps)
	}
	if probe.attempts != 181 {
		t.Fatalf("attempts = %d, want 181 (one attempt per wait plus the final one)", probe.attempts)
	}
}

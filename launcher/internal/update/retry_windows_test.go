//go:build windows

package update

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The unit tests prove the retry policy against a fake. This one asks Windows
// itself what it refuses, because the whole fix rests on that answer and the
// obvious guess was wrong: a process merely sitting in a directory (its
// working directory) does not block the rename, and neither does a running
// image inside the tree. What Windows does refuse is renaming the *calling*
// process's own working directory — and no amount of waiting clears that,
// which is why the launcher leaves the directory instead of only retrying.
func TestWindowsRefusesToRenameTheCallingProcessWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "program")
	target := filepath.Join(root, "backup", "program")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatalf("create the source: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("create the backup parent: %v", err)
	}
	if err := os.WriteFile(filepath.Join(source, "payload.txt"), []byte("payload"), 0o644); err != nil {
		t.Fatalf("write the payload: %v", err)
	}

	// Plain os.Chdir, not t.Chdir: testing's helper keeps a handle open on the
	// directory it left (so it can restore it later), and that handle holds the
	// same tree — measured: with t.Chdir the rename stays refused even after
	// the process has moved out, which is an artefact of the helper rather than
	// anything about the launcher.
	original, err := os.Getwd()
	if err != nil {
		t.Fatalf("read the working directory: %v", err)
	}
	defer func() {
		if err := os.Chdir(original); err != nil {
			t.Errorf("restore the working directory: %v", err)
		}
	}()
	real := SystemOps{}
	if err := os.Chdir(source); err != nil {
		t.Fatalf("enter the source directory: %v", err)
	}

	refused := real.Rename(source, target)
	if refused == nil {
		t.Fatalf("Windows renamed the calling process's working directory: the reason the launcher moves out first is gone")
	}
	if !isRetryableLockError(refused) {
		t.Fatalf("the refusal is not the lock error the retry handles: %v", refused)
	}
	t.Logf("the real refusal: %v", refused)

	// Waiting is not enough — the directory is the caller's own, so the next
	// attempt lands exactly where this one did. That is the whole reason the
	// launcher steps out before it starts moving trees. (Checked with a second
	// attempt rather than by spending the 90s budget: the point is that time
	// alone changes nothing, and a real 90s wait makes this suite unusable.)
	time.Sleep(500 * time.Millisecond)
	if again := real.Rename(source, target); again == nil {
		t.Fatalf("the refusal cleared on its own: it is about timing after all")
	}

	// Once out, the same rename goes through — and a lock that clears while we
	// wait is what the retry is for.
	if err := os.Chdir(root); err != nil {
		t.Fatalf("leave the source directory: %v", err)
	}
	if err := renameWithRetry(real, source, target); err != nil {
		t.Fatalf("the rename must succeed once the launcher is out: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "payload.txt")); err != nil {
		t.Fatalf("the tree must be at the destination: %v", err)
	}
}

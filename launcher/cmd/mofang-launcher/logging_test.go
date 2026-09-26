package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mofang-compass/portable-launcher/internal/update"
)

// The app starts the launcher with its output discarded, so the log on the
// disk is the only account of a failed or hanging update that survives it.
//
// This drives the real dependency wiring rather than a copy of it, on purpose:
// a sink that exists but is never attached passes every test of the sink
// itself, and behaves exactly like a working one right up until somebody needs
// to read it.
func TestTheLauncherWritesItsLogWhereSupportCanFindIt(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	harness.installCurrentProgram(t)
	harness.writeState(t, transaction)

	deps := launcherDependencies(harness.launcherPath, harness.messages, harness.publicKey)
	deps.ops = harness.ops
	deps.screen = harness.screen

	if code := run(nil, deps); code != exitOK {
		t.Fatalf("exit code = %d, want %d", code, exitOK)
	}

	logPath := filepath.Join(harness.root, update.UpdateDirectoryName, launcherLogName)
	content, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("the launcher must leave a log at %s: %v", logPath, err)
	}
	if !strings.Contains(string(content), "reconciled the disk state: none") {
		t.Fatalf("the log must carry what the launcher did, got %q", content)
	}
}

// Best effort by design: a disk that refuses the log must still start the
// program. The log explains failures; it must never become one.
func TestAFailingLogDoesNotStopTheLauncher(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	harness.installCurrentProgram(t)
	harness.writeState(t, transaction)

	// A directory where the log file should be: every write to it fails.
	harness.mkdir(t, filepath.Join(harness.root, update.UpdateDirectoryName, launcherLogName))

	deps := launcherDependencies(harness.launcherPath, harness.messages, harness.publicKey)
	deps.ops = harness.ops
	deps.screen = harness.screen

	if code := run(nil, deps); code != exitOK {
		t.Fatalf("exit code = %d, want %d: an unwritable log must not block the launch", code, exitOK)
	}
	if len(harness.ops.started) != 1 {
		t.Fatalf("the program must still start, started %v", harness.ops.started)
	}
}

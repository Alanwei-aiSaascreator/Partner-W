package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"partner-w/portable-launcher/internal/update"
)

func programDirectory(harness *harness) string {
	return filepath.Join(harness.root, update.ProgramDirectoryName)
}

// The launcher inherits its working directory from whoever started it, and the
// app is normally started from the program directory the launcher is about to
// move. Windows refuses to rename the calling process's own working directory
// — measured with a probe: Win32 32 (sharing violation) while inside, clean
// rename once out — and waiting cannot clear that, so the wait added for the
// app's shutdown would only burn its whole budget. The launcher works in
// absolute paths only, so stepping out costs nothing.
func TestRunLeavesTheWorkingDirectoryItInherited(t *testing.T) {
	harness := newHarness(t)
	harness.installCurrentProgram(t)
	t.Chdir(programDirectory(harness))

	run(nil, harness.dependencies())

	after, err := os.Getwd()
	if err != nil {
		t.Fatalf("read the working directory: %v", err)
	}
	if strings.HasPrefix(strings.ToLower(after), strings.ToLower(programDirectory(harness))) {
		t.Fatalf("the launcher is still sitting in the tree it is about to move: %s", after)
	}
}

// The same thing end to end, on the only platform that refuses: an update is
// handed over while the launcher sits in the program directory.
func TestLaunchAppliesAnUpdateStartedFromInsideTheProgramDirectory(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("only Windows refuses to rename the calling process's own working directory")
	}
	harness := newHarness(t)
	transaction := harness.transaction()
	harness.installCurrentProgram(t)
	harness.installVerifiedStage(t, transaction)
	harness.writeHealthReceipt(t, transaction)
	harness.writeState(t, transaction)
	t.Chdir(programDirectory(harness))

	if code := run(nil, harness.dependencies()); code != exitOK {
		t.Fatalf("exit code = %d, want %d", code, exitOK)
	}

	mustExist(t, filepath.Join(programDirectory(harness), "resources", "app.asar"))
	mustExist(t, filepath.Join(transaction.BackupProgramPath, "old.txt"))
	if phase := phaseOf(t, harness, transaction); phase != "committed" {
		t.Fatalf("phase = %s, want committed", phase)
	}
}

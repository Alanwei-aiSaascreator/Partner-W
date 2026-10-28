package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"partner-w/portable-launcher/internal/update"
)

func phaseOf(t *testing.T, harness *harness, transaction update.TransactionV1) string {
	t.Helper()
	state, err := update.ReadTransactionWith(harness.ops, harness.stagePath(transaction))
	if err != nil {
		t.Fatalf("read the transaction: %v", err)
	}
	return state.Phase
}

func mustExist(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("%s must exist: %v", path, err)
	}
}

func mustNotExist(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("%s must not exist", path)
	}
}

// A launcher started by hand is the second chance for an update that the app
// could not hand over: the app spawns the launcher and quits, and on a real
// disk the swap loses that race. Without this the user has to press the button
// again and lose it again.
func TestLaunchAppliesAPendingTransactionBeforeStarting(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	harness.installCurrentProgram(t)
	harness.installVerifiedStage(t, transaction)
	harness.writeHealthReceipt(t, transaction)
	harness.writeState(t, transaction)

	if code := run(nil, harness.dependencies()); code != exitOK {
		t.Fatalf("exit code = %d, want %d", code, exitOK)
	}

	mustExist(t, filepath.Join(harness.root, update.ProgramDirectoryName, "resources", "app.asar"))
	mustExist(t, filepath.Join(transaction.BackupProgramPath, "old.txt"))
	if len(harness.ops.started) != 1 {
		t.Fatalf("the program must start exactly once (the update starts it), started %v", harness.ops.started)
	}
	if phase := phaseOf(t, harness, transaction); phase != "committed" {
		t.Fatalf("phase = %s, want committed", phase)
	}
}

// Only a ready transaction is an update waiting to be applied. Anything else
// is a state the app was in the middle of, and guessing there would mean
// swapping trees on the strength of a half-written record.
func TestLaunchLeavesANonReadyTransactionAlone(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	transaction.Phase = "applying"
	harness.installCurrentProgram(t)
	harness.installVerifiedStage(t, transaction)
	harness.writeHealthReceipt(t, transaction)
	harness.writeState(t, transaction)

	if code := run(nil, harness.dependencies()); code != exitOK {
		t.Fatalf("exit code = %d, want %d", code, exitOK)
	}

	mustExist(t, filepath.Join(harness.root, update.ProgramDirectoryName, "old.txt"))
	mustNotExist(t, transaction.BackupProgramPath)
	if len(harness.ops.started) != 1 {
		t.Fatalf("the program must start exactly once, started %v", harness.ops.started)
	}
	if phase := phaseOf(t, harness, transaction); phase != "applying" {
		t.Fatalf("phase = %s, want the state left alone", phase)
	}
}

// A ready transaction whose directories do not match is not an update waiting
// to be applied — the stage may be gone because the last attempt rolled back.
// Trying anyway would greet someone who just wanted to start the program with
// an error dialog about an update they did not ask for.
func TestLaunchDoesNotApplyWithoutAStage(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	harness.installCurrentProgram(t)
	harness.writeState(t, transaction)

	if code := run(nil, harness.dependencies()); code != exitOK {
		t.Fatalf("exit code = %d, want %d", code, exitOK)
	}

	if len(harness.screen.errors) != 0 {
		t.Fatalf("a launch must not report an update error here: %v", harness.screen.errors)
	}
	mustExist(t, filepath.Join(harness.root, update.ProgramDirectoryName, "old.txt"))
	mustNotExist(t, transaction.BackupProgramPath)
	if len(harness.ops.started) != 1 {
		t.Fatalf("the program must start exactly once, started %v", harness.ops.started)
	}
	if phase := phaseOf(t, harness, transaction); phase != "ready" {
		t.Fatalf("phase = %s, want the handed-over state untouched", phase)
	}
}

// Waiting out a lock must never cost the user the program. If the update is
// still refused after the whole budget, the launcher starts what is on the
// disk and leaves the ready transaction for the next attempt.
func TestLaunchStartsTheProgramWhenTheAutoApplyCannotWait(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	harness.installCurrentProgram(t)
	harness.installVerifiedStage(t, transaction)
	harness.writeHealthReceipt(t, transaction)
	harness.writeState(t, transaction)
	harness.ops.lockRenames = 1 << 30

	if code := run(nil, harness.dependencies()); code != exitOK {
		t.Fatalf("exit code = %d, want %d: a refused update must not stop the launcher", code, exitOK)
	}

	mustExist(t, filepath.Join(harness.root, update.ProgramDirectoryName, "old.txt"))
	mustNotExist(t, transaction.BackupProgramPath)
	if len(harness.ops.started) != 1 {
		t.Fatalf("the current program must start once, started %v", harness.ops.started)
	}
	if phase := phaseOf(t, harness, transaction); phase != "ready" {
		t.Fatalf("phase = %s, want ready: the next attempt must still find it", phase)
	}
}

// A rollback is invisible from the outside: the program starts, nothing on
// screen differs from a plain launch, and the user is left believing the update
// went in — they only find out when they look for something the new version was
// supposed to bring. Recover reports "restored" at exactly the moment the
// launcher knows, so that is where it has to speak up.
func TestLaunchTellsTheUserWhenAnUpdateWasRolledBack(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	// Only a backup remains: the previous attempt lost the current tree before
	// it could put anything in its place. Recover restores it and reports
	// "restored"; that is the shape a real rolled-back disk is left in.
	harness.writeFile(t, filepath.Join(transaction.BackupProgramPath, "old.txt"), "old")
	harness.writeFile(t, filepath.Join(transaction.BackupProgramPath, update.ProgramExecutableName), "program executable")
	harness.writeState(t, transaction)

	if code := run(nil, harness.dependencies()); code != exitOK {
		t.Fatalf("exit code = %d, want %d: a rollback must not cost the user the program", code, exitOK)
	}

	// The recovery itself must still happen — the notice is added on top of it,
	// not instead of it.
	mustExist(t, filepath.Join(harness.root, update.ProgramDirectoryName, "old.txt"))
	mustNotExist(t, transaction.BackupProgramPath)
	if len(harness.ops.started) != 1 {
		t.Fatalf("the restored program must start exactly once, started %v", harness.ops.started)
	}
	if len(harness.screen.errors) != 1 {
		t.Fatalf("the user must be told the update was rolled back, got %v", harness.screen.errors)
	}
	if !strings.HasPrefix(harness.screen.errors[0], harness.messages.RolledBack) {
		t.Fatalf("got %q, want the rolled-back notice", harness.screen.errors[0])
	}
}

// The opposite direction, pinned so the notice cannot become noise: a launch
// that had nothing to recover must stay silent.
func TestLaunchStaysSilentWhenThereWasNothingToRollBack(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	harness.installCurrentProgram(t)
	harness.writeState(t, transaction)

	if code := run(nil, harness.dependencies()); code != exitOK {
		t.Fatalf("exit code = %d, want %d", code, exitOK)
	}

	if len(harness.screen.errors) != 0 || len(harness.screen.shown) != 0 {
		t.Fatalf("an ordinary launch must not warn about an update: %v %v", harness.screen.errors, harness.screen.shown)
	}
}

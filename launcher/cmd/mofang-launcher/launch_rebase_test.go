package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mofang-compass/portable-launcher/internal/update"
)

// rehomedTo rewrites every absolute path of a transaction onto another volume,
// which is what a record written on E: looks like when the stick comes back as
// F: — the field case from 2026-10-19.
func rehomedTo(transaction update.TransactionV1, root string) update.TransactionV1 {
	rehome := func(value string) string {
		volume := filepath.VolumeName(value)
		if volume == "" {
			return value
		}
		return filepath.Join(root, value[len(volume):])
	}
	rehomed := transaction
	rehomed.UpdateRoot = rehome(transaction.UpdateRoot)
	rehomed.ArchivePath = rehome(transaction.ArchivePath)
	rehomed.StagedProgramPath = rehome(transaction.StagedProgramPath)
	rehomed.CurrentProgramPath = rehome(transaction.CurrentProgramPath)
	rehomed.BackupProgramPath = rehome(transaction.BackupProgramPath)
	rehomed.ManifestPath = rehome(transaction.ManifestPath)
	rehomed.FileManifestPath = rehome(transaction.FileManifestPath)
	rehomed.HealthPath = rehome(transaction.HealthPath)
	return rehomed
}

// writeRecord writes a record at the real state path even when the record
// itself points somewhere else — exactly the situation on the user's disk.
func (harness *harness) writeRecord(t *testing.T, transaction update.TransactionV1) {
	t.Helper()
	encoded, err := json.Marshal(transaction)
	if err != nil {
		t.Fatalf("encode the transaction: %v", err)
	}
	harness.writeFile(t,
		filepath.Join(harness.root, update.UpdateDirectoryName, update.StateFileName),
		string(encoded),
	)
}

// The launcher must read the record from the root it was started from and move
// the recorded paths onto that root. Before this, it looked for the program on
// the old letter, found nothing, and refused to start a program that was sitting
// right there — the user had to open the .exe by hand to find that out.
func TestLaunchRebasesARecordWrittenOnAnotherDriveLetter(t *testing.T) {
	harness := newHarness(t)
	real := harness.transaction()
	harness.installCurrentProgram(t)

	harness.writeRecord(t, rehomedTo(real, `Z:\`))

	if code := run(nil, harness.dependencies()); code != exitOK {
		t.Fatalf("exit code = %d, want %d; launcher log: %s", code, exitOK, harness.logs.String())
	}
	if len(harness.screen.errors) != 0 {
		t.Fatalf("a record from another letter must not raise an error dialog: %v", harness.screen.errors)
	}
	if len(harness.ops.started) != 1 {
		t.Fatalf("the program must start exactly once, started %v", harness.ops.started)
	}

	state, err := update.ReadTransactionWith(harness.ops, filepath.Join(real.UpdateRoot, update.StateFileName))
	if err != nil {
		t.Fatalf("read the rewritten record: %v", err)
	}
	if state.UpdateRoot != real.UpdateRoot || state.CurrentProgramPath != real.CurrentProgramPath {
		t.Fatalf("the record must be rewritten onto this root: %+v", state)
	}
}

// The same rule applies to a record the recovery pass cannot reconcile: current,
// staged and backup all present is evidence-kept territory, and it used to end
// in a dialog with the program left unstarted.
func TestLaunchStartsTheProgramWhenRecoveryCannotReconcile(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	transaction.Phase = "applying"
	harness.installCurrentProgram(t)
	harness.installVerifiedStage(t, transaction)
	harness.mkdir(t, transaction.BackupProgramPath)
	harness.writeState(t, transaction)

	if code := run(nil, harness.dependencies()); code != exitOK {
		t.Fatalf("exit code = %d, want %d; log: %s", code, exitOK, harness.logs.String())
	}
	if len(harness.screen.errors) != 0 {
		t.Fatalf("an unreconcilable record must not raise an error dialog: %v", harness.screen.errors)
	}
	if len(harness.ops.started) != 1 {
		t.Fatalf("the program must start exactly once, started %v", harness.ops.started)
	}

	// 记录被"停放"（改名保留，不删除）：下一次启动不再重复报同一个错，
	// 支持仍能拿到原文件。
	if _, err := os.Stat(filepath.Join(transaction.UpdateRoot, update.StateFileName)); !os.IsNotExist(err) {
		t.Fatalf("the unusable record must be moved out of the startup path")
	}
	entries, err := os.ReadDir(transaction.UpdateRoot)
	if err != nil {
		t.Fatalf("read the update root: %v", err)
	}
	parked := false
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), update.StateFileName+".unreconciled-") {
			parked = true
		}
	}
	if !parked {
		t.Fatalf("the unusable record must be kept under an .unreconciled- name: %v", entries)
	}
}

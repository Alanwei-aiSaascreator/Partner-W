package update

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// The launcher is spawned by the app it is about to replace, and the app is
// still exiting. On a real disk the first rename therefore fails with a lock
// error; the launcher used to give up on it and the button never worked.
//
// The faults aim by path, not by attempt number: a retry spends an attempt of
// its own, so counting would aim the second fault at the retry rather than at
// the next rename.
func TestApplyWaitsOutALockedProgramDirectory(t *testing.T) {
	instance := newScenario(t)
	instance.writeCurrentProgram(t)
	instance.stageVerifiedProgram(t)
	instance.writeHealthReceipt(t, instance.transaction.TransactionID, instance.transaction.TargetVersion, instance.transaction.CurrentProgramPath)
	instance.ops.lockFaults = []lockFault{{contains: instance.transaction.BackupProgramPath, first: 1, last: 3, errno: 32}}

	if err := Apply(context.Background(), instance.transaction, instance.key, instance.ops); err != nil {
		t.Fatalf("apply must wait out the lock, got %v", err)
	}

	if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "resources", "app.asar")); err != nil {
		t.Fatalf("the new tree must be live once the lock clears: %v", err)
	}
	if _, err := os.Stat(filepath.Join(instance.transaction.BackupProgramPath, "old.txt")); err != nil {
		t.Fatalf("the previous tree must be in the backup: %v", err)
	}
	if instance.ops.counts["rename"] <= 4 {
		t.Fatalf("rename attempts = %d, want more than 4: the lock must have been waited out", instance.ops.counts["rename"])
	}
	state, err := ReadTransactionWith(instance.ops, StatePath(instance.transaction))
	if err != nil {
		t.Fatalf("read the final state: %v", err)
	}
	if state.Phase != "committed" {
		t.Fatalf("final phase = %s, want committed", state.Phase)
	}
	instance.assertOnlyScopedOperations(t)
}

// The second rename moves the verified stage into place. It can be refused for
// the same reason and must be waited out just as well: the tree is only half
// swapped here, so giving up would leave the rollback to clean up instead.
func TestApplyWaitsOutALockedStageRename(t *testing.T) {
	instance := newScenario(t)
	instance.writeCurrentProgram(t)
	instance.stageVerifiedProgram(t)
	instance.writeHealthReceipt(t, instance.transaction.TransactionID, instance.transaction.TargetVersion, instance.transaction.CurrentProgramPath)
	instance.ops.lockFaults = []lockFault{{contains: instance.transaction.StagedProgramPath, first: 1, last: 2, errno: 33}}

	if err := Apply(context.Background(), instance.transaction, instance.key, instance.ops); err != nil {
		t.Fatalf("the stage rename must be waited out too, got %v", err)
	}

	if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "resources", "app.asar")); err != nil {
		t.Fatalf("the new tree must be live: %v", err)
	}
	state, err := ReadTransactionWith(instance.ops, StatePath(instance.transaction))
	if err != nil {
		t.Fatalf("read the final state: %v", err)
	}
	if state.Phase != "committed" {
		t.Fatalf("final phase = %s, want committed", state.Phase)
	}
}

func TestApplyKeepsTheStageAndTheReadyStateWhenTheLockNeverClears(t *testing.T) {
	instance := newScenario(t)
	instance.writeCurrentProgram(t)
	instance.stageVerifiedProgram(t)
	// Whatever the app left on the disk: a ready transaction and a verified
	// stage. The refused attempt must not touch either of them.
	if _, err := WriteTransaction(instance.ops, instance.transaction); err != nil {
		t.Fatalf("write the ready transaction: %v", err)
	}
	before, err := os.ReadFile(StatePath(instance.transaction))
	if err != nil {
		t.Fatalf("read the handed-over state: %v", err)
	}
	instance.ops.lockFaults = []lockFault{{first: 1, errno: 5}}
	started := instance.ops.clock.now

	applyErr := Apply(context.Background(), instance.transaction, instance.key, instance.ops)

	if !isRetryableLockError(applyErr) {
		t.Fatalf("a lock that never clears must surface the lock error, got %v", err)
	}
	if waited := instance.ops.clock.now.Sub(started); waited != renameRetryBudget {
		t.Fatalf("waited %s, want the full %s budget before giving up", waited, renameRetryBudget)
	}

	// Everything a later attempt needs has to survive: the ready transaction,
	// the verified stage and the tree that is still running.
	if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "old.txt")); err != nil {
		t.Fatalf("the running tree must be untouched: %v", err)
	}
	if _, err := os.Stat(filepath.Join(instance.transaction.StagedProgramPath, "resources", "app.asar")); err != nil {
		t.Fatalf("the verified stage must be kept for the next attempt: %v", err)
	}
	if _, err := os.Stat(instance.transaction.BackupProgramPath); !os.IsNotExist(err) {
		t.Fatalf("a refused first rename must not leave a backup behind")
	}
	state, err := ReadTransactionWith(instance.ops, StatePath(instance.transaction))
	if err != nil {
		t.Fatalf("the transaction must still be readable: %v", err)
	}
	if state.Phase != "ready" {
		t.Fatalf("phase = %s, want ready: the update must stay applicable", state.Phase)
	}
	after, err := os.ReadFile(StatePath(instance.transaction))
	if err != nil {
		t.Fatalf("read the state after the refusal: %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("a refused attempt must leave the handed-over state byte for byte")
	}
}

func TestApplyRollsBackWhileTheDirectoryIsStillLocked(t *testing.T) {
	instance := newScenario(t)
	instance.writeCurrentProgram(t)
	instance.stageVerifiedProgram(t)
	// No usable health receipt: the new build never confirms, so Apply rolls
	// back. The faults aim at the rename that puts the backup back in place —
	// by path, because the transaction write is a rename too, and the first
	// attempt already has the backup path as its destination.
	instance.ops.lockFaults = []lockFault{{contains: instance.transaction.BackupProgramPath, first: 2, last: 4, errno: 33}}
	instance.writeHealthReceipt(t, "another-transaction", instance.transaction.TargetVersion, instance.transaction.CurrentProgramPath)

	if err := Apply(context.Background(), instance.transaction, instance.key, instance.ops); err != nil {
		t.Fatalf("a rolled back update is a clean outcome, got %v", err)
	}

	if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "old.txt")); err != nil {
		t.Fatalf("the previous tree must be back in place: %v", err)
	}
	state, err := ReadTransactionWith(instance.ops, StatePath(instance.transaction))
	if err != nil {
		t.Fatalf("read the final state: %v", err)
	}
	if state.Phase != "rolled-back" {
		t.Fatalf("phase = %s, want rolled-back", state.Phase)
	}
}

// The budget must not leak into failures that waiting cannot fix.
func TestApplyFailsImmediatelyOnANonLockRenameError(t *testing.T) {
	instance := newScenario(t)
	instance.writeCurrentProgram(t)
	instance.stageVerifiedProgram(t)
	instance.ops.faults = []fault{{operation: "rename", index: 1}}
	started := instance.ops.clock.now

	err := Apply(context.Background(), instance.transaction, instance.key, instance.ops)

	if err == nil {
		t.Fatalf("an injected rename failure must surface")
	}
	if waited := instance.ops.clock.now.Sub(started); waited != 0 {
		t.Fatalf("waited %s on a non-lock error, want no waiting at all", waited)
	}
	if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "old.txt")); err != nil {
		t.Fatalf("the running tree must be untouched: %v", err)
	}
}

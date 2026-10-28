package update

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeLockRecord(t *testing.T, instance *scenario, pid int, transactionID string) {
	t.Helper()
	encoded, err := json.Marshal(LockRecordV1{
		SchemaVersion: SchemaVersion,
		Pid:           pid,
		TransactionID: transactionID,
		CreatedAt:     "2026-09-21T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("encode the lock record: %v", err)
	}
	if err := os.MkdirAll(instance.transaction.UpdateRoot, 0o755); err != nil {
		t.Fatalf("create the update root: %v", err)
	}
	if err := os.WriteFile(LockPath(instance.transaction), encoded, 0o600); err != nil {
		t.Fatalf("write the lock record: %v", err)
	}
}

func TestLockRejectsASecondLauncherWhileTheHolderRuns(t *testing.T) {
	instance := newScenario(t)
	const holder = 4242
	writeLockRecord(t, instance, holder, instance.transaction.TransactionID)
	instance.ops.alive[holder] = true

	reconciled := false
	lock, _, err := AcquireLock(instance.ops, instance.transaction, func() (RecoveryResult, error) {
		reconciled = true
		return RecoveryNone, nil
	})

	if !errors.Is(err, ErrLockHeld) {
		t.Fatalf("a live holder must block the second launcher, got %v", err)
	}
	if lock != nil {
		t.Fatalf("no lock may be handed out while another process holds it")
	}
	if reconciled {
		t.Fatalf("a live holder must not trigger reconciliation of its disk state")
	}
}

func TestLockTakesOverAStaleRecordOnlyAfterReconciling(t *testing.T) {
	instance := newScenario(t)
	const deadHolder = 4243
	writeLockRecord(t, instance, deadHolder, instance.transaction.TransactionID)
	instance.ops.alive[deadHolder] = false

	lock, result, err := AcquireLock(instance.ops, instance.transaction, func() (RecoveryResult, error) {
		return RecoveryAwaitHealth, nil
	})
	if lock != nil {
		defer lock.Release()
	}
	if err != nil {
		t.Fatalf("a stale record must be replaceable: %v", err)
	}
	if result != RecoveryAwaitHealth {
		t.Fatalf("the takeover must report what reconciliation found, got %s", result)
	}

	record, err := readLockRecord(instance.ops, LockPath(instance.transaction))
	if err != nil {
		t.Fatalf("read the replacement record: %v", err)
	}
	if record.Pid != os.Getpid() {
		t.Fatalf("the replacement record must name this process, got %d", record.Pid)
	}
}

func TestLockRefusesWhenTheDiskStateNeedsAHuman(t *testing.T) {
	instance := newScenario(t)
	const deadHolder = 4244
	writeLockRecord(t, instance, deadHolder, instance.transaction.TransactionID)
	instance.ops.alive[deadHolder] = false

	lock, result, err := AcquireLock(instance.ops, instance.transaction, func() (RecoveryResult, error) {
		return RecoveryEvidenceKept, nil
	})
	if !errors.Is(err, ErrLockHeld) {
		t.Fatalf("an unrecoverable disk state must not be overwritten blindly, got %v", err)
	}
	if lock != nil {
		t.Fatalf("no lock may be handed out when the evidence must be kept")
	}
	if result != RecoveryEvidenceKept {
		t.Fatalf("the refusal must report the reason, got %s", result)
	}

	record, err := readLockRecord(instance.ops, LockPath(instance.transaction))
	if err != nil {
		t.Fatalf("the stale record must survive: %v", err)
	}
	if record.Pid != deadHolder {
		t.Fatalf("the stale record must be left untouched, got pid %d", record.Pid)
	}
}

func TestLockRefusesWhenReconciliationFails(t *testing.T) {
	instance := newScenario(t)
	const deadHolder = 4245
	writeLockRecord(t, instance, deadHolder, instance.transaction.TransactionID)
	instance.ops.alive[deadHolder] = false

	lock, _, err := AcquireLock(instance.ops, instance.transaction, func() (RecoveryResult, error) {
		return RecoveryNone, ErrRecoveryImpossible
	})
	if !errors.Is(err, ErrRecoveryImpossible) {
		t.Fatalf("a failed reconciliation must stop the takeover, got %v", err)
	}
	if lock != nil {
		t.Fatalf("no lock may be handed out after a failed reconciliation")
	}
}

func TestLockReleaseLetsTheNextAcquisitionSucceed(t *testing.T) {
	instance := newScenario(t)
	lock, _, err := AcquireLock(instance.ops, instance.transaction, func() (RecoveryResult, error) {
		return RecoveryNone, nil
	})
	if err != nil {
		t.Fatalf("the first acquisition must succeed: %v", err)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, err := os.Stat(LockPath(instance.transaction)); !os.IsNotExist(err) {
		t.Fatalf("the lock file must be gone after release")
	}

	second, _, err := AcquireLock(instance.ops, instance.transaction, func() (RecoveryResult, error) {
		return RecoveryNone, nil
	})
	if err != nil {
		t.Fatalf("releasing must allow a later acquisition: %v", err)
	}
	if err := second.Release(); err != nil {
		t.Fatalf("release the second lock: %v", err)
	}
}

func TestStateRoundTripsAndKeepsUpdatedAtIncreasing(t *testing.T) {
	instance := newScenario(t)

	first, err := WriteTransaction(instance.ops, instance.transaction)
	if err != nil {
		t.Fatalf("write the transaction: %v", err)
	}
	read, err := ReadTransactionWith(instance.ops, StatePath(instance.transaction))
	if err != nil {
		t.Fatalf("read the transaction: %v", err)
	}
	if read.TransactionID != instance.transaction.TransactionID {
		t.Fatalf("read transaction id = %s", read.TransactionID)
	}

	instance.ops.clock.now = instance.ops.clock.now.Add(-time.Hour)
	second, err := WriteTransaction(instance.ops, instance.transaction)
	if err != nil {
		t.Fatalf("write again: %v", err)
	}
	if second.UpdatedAt <= first.UpdatedAt {
		t.Fatalf("updatedAt must increase even when the clock moves backwards: %d then %d", first.UpdatedAt, second.UpdatedAt)
	}
}

func TestStateRefusesToPersistAnInvalidTransaction(t *testing.T) {
	instance := newScenario(t)
	invalid := instance.transaction
	invalid.StagedProgramPath = filepath.Join(instance.root, "elsewhere")

	if _, err := WriteTransaction(instance.ops, invalid); err == nil {
		t.Fatalf("an invalid transaction must not be persisted")
	}
	if _, err := os.Stat(StatePath(instance.transaction)); !os.IsNotExist(err) {
		t.Fatalf("no state file may appear for a rejected transaction")
	}
}

func TestStateRejectsAStoredTransactionWithUnusablePaths(t *testing.T) {
	instance := newScenario(t)
	invalid := instance.transaction
	invalid.CurrentProgramPath = filepath.Join(instance.root, "somewhere-else")
	encoded, err := json.Marshal(invalid)
	if err != nil {
		t.Fatalf("encode the transaction: %v", err)
	}
	if err := os.MkdirAll(instance.transaction.UpdateRoot, 0o755); err != nil {
		t.Fatalf("create the update root: %v", err)
	}
	if err := os.WriteFile(StatePath(instance.transaction), encoded, 0o600); err != nil {
		t.Fatalf("write the state file: %v", err)
	}

	if _, err := ReadTransactionWith(instance.ops, StatePath(instance.transaction)); err == nil {
		t.Fatalf("a stored transaction with unusable paths must be refused")
	}
}

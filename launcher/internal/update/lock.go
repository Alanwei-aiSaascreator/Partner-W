package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

var ErrLockHeld = errors.New("portable update: another launcher holds the update lock")

type LockRecordV1 struct {
	SchemaVersion int    `json:"schemaVersion"`
	Pid           int    `json:"pid"`
	TransactionID string `json:"transactionId"`
	CreatedAt     string `json:"createdAt"`
}

type Lock struct {
	ops  Ops
	path string
}

func LockPath(transaction TransactionV1) string {
	return filepath.Join(transaction.UpdateRoot, LockFileName)
}

func readLockRecord(ops Ops, path string) (LockRecordV1, error) {
	data, err := ops.ReadFile(path)
	if err != nil {
		return LockRecordV1{}, err
	}
	var record LockRecordV1
	if err := decodeStrict(data, &record); err != nil {
		return LockRecordV1{}, err
	}
	return record, nil
}

func AcquireLock(
	ops Ops,
	transaction TransactionV1,
	reconcile func() (RecoveryResult, error),
) (*Lock, RecoveryResult, error) {
	if err := ValidateTransactionPaths(transaction); err != nil {
		return nil, RecoveryNone, err
	}
	path := LockPath(transaction)
	record := LockRecordV1{
		SchemaVersion: SchemaVersion,
		Pid:           os.Getpid(),
		TransactionID: transaction.TransactionID,
		CreatedAt:     ops.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.Marshal(record)
	if err != nil {
		return nil, RecoveryNone, err
	}

	if err := ops.WriteFileExclusive(path, data, 0o600); err == nil {
		return &Lock{ops: ops, path: path}, RecoveryNone, nil
	}

	existing, readErr := readLockRecord(ops, path)
	if readErr != nil {
		return nil, RecoveryNone, fmt.Errorf("%w: unreadable lock record: %v", ErrLockHeld, readErr)
	}
	if ops.ProcessAlive(existing.Pid) {
		return nil, RecoveryNone, fmt.Errorf("%w: pid %d still runs", ErrLockHeld, existing.Pid)
	}

	result, err := reconcile()
	if err != nil {
		return nil, result, err
	}
	if result == RecoveryEvidenceKept {
		return nil, result, fmt.Errorf("%w: the disk state needs a human before the lock can be replaced", ErrLockHeld)
	}

	if err := ops.RemoveAll(path); err != nil {
		return nil, result, err
	}
	if err := ops.WriteFileExclusive(path, data, 0o600); err != nil {
		return nil, result, err
	}
	return &Lock{ops: ops, path: path}, result, nil
}

func (lock *Lock) Release() error {
	return lock.ops.RemoveAll(lock.path)
}

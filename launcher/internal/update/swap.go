package update

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"path/filepath"
	"time"
)

type RecoveryResult string

const (
	RecoveryNone         RecoveryResult = "none"
	RecoveryReady        RecoveryResult = "ready"
	RecoveryRestored     RecoveryResult = "restored"
	RecoveryAwaitHealth  RecoveryResult = "awaiting-health"
	RecoveryEvidenceKept RecoveryResult = "evidence-kept"
)

const (
	healthPollInterval   = 250 * time.Millisecond
	defaultHealthTimeout = 90 * time.Second
)

var (
	ErrRecoveryImpossible = errors.New("portable update: no recoverable program directory remains")
	ErrHealthTimeout      = errors.New("portable update: the new build did not confirm health in time")
	ErrHealthFailed       = errors.New("portable update: the new build stopped before confirming health")
	ErrNotReadyToApply    = errors.New("portable update: the disk state is not ready to apply")
)

func isInsideOrEqual(parent, child string) bool {
	parentKey := compareKey(parent)
	childKey := compareKey(child)
	if childKey == parentKey {
		return true
	}
	return len(childKey) > len(parentKey) &&
		childKey[:len(parentKey)] == parentKey &&
		childKey[len(parentKey)] == filepath.Separator
}

func transactionScope(transaction TransactionV1) []string {
	return []string{
		filepath.Dir(transaction.ArchivePath),
		filepath.Dir(transaction.StagedProgramPath),
		transaction.BackupProgramPath,
		transaction.CurrentProgramPath,
	}
}

func assertScopedTarget(transaction TransactionV1, target string) error {
	for _, root := range transactionScope(transaction) {
		if isInsideOrEqual(root, target) {
			return nil
		}
	}
	return fmt.Errorf("%w: %s is outside the transaction scope", ErrUnsafePath, target)
}

func scopedRename(ops Ops, transaction TransactionV1, oldPath, newPath string) error {
	if err := assertScopedTarget(transaction, oldPath); err != nil {
		return err
	}
	if err := assertScopedTarget(transaction, newPath); err != nil {
		return err
	}
	return ops.Rename(oldPath, newPath)
}

func scopedMkdirAll(ops Ops, transaction TransactionV1, target string) error {
	if !isInsideOrEqual(transaction.UpdateRoot, target) || compareKey(target) == compareKey(transaction.UpdateRoot) {
		return fmt.Errorf("%w: %s is not a directory inside the update root", ErrUnsafePath, target)
	}
	for _, root := range transactionScope(transaction) {
		if isInsideOrEqual(root, target) || isInsideOrEqual(target, root) {
			return ops.MkdirAll(target)
		}
	}
	return fmt.Errorf("%w: %s is outside the transaction scope", ErrUnsafePath, target)
}

func scopedRemoveAll(ops Ops, transaction TransactionV1, target string) error {
	if err := assertScopedTarget(transaction, target); err != nil {
		return err
	}
	return ops.RemoveAll(target)
}

func Recover(_ context.Context, transaction TransactionV1, ops Ops) (RecoveryResult, error) {
	if err := ValidateTransactionPaths(transaction); err != nil {
		return RecoveryNone, err
	}
	current, err := ops.Exists(transaction.CurrentProgramPath)
	if err != nil {
		return RecoveryNone, err
	}
	staged, err := ops.Exists(transaction.StagedProgramPath)
	if err != nil {
		return RecoveryNone, err
	}
	backup, err := ops.Exists(transaction.BackupProgramPath)
	if err != nil {
		return RecoveryNone, err
	}

	switch {
	case current && staged && !backup:
		return RecoveryReady, nil
	case !current && staged && backup:
		return RecoveryRestored, scopedRename(ops, transaction, transaction.BackupProgramPath, transaction.CurrentProgramPath)
	case current && !staged && backup:
		return RecoveryAwaitHealth, nil
	case !current && !staged && backup:
		return RecoveryRestored, scopedRename(ops, transaction, transaction.BackupProgramPath, transaction.CurrentProgramPath)
	case current && !staged && !backup:
		return RecoveryNone, nil
	default:
		return RecoveryEvidenceKept, ErrRecoveryImpossible
	}
}

func VerifyStagedTransaction(ops Ops, transaction TransactionV1, publicKey ed25519.PublicKey) error {
	manifestBytes, err := ops.ReadFile(transaction.ManifestPath)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrManifestInvalid, err)
	}
	manifest, err := DecodeSignedManifest(manifestBytes)
	if err != nil {
		return err
	}
	if err := VerifySignedManifest(manifest, publicKey); err != nil {
		return err
	}
	filesBytes, err := ops.ReadFile(transaction.FileManifestPath)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrManifestInvalid, err)
	}
	files, err := DecodeFileManifest(filesBytes)
	if err != nil {
		return err
	}
	if err := VerifyFileManifestHash(manifest, files); err != nil {
		return err
	}
	if manifest.Version != transaction.TargetVersion {
		return fmt.Errorf(
			"%w: the signed manifest names version %s, the transaction names %s",
			ErrManifestInvalid,
			manifest.Version,
			transaction.TargetVersion,
		)
	}
	return VerifyProgramTree(transaction.StagedProgramPath, files)
}

func Apply(ctx context.Context, transaction TransactionV1, publicKey ed25519.PublicKey, ops Ops) error {
	if err := ValidateTransactionPaths(transaction); err != nil {
		return err
	}
	if err := VerifyStagedTransaction(ops, transaction, publicKey); err != nil {
		return err
	}

	current, err := ops.Exists(transaction.CurrentProgramPath)
	if err != nil {
		return err
	}
	backup, err := ops.Exists(transaction.BackupProgramPath)
	if err != nil {
		return err
	}
	if !current || backup {
		return fmt.Errorf("%w: current=%v backup=%v", ErrNotReadyToApply, current, backup)
	}

	if err := scopedMkdirAll(ops, transaction, filepath.Dir(transaction.BackupProgramPath)); err != nil {
		return err
	}
	if err := scopedRename(ops, transaction, transaction.CurrentProgramPath, transaction.BackupProgramPath); err != nil {
		return err
	}
	if err := scopedRename(ops, transaction, transaction.StagedProgramPath, transaction.CurrentProgramPath); err != nil {
		_ = scopedRename(ops, transaction, transaction.BackupProgramPath, transaction.CurrentProgramPath)
		return err
	}

	applying := transaction
	applying.Phase = "applying"
	if _, err := WriteTransaction(ops, applying); err != nil {
		return err
	}

	process, err := ops.StartApp(filepath.Join(transaction.CurrentProgramPath, ProgramExecutableName), nil)
	if err != nil {
		return Rollback(ctx, transaction, ops)
	}
	if err := WaitForHealth(ctx, transaction, process, ops); err != nil {
		_ = process.Kill()
		return Rollback(ctx, transaction, ops)
	}

	committed := transaction
	committed.Phase = "committed"
	_, err = WriteTransaction(ops, committed)
	return err
}

func WaitForHealth(ctx context.Context, transaction TransactionV1, process Process, ops Ops) error {
	deadline := ops.Now().Add(defaultHealthTimeout)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		select {
		case <-process.Done():
			return fmt.Errorf("%w: exit error %v", ErrHealthFailed, process.Err())
		default:
		}
		if receipt, err := ReadHealthReceipt(ops, transaction.HealthPath); err == nil {
			if receipt.TransactionID == transaction.TransactionID &&
				receipt.Version == transaction.TargetVersion &&
				compareKey(receipt.ProgramPath) == compareKey(transaction.CurrentProgramPath) {
				return nil
			}
		}
		if !ops.Now().Before(deadline) {
			return ErrHealthTimeout
		}
		ops.Sleep(healthPollInterval)
	}
}

func Rollback(_ context.Context, transaction TransactionV1, ops Ops) error {
	if err := ValidateTransactionPaths(transaction); err != nil {
		return err
	}
	current, err := ops.Exists(transaction.CurrentProgramPath)
	if err != nil {
		return err
	}
	backup, err := ops.Exists(transaction.BackupProgramPath)
	if err != nil {
		return err
	}
	if !backup {
		return fmt.Errorf("%w: there is no backup to restore", ErrRecoveryImpossible)
	}
	if current {
		if err := scopedRemoveAll(ops, transaction, transaction.CurrentProgramPath); err != nil {
			return err
		}
	}
	if err := scopedRename(ops, transaction, transaction.BackupProgramPath, transaction.CurrentProgramPath); err != nil {
		return err
	}
	if err := scopedRemoveAll(ops, transaction, filepath.Dir(transaction.StagedProgramPath)); err != nil {
		return err
	}
	rolledBack := transaction
	rolledBack.Phase = "rolled-back"
	_, err = WriteTransaction(ops, rolledBack)
	return err
}

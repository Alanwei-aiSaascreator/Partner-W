package update

import (
	"path/filepath"
	"strings"
)

// RebaseTransaction re-expresses an update record under the volume the launcher
// is actually running from.
//
// Why this exists (2026-10-19, real disk): the record stores absolute paths
// taken when the update was staged. A portable disk does not keep its drive
// letter — the same stick is E: at the office and F: at home, which is exactly
// the scenario the product promises to survive. Read from F:, the record still
// pointed at E:; Recover() found neither the program, the stage nor the backup
// and fell through to ErrRecoveryImpossible, so the launcher refused to start a
// program that was sitting right there and perfectly intact.
//
// The state file is read from <root>\.Partner-W更新\update-state.json, so whatever
// volume it sits on *is* the disk the record belongs to. Moving every path onto
// that root is therefore not a guess; it is the only reading that is consistent
// with where the file was found.
//
// It returns the transaction unchanged and false whenever it cannot rebase every
// field exactly: a partial rewrite would be worse than no rewrite at all.
func RebaseTransaction(transaction TransactionV1, root string) (TransactionV1, bool) {
	recordedRoot := filepath.Clean(transaction.UpdateRoot)
	currentRoot := filepath.Clean(filepath.Join(root, UpdateDirectoryName))
	if compareKey(recordedRoot) == compareKey(currentRoot) {
		return transaction, false
	}
	if !filepath.IsAbs(recordedRoot) || !filepath.IsAbs(root) {
		return transaction, false
	}

	// Every recorded path must sit inside the recorded update root. Anything
	// else is a record we do not understand well enough to move.
	move := func(value string) (string, bool) {
		relative, err := filepath.Rel(recordedRoot, filepath.Clean(value))
		if err != nil {
			return "", false
		}
		if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return "", false
		}
		return filepath.Join(currentRoot, relative), true
	}

	rebased := transaction
	rebased.UpdateRoot = currentRoot
	fields := []*string{
		&rebased.ArchivePath,
		&rebased.StagedProgramPath,
		&rebased.BackupProgramPath,
		&rebased.ManifestPath,
		&rebased.FileManifestPath,
		&rebased.HealthPath,
	}
	for _, field := range fields {
		next, ok := move(*field)
		if !ok {
			return transaction, false
		}
		*field = next
	}

	// The program directory is a sibling of the update root, never inside it.
	recordedProgramParent := filepath.Dir(recordedRoot)
	if compareKey(filepath.Dir(transaction.CurrentProgramPath)) != compareKey(recordedProgramParent) {
		return transaction, false
	}
	rebased.CurrentProgramPath = filepath.Join(root, filepath.Base(transaction.CurrentProgramPath))

	// The rewrite must still describe a well-formed transaction.
	if err := ValidateTransactionPaths(rebased); err != nil {
		return transaction, false
	}
	return rebased, true
}

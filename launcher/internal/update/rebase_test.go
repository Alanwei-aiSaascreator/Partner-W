package update

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func transactionOn(root string) TransactionV1 {
	transactionID := "txn-rebase"
	updateRoot := filepath.Join(root, UpdateDirectoryName)
	stageRoot := filepath.Join(updateRoot, StagedDirName, transactionID)
	return TransactionV1{
		SchemaVersion:      SchemaVersion,
		TransactionID:      transactionID,
		Phase:              "committed",
		CurrentVersion:     "1.0.8",
		TargetVersion:      "1.0.9",
		Channel:            "internal",
		UpdateRoot:         updateRoot,
		ArchivePath:        filepath.Join(updateRoot, DownloadDirName, transactionID, PackageFileName),
		StagedProgramPath:  filepath.Join(stageRoot, ProgramDirName),
		CurrentProgramPath: filepath.Join(root, ProgramDirectoryName),
		BackupProgramPath:  filepath.Join(updateRoot, BackupDirName, transactionID),
		ManifestPath:       filepath.Join(stageRoot, ManifestName),
		FileManifestPath:   filepath.Join(stageRoot, FileManifestName),
		HealthPath:         filepath.Join(updateRoot, HealthDirName, transactionID+HealthFileSuffix),
		UpdatedAt:          1,
	}
}

// The field case (2026-10-19): the record was written while the stick was E:,
// then the stick came back as F:. Every path must move, and the result must
// still pass the same validation a freshly written record does.
func TestRebaseMovesEveryPathOntoTheCurrentRoot(t *testing.T) {
	transaction := transactionOn(`E:\`)
	rebased, changed := RebaseTransaction(transaction, `F:\`)
	if !changed {
		t.Fatal("a record from another volume must be rebased")
	}

	wantRoot := filepath.Join(`F:\`, UpdateDirectoryName)
	if rebased.UpdateRoot != wantRoot {
		t.Fatalf("updateRoot = %s, want %s", rebased.UpdateRoot, wantRoot)
	}
	if rebased.CurrentProgramPath != filepath.Join(`F:\`, ProgramDirectoryName) {
		t.Fatalf("currentProgramPath = %s", rebased.CurrentProgramPath)
	}
	for name, value := range map[string]string{
		"archivePath":       rebased.ArchivePath,
		"stagedProgramPath": rebased.StagedProgramPath,
		"backupProgramPath": rebased.BackupProgramPath,
		"manifestPath":      rebased.ManifestPath,
		"fileManifestPath":  rebased.FileManifestPath,
		"healthPath":        rebased.HealthPath,
	} {
		if filepath.VolumeName(value) != `F:` {
			t.Fatalf("%s = %s, still on the old volume", name, value)
		}
		if _, err := filepath.Rel(wantRoot, value); err != nil {
			t.Fatalf("%s = %s is not under %s", name, value, wantRoot)
		}
	}
	if err := ValidateTransactionPaths(rebased); err != nil {
		t.Fatalf("the rebased record must still be valid: %v", err)
	}
	if transaction.UpdateRoot != filepath.Join(`E:\`, UpdateDirectoryName) {
		t.Fatal("the input record must not be mutated")
	}
}

func TestRebaseLeavesAMatchingRootAlone(t *testing.T) {
	root := `F:\`
	transaction := transactionOn(root)
	rebased, changed := RebaseTransaction(transaction, root)
	if changed {
		t.Fatal("a record already on this root must not be rewritten")
	}
	if rebased != transaction {
		t.Fatal("an unchanged record must come back untouched")
	}
}

// A record we cannot map exactly must be refused whole: a half-rewritten
// record would point at one volume for some fields and another for the rest.
func TestRebaseRefusesAPathOutsideTheRecordedRoot(t *testing.T) {
	transaction := transactionOn(`E:\`)
	transaction.ArchivePath = `C:\elsewhere\package.zip`
	rebased, changed := RebaseTransaction(transaction, `F:\`)
	if changed {
		t.Fatal("a path outside the recorded root must refuse the rebase")
	}
	if rebased != transaction {
		t.Fatal("a refused rebase must return the record untouched")
	}
}

func TestRebaseRefusesAProgramDirectoryThatIsNotASibling(t *testing.T) {
	transaction := transactionOn(`E:\`)
	transaction.CurrentProgramPath = filepath.Join(`E:\`, "somewhere", ProgramDirectoryName)
	if _, changed := RebaseTransaction(transaction, `F:\`); changed {
		t.Fatal("a program directory outside the volume root must refuse the rebase")
	}
}

// 回归护栏（2026-10-19 用户要求"以后更新不能再有这种基础问题"）：
// 以后往 TransactionV1 里加**任何**路径字段，只要 RebaseTransaction 没处理，
// 这条就会红 —— 不需要有人记得"还要改 rebase"。
func TestRebaseCoversEveryPathField(t *testing.T) {
	rebased, changed := RebaseTransaction(transactionOn(`E:\`), `F:\`)
	if !changed {
		t.Fatal("a record from another volume must be rebased")
	}
	before := reflect.ValueOf(transactionOn(`E:\`))
	after := reflect.ValueOf(rebased)
	typ := before.Type()
	for index := 0; index < typ.NumField(); index++ {
		field := typ.Field(index)
		if before.Field(index).Kind() != reflect.String {
			continue
		}
		if !strings.Contains(strings.ToLower(before.Field(index).String()), `e:\`) {
			continue
		}
		if strings.Contains(strings.ToLower(after.Field(index).String()), `e:\`) {
			t.Fatalf("field %s still points at the old volume (%q); teach RebaseTransaction about it",
				field.Name, after.Field(index).String())
		}
	}
}

func TestRebaseRefusesRelativeRoots(t *testing.T) {
	transaction := transactionOn(`E:\`)
	transaction.UpdateRoot = UpdateDirectoryName
	if _, changed := RebaseTransaction(transaction, `F:\`); changed {
		t.Fatal("a relative update root must refuse the rebase")
	}
}

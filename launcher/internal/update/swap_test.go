package update

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var errInjected = errors.New("injected failure")

type recordedOp struct {
	operation string
	target    string
}

type fault struct {
	operation string
	index     int
	after     bool
}

type fakeClock struct {
	now time.Time
}

func (clock *fakeClock) Now() time.Time { return clock.now }

func (clock *fakeClock) Sleep(duration time.Duration) { clock.now = clock.now.Add(duration) }

type fakeProcess struct {
	done   chan struct{}
	err    error
	killed bool
}

func newFakeProcess() *fakeProcess {
	return &fakeProcess{done: make(chan struct{})}
}

func (process *fakeProcess) Done() <-chan struct{} { return process.done }
func (process *fakeProcess) Err() error            { return process.err }
func (process *fakeProcess) Kill() error {
	process.killed = true
	return nil
}

func (process *fakeProcess) exit(err error) {
	process.err = err
	close(process.done)
}

type harnessOps struct {
	inner   Ops
	clock   *fakeClock
	process *fakeProcess
	alive   map[int]bool
	records []recordedOp
	counts  map[string]int
	faults  []fault
}

func newHarnessOps() *harnessOps {
	clock := &fakeClock{now: time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)}
	return &harnessOps{
		inner:   SystemOps{},
		clock:   clock,
		process: newFakeProcess(),
		alive:   map[int]bool{},
		counts:  map[string]int{},
	}
}

func (ops *harnessOps) record(operation string, targets ...string) {
	for _, target := range targets {
		ops.records = append(ops.records, recordedOp{operation: operation, target: target})
	}
}

func (ops *harnessOps) gate(operation string) error {
	ops.counts[operation]++
	for _, injected := range ops.faults {
		if injected.operation == operation && injected.index == ops.counts[operation] && !injected.after {
			return errInjected
		}
	}
	return nil
}

func (ops *harnessOps) gateAfter(operation string) error {
	for _, injected := range ops.faults {
		if injected.operation == operation && injected.index == ops.counts[operation] && injected.after {
			return errInjected
		}
	}
	return nil
}

func (ops *harnessOps) Rename(oldPath, newPath string) error {
	ops.record("rename", oldPath, newPath)
	if err := ops.gate("rename"); err != nil {
		return err
	}
	err := ops.inner.Rename(oldPath, newPath)
	if err == nil {
		err = ops.gateAfter("rename")
	}
	return err
}

func (ops *harnessOps) RemoveAll(path string) error {
	ops.record("remove-all", path)
	if err := ops.gate("remove-all"); err != nil {
		return err
	}
	err := ops.inner.RemoveAll(path)
	if err == nil {
		err = ops.gateAfter("remove-all")
	}
	return err
}

func (ops *harnessOps) MkdirAll(path string) error {
	ops.record("mkdir-all", path)
	return ops.inner.MkdirAll(path)
}

func (ops *harnessOps) Exists(path string) (bool, error) {
	return ops.inner.Exists(path)
}

func (ops *harnessOps) ReadFile(path string) ([]byte, error) {
	return ops.inner.ReadFile(path)
}

func (ops *harnessOps) WriteFile(path string, data []byte, perm os.FileMode) error {
	ops.record("write-file", path)
	if err := ops.gate("write-file"); err != nil {
		return err
	}
	err := ops.inner.WriteFile(path, data, perm)
	if err == nil {
		err = ops.gateAfter("write-file")
	}
	return err
}

func (ops *harnessOps) WriteFileExclusive(path string, data []byte, perm os.FileMode) error {
	ops.record("write-file-exclusive", path)
	if err := ops.gate("write-file-exclusive"); err != nil {
		return err
	}
	return ops.inner.WriteFileExclusive(path, data, perm)
}

func (ops *harnessOps) StartApp(exePath string, env []string) (Process, error) {
	ops.record("start-app", exePath)
	if err := ops.gate("start-app"); err != nil {
		return nil, err
	}
	return ops.process, nil
}

func (ops *harnessOps) ProcessAlive(pid int) bool { return ops.alive[pid] }

func (ops *harnessOps) Now() time.Time { return ops.clock.Now() }

func (ops *harnessOps) Sleep(duration time.Duration) { ops.clock.Sleep(duration) }

type scenario struct {
	root        string
	transaction TransactionV1
	ops         *harnessOps
	key         ed25519.PublicKey
}

func newScenario(t *testing.T) *scenario {
	t.Helper()
	root := t.TempDir()
	transaction := validTransaction(root)
	ops := newHarnessOps()
	instance := &scenario{root: root, transaction: transaction, ops: ops, key: readPublicKey(t)}

	for _, directory := range []string{
		filepath.Dir(transaction.ArchivePath),
		filepath.Dir(transaction.FileManifestPath),
		filepath.Dir(transaction.HealthPath),
	} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatalf("create %s: %v", directory, err)
		}
	}
	if err := os.WriteFile(transaction.ArchivePath, []byte("package"), 0o644); err != nil {
		t.Fatalf("write the archive: %v", err)
	}
	return instance
}

func (instance *scenario) stageVerifiedProgram(t *testing.T) {
	t.Helper()
	if err := copyTree(filepath.Join(fixtureRoot, fixtureProgram), instance.transaction.StagedProgramPath); err != nil {
		t.Fatalf("stage the program tree: %v", err)
	}
	copyFile(t, filepath.Join(fixtureRoot, fixtureManifest), instance.transaction.ManifestPath)
	copyFile(t, filepath.Join(fixtureRoot, fixtureFiles), instance.transaction.FileManifestPath)
}

func copyFile(t *testing.T, source, target string) {
	t.Helper()
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatalf("read %s: %v", source, err)
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		t.Fatalf("write %s: %v", target, err)
	}
}

func (instance *scenario) writeCurrentProgram(t *testing.T) {
	t.Helper()
	if err := os.MkdirAll(instance.transaction.CurrentProgramPath, 0o755); err != nil {
		t.Fatalf("create the current program directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(instance.transaction.CurrentProgramPath, "old.txt"), []byte("old"), 0o644); err != nil {
		t.Fatalf("write the current program: %v", err)
	}
}

func (instance *scenario) createOperatorsAssets(t *testing.T) []string {
	t.Helper()
	targets := []string{
		filepath.Join(instance.transaction.UpdateRoot, LogsDirName, "launcher.log"),
		filepath.Join(instance.transaction.UpdateRoot, StagedDirName, "other-transaction", ProgramDirName, "keep.txt"),
		filepath.Join(instance.root, DataDirectoryName, "keep.bin"),
		filepath.Join(instance.root, WorkspaceDirectoryName, "keep.bin"),
	}
	for _, target := range targets {
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatalf("create %s: %v", filepath.Dir(target), err)
		}
		if err := os.WriteFile(target, []byte("keep"), 0o644); err != nil {
			t.Fatalf("write %s: %v", target, err)
		}
	}
	return targets
}

func (instance *scenario) writeHealthReceipt(t *testing.T, transactionID string, version string, programPath string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(instance.transaction.HealthPath), 0o755); err != nil {
		t.Fatalf("create the health directory: %v", err)
	}
	encoded, err := json.Marshal(HealthReceiptV1{
		SchemaVersion: SchemaVersion,
		TransactionID: transactionID,
		Version:       version,
		ProgramPath:   programPath,
		HealthyAt:     "2026-09-21T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("encode the health receipt: %v", err)
	}
	if err := os.WriteFile(instance.transaction.HealthPath, encoded, 0o644); err != nil {
		t.Fatalf("write the health receipt: %v", err)
	}
	if _, err := ReadHealthReceipt(instance.ops, instance.transaction.HealthPath); err != nil {
		t.Fatalf("the fixture receipt must be readable, otherwise every health test passes for the wrong reason: %v", err)
	}
}

func (instance *scenario) assertOnlyScopedOperations(t *testing.T) {
	t.Helper()
	transaction := instance.transaction
	exactTargets := []string{transaction.UpdateRoot, instance.root}
	protectedRoots := []string{
		filepath.Join(instance.root, DataDirectoryName),
		filepath.Join(instance.root, WorkspaceDirectoryName),
		filepath.Join(instance.root, LauncherFileName),
	}
	allowedRoots := append(transactionScope(transaction), transaction.UpdateRoot)

	for _, record := range instance.ops.records {
		for _, guard := range protectedRoots {
			if isInsideOrEqual(guard, record.target) {
				t.Fatalf("operation %s touched the protected path %s", record.operation, record.target)
			}
		}
		if record.operation != "rename" && record.operation != "remove-all" {
			continue
		}
		for _, guard := range exactTargets {
			if compareKey(guard) == compareKey(record.target) {
				t.Fatalf("operation %s targeted %s itself", record.operation, record.target)
			}
		}
		matched := false
		for _, allowed := range allowedRoots {
			if isInsideOrEqual(allowed, record.target) {
				matched = true
				break
			}
		}
		if !matched {
			t.Fatalf("operation %s touched %s, which is outside the transaction scope", record.operation, record.target)
		}
	}
}

func TestRecoverCoversEveryDirectoryState(t *testing.T) {
	cases := []struct {
		name     string
		current  bool
		staged   bool
		backup   bool
		expected RecoveryResult
		fails    bool
	}{
		{"ready to apply", true, true, false, RecoveryReady, false},
		{"staged and backup without a current tree", false, true, true, RecoveryRestored, false},
		{"awaiting health", true, false, true, RecoveryAwaitHealth, false},
		{"only a backup remains", false, false, true, RecoveryRestored, false},
		{"normal launch", true, false, false, RecoveryNone, false},
		{"nothing left", false, false, false, RecoveryEvidenceKept, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			instance := newScenario(t)
			if testCase.current {
				instance.writeCurrentProgram(t)
			}
			if testCase.staged {
				instance.stageVerifiedProgram(t)
			}
			if testCase.backup {
				if err := os.MkdirAll(instance.transaction.BackupProgramPath, 0o755); err != nil {
					t.Fatalf("create the backup: %v", err)
				}
			}

			result, err := Recover(context.Background(), instance.transaction, instance.ops)
			if testCase.fails {
				if !errors.Is(err, ErrRecoveryImpossible) {
					t.Fatalf("expected ErrRecoveryImpossible, got %v", err)
				}
			} else if err != nil {
				t.Fatalf("recover: %v", err)
			}
			if result != testCase.expected {
				t.Fatalf("recover result = %s, want %s", result, testCase.expected)
			}
			instance.assertOnlyScopedOperations(t)
		})
	}
}

func TestRecoverRestoresTheBackupIntoTheProgramDirectory(t *testing.T) {
	instance := newScenario(t)
	if err := os.MkdirAll(instance.transaction.BackupProgramPath, 0o755); err != nil {
		t.Fatalf("create the backup: %v", err)
	}
	marker := filepath.Join(instance.transaction.BackupProgramPath, "previous.txt")
	if err := os.WriteFile(marker, []byte("previous"), 0o644); err != nil {
		t.Fatalf("write the backup marker: %v", err)
	}

	result, err := Recover(context.Background(), instance.transaction, instance.ops)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if result != RecoveryRestored {
		t.Fatalf("recover result = %s, want restored", result)
	}
	if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "previous.txt")); err != nil {
		t.Fatalf("the backup must now sit in the program directory: %v", err)
	}
	if _, err := os.Stat(instance.transaction.BackupProgramPath); !os.IsNotExist(err) {
		t.Fatalf("the backup directory must have moved away")
	}
}

func TestRecoverIsIdempotentAcrossRenameInjections(t *testing.T) {
	for _, after := range []bool{false, true} {
		name := "before the rename"
		if after {
			name = "after the rename"
		}
		t.Run(name, func(t *testing.T) {
			instance := newScenario(t)
			if err := os.MkdirAll(instance.transaction.BackupProgramPath, 0o755); err != nil {
				t.Fatalf("create the backup: %v", err)
			}
			if err := os.WriteFile(filepath.Join(instance.transaction.BackupProgramPath, "previous.txt"), []byte("previous"), 0o644); err != nil {
				t.Fatalf("write the backup marker: %v", err)
			}

			instance.ops.faults = []fault{{operation: "rename", index: 1, after: after}}
			if _, err := Recover(context.Background(), instance.transaction, instance.ops); !errors.Is(err, errInjected) {
				t.Fatalf("the injected failure must surface, got %v", err)
			}

			instance.ops.faults = nil
			if _, err := Recover(context.Background(), instance.transaction, instance.ops); err != nil {
				t.Fatalf("recovery after an interruption must be clean: %v", err)
			}
			if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "previous.txt")); err != nil {
				t.Fatalf("the backup must end up in the program directory: %v", err)
			}
			if _, err := os.Stat(instance.transaction.BackupProgramPath); !os.IsNotExist(err) {
				t.Fatalf("the backup must not be duplicated")
			}
		})
	}
}

func TestApplyIsIdempotentAcrossSwapInjections(t *testing.T) {
	for _, after := range []bool{false, true} {
		name := "before the swap rename"
		if after {
			name = "after the swap rename"
		}
		t.Run(name, func(t *testing.T) {
			instance := newScenario(t)
			instance.writeCurrentProgram(t)
			instance.stageVerifiedProgram(t)
			instance.writeHealthReceipt(t, instance.transaction.TransactionID, instance.transaction.TargetVersion, instance.transaction.CurrentProgramPath)

			instance.ops.faults = []fault{{operation: "rename", index: 1, after: after}}
			if err := Apply(context.Background(), instance.transaction, instance.key, instance.ops); !errors.Is(err, errInjected) {
				t.Fatalf("the injected failure must surface, got %v", err)
			}

			instance.ops.faults = nil
			if _, err := Recover(context.Background(), instance.transaction, instance.ops); err != nil {
				t.Fatalf("recovery after an interrupted swap must be clean: %v", err)
			}
			if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "old.txt")); err != nil {
				t.Fatalf("an interrupted swap must leave the previous tree in place: %v", err)
			}
			instance.assertOnlyScopedOperations(t)
		})
	}
}

func TestApplySwapsTheTreesAndCommitsAfterHealth(t *testing.T) {
	instance := newScenario(t)
	instance.writeCurrentProgram(t)
	instance.stageVerifiedProgram(t)
	instance.writeHealthReceipt(t, instance.transaction.TransactionID, instance.transaction.TargetVersion, instance.transaction.CurrentProgramPath)
	protected := instance.createOperatorsAssets(t)

	if err := Apply(context.Background(), instance.transaction, instance.key, instance.ops); err != nil {
		t.Fatalf("apply: %v", err)
	}

	if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "resources", "app.asar")); err != nil {
		t.Fatalf("the new tree must be live: %v", err)
	}
	if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "old.txt")); !os.IsNotExist(err) {
		t.Fatalf("the old tree must have moved to the backup")
	}
	if _, err := os.Stat(filepath.Join(instance.transaction.BackupProgramPath, "old.txt")); err != nil {
		t.Fatalf("the backup must hold the previous tree: %v", err)
	}
	if _, err := os.Stat(instance.transaction.StagedProgramPath); !os.IsNotExist(err) {
		t.Fatalf("the stage directory must have moved away")
	}
	for _, target := range protected {
		if _, err := os.Stat(target); err != nil {
			t.Fatalf("protected asset %s must survive: %v", target, err)
		}
	}
	instance.assertOnlyScopedOperations(t)

	state, err := ReadTransactionWith(instance.ops, StatePath(instance.transaction))
	if err != nil {
		t.Fatalf("read the final state: %v", err)
	}
	if state.Phase != "committed" {
		t.Fatalf("final phase = %s, want committed", state.Phase)
	}
}

func TestApplyRefusesAnUnverifiedStage(t *testing.T) {
	instance := newScenario(t)
	instance.writeCurrentProgram(t)
	instance.stageVerifiedProgram(t)
	tampered := filepath.Join(instance.transaction.StagedProgramPath, "resources", "app.asar")
	if err := os.WriteFile(tampered, []byte("tampered content"), 0o644); err != nil {
		t.Fatalf("tamper with the stage: %v", err)
	}

	if err := Apply(context.Background(), instance.transaction, instance.key, instance.ops); !errors.Is(err, ErrFileIntegrity) {
		t.Fatalf("a tampered stage must be refused, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "old.txt")); err != nil {
		t.Fatalf("the current program must be untouched: %v", err)
	}
}

func TestApplyRollsBackWhenTheNewBuildNeverConfirmsHealth(t *testing.T) {
	instance := newScenario(t)
	instance.writeCurrentProgram(t)
	instance.stageVerifiedProgram(t)
	protected := instance.createOperatorsAssets(t)

	if err := Apply(context.Background(), instance.transaction, instance.key, instance.ops); err != nil {
		t.Fatalf("apply must roll back rather than fail: %v", err)
	}

	if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "old.txt")); err != nil {
		t.Fatalf("the previous tree must be back in place: %v", err)
	}
	if _, err := os.Stat(instance.transaction.BackupProgramPath); !os.IsNotExist(err) {
		t.Fatalf("the backup must have been consumed by the rollback")
	}
	if _, err := os.Stat(filepath.Join(instance.transaction.UpdateRoot, DownloadDirName, instance.transaction.TransactionID)); err != nil {
		t.Fatalf("the download directory stays until the next launcher start: %v", err)
	}
	for _, target := range protected {
		if _, err := os.Stat(target); err != nil {
			t.Fatalf("protected asset %s must survive the rollback: %v", target, err)
		}
	}
	instance.assertOnlyScopedOperations(t)

	state, err := ReadTransactionWith(instance.ops, StatePath(instance.transaction))
	if err != nil {
		t.Fatalf("read the final state: %v", err)
	}
	if state.Phase != "rolled-back" {
		t.Fatalf("final phase = %s, want rolled-back", state.Phase)
	}
}

func TestApplyRollsBackWhenTheNewBuildExitsEarly(t *testing.T) {
	instance := newScenario(t)
	instance.writeCurrentProgram(t)
	instance.stageVerifiedProgram(t)
	instance.ops.process.exit(errors.New("crashed"))

	if err := Apply(context.Background(), instance.transaction, instance.key, instance.ops); err != nil {
		t.Fatalf("a crash before health must roll back rather than fail: %v", err)
	}
	if _, err := os.Stat(filepath.Join(instance.transaction.CurrentProgramPath, "old.txt")); err != nil {
		t.Fatalf("the previous tree must be back in place: %v", err)
	}
}

func TestWaitForHealthRejectsAReceiptFromAnotherTransaction(t *testing.T) {
	instance := newScenario(t)
	instance.writeHealthReceipt(t, "another-transaction", instance.transaction.TargetVersion, instance.transaction.CurrentProgramPath)
	instance.ops.clock.now = time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)

	if err := WaitForHealth(context.Background(), instance.transaction, instance.ops.process, instance.ops); !errors.Is(err, ErrHealthTimeout) {
		t.Fatalf("a receipt from another transaction must not confirm health, got %v", err)
	}
}

func TestWaitForHealthRejectsAReceiptFromAnotherProgramPath(t *testing.T) {
	instance := newScenario(t)
	instance.writeHealthReceipt(t, instance.transaction.TransactionID, instance.transaction.TargetVersion, filepath.Join(instance.root, "elsewhere"))

	if err := WaitForHealth(context.Background(), instance.transaction, instance.ops.process, instance.ops); !errors.Is(err, ErrHealthTimeout) {
		t.Fatalf("a receipt from another path must not confirm health, got %v", err)
	}
}

func TestWaitForHealthRejectsAReceiptForAnotherVersion(t *testing.T) {
	instance := newScenario(t)
	instance.writeHealthReceipt(t, instance.transaction.TransactionID, "0.0.27", instance.transaction.CurrentProgramPath)

	if err := WaitForHealth(context.Background(), instance.transaction, instance.ops.process, instance.ops); !errors.Is(err, ErrHealthTimeout) {
		t.Fatalf("a receipt for another version must not confirm health, got %v", err)
	}
}

func TestWaitForHealthReportsAnEarlyExit(t *testing.T) {
	instance := newScenario(t)
	instance.ops.process.exit(errors.New("crashed"))

	if err := WaitForHealth(context.Background(), instance.transaction, instance.ops.process, instance.ops); !errors.Is(err, ErrHealthFailed) {
		t.Fatalf("an early exit must be reported as a health failure, got %v", err)
	}
}

func TestWaitForHealthStopsWhenTheContextIsCancelled(t *testing.T) {
	instance := newScenario(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := WaitForHealth(ctx, instance.transaction, instance.ops.process, instance.ops); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled context must stop the wait, got %v", err)
	}
}

func TestSwapRefusesOperationsOutsideTheTransactionScope(t *testing.T) {
	instance := newScenario(t)

	if err := scopedRemoveAll(instance.ops, instance.transaction, instance.transaction.UpdateRoot); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("clearing the whole update root must be refused, got %v", err)
	}
	if err := scopedRemoveAll(instance.ops, instance.transaction, instance.root); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("clearing the delivery root must be refused, got %v", err)
	}
	if err := scopedRemoveAll(instance.ops, instance.transaction, filepath.Join(instance.root, DataDirectoryName)); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("clearing the run data directory must be refused, got %v", err)
	}
	if err := scopedRename(instance.ops, instance.transaction, instance.transaction.UpdateRoot, instance.transaction.BackupProgramPath); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("renaming the whole update root must be refused, got %v", err)
	}
	if _, err := os.Stat(instance.transaction.UpdateRoot); err != nil {
		t.Fatalf("the update root must still exist: %v", err)
	}
	if len(instance.ops.records) != 0 {
		t.Fatalf("a refused operation must not reach the filesystem, recorded %v", instance.ops.records)
	}
}

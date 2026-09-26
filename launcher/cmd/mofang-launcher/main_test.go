package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"mofang-compass/portable-launcher/internal/ui"
	"mofang-compass/portable-launcher/internal/update"
)

// fixtureRoot is resolved once, absolutely: a test may change the process
// working directory — the launcher under test does exactly that, see
// workdir_test.go — and a relative fixture path would then point at nothing.
var (
	fixtureRoot = func() string {
		absolute, err := filepath.Abs("../../testdata")
		if err != nil {
			panic(err)
		}
		return absolute
	}()
	launcherRoot = filepath.Join(fixtureRoot, "..")
)

const modeUnused invocationMode = -1

type fakeProcess struct {
	done chan struct{}
}

func (process *fakeProcess) Done() <-chan struct{} { return process.done }
func (process *fakeProcess) Err() error            { return nil }
func (process *fakeProcess) Kill() error           { return nil }

type fakeOps struct {
	inner    update.Ops
	started  []string
	startErr error
	alive    map[int]bool
	now      time.Time
	// lockRenames makes the next renames fail the way Windows does while
	// something still holds the tree; 1<<30 means "for the whole call".
	lockRenames int
}

func newFakeOps() *fakeOps {
	return &fakeOps{
		inner: update.SystemOps{},
		alive: map[int]bool{},
		now:   time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC),
	}
}

func (ops *fakeOps) Rename(oldPath, newPath string) error {
	if ops.lockRenames > 0 {
		ops.lockRenames--
		return &os.LinkError{Op: "rename", Old: oldPath, New: newPath, Err: syscall.Errno(32)}
	}
	return ops.inner.Rename(oldPath, newPath)
}
func (ops *fakeOps) RemoveAll(path string) error          { return ops.inner.RemoveAll(path) }
func (ops *fakeOps) Exists(path string) (bool, error)     { return ops.inner.Exists(path) }
func (ops *fakeOps) MkdirAll(path string) error           { return ops.inner.MkdirAll(path) }
func (ops *fakeOps) ReadFile(path string) ([]byte, error) { return ops.inner.ReadFile(path) }
func (ops *fakeOps) WriteFile(path string, data []byte, perm fs.FileMode) error {
	return ops.inner.WriteFile(path, data, perm)
}
func (ops *fakeOps) WriteFileExclusive(path string, data []byte, perm fs.FileMode) error {
	return ops.inner.WriteFileExclusive(path, data, perm)
}
func (ops *fakeOps) StartApp(exePath string, _ []string) (update.Process, error) {
	ops.started = append(ops.started, exePath)
	if ops.startErr != nil {
		return nil, ops.startErr
	}
	return &fakeProcess{done: make(chan struct{})}, nil
}
func (ops *fakeOps) ProcessAlive(pid int) bool { return ops.alive[pid] }
func (ops *fakeOps) Now() time.Time            { return ops.now }
func (ops *fakeOps) Sleep(duration time.Duration) {
	ops.now = ops.now.Add(duration)
}

type fakeScreen struct {
	shown   []string
	updated []string
	errors  []string
	closed  int
}

func (screen *fakeScreen) Show(title, message string) {
	screen.shown = append(screen.shown, title+"|"+message)
}
func (screen *fakeScreen) Update(message string) { screen.updated = append(screen.updated, message) }
func (screen *fakeScreen) Close()                { screen.closed += 1 }
func (screen *fakeScreen) Error(title, message string) {
	screen.errors = append(screen.errors, title+"|"+message)
}

type harness struct {
	root         string
	ops          *fakeOps
	screen       *fakeScreen
	messages     ui.Messages
	publicKey    ed25519.PublicKey
	launcherPath string
	output       *bytes.Buffer
	logs         *bytes.Buffer
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	root := t.TempDir()
	// The launcher moves its own working directory, and that is process-wide:
	// give every test its own and let testing restore it, so one test cannot
	// leave the next one standing in a deleted directory.
	t.Chdir(root)
	publicKeyText, err := os.ReadFile(filepath.Join(fixtureRoot, "public-key.der.b64"))
	if err != nil {
		t.Fatalf("read the fixture public key: %v", err)
	}
	publicKey, err := decodePublicKey(strings.TrimSpace(string(publicKeyText)))
	if err != nil {
		t.Fatalf("decode the fixture public key: %v", err)
	}
	localeBytes, err := os.ReadFile(filepath.Join(launcherRoot, "locales", "zh-CN.json"))
	if err != nil {
		t.Fatalf("read the locale file: %v", err)
	}
	messages, err := ui.ParseMessages(localeBytes)
	if err != nil {
		t.Fatalf("parse the locale file: %v", err)
	}
	return &harness{
		root:         root,
		ops:          newFakeOps(),
		screen:       &fakeScreen{},
		messages:     messages,
		publicKey:    publicKey,
		launcherPath: filepath.Join(root, "launcher.exe"),
		output:       &bytes.Buffer{},
		logs:         &bytes.Buffer{},
	}
}

func (harness *harness) dependencies() dependencies {
	return dependencies{
		ops:          harness.ops,
		screen:       harness.screen,
		messages:     harness.messages,
		publicKey:    harness.publicKey,
		version:      "1.2.3",
		launcherPath: harness.launcherPath,
		output:       harness.output,
		logf: func(format string, args ...any) {
			fmt.Fprintf(harness.logs, format+"|", args...)
		},
	}
}

func (harness *harness) transaction() update.TransactionV1 {
	transactionID := "txn-launcher"
	updateRoot := filepath.Join(harness.root, update.UpdateDirectoryName)
	stageRoot := filepath.Join(updateRoot, update.StagedDirName, transactionID)
	return update.TransactionV1{
		SchemaVersion:      update.SchemaVersion,
		TransactionID:      transactionID,
		Phase:              "ready",
		CurrentVersion:     "0.0.25",
		TargetVersion:      "0.0.26",
		Channel:            "internal",
		UpdateRoot:         updateRoot,
		ArchivePath:        filepath.Join(updateRoot, update.DownloadDirName, transactionID, update.PackageFileName),
		StagedProgramPath:  filepath.Join(stageRoot, update.ProgramDirName),
		CurrentProgramPath: filepath.Join(harness.root, update.ProgramDirectoryName),
		BackupProgramPath:  filepath.Join(updateRoot, update.BackupDirName, transactionID),
		ManifestPath:       filepath.Join(stageRoot, update.ManifestName),
		FileManifestPath:   filepath.Join(stageRoot, update.FileManifestName),
		HealthPath:         filepath.Join(updateRoot, update.HealthDirName, transactionID+update.HealthFileSuffix),
		UpdatedAt:          1,
	}
}

func (harness *harness) mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
}

func (harness *harness) writeFile(t *testing.T, path string, content string) {
	t.Helper()
	harness.mkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func copyTreeInto(t *testing.T, source, target string) {
	t.Helper()
	err := filepath.WalkDir(source, func(current string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		data, err := os.ReadFile(current)
		if err != nil {
			return err
		}
		return os.WriteFile(destination, data, 0o644)
	})
	if err != nil {
		t.Fatalf("copy the fixture tree: %v", err)
	}
}

func (harness *harness) installCurrentProgram(t *testing.T) {
	t.Helper()
	directory := filepath.Join(harness.root, update.ProgramDirectoryName)
	harness.writeFile(t, filepath.Join(directory, "old.txt"), "old")
	harness.writeFile(t, filepath.Join(directory, update.ProgramExecutableName), "program executable")
}

func (harness *harness) installVerifiedStage(t *testing.T, transaction update.TransactionV1) {
	t.Helper()
	copyTreeInto(t, filepath.Join(fixtureRoot, "program"), transaction.StagedProgramPath)
	for _, pair := range [][2]string{
		{filepath.Join(fixtureRoot, "manifest.json"), transaction.ManifestPath},
		{filepath.Join(fixtureRoot, "portable-files.json"), transaction.FileManifestPath},
	} {
		data, err := os.ReadFile(pair[0])
		if err != nil {
			t.Fatalf("read %s: %v", pair[0], err)
		}
		harness.writeFile(t, pair[1], string(data))
	}
	harness.mkdir(t, filepath.Dir(transaction.HealthPath))
}

func (harness *harness) writeHealthReceipt(t *testing.T, transaction update.TransactionV1) {
	t.Helper()
	encoded, err := json.Marshal(update.HealthReceiptV1{
		SchemaVersion: update.SchemaVersion,
		TransactionID: transaction.TransactionID,
		Version:       transaction.TargetVersion,
		ProgramPath:   transaction.CurrentProgramPath,
		HealthyAt:     "2026-09-21T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("encode the health receipt: %v", err)
	}
	harness.writeFile(t, transaction.HealthPath, string(encoded))
}

func (harness *harness) writeState(t *testing.T, transaction update.TransactionV1) {
	t.Helper()
	encoded, err := json.Marshal(transaction)
	if err != nil {
		t.Fatalf("encode the transaction: %v", err)
	}
	harness.writeFile(t, filepath.Join(transaction.UpdateRoot, update.StateFileName), string(encoded))
}

func (harness *harness) stagePath(transaction update.TransactionV1) string {
	return filepath.Join(transaction.UpdateRoot, update.StateFileName)
}

// A message lives in three places — the struct, the JSON and the embedded file
// — and a key missing from the JSON is silently an empty string, so the user
// would get a blank dialog with no way to tell whether it meant anything.
// Nothing else would notice: the launcher still starts, the tag still parses.
func TestEveryLauncherMessageHasCopy(t *testing.T) {
	harness := newHarness(t)
	value := reflect.ValueOf(harness.messages)
	messageType := value.Type()
	for index := 0; index < value.NumField(); index++ {
		if value.Field(index).String() == "" {
			field := messageType.Field(index)
			t.Errorf("locales/zh-CN.json is missing copy for %s (key %q)", field.Name, field.Tag.Get("json"))
		}
	}
}

func TestParseInvocationAcceptsOnlyTheDocumentedArguments(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		mode     invocationMode
		rejected bool
	}{
		{"no arguments launches", nil, modeLaunch, false},
		{"version", []string{"--version"}, modeVersion, false},
		{"apply with a path", []string{"--apply", "C:/state.json"}, modeApply, false},
		{"apply without a path", []string{"--apply"}, modeUnused, true},
		{"apply with an empty path", []string{"--apply", ""}, modeUnused, true},
		{"unknown flag", []string{"--force"}, modeUnused, true},
		{"positional argument", []string{"state.json"}, modeUnused, true},
		{"too many arguments", []string{"--apply", "a", "b"}, modeUnused, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := parseInvocation(testCase.args)
			if testCase.rejected {
				if err == nil {
					t.Fatalf("expected %v to be rejected", testCase.args)
				}
				return
			}
			if err != nil {
				t.Fatalf("%v must be accepted: %v", testCase.args, err)
			}
			if parsed.mode != testCase.mode {
				t.Fatalf("mode = %v, want %v", parsed.mode, testCase.mode)
			}
		})
	}
}

func TestVersionReportsTheLauncherVersion(t *testing.T) {
	harness := newHarness(t)
	code := run([]string{"--version"}, harness.dependencies())

	if code != exitOK {
		t.Fatalf("exit code = %d, want %d", code, exitOK)
	}
	if strings.TrimSpace(harness.output.String()) != "1.2.3" {
		t.Fatalf("version output = %q", harness.output.String())
	}
	if len(harness.ops.started) != 0 {
		t.Fatalf("printing the version must not start anything")
	}
}

func TestLaunchStartsTheProgramFromTheDeliveryRoot(t *testing.T) {
	harness := newHarness(t)
	harness.installCurrentProgram(t)

	code := run(nil, harness.dependencies())

	if code != exitOK {
		t.Fatalf("exit code = %d, want %d", code, exitOK)
	}
	expected := filepath.Join(harness.root, update.ProgramDirectoryName, update.ProgramExecutableName)
	if len(harness.ops.started) != 1 || harness.ops.started[0] != expected {
		t.Fatalf("started %v, want %s", harness.ops.started, expected)
	}
	if len(harness.screen.errors) != 0 {
		t.Fatalf("a clean launch must not report an error: %v", harness.screen.errors)
	}
}

func TestLaunchRefusesWhenTheProgramExecutableIsMissing(t *testing.T) {
	harness := newHarness(t)
	harness.mkdir(t, filepath.Join(harness.root, update.ProgramDirectoryName))

	code := run(nil, harness.dependencies())

	if code != exitNoProgram {
		t.Fatalf("exit code = %d, want %d", code, exitNoProgram)
	}
	if len(harness.ops.started) != 0 {
		t.Fatalf("nothing may be started without a program executable")
	}
	if len(harness.screen.errors) != 1 || !strings.HasPrefix(harness.screen.errors[0], harness.messages.MissingProgram) {
		t.Fatalf("the user must be told the program is missing: %v", harness.screen.errors)
	}
}

func TestLaunchReportsAStartFailure(t *testing.T) {
	harness := newHarness(t)
	harness.installCurrentProgram(t)
	harness.ops.startErr = errors.New("blocked")

	code := run(nil, harness.dependencies())

	if code != exitLaunchFailed {
		t.Fatalf("exit code = %d, want %d", code, exitLaunchFailed)
	}
	if len(harness.screen.errors) != 1 || !strings.HasPrefix(harness.screen.errors[0], harness.messages.LaunchFailed) {
		t.Fatalf("the user must be told the launch failed: %v", harness.screen.errors)
	}
}

func TestLaunchRecoversAPendingTransactionBeforeStarting(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	harness.installCurrentProgram(t)
	harness.installVerifiedStage(t, transaction)
	harness.writeState(t, transaction)

	code := run(nil, harness.dependencies())

	if code != exitOK {
		t.Fatalf("exit code = %d, want %d", code, exitOK)
	}
	if len(harness.ops.started) != 1 {
		t.Fatalf("the program must start once, started %v", harness.ops.started)
	}
	if _, err := os.Stat(filepath.Join(harness.root, update.UpdateDirectoryName, update.LockFileName)); !os.IsNotExist(err) {
		t.Fatalf("the launcher must release the lock before exiting")
	}
}

func TestLaunchRefusesAnUnreadableStateFile(t *testing.T) {
	harness := newHarness(t)
	harness.writeFile(t, filepath.Join(harness.root, update.UpdateDirectoryName, update.StateFileName), "{ not json")
	harness.installCurrentProgram(t)

	code := run(nil, harness.dependencies())

	if code != exitInvalidState {
		t.Fatalf("exit code = %d, want %d", code, exitInvalidState)
	}
	if len(harness.ops.started) != 0 {
		t.Fatalf("an unreadable state file must not start anything")
	}
}

func TestApplySwapsTheTreesWithoutRelaunching(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	harness.installCurrentProgram(t)
	harness.installVerifiedStage(t, transaction)
	harness.writeState(t, transaction)
	harness.writeHealthReceipt(t, transaction)

	code := run([]string{"--apply", harness.stagePath(transaction)}, harness.dependencies())

	if code != exitOK {
		t.Fatalf("exit code = %d, want %d; launcher log: %s", code, exitOK, harness.logs.String())
	}
	if len(harness.screen.shown) != 1 {
		t.Fatalf("the launcher must warn the user not to unplug the drive: %v", harness.screen.shown)
	}
	if harness.screen.closed != 1 {
		t.Fatalf("the warning window must be closed again, closed %d times", harness.screen.closed)
	}
	if _, err := os.Stat(filepath.Join(transaction.CurrentProgramPath, "resources", "app.asar")); err != nil {
		t.Fatalf("the new tree must be live: %v", err)
	}
	if len(harness.screen.errors) != 0 {
		t.Fatalf("a clean apply must not report an error: %v", harness.screen.errors)
	}
}

func TestApplyReportsInvalidStateWithoutTouchingTheDisk(t *testing.T) {
	harness := newHarness(t)
	harness.installCurrentProgram(t)
	path := filepath.Join(harness.root, "broken.json")
	harness.writeFile(t, path, "{ not json")

	code := run([]string{"--apply", path}, harness.dependencies())

	if code != exitInvalidState {
		t.Fatalf("exit code = %d, want %d", code, exitInvalidState)
	}
	if len(harness.screen.errors) != 1 || !strings.HasPrefix(harness.screen.errors[0], harness.messages.InvalidState) {
		t.Fatalf("the user must be told the state is unusable: %v", harness.screen.errors)
	}
	if len(harness.ops.started) != 0 {
		t.Fatalf("an unusable state file must not start anything")
	}
}

func TestApplyRefusesWhileAnotherLauncherHoldsTheLock(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	harness.installCurrentProgram(t)
	harness.installVerifiedStage(t, transaction)
	harness.writeState(t, transaction)

	const holder = 5150
	harness.ops.alive[holder] = true
	lockBytes, err := json.Marshal(update.LockRecordV1{
		SchemaVersion: update.SchemaVersion,
		Pid:           holder,
		TransactionID: transaction.TransactionID,
		CreatedAt:     "2026-09-21T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("encode the lock record: %v", err)
	}
	harness.writeFile(t, update.LockPath(transaction), string(lockBytes))

	code := run([]string{"--apply", harness.stagePath(transaction)}, harness.dependencies())

	if code != exitLockHeld {
		t.Fatalf("exit code = %d, want %d", code, exitLockHeld)
	}
	if len(harness.screen.errors) != 1 || !strings.HasPrefix(harness.screen.errors[0], harness.messages.LockHeld) {
		t.Fatalf("the user must be told another launcher is working: %v", harness.screen.errors)
	}
	if _, err := os.Stat(filepath.Join(transaction.CurrentProgramPath, "old.txt")); err != nil {
		t.Fatalf("the current program must be untouched: %v", err)
	}
}

func TestApplyRefusesWithoutABuildTimePublicKey(t *testing.T) {
	harness := newHarness(t)
	transaction := harness.transaction()
	harness.installCurrentProgram(t)
	harness.installVerifiedStage(t, transaction)
	harness.writeState(t, transaction)

	deps := harness.dependencies()
	deps.publicKey = nil
	code := run([]string{"--apply", harness.stagePath(transaction)}, deps)

	if code != exitApplyFailed {
		t.Fatalf("exit code = %d, want %d", code, exitApplyFailed)
	}
	if len(harness.screen.errors) != 1 || !strings.HasPrefix(harness.screen.errors[0], harness.messages.MissingPublicKey) {
		t.Fatalf("a launcher without a public key must say so: %v", harness.screen.errors)
	}
	if _, err := os.Stat(filepath.Join(transaction.CurrentProgramPath, "old.txt")); err != nil {
		t.Fatalf("the current program must be untouched: %v", err)
	}
}

func TestApplyReportsRefusalForAnUnknownArgument(t *testing.T) {
	harness := newHarness(t)
	code := run([]string{"--please"}, harness.dependencies())

	if code != exitUnsupported {
		t.Fatalf("exit code = %d, want %d", code, exitUnsupported)
	}
	if len(harness.screen.errors) != 1 || !strings.HasPrefix(harness.screen.errors[0], harness.messages.UnsupportedArgs) {
		t.Fatalf("the user must be told the arguments are wrong: %v", harness.screen.errors)
	}
}

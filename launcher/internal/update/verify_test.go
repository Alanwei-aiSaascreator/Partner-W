package update

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	fixtureRoot     = "../../testdata"
	fixtureManifest = "manifest.json"
	fixtureFiles    = "portable-files.json"
	fixtureKey      = "public-key.der.b64"
	fixtureProgram  = "program"
)

func quoted(value string) string {
	q := string(rune(34))
	return q + value + q
}

func readPublicKey(t *testing.T) ed25519.PublicKey {
	t.Helper()
	encoded, err := os.ReadFile(filepath.Join(fixtureRoot, fixtureKey))
	if err != nil {
		t.Fatalf("read the fixture public key: %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil {
		t.Fatalf("decode the fixture public key: %v", err)
	}
	parsed, err := x509.ParsePKIXPublicKey(decoded)
	if err != nil {
		t.Fatalf("parse the fixture public key: %v", err)
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		t.Fatalf("the fixture public key is not Ed25519")
	}
	return key
}

func readFixtureManifest(t *testing.T) SignedManifestV1 {
	t.Helper()
	manifest, err := ReadSignedManifest(filepath.Join(fixtureRoot, fixtureManifest))
	if err != nil {
		t.Fatalf("read the signed manifest: %v", err)
	}
	return manifest
}

func readFixtureFiles(t *testing.T) FileManifestV1 {
	t.Helper()
	files, err := ReadFileManifest(filepath.Join(fixtureRoot, fixtureFiles))
	if err != nil {
		t.Fatalf("read the file manifest: %v", err)
	}
	return files
}

func copyTree(source, target string) error {
	return filepath.WalkDir(source, func(current string, entry os.DirEntry, err error) error {
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
}

func stagedProgramTree(t *testing.T, files FileManifestV1) string {
	t.Helper()
	target := filepath.Join(t.TempDir(), ProgramDirName)
	if err := copyTree(filepath.Join(fixtureRoot, fixtureProgram), target); err != nil {
		t.Fatalf("copy the fixture program tree: %v", err)
	}
	if len(files.Files) == 0 {
		t.Fatalf("the fixture file manifest is empty")
	}
	return target
}

func validTransaction(root string) TransactionV1 {
	transactionID := "txn-fixture"
	updateRoot := filepath.Join(root, UpdateDirectoryName)
	stageRoot := filepath.Join(updateRoot, StagedDirName, transactionID)
	return TransactionV1{
		SchemaVersion:      SchemaVersion,
		TransactionID:      transactionID,
		Phase:              "ready",
		CurrentVersion:     "0.0.25",
		TargetVersion:      "0.0.26",
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

func TestCanonicalizeJSONMatchesJSONStringify(t *testing.T) {
	cases := []struct {
		name     string
		value    any
		expected string
	}{
		{"null", nil, "null"},
		{"true", true, "true"},
		{"integer", 1024, "1024"},
		{"large safe integer", int64(9007199254740991), "9007199254740991"},
		{"string", "plain", quoted("plain")},
		{"empty array", []any{}, "[]"},
		{"array", []any{1, "two", false}, "[1," + quoted("two") + ",false]"},
		{
			"keys sort",
			map[string]any{"b": 1, "a": 2},
			"{" + quoted("a") + ":2," + quoted("b") + ":1}",
		},
		{
			"nested",
			map[string]any{"z": map[string]any{"y": []any{2, 1}}},
			"{" + quoted("z") + ":{" + quoted("y") + ":[2,1]}}",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := CanonicalizeJSON(testCase.value)
			if err != nil {
				t.Fatalf("canonicalize %s: %v", testCase.name, err)
			}
			if got != testCase.expected {
				t.Fatalf("canonicalize %s = %s, want %s", testCase.name, got, testCase.expected)
			}
		})
	}
}

func TestCanonicalizeJSONEscapesLikeJSONStringify(t *testing.T) {
	value := "quote" + string(rune(34)) +
		" slash" + backslash +
		" newline" + "\n" +
		" tab" + "\t" +
		" bell" + string(rune(1))
	expected := quoted(
		"quote" + backslash + string(rune(34)) +
			" slash" + backslash + backslash +
			" newline" + backslash + "n" +
			" tab" + backslash + "t" +
			" bell" + backslash + "u0001",
	)
	got, err := CanonicalizeJSON(value)
	if err != nil {
		t.Fatalf("canonicalize escaped string: %v", err)
	}
	if got != expected {
		t.Fatalf("canonicalize escaped string = %s, want %s", got, expected)
	}
}

func TestCanonicalizeJSONSortsObjectKeysByUTF16CodeUnit(t *testing.T) {
	astral := string(rune(0x10400))
	fullwidth := string(rune(0xff21))
	got, err := CanonicalizeJSON(map[string]any{fullwidth: 1, astral: 2})
	if err != nil {
		t.Fatalf("canonicalize astral keys: %v", err)
	}
	astralIndex := strings.Index(got, astral)
	fullwidthIndex := strings.Index(got, fullwidth)
	if astralIndex < 0 || fullwidthIndex < 0 {
		t.Fatalf("canonicalize astral keys dropped a key: %s", got)
	}
	if astralIndex > fullwidthIndex {
		t.Fatalf("UTF-16 code unit order puts the astral key first, got %s", got)
	}
}

func TestCanonicalizeJSONRejectsUnsupportedNumbers(t *testing.T) {
	for name, value := range map[string]any{
		"float":          1.5,
		"unsafe integer": float64(1 << 53),
		"json float":     json.Number("1.5"),
		"nan":            json.Number("NaN"),
	} {
		if _, err := CanonicalizeJSON(value); err == nil {
			t.Fatalf("canonicalize %s: expected a rejection", name)
		}
	}
	if got, err := CanonicalizeJSON(json.Number("1e5")); err != nil || got != "100000" {
		t.Fatalf("canonicalize exponent integer = %q, err = %v; want 100000", got, err)
	}
}

func TestCanonicalizeJSONRejectsUnsupportedValues(t *testing.T) {
	if _, err := CanonicalizeJSON(struct{ A int }{A: 1}); err == nil {
		t.Fatalf("expected a rejection for a struct value")
	}
	if _, err := CanonicalizeJSON(map[string]any{"f": func() {}}); err == nil {
		t.Fatalf("expected a rejection for a function value")
	}
}

func TestVerifyManifestSignatureAcceptsTheTypeScriptFixture(t *testing.T) {
	if err := VerifySignedManifest(readFixtureManifest(t), readPublicKey(t)); err != nil {
		t.Fatalf("the TypeScript fixture signature must verify: %v", err)
	}
}

func TestVerifyManifestSignatureRejectsAMutatedManifest(t *testing.T) {
	manifest := readFixtureManifest(t)
	manifest.PackageSize++
	if err := VerifySignedManifest(manifest, readPublicKey(t)); !errors.Is(err, ErrSignatureInvalid) {
		t.Fatalf("a mutated packageSize must fail signature verification, got %v", err)
	}

	renamed := readFixtureManifest(t)
	renamed.Version = "0.0.27"
	if err := VerifySignedManifest(renamed, readPublicKey(t)); !errors.Is(err, ErrSignatureInvalid) {
		t.Fatalf("a mutated version must fail signature verification, got %v", err)
	}
}

func TestVerifyManifestSignatureRejectsMalformedSignatures(t *testing.T) {
	key := readPublicKey(t)
	for name, signature := range map[string]string{
		"empty":           "",
		"not base64":      "not a signature!",
		"truncated":       "c2hvcnQ=",
		"wrong length":    base64.StdEncoding.EncodeToString([]byte("too short for ed25519")),
		"other key bytes": base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize)),
	} {
		manifest := readFixtureManifest(t)
		manifest.Signature = signature
		if err := VerifySignedManifest(manifest, key); !errors.Is(err, ErrSignatureInvalid) {
			t.Fatalf("signature case %s: expected ErrSignatureInvalid, got %v", name, err)
		}
	}
}

func TestVerifyManifestSignatureFailsClosedWithoutAKey(t *testing.T) {
	if err := VerifySignedManifest(readFixtureManifest(t), nil); !errors.Is(err, ErrSignatureInvalid) {
		t.Fatalf("a missing public key must fail closed, got %v", err)
	}
	if err := VerifySignedManifest(readFixtureManifest(t), ed25519.PublicKey(make([]byte, 7))); !errors.Is(err, ErrSignatureInvalid) {
		t.Fatalf("a malformed public key must fail closed, got %v", err)
	}
}

func TestVerifyFileManifestHashMatchesTheSignedManifest(t *testing.T) {
	if err := VerifyFileManifestHash(readFixtureManifest(t), readFixtureFiles(t)); err != nil {
		t.Fatalf("the fixture file manifest must match its signed digest: %v", err)
	}

	mutated := readFixtureFiles(t)
	mutated.Files[0].Size++
	if err := VerifyFileManifestHash(readFixtureManifest(t), mutated); !errors.Is(err, ErrManifestInvalid) {
		t.Fatalf("a mutated file manifest must not match, got %v", err)
	}
}

func TestVerifyProgramTreeAcceptsTheExactTree(t *testing.T) {
	files := readFixtureFiles(t)
	if err := VerifyProgramTree(stagedProgramTree(t, files), files); err != nil {
		t.Fatalf("the exact staged tree must verify: %v", err)
	}
}

func TestExternalReleaseFixtureEndToEnd(t *testing.T) {
	root := os.Getenv("PARTNERW_PORTABLE_FIXTURE_ROOT")
	if root == "" {
		root = fixtureRoot
	}
	publicKeyText, err := os.ReadFile(filepath.Join(root, fixtureKey))
	if err != nil {
		t.Fatalf("read external fixture key: %v", err)
	}
	publicKeyDER, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(publicKeyText)))
	if err != nil {
		t.Fatalf("decode external fixture key: %v", err)
	}
	parsedKey, err := x509.ParsePKIXPublicKey(publicKeyDER)
	if err != nil {
		t.Fatalf("parse external fixture key: %v", err)
	}
	publicKey, ok := parsedKey.(ed25519.PublicKey)
	if !ok {
		t.Fatal("external fixture key is not Ed25519")
	}
	manifest, err := ReadSignedManifest(filepath.Join(root, fixtureManifest))
	if err != nil {
		t.Fatalf("read external signed manifest: %v", err)
	}
	files, err := ReadFileManifest(filepath.Join(root, fixtureFiles))
	if err != nil {
		t.Fatalf("read external file manifest: %v", err)
	}
	if err := VerifySignedManifest(manifest, publicKey); err != nil {
		t.Fatalf("verify external signature: %v", err)
	}
	if err := VerifyFileManifestHash(manifest, files); err != nil {
		t.Fatalf("verify external file manifest hash: %v", err)
	}
	if err := VerifyProgramTree(filepath.Join(root, fixtureProgram), files); err != nil {
		t.Fatalf("verify external program tree: %v", err)
	}
}

func TestVerifyProgramTreeRejectsExtraFiles(t *testing.T) {
	files := readFixtureFiles(t)
	root := stagedProgramTree(t, files)
	if err := os.WriteFile(filepath.Join(root, "extra.txt"), []byte("extra"), 0o644); err != nil {
		t.Fatalf("write the extra file: %v", err)
	}
	if err := VerifyProgramTree(root, files); !errors.Is(err, ErrFileIntegrity) {
		t.Fatalf("an extra file must be rejected, got %v", err)
	}
}

func TestVerifyProgramTreeRejectsMissingFiles(t *testing.T) {
	files := readFixtureFiles(t)
	root := stagedProgramTree(t, files)
	if err := os.Remove(fixturePathInto(t, root, files, 0)); err != nil {
		t.Fatalf("remove a staged file: %v", err)
	}
	if err := VerifyProgramTree(root, files); !errors.Is(err, ErrFileIntegrity) {
		t.Fatalf("a missing file must be rejected, got %v", err)
	}
}

func fixturePathInto(t *testing.T, root string, files FileManifestV1, index int) string {
	t.Helper()
	if index >= len(files.Files) {
		t.Fatalf("the fixture file manifest lists %d files, index %d requested", len(files.Files), index)
	}
	return filepath.Join(root, filepath.FromSlash(files.Files[index].Path))
}

func TestVerifyProgramTreeRejectsWrongSize(t *testing.T) {
	files := readFixtureFiles(t)
	root := stagedProgramTree(t, files)
	target := fixturePathInto(t, root, files, 1)
	if err := os.WriteFile(target, []byte("a different length entirely"), 0o644); err != nil {
		t.Fatalf("overwrite a staged file: %v", err)
	}
	if err := VerifyProgramTree(root, files); !errors.Is(err, ErrFileIntegrity) {
		t.Fatalf("a wrong size must be rejected, got %v", err)
	}
}

func TestVerifyProgramTreeRejectsWrongHash(t *testing.T) {
	files := readFixtureFiles(t)
	root := stagedProgramTree(t, files)
	entry := files.Files[1]
	target := fixturePathInto(t, root, files, 1)
	if err := os.WriteFile(target, []byte(strings.Repeat("x", int(entry.Size))), 0o644); err != nil {
		t.Fatalf("overwrite a staged file: %v", err)
	}
	if err := VerifyProgramTree(root, files); !errors.Is(err, ErrFileIntegrity) {
		t.Fatalf("a wrong hash must be rejected, got %v", err)
	}
}

type fakeDirEntry struct {
	name  string
	mode  fs.FileMode
	isDir bool
}

func (entry fakeDirEntry) Name() string               { return entry.name }
func (entry fakeDirEntry) IsDir() bool                { return entry.isDir }
func (entry fakeDirEntry) Type() fs.FileMode          { return entry.mode }
func (entry fakeDirEntry) Info() (fs.FileInfo, error) { return nil, errors.New("not implemented") }

func TestVerifyStagedEntryKindAcceptsOnlyFilesAndDirectories(t *testing.T) {
	cases := []struct {
		name     string
		entry    fakeDirEntry
		accepted bool
	}{
		{"regular file", fakeDirEntry{name: "app.asar", mode: 0}, true},
		{"directory", fakeDirEntry{name: "resources", mode: fs.ModeDir, isDir: true}, true},
		{"symlink", fakeDirEntry{name: "linked", mode: fs.ModeSymlink}, false},
		{"reparse style device", fakeDirEntry{name: "device", mode: fs.ModeDevice}, false},
		{"named pipe", fakeDirEntry{name: "pipe", mode: fs.ModeNamedPipe}, false},
		{"socket", fakeDirEntry{name: "socket", mode: fs.ModeSocket}, false},
		{"irregular", fakeDirEntry{name: "odd", mode: fs.ModeIrregular}, false},
	}
	for _, testCase := range cases {
		if got := isAcceptableStagedEntry(testCase.entry); got != testCase.accepted {
			t.Fatalf("%s: isAcceptableStagedEntry = %v, want %v", testCase.name, got, testCase.accepted)
		}
	}
}

func TestVerifyProgramTreeRejectsReparsePoints(t *testing.T) {
	files := readFixtureFiles(t)
	root := stagedProgramTree(t, files)
	link := filepath.Join(root, "linked")
	if err := os.Symlink(fixturePathInto(t, root, files, 1), link); err != nil {
		t.Skipf(
			"unverified on this host: creating a symlink needs a privilege it does not hold (%v); "+
				"the entry-kind rule itself is covered by TestVerifyStagedEntryKindAcceptsOnlyFilesAndDirectories",
			err,
		)
	}
	if err := VerifyProgramTree(root, files); !errors.Is(err, ErrFileIntegrity) {
		t.Fatalf("a symlink in the staged tree must be rejected, got %v", err)
	}
}

func TestVerifyProgramTreeRejectsUnsafeManifestPaths(t *testing.T) {
	root := t.TempDir()
	for name, unsafe := range map[string]string{
		"absolute":        "/etc/passwd",
		"parent":          "../escape.txt",
		"drive":           "C:/escape.txt",
		"unc":             string(rune(92)) + string(rune(92)) + "server/share/escape.txt",
		"device":          "app/CON.txt",
		"protected data":  DataDirectoryName + "/secret.txt",
		"protected work":  WorkspaceDirectoryName + "/secret.txt",
		"update sibling":  UpdateDirectoryName + "/state.json",
		"launcher itself": LauncherFileName,
	} {
		files := FileManifestV1{SchemaVersion: SchemaVersion, Version: "0.0.26", Files: []FileEntry{
			{Path: unsafe, Size: 1, Sha256: strings.Repeat("a", 64)},
		}}
		if err := VerifyProgramTree(root, files); !errors.Is(err, ErrUnsafePath) {
			t.Fatalf("manifest path %s: expected ErrUnsafePath, got %v", name, err)
		}
	}
}

func TestVerifyTransactionPathsAcceptsThePortableLayout(t *testing.T) {
	if err := ValidateTransactionPaths(validTransaction(t.TempDir())); err != nil {
		t.Fatalf("the canonical portable layout must validate: %v", err)
	}
}

func TestVerifyTransactionPathsRejectsUnsafeTransactions(t *testing.T) {
	root := t.TempDir()
	cases := map[string]func(tx *TransactionV1){
		"parent in transaction id":       func(tx *TransactionV1) { tx.TransactionID = ".." },
		"separator in transaction id":    func(tx *TransactionV1) { tx.TransactionID = "a/b" },
		"staged outside the update root": func(tx *TransactionV1) { tx.StagedProgramPath = filepath.Join(root, StagedDirName, "program") },
		"archive outside the update root": func(tx *TransactionV1) {
			tx.ArchivePath = filepath.Join(root, PackageFileName)
		},
		"backup outside the update root": func(tx *TransactionV1) { tx.BackupProgramPath = filepath.Join(root, BackupDirName) },
		"program not the portable name":  func(tx *TransactionV1) { tx.CurrentProgramPath = filepath.Join(root, "somewhere-else") },
		"program not a sibling":          func(tx *TransactionV1) { tx.CurrentProgramPath = filepath.Join(root, "nested", ProgramDirectoryName) },
	}
	for name, mutate := range cases {
		transaction := validTransaction(root)
		mutate(&transaction)
		if err := ValidateTransactionPaths(transaction); err == nil {
			t.Fatalf("transaction case %s: expected a rejection", name)
		}
	}
}

func TestVerifyTransactionPathsRejectsProtectedUpdateRoots(t *testing.T) {
	root := t.TempDir()
	for name, protectedDirectory := range map[string]string{
		"run data":  DataDirectoryName,
		"workspace": WorkspaceDirectoryName,
	} {
		protectedRoot := filepath.Join(root, protectedDirectory)
		transaction := validTransaction(protectedRoot)
		if err := ValidateTransactionPaths(transaction); !errors.Is(err, ErrProtectedPath) {
			t.Fatalf("update root inside %s: expected ErrProtectedPath, got %v", name, err)
		}
	}
}

func TestVerifyTransactionPathsRequiresAMatchingStageDirectory(t *testing.T) {
	root := t.TempDir()
	transaction := validTransaction(root)
	transaction.StagedProgramPath = filepath.Join(transaction.UpdateRoot, StagedDirName, "other-transaction", ProgramDirName)
	if err := ValidateTransactionPaths(transaction); !errors.Is(err, ErrInvalidTransaction) {
		t.Fatalf("a stage directory from another transaction must be rejected, got %v", err)
	}
}

func TestVerifyReadTransactionRejectsUnknownFields(t *testing.T) {
	directory := t.TempDir()
	transaction := validTransaction(directory)
	encoded, err := json.Marshal(transaction)
	if err != nil {
		t.Fatalf("marshal the fixture transaction: %v", err)
	}
	path := filepath.Join(directory, StateFileName)
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatalf("write the fixture transaction: %v", err)
	}
	read, err := ReadTransaction(path)
	if err != nil {
		t.Fatalf("read the fixture transaction: %v", err)
	}
	if read.TransactionID != transaction.TransactionID {
		t.Fatalf("read transaction id = %s, want %s", read.TransactionID, transaction.TransactionID)
	}

	withExtra := append([]byte(nil), encoded[:len(encoded)-1]...)
	withExtra = append(withExtra, []byte(","+quoted("unexpected")+":1}")...)
	if err := os.WriteFile(path, withExtra, 0o600); err != nil {
		t.Fatalf("write the extended transaction: %v", err)
	}
	if _, err := ReadTransaction(path); !errors.Is(err, ErrInvalidTransaction) {
		t.Fatalf("an unknown field must be rejected, got %v", err)
	}
}

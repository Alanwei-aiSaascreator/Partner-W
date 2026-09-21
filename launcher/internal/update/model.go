package update

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

const (
	SchemaVersion = 1

	ProgramDirectoryName   = "\u8363\u76c8\u9b54\u65b9"
	UpdateDirectoryName    = ".\u8363\u76c8\u9b54\u65b9\u66f4\u65b0"
	DataDirectoryName      = "\u8363\u76c8\u9b54\u65b9-\u8fd0\u884c\u6570\u636e"
	WorkspaceDirectoryName = "\u8363\u76c8\u9b54\u65b9\u5de5\u4f5c\u533a"
	LauncherFileName       = "\u8363\u76c8\u9b54\u65b9\u542f\u52a8\u5668.exe"

	StateFileName      = "update-state.json"
	FileManifestName   = "portable-files.json"
	HealthFileName     = "health.json"
	ManifestName       = "manifest.json"
	PackageFileName    = "package.zip"
	LockFileName       = "update.lock"
	ProgramDirName     = "program"
	StagedDirName      = "staged"
	DownloadDirName    = "download"
	BackupDirName      = "backup"
	LogsDirName        = "logs"
	LauncherVersionDev = "dev"
)

var (
	ErrInvalidTransaction = errors.New("portable update: invalid transaction")
	ErrUnsafePath         = errors.New("portable update: unsafe path")
	ErrProtectedPath      = errors.New("portable update: protected path")
	ErrSignatureInvalid   = errors.New("portable update: manifest signature is invalid")
	ErrManifestInvalid    = errors.New("portable update: manifest is invalid")
	ErrFileIntegrity      = errors.New("portable update: file integrity mismatch")
)

type SignedManifestV1 struct {
	SchemaVersion      int    `json:"schemaVersion"`
	Channel            string `json:"channel"`
	Version            string `json:"version"`
	MinLauncherVersion string `json:"minLauncherVersion"`
	PackageURL         string `json:"packageUrl"`
	PackageSize        int64  `json:"packageSize"`
	PackageSha256      string `json:"packageSha256"`
	FileManifestSha256 string `json:"fileManifestSha256"`
	PublishedAt        string `json:"publishedAt"`
	Mandatory          bool   `json:"mandatory"`
	Signature          string `json:"signature"`
}

type FileEntry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	Sha256 string `json:"sha256"`
}

type FileManifestV1 struct {
	SchemaVersion int         `json:"schemaVersion"`
	Version       string      `json:"version"`
	Files         []FileEntry `json:"files"`
}

type TransactionV1 struct {
	SchemaVersion      int    `json:"schemaVersion"`
	TransactionID      string `json:"transactionId"`
	Phase              string `json:"phase"`
	CurrentVersion     string `json:"currentVersion"`
	TargetVersion      string `json:"targetVersion"`
	Channel            string `json:"channel"`
	UpdateRoot         string `json:"updateRoot"`
	ArchivePath        string `json:"archivePath"`
	StagedProgramPath  string `json:"stagedProgramPath"`
	CurrentProgramPath string `json:"currentProgramPath"`
	BackupProgramPath  string `json:"backupProgramPath"`
	ManifestPath       string `json:"manifestPath"`
	FileManifestPath   string `json:"fileManifestPath"`
	HealthPath         string `json:"healthPath"`
	ErrorCode          string `json:"errorCode,omitempty"`
	UpdatedAt          int64  `json:"updatedAt"`
}

type HealthReceiptV1 struct {
	SchemaVersion int    `json:"schemaVersion"`
	TransactionID string `json:"transactionId"`
	Version       string `json:"version"`
	ProgramPath   string `json:"programPath"`
	HealthyAt     string `json:"healthyAt"`
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return fmt.Errorf("unexpected trailing content")
	}
	return nil
}

func readStrict(path string, target any, wrap error) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("%w: %v", wrap, err)
	}
	if err := decodeStrict(data, target); err != nil {
		return fmt.Errorf("%w: %v", wrap, err)
	}
	return nil
}

func ReadTransaction(path string) (TransactionV1, error) {
	var transaction TransactionV1
	if err := readStrict(path, &transaction, ErrInvalidTransaction); err != nil {
		return TransactionV1{}, err
	}
	if transaction.SchemaVersion != SchemaVersion {
		return TransactionV1{}, fmt.Errorf("%w: unsupported schema version %d", ErrInvalidTransaction, transaction.SchemaVersion)
	}
	return transaction, nil
}

func ReadFileManifest(path string) (FileManifestV1, error) {
	var manifest FileManifestV1
	if err := readStrict(path, &manifest, ErrManifestInvalid); err != nil {
		return FileManifestV1{}, err
	}
	if manifest.SchemaVersion != SchemaVersion {
		return FileManifestV1{}, fmt.Errorf("%w: unsupported file manifest schema %d", ErrManifestInvalid, manifest.SchemaVersion)
	}
	return manifest, nil
}

func ReadSignedManifest(path string) (SignedManifestV1, error) {
	var manifest SignedManifestV1
	if err := readStrict(path, &manifest, ErrManifestInvalid); err != nil {
		return SignedManifestV1{}, err
	}
	if manifest.SchemaVersion != SchemaVersion {
		return SignedManifestV1{}, fmt.Errorf("%w: unsupported manifest schema %d", ErrManifestInvalid, manifest.SchemaVersion)
	}
	if manifest.Mandatory {
		return SignedManifestV1{}, fmt.Errorf("%w: mandatory updates are not supported", ErrManifestInvalid)
	}
	return manifest, nil
}

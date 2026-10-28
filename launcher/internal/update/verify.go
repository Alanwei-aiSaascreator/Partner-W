package update

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	transactionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	deviceNamePattern    = regexp.MustCompile(`(?i)^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$`)
	drivePattern         = regexp.MustCompile(`^[A-Za-z]:`)
)

var forbiddenSiblings = map[string]bool{
	strings.ToLower(DataDirectoryName):      true,
	strings.ToLower(WorkspaceDirectoryName): true,
	strings.ToLower(UpdateDirectoryName):    true,
	strings.ToLower(LauncherFileName):       true,
}

func normalizeRelativePath(raw string) (string, error) {
	unified := strings.ReplaceAll(raw, backslash, "/")
	trimmed := strings.TrimRight(unified, "/")
	if trimmed == "" || strings.ContainsRune(trimmed, 0) {
		return "", ErrUnsafePath
	}
	if strings.HasPrefix(trimmed, "/") || drivePattern.MatchString(trimmed) {
		return "", ErrUnsafePath
	}
	cleaned := path.Clean(trimmed)
	if cleaned == "." || cleaned == ".." || cleaned == "/" {
		return "", ErrUnsafePath
	}
	if strings.HasPrefix(cleaned, "../") {
		return "", ErrUnsafePath
	}
	segments := strings.Split(cleaned, "/")
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return "", ErrUnsafePath
		}
		stem := segment
		if index := strings.Index(segment, "."); index >= 0 {
			stem = segment[:index]
		}
		if deviceNamePattern.MatchString(stem) {
			return "", ErrUnsafePath
		}
	}
	if forbiddenSiblings[strings.ToLower(segments[0])] {
		return "", ErrUnsafePath
	}
	return cleaned, nil
}

func collisionKey(relative string) string {
	segments := strings.Split(relative, "/")
	for index, segment := range segments {
		segments[index] = strings.ToLower(strings.TrimRight(segment, ". "))
	}
	return strings.Join(segments, "/")
}

func compareKey(target string) string {
	absolute, err := filepath.Abs(target)
	if err != nil {
		absolute = target
	}
	return strings.ToLower(filepath.Clean(absolute))
}

func containsProtectedSegment(target string) bool {
	absolute, err := filepath.Abs(target)
	if err != nil {
		absolute = target
	}
	for _, segment := range strings.Split(filepath.Clean(absolute), string(filepath.Separator)) {
		lowered := strings.ToLower(segment)
		if lowered == strings.ToLower(DataDirectoryName) || lowered == strings.ToLower(WorkspaceDirectoryName) {
			return true
		}
	}
	return false
}

func decodeSignature(encoded string) ([]byte, error) {
	if encoded == "" {
		return nil, ErrSignatureInvalid
	}
	if decoded, err := base64.StdEncoding.DecodeString(encoded); err == nil {
		return decoded, nil
	}
	if decoded, err := base64.RawStdEncoding.DecodeString(encoded); err == nil {
		return decoded, nil
	}
	return nil, ErrSignatureInvalid
}

func signedPayload(manifest SignedManifestV1) map[string]any {
	return map[string]any{
		"schemaVersion":      manifest.SchemaVersion,
		"channel":            manifest.Channel,
		"version":            manifest.Version,
		"minLauncherVersion": manifest.MinLauncherVersion,
		"packageUrl":         manifest.PackageURL,
		"packageSize":        manifest.PackageSize,
		"packageSha256":      manifest.PackageSha256,
		"fileManifestSha256": manifest.FileManifestSha256,
		"publishedAt":        manifest.PublishedAt,
		"mandatory":          manifest.Mandatory,
	}
}

func VerifySignedManifest(manifest SignedManifestV1, publicKey ed25519.PublicKey) error {
	if len(publicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("%w: the build carries no usable public key", ErrSignatureInvalid)
	}
	signature, err := decodeSignature(manifest.Signature)
	if err != nil {
		return err
	}
	if len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("%w: signature length %d", ErrSignatureInvalid, len(signature))
	}
	canonical, err := CanonicalizeJSON(signedPayload(manifest))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrManifestInvalid, err)
	}
	if !ed25519.Verify(publicKey, []byte(canonical), signature) {
		return ErrSignatureInvalid
	}
	return nil
}

func VerifyFileManifestHash(manifest SignedManifestV1, files FileManifestV1) error {
	entries := make([]any, 0, len(files.Files))
	for _, entry := range files.Files {
		entries = append(entries, map[string]any{
			"path":   entry.Path,
			"size":   entry.Size,
			"sha256": entry.Sha256,
		})
	}
	canonical, err := CanonicalizeJSON(map[string]any{
		"schemaVersion": files.SchemaVersion,
		"version":       files.Version,
		"files":         entries,
	})
	if err != nil {
		return fmt.Errorf("%w: %v", ErrManifestInvalid, err)
	}
	digest := sha256.Sum256([]byte(canonical))
	if hex.EncodeToString(digest[:]) != strings.ToLower(manifest.FileManifestSha256) {
		return fmt.Errorf("%w: file manifest digest does not match the signed manifest", ErrManifestInvalid)
	}
	return nil
}

func ValidateTransactionPaths(transaction TransactionV1) error {
	if !transactionIDPattern.MatchString(transaction.TransactionID) || strings.Contains(transaction.TransactionID, "..") {
		return fmt.Errorf("%w: invalid transaction id", ErrInvalidTransaction)
	}

	updateRoot := transaction.UpdateRoot
	stageRoot := filepath.Join(updateRoot, StagedDirName, transaction.TransactionID)
	expected := []struct {
		name     string
		actual   string
		expected string
	}{
		{"archivePath", transaction.ArchivePath, filepath.Join(updateRoot, DownloadDirName, transaction.TransactionID, PackageFileName)},
		{"stagedProgramPath", transaction.StagedProgramPath, filepath.Join(stageRoot, ProgramDirName)},
		{"backupProgramPath", transaction.BackupProgramPath, filepath.Join(updateRoot, BackupDirName, transaction.TransactionID)},
		{"manifestPath", transaction.ManifestPath, filepath.Join(stageRoot, ManifestName)},
		{"fileManifestPath", transaction.FileManifestPath, filepath.Join(stageRoot, FileManifestName)},
		{"healthPath", transaction.HealthPath, filepath.Join(updateRoot, HealthDirName, transaction.TransactionID+HealthFileSuffix)},
	}
	for _, item := range expected {
		if compareKey(item.actual) != compareKey(item.expected) {
			return fmt.Errorf("%w: unexpected %s", ErrInvalidTransaction, item.name)
		}
	}

	if filepath.Base(transaction.CurrentProgramPath) != ProgramDirectoryName {
		return fmt.Errorf("%w: unexpected currentProgramPath", ErrInvalidTransaction)
	}
	if compareKey(filepath.Dir(transaction.CurrentProgramPath)) != compareKey(filepath.Dir(updateRoot)) {
		return fmt.Errorf("%w: currentProgramPath is not a sibling of the update root", ErrInvalidTransaction)
	}

	writable := []string{
		updateRoot,
		transaction.ArchivePath,
		transaction.StagedProgramPath,
		transaction.CurrentProgramPath,
		transaction.BackupProgramPath,
		transaction.ManifestPath,
		transaction.FileManifestPath,
		transaction.HealthPath,
	}
	for _, target := range writable {
		if containsProtectedSegment(target) {
			return fmt.Errorf("%w: %s lives inside a protected directory", ErrProtectedPath, target)
		}
	}

	return nil
}

func verifyFileDigest(target string, entry FileEntry) error {
	info, err := os.Stat(target)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrFileIntegrity, err)
	}
	if info.Size() != entry.Size {
		return fmt.Errorf("%w: %s has size %d, manifest lists %d", ErrFileIntegrity, entry.Path, info.Size(), entry.Size)
	}
	file, err := os.Open(target)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrFileIntegrity, err)
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return fmt.Errorf("%w: %v", ErrFileIntegrity, err)
	}
	if hex.EncodeToString(digest.Sum(nil)) != strings.ToLower(entry.Sha256) {
		return fmt.Errorf("%w: %s digest does not match the manifest", ErrFileIntegrity, entry.Path)
	}
	return nil
}

func isAcceptableStagedEntry(entry fs.DirEntry) bool {
	return entry.IsDir() || entry.Type().IsRegular()
}

func VerifyProgramTree(programRoot string, files FileManifestV1) error {
	return VerifyProgramTreeWithProgress(programRoot, files, nil)
}

// VerifyProgramTreeWithProgress 与 VerifyProgramTree 判据完全相同，只是在校验
// 每个文件（sha256 是最慢的一段）之后回调 (done, total)，供进度窗显示真实百分比。
// onProgress 可为 nil。
func VerifyProgramTreeWithProgress(programRoot string, files FileManifestV1, onProgress func(done, total int)) error {
	expected := make(map[string]FileEntry, len(files.Files))
	for _, entry := range files.Files {
		normalized, err := normalizeRelativePath(entry.Path)
		if err != nil {
			return err
		}
		key := collisionKey(normalized)
		if _, exists := expected[key]; exists {
			return fmt.Errorf("%w: duplicate manifest path %s", ErrFileIntegrity, entry.Path)
		}
		expected[key] = entry
	}

	actual := make(map[string]string)
	walkErr := filepath.WalkDir(programRoot, func(target string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if !isAcceptableStagedEntry(entry) {
			return fmt.Errorf("%w: %s is not a regular file", ErrFileIntegrity, entry.Name())
		}
		relative, err := filepath.Rel(programRoot, target)
		if err != nil {
			return err
		}
		key := collisionKey(strings.ReplaceAll(relative, backslash, "/"))
		if _, exists := actual[key]; exists {
			return fmt.Errorf("%w: duplicate staged path %s", ErrFileIntegrity, relative)
		}
		actual[key] = target
		return nil
	})
	if walkErr != nil {
		if errors.Is(walkErr, ErrFileIntegrity) {
			return walkErr
		}
		return fmt.Errorf("%w: %v", ErrFileIntegrity, walkErr)
	}

	if len(actual) != len(expected) {
		return fmt.Errorf("%w: staged tree holds %d files, the manifest lists %d", ErrFileIntegrity, len(actual), len(expected))
	}
	done := 0
	for key, entry := range expected {
		target, ok := actual[key]
		if !ok {
			return fmt.Errorf("%w: missing file %s", ErrFileIntegrity, entry.Path)
		}
		if err := verifyFileDigest(target, entry); err != nil {
			return err
		}
		done++
		if onProgress != nil {
			onProgress(done, len(expected))
		}
	}
	return nil
}

package ui

import (
	"encoding/json"
	"fmt"
)

type Messages struct {
	Applying               string `json:"applying"`
	ApplyingTitle          string `json:"applyingTitle"`
	Finishing              string `json:"finishing"`
	PhaseVerify            string `json:"phaseVerify"`
	PhaseSwap              string `json:"phaseSwap"`
	PhaseHealth            string `json:"phaseHealth"`
	PhaseRollback          string `json:"phaseRollback"`
	PhaseRestored          string `json:"phaseRestored"`
	RestoredOpening        string `json:"restoredOpening"`
	DontUnplug             string `json:"dontUnplug"`
	HealthNote             string `json:"healthNote"`
	LaunchFailed           string `json:"launchFailed"`
	LaunchFailedDetail     string `json:"launchFailedDetail"`
	ApplyFailed            string `json:"applyFailed"`
	ApplyFailedDetail      string `json:"applyFailedDetail"`
	RolledBack             string `json:"rolledBack"`
	RolledBackDetail       string `json:"rolledBackDetail"`
	RollbackFailed         string `json:"rollbackFailed"`
	RollbackFailedDetail   string `json:"rollbackFailedDetail"`
	LockHeld               string `json:"lockHeld"`
	LockHeldDetail         string `json:"lockHeldDetail"`
	InvalidState           string `json:"invalidState"`
	InvalidStateDetail     string `json:"invalidStateDetail"`
	MissingProgram         string `json:"missingProgram"`
	MissingProgramDetail   string `json:"missingProgramDetail"`
	UnsupportedArgs        string `json:"unsupportedArgs"`
	UnsupportedArgsDetail  string `json:"unsupportedArgsDetail"`
	MissingPublicKey       string `json:"missingPublicKey"`
	MissingPublicKeyDetail string `json:"missingPublicKeyDetail"`
}

func ParseMessages(data []byte) (Messages, error) {
	var messages Messages
	if err := json.Unmarshal(data, &messages); err != nil {
		return Messages{}, fmt.Errorf("portable launcher locale: %w", err)
	}
	return messages, nil
}

// ProgressView 是进度窗一次完整呈现：主文案 + 进度 + 右下角附加说明。
// Percent < 0 表示不确定进度（流动条）。
type ProgressView struct {
	Title   string
	Percent int
	Note    string
}

type Screen interface {
	Show(title, message string)
	Progress(view ProgressView)
	Update(message string)
	Close()
	Error(title, message string)
}

type silentScreen struct{}

func NewSilentScreen() Screen { return silentScreen{} }

func (silentScreen) Show(string, string)   {}
func (silentScreen) Progress(ProgressView) {}
func (silentScreen) Update(string)         {}
func (silentScreen) Close()                {}
func (silentScreen) Error(string, string)  {}

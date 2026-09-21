package ui

import (
	"encoding/json"
	"fmt"
)

type Messages struct {
	Applying               string `json:"applying"`
	ApplyingTitle          string `json:"applyingTitle"`
	Finishing              string `json:"finishing"`
	LaunchFailed           string `json:"launchFailed"`
	LaunchFailedDetail     string `json:"launchFailedDetail"`
	ApplyFailed            string `json:"applyFailed"`
	ApplyFailedDetail      string `json:"applyFailedDetail"`
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

type Screen interface {
	Show(title, message string)
	Update(message string)
	Close()
	Error(title, message string)
}

type silentScreen struct{}

func NewSilentScreen() Screen { return silentScreen{} }

func (silentScreen) Show(string, string)  {}
func (silentScreen) Update(string)        {}
func (silentScreen) Close()               {}
func (silentScreen) Error(string, string) {}

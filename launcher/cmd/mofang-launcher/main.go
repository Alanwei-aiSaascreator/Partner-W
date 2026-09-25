package main

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"mofang-compass/portable-launcher/internal/ui"
	"mofang-compass/portable-launcher/internal/update"
	"mofang-compass/portable-launcher/locales"
)

var (
	version         = "dev"
	publicKeyBase64 = ""
)

type invocationMode int

const (
	modeLaunch invocationMode = iota
	modeApply
	modeVersion
)

const (
	exitOK           = 0
	exitUnsupported  = 2
	exitLaunchFailed = 3
	exitApplyFailed  = 4
	exitLockHeld     = 5
	exitInvalidState = 6
	exitNoProgram    = 7
)

type invocation struct {
	mode      invocationMode
	statePath string
}

func parseInvocation(args []string) (invocation, error) {
	switch len(args) {
	case 0:
		return invocation{mode: modeLaunch}, nil
	case 1:
		if args[0] == "--version" {
			return invocation{mode: modeVersion}, nil
		}
	case 2:
		if args[0] == "--apply" && args[1] != "" {
			return invocation{mode: modeApply, statePath: args[1]}, nil
		}
	}
	return invocation{}, errors.New("unsupported launcher arguments")
}

type dependencies struct {
	ops          update.Ops
	screen       ui.Screen
	messages     ui.Messages
	publicKey    ed25519.PublicKey
	version      string
	launcherPath string
	output       io.Writer
	logf         func(format string, args ...any)
}

func decodePublicKey(encoded string) (ed25519.PublicKey, error) {
	if encoded == "" {
		return nil, errors.New("no update public key was compiled in")
	}
	der, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("the compiled update public key is not Ed25519")
	}
	return key, nil
}

func launchProgram(deps dependencies, root string) int {
	exePath := filepath.Join(root, update.ProgramDirectoryName, update.ProgramExecutableName)
	exists, existsErr := deps.ops.Exists(exePath)
	if existsErr != nil || !exists {
		if existsErr != nil {
			deps.logf("checking the program executable failed: %v", existsErr)
		}
		deps.screen.Error(deps.messages.MissingProgram, deps.messages.MissingProgramDetail)
		return exitNoProgram
	}
	if _, startErr := deps.ops.StartApp(exePath, nil); startErr != nil {
		deps.logf("starting the program failed: %v", startErr)
		deps.screen.Error(deps.messages.LaunchFailed, deps.messages.LaunchFailedDetail)
		return exitLaunchFailed
	}
	return exitOK
}

func applyTransaction(deps dependencies, transaction update.TransactionV1) int {
	if len(deps.publicKey) != ed25519.PublicKeySize {
		deps.screen.Error(deps.messages.MissingPublicKey, deps.messages.MissingPublicKeyDetail)
		return exitApplyFailed
	}
	deps.screen.Show(deps.messages.ApplyingTitle, deps.messages.Applying)
	applyErr := update.Apply(context.Background(), transaction, deps.publicKey, deps.ops)
	deps.screen.Close()
	if applyErr != nil {
		deps.logf("applying the update failed: %v", applyErr)
		deps.screen.Error(deps.messages.ApplyFailed, deps.messages.ApplyFailedDetail)
		return exitApplyFailed
	}
	return exitOK
}

func run(args []string, deps dependencies) int {
	parsed, parseErr := parseInvocation(args)
	if parseErr != nil {
		deps.screen.Error(deps.messages.UnsupportedArgs, deps.messages.UnsupportedArgsDetail)
		return exitUnsupported
	}
	if parsed.mode == modeVersion {
		fmt.Fprintln(deps.output, deps.version)
		return exitOK
	}

	root := filepath.Dir(deps.launcherPath)
	statePath := parsed.statePath
	explicitState := statePath != ""
	if !explicitState {
		statePath = filepath.Join(root, update.UpdateDirectoryName, update.StateFileName)
	}

	data, readErr := deps.ops.ReadFile(statePath)
	if readErr != nil {
		if !explicitState {
			return launchProgram(deps, root)
		}
		deps.logf("reading the handed-over state failed: %v", readErr)
		deps.screen.Error(deps.messages.InvalidState, deps.messages.InvalidStateDetail)
		return exitInvalidState
	}

	transaction, decodeErr := update.DecodeTransaction(data)
	if decodeErr != nil {
		deps.logf("the handed-over state is unusable: %v", decodeErr)
		deps.screen.Error(deps.messages.InvalidState, deps.messages.InvalidStateDetail)
		return exitInvalidState
	}

	lock, _, lockErr := update.AcquireLock(deps.ops, transaction, func() (update.RecoveryResult, error) {
		return update.Recover(context.Background(), transaction, deps.ops)
	})
	if lockErr != nil {
		deps.logf("taking the update lock failed: %v", lockErr)
		deps.screen.Error(deps.messages.LockHeld, deps.messages.LockHeldDetail)
		return exitLockHeld
	}
	defer func() {
		if releaseErr := lock.Release(); releaseErr != nil {
			deps.logf("releasing the update lock failed: %v", releaseErr)
		}
	}()

	recovery, recoverErr := update.Recover(context.Background(), transaction, deps.ops)
	if recoverErr != nil {
		deps.logf("recovery stopped: %v", recoverErr)
		deps.screen.Error(deps.messages.RollbackFailed, deps.messages.RollbackFailedDetail+root)
		return exitApplyFailed
	}
	deps.logf("reconciled the disk state: %s", recovery)

	if transaction.Phase == "ready" {
		if parsed.mode == modeApply {
			return applyTransaction(deps, transaction)
		}
		// A launcher started by hand is the second chance for an update the
		// app handed over but could not finish: the app spawns the launcher
		// and quits, and on a real disk the swap loses that race. Applying it
		// here is what makes a single click enough.
		//
		// Only a transaction that is ready *and* whose directories match is
		// trusted; anything else is a state the app was in the middle of, and
		// swapping trees on the strength of a half-written record is not a
		// thing this launcher gets to guess at.
		if recovery == update.RecoveryReady {
			if code := applyTransaction(deps, transaction); code == exitOK {
				return code
			}
			// A refused update must never cost the user the program.
			deps.logf("the deferred update was refused, starting what is on the disk")
		}
	}
	return launchProgram(deps, root)
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "portable launcher: cannot resolve its own path:", err)
		os.Exit(exitLaunchFailed)
	}
	messages, err := ui.ParseMessages(locales.ChineseSimplified)
	if err != nil {
		fmt.Fprintln(os.Stderr, "portable launcher: cannot read the built-in locale:", err)
		os.Exit(exitLaunchFailed)
	}
	publicKey, keyErr := decodePublicKey(publicKeyBase64)
	if keyErr != nil {
		fmt.Fprintln(os.Stderr, "portable launcher:", keyErr)
	}
	os.Exit(run(os.Args[1:], dependencies{
		ops:          update.SystemOps{},
		screen:       ui.NewScreen(),
		messages:     messages,
		publicKey:    publicKey,
		version:      version,
		launcherPath: executable,
		output:       os.Stdout,
		logf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "portable launcher: "+format+"\n", args...)
		},
	}))
}

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
	"time"

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

// programIsPresent reports whether the program the launcher would start is on
// the disk. It decides whether a defective update record may block startup:
// when the program is there, it may not (2026-10-19 — a record written on E:
// stopped the launcher from starting a perfectly good program, and the user had
// to open the .exe by hand to discover that).
func programIsPresent(ops update.Ops, root string) bool {
	exists, err := ops.Exists(filepath.Join(root, update.ProgramDirectoryName, update.ProgramExecutableName))
	return err == nil && exists
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

// parkUnusableRecord keeps an update record the launcher cannot reconcile out of
// the startup path without losing it: rename, never delete. The next launch then
// starts from a clean state instead of logging the same rejection forever, and
// support still has the exact record to look at (2026-10-19).
func parkUnusableRecord(deps dependencies, statePath string) {
	parked := statePath + ".unreconciled-" + time.Now().UTC().Format("20060102T150405Z")
	if err := deps.ops.Rename(statePath, parked); err != nil {
		deps.logf("parking the unusable update record failed: %v", err)
		return
	}
	deps.logf("parked the unusable update record as %s", filepath.Base(parked))
}

// restoredNoticeHold 是"已恢复"提示在界面上停留的时长（经 ops.Sleep，测试里不真等）。
const restoredNoticeHold = 2500 * time.Millisecond

func applyTransaction(deps dependencies, transaction update.TransactionV1, statePath string) int {
	if len(deps.publicKey) != ed25519.PublicKeySize {
		deps.screen.Error(deps.messages.MissingPublicKey, deps.messages.MissingPublicKeyDetail)
		return exitApplyFailed
	}
	// Show 的 title 槽位 = 底部常驻提示；message = 首个主文案（随后被相位事件覆盖）。
	deps.screen.Show(deps.messages.DontUnplug, deps.messages.Applying)
	progress := func(event update.Progress) {
		deps.screen.Progress(progressView(deps.messages, event))
	}
	applyErr := update.ApplyWithProgress(context.Background(), transaction, deps.publicKey, deps.ops, progress)
	if applyErr != nil {
		deps.screen.Close()
		deps.logf("applying the update failed: %v", applyErr)
		deps.screen.Error(deps.messages.ApplyFailed, deps.messages.ApplyFailedDetail)
		return exitApplyFailed
	}
	// Apply 返回 nil 有两种干净结果：committed、或 rolled-back（健康回执失败被
	// 回滚收成干净结果）。rolled-back 必须如实说、并把原版本拉起来，而不是无声
	// 退出让用户再双击一次（2026-09-25 真机验收登记的 UX 欠账，2026-10-09 消账）。
	state, readErr := update.ReadTransactionWith(deps.ops, statePath)
	if readErr == nil && state.Phase == "rolled-back" {
		deps.screen.Progress(ui.ProgressView{
			Title:   deps.messages.PhaseRestored,
			Percent: 100,
			Note:    deps.messages.RestoredOpening,
		})
		deps.ops.Sleep(restoredNoticeHold)
		deps.screen.Close()
		return launchProgram(deps, filepath.Dir(deps.launcherPath))
	}
	deps.screen.Close()
	return exitOK
}

// progressView 把 update 包的进度事件映射为进度窗文案。
func progressView(messages ui.Messages, event update.Progress) ui.ProgressView {
	switch event.Phase {
	case update.PhaseVerify:
		note := ""
		if event.Total > 0 {
			note = fmt.Sprintf("%d/%d", event.Done, event.Total)
		}
		return ui.ProgressView{Title: messages.PhaseVerify, Percent: verifyPercent(event), Note: note}
	case update.PhaseSwap:
		return ui.ProgressView{Title: messages.PhaseSwap, Percent: -1}
	case update.PhaseHealth:
		return ui.ProgressView{
			Title:   messages.PhaseHealth,
			Percent: -1,
			Note:    fmt.Sprintf(messages.HealthNote, int(event.Elapsed.Seconds()), int(event.Budget.Seconds())),
		}
	case update.PhaseRollback:
		return ui.ProgressView{Title: messages.PhaseRollback, Percent: -1}
	case update.PhaseRestored:
		return ui.ProgressView{Title: messages.PhaseRestored, Percent: 100, Note: messages.RestoredOpening}
	}
	return ui.ProgressView{Title: messages.Applying, Percent: -1}
}

func verifyPercent(event update.Progress) int {
	if event.Total <= 0 {
		return -1
	}
	return event.Done * 100 / event.Total
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

	// Whoever started the launcher decided its working directory, and the app
	// is normally started from the program directory this launcher is about to
	// move. Windows refuses to rename the calling process's own working
	// directory — measured with a probe: Win32 32 while sitting inside, a clean
	// rename once out — and waiting cannot clear that, so the wait added for
	// the app's shutdown would only burn its whole budget. Everything below
	// works in absolute paths, so stepping out costs nothing.
	if chdirErr := os.Chdir(root); chdirErr != nil {
		deps.logf("leaving the inherited working directory failed: %v", chdirErr)
	}

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
		// A record we cannot read is not a reason to keep someone out of the
		// program that is already on the disk (2026-10-19: a stale record left
		// the launcher showing a dialog while the program folder itself started
		// fine). Leave the record untouched for support to read.
		if !explicitState && programIsPresent(deps.ops, root) {
			deps.logf("starting the program on the disk; the unusable record is parked")
			parkUnusableRecord(deps, statePath)
			return launchProgram(deps, root)
		}
		deps.screen.Error(deps.messages.InvalidState, deps.messages.InvalidStateDetail)
		return exitInvalidState
	}

	// The record may have been written while the disk had a different drive
	// letter — the same stick is E: at the office and F: at home, which is the
	// move this product exists to survive. The record was just read from this
	// root, so rebasing it onto this root is the only reading consistent with
	// where the file was found. Persist the rewrite so later launches are cheap.
	if rebased, changed := update.RebaseTransaction(transaction, root); changed {
		transaction = rebased
		if _, writeErr := update.WriteTransaction(deps.ops, transaction); writeErr != nil {
			deps.logf("persisting the rebased update record failed: %v", writeErr)
		} else {
			deps.logf("rebased the update record onto %s", root)
		}
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
		// Same rule as above: a transaction we cannot reconcile is not a reason
		// to keep someone out of the program that is already on the disk. The
		// record stays where it is, so the next launch (or support) can look at it.
		if programIsPresent(deps.ops, root) {
			deps.logf("starting the program on the disk; the unusable update record is parked")
			if !explicitState {
				parkUnusableRecord(deps, statePath)
			}
			return launchProgram(deps, root)
		}
		deps.screen.Error(deps.messages.RollbackFailed, deps.messages.RollbackFailedDetail+root)
		return exitApplyFailed
	}
	deps.logf("reconciled the disk state: %s", recovery)

	// A restore is the one moment the launcher knows an update did not go in.
	// From the outside it is invisible — the program starts either way and
	// nothing on screen differs from an ordinary launch — so without this the
	// user believes the update took and only finds out when something the new
	// version was supposed to bring is missing.
	//
	// This is the path a killed or powered-off update leaves behind: the app
	// never got to report the failure itself, so nobody has told the user yet.
	if recovery == update.RecoveryRestored {
		deps.screen.Error(deps.messages.RolledBack, deps.messages.RolledBackDetail)
	}

	if transaction.Phase == "ready" {
		if parsed.mode == modeApply {
			return applyTransaction(deps, transaction, statePath)
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
			if code := applyTransaction(deps, transaction, statePath); code == exitOK {
				return code
			}
			// A refused update must never cost the user the program.
			deps.logf("the deferred update was refused, starting what is on the disk")
		}
	}
	return launchProgram(deps, root)
}

// launcherDependencies is what the launcher runs with, split out of main so a
// test can drive the real wiring rather than a copy of it. The log sink is why
// that matters: the launcher is started with its output discarded, so a sink
// that was written but never attached behaves exactly like a working one right
// up until the moment somebody needs to read it.
func launcherDependencies(executable string, messages ui.Messages, publicKey ed25519.PublicKey) dependencies {
	toFile := logFileSink(filepath.Join(filepath.Dir(executable), update.UpdateDirectoryName, launcherLogName))
	return dependencies{
		ops:          update.SystemOps{},
		screen:       ui.NewScreen(),
		messages:     messages,
		publicKey:    publicKey,
		version:      version,
		launcherPath: executable,
		output:       os.Stdout,
		logf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "portable launcher: "+format+"\n", args...)
			toFile(format, args...)
		},
	}
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
	os.Exit(run(os.Args[1:], launcherDependencies(executable, messages, publicKey)))
}

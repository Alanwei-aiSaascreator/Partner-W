package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// The app starts the launcher with its output discarded — the launcher is
// spawned with stdio ignored and the app quits right after — so anything the
// launcher has to say about an update it could not finish goes nowhere. A
// launcher instance that sat for seven minutes burning no CPU and touching no
// disk stayed unexplained for a whole session for exactly that reason: there
// was nothing to read afterwards.
//
// Keep the lines on the disk too, in the update directory they are about.
const launcherLogName = "launcher.log"

// A launcher runs once per start and writes a handful of lines each time. The
// cap is there so a disk nobody ever cleans cannot accumulate them forever;
// past it the file starts over rather than growing without bound.
const launcherLogLimit = 64 * 1024

// logFileSink returns a logger that appends to path, best effort. A launcher
// that cannot write its log must still start the program, so every error here
// is dropped on purpose — the log exists to explain failures, it must never
// become one.
func logFileSink(path string) func(format string, args ...any) {
	return func(format string, args ...any) {
		if info, err := os.Stat(path); err == nil && info.Size() > launcherLogLimit {
			_ = os.Remove(path)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return
		}
		file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return
		}
		defer func() { _ = file.Close() }()
		line := fmt.Sprintf("%s portable launcher: "+format+"\n", append([]any{time.Now().UTC().Format(time.RFC3339)}, args...)...)
		_, _ = file.WriteString(line)
	}
}

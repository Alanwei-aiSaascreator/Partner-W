package update

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type Process interface {
	Done() <-chan struct{}
	Err() error
	Kill() error
}

type Ops interface {
	Rename(oldPath, newPath string) error
	RemoveAll(path string) error
	Exists(path string) (bool, error)
	MkdirAll(path string) error
	ReadFile(path string) ([]byte, error)
	WriteFile(path string, data []byte, perm fs.FileMode) error
	WriteFileExclusive(path string, data []byte, perm fs.FileMode) error
	StartApp(exePath string, env []string) (Process, error)
	ProcessAlive(pid int) bool
	Now() time.Time
	Sleep(duration time.Duration)
}

type SystemOps struct{}

type systemProcess struct {
	done chan struct{}
	err  func() error
	kill func() error
}

func (process *systemProcess) Done() <-chan struct{} { return process.done }
func (process *systemProcess) Err() error            { return process.err() }
func (process *systemProcess) Kill() error           { return process.kill() }

func (SystemOps) Rename(oldPath, newPath string) error {
	return os.Rename(oldPath, newPath)
}

func (SystemOps) RemoveAll(path string) error {
	return os.RemoveAll(path)
}

func (SystemOps) MkdirAll(path string) error {
	return os.MkdirAll(path, 0o755)
}

func (SystemOps) Exists(path string) (bool, error) {
	_, err := os.Lstat(path)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, err
}

func (SystemOps) ReadFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func (SystemOps) WriteFile(path string, data []byte, perm fs.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, perm)
}

func (SystemOps) WriteFileExclusive(path string, data []byte, perm fs.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func (SystemOps) ProcessAlive(pid int) bool {
	return processAlive(pid)
}

func (SystemOps) Now() time.Time {
	return time.Now()
}

func (SystemOps) Sleep(duration time.Duration) {
	time.Sleep(duration)
}

func (SystemOps) StartApp(exePath string, env []string) (Process, error) {
	command := exec.Command(exePath)
	command.Dir = filepath.Dir(exePath)
	command.Env = append(os.Environ(), env...)
	if err := command.Start(); err != nil {
		return nil, err
	}
	done := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = command.Wait()
		close(done)
	}()
	return &systemProcess{
		done: done,
		err:  func() error { return waitErr },
		kill: func() error { return command.Process.Kill() },
	}, nil
}

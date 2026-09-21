//go:build !windows

package ui

func NewScreen() Screen {
	return NewSilentScreen()
}

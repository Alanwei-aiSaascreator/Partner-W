//go:build windows

package ui

import (
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	wsPopup     = 0x80000000
	wsVisible   = 0x10000000
	wsExTopmost = 0x00000008

	swShow = 5

	pmRemove = 0x0001

	mbOK            = 0x00000000
	mbIconError     = 0x00000010
	mbSetForeground = 0x00010000
	mbTopmost       = 0x00040000

	wmSetFont = 0x0030

	defaultGuiFont = 17

	smCxScreen = 0
	smCyScreen = 1

	windowWidth  = 460
	windowHeight = 120
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procCreateWindowExW  = user32.NewProc("CreateWindowExW")
	procDestroyWindow    = user32.NewProc("DestroyWindow")
	procShowWindow       = user32.NewProc("ShowWindow")
	procUpdateWindow     = user32.NewProc("UpdateWindow")
	procSetWindowTextW   = user32.NewProc("SetWindowTextW")
	procPeekMessageW     = user32.NewProc("PeekMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessageW = user32.NewProc("DispatchMessageW")
	procMessageBoxW      = user32.NewProc("MessageBoxW")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
	procSendMessageW     = user32.NewProc("SendMessageW")
	procGetStockObject   = gdi32.NewProc("GetStockObject")
	procGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")
)

type point struct {
	x int32
	y int32
}

type windowMessage struct {
	handle  uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
}

type windowScreen struct {
	mutex  sync.Mutex
	handle uintptr
	stop   chan struct{}
}

func NewScreen() Screen {
	return &windowScreen{}
}

func utf16(value string) (uintptr, bool) {
	pointer, err := syscall.UTF16PtrFromString(value)
	if err != nil {
		return 0, false
	}
	return uintptr(unsafe.Pointer(pointer)), true
}

func metric(index int) int32 {
	value, _, _ := procGetSystemMetrics.Call(uintptr(index))
	return int32(value)
}

func (screen *windowScreen) Show(title, message string) {
	screen.mutex.Lock()
	defer screen.mutex.Unlock()
	if screen.handle != 0 {
		return
	}
	className, ok := utf16("Static")
	if !ok {
		return
	}
	text, ok := utf16(message)
	if !ok {
		return
	}
	x := (metric(smCxScreen) - windowWidth) / 2
	y := (metric(smCyScreen) - windowHeight) / 2
	handle, _, _ := procCreateWindowExW.Call(
		wsExTopmost,
		className,
		text,
		wsPopup|wsVisible,
		uintptr(int64(x)),
		uintptr(int64(y)),
		windowWidth,
		windowHeight,
		0,
		0,
		0,
		0,
	)
	if handle == 0 {
		return
	}
	screen.handle = handle
	font, _, _ := procGetStockObject.Call(defaultGuiFont)
	procSendMessageW.Call(handle, wmSetFont, font, 1)
	procShowWindow.Call(handle, swShow)
	procUpdateWindow.Call(handle)

	screen.stop = make(chan struct{})
	go screen.pump(screen.stop)
}

func (screen *windowScreen) pump(stop chan struct{}) {
	var message windowMessage
	for {
		select {
		case <-stop:
			return
		default:
		}
		present, _, _ := procPeekMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0, pmRemove)
		if present == 0 {
			time.Sleep(15 * time.Millisecond)
			continue
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func (screen *windowScreen) Update(message string) {
	screen.mutex.Lock()
	handle := screen.handle
	screen.mutex.Unlock()
	if handle == 0 {
		return
	}
	text, ok := utf16(message)
	if !ok {
		return
	}
	procSetWindowTextW.Call(handle, text)
	procUpdateWindow.Call(handle)
}

func (screen *windowScreen) Close() {
	screen.mutex.Lock()
	handle := screen.handle
	stop := screen.stop
	screen.handle = 0
	screen.stop = nil
	screen.mutex.Unlock()

	if stop != nil {
		close(stop)
	}
	if handle != 0 {
		procDestroyWindow.Call(handle)
	}
}

func (screen *windowScreen) Error(title, message string) {
	titlePointer, ok := utf16(title)
	if !ok {
		return
	}
	messagePointer, ok := utf16(message)
	if !ok {
		return
	}
	procMessageBoxW.Call(
		0,
		messagePointer,
		titlePointer,
		mbOK|mbIconError|mbSetForeground|mbTopmost,
	)
}

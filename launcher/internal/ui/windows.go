//go:build windows

package ui

import (
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// 进度窗（2026-10-09 改版 + BUG-063 修复架构）：
//   - 单一 UI owner goroutine（LockOSThread）持有窗口与全部 Win32/GDI 调用；
//   - 外部 Show/Progress/Update/Close/Error 只投递命令并等各自回执；
//   - 自绘深色卡片（双缓冲）：品牌行 + 相位主文案 + 真进度条 + 底部提示。
// Win32 规定窗口与消息队列归创建线程（见 BUG-063 根因），本文件全部操作都在 owner。

const (
	wsPopup     = 0x80000000
	wsVisible   = 0x10000000
	wsExTopmost = 0x00000008

	swShow = 5

	pmRemove = 0x0001

	csHRedraw = 0x0002
	csVRedraw = 0x0001

	wmPaint      = 0x000F
	wmEraseBkgnd = 0x0014
	wmDestroy    = 0x0002
	wmSetFont    = 0x0030

	mbOK            = 0x00000000
	mbIconError     = 0x00000010
	mbSetForeground = 0x00010000
	mbTopmost       = 0x00040000

	smCxScreen = 0
	smCyScreen = 1

	windowWidth  = 520
	windowHeight = 208

	pumpInterval = 10 * time.Millisecond

	marqueeWidth = 132
	marqueeStep  = 5

	nullBrush     = 5
	dtLeft        = 0x00000000
	dtRight       = 0x00000002
	dtVCenter     = 0x00000004
	dtSingleLine  = 0x00000020
	dtNoPrefix    = 0x00000800
	dtEndEllipsis = 0x00008000

	srcCopy = 0x00CC0020

	fwNormal   = 400
	fwSemibold = 600

	cleartypeQuality = 5
	defaultCharset   = 1

	dwmaWindowCornerPreference = 33
	dwmcpRound                 = 2
)

// 深色卡片配色（取品牌图标色：红→品红系）。
const (
	colorBackground = 0x001C1714 // #14171C
	colorBorder     = 0x00332B26 // #262B33
	colorTrack      = 0x00332B26 // #262B33
	colorAccent     = 0x004F38E8 // #E8384F（品牌红）
	colorTitle      = 0x00F6F4F3 // #F3F4F6
	colorBrand      = 0x00B3A298 // #98A2B3
	colorNote       = 0x0098867C // #7C8698
)

// gwlpUserdata = GWLP_USERDATA(-21) 的 64 位两补数。
const gwlpUserdata = ^uintptr(20)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	dwmapi   = syscall.NewLazyDLL("dwmapi.dll")

	procRegisterClassExW  = user32.NewProc("RegisterClassExW")
	procCreateWindowExW   = user32.NewProc("CreateWindowExW")
	procDestroyWindow     = user32.NewProc("DestroyWindow")
	procDefWindowProcW    = user32.NewProc("DefWindowProcW")
	procShowWindow        = user32.NewProc("ShowWindow")
	procUpdateWindow      = user32.NewProc("UpdateWindow")
	procSetWindowTextW    = user32.NewProc("SetWindowTextW")
	procGetWindowLongPtrW = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW = user32.NewProc("SetWindowLongPtrW")
	procPeekMessageW      = user32.NewProc("PeekMessageW")
	procTranslateMessage  = user32.NewProc("TranslateMessage")
	procDispatchMessageW  = user32.NewProc("DispatchMessageW")
	procBeginPaint        = user32.NewProc("BeginPaint")
	procEndPaint          = user32.NewProc("EndPaint")
	procInvalidateRect    = user32.NewProc("InvalidateRect")
	procGetClientRect     = user32.NewProc("GetClientRect")
	procMessageBoxW       = user32.NewProc("MessageBoxW")
	procGetSystemMetrics  = user32.NewProc("GetSystemMetrics")
	procLoadCursorW       = user32.NewProc("LoadCursorW")
	procDrawTextW         = user32.NewProc("DrawTextW")
	procSetWindowRgn      = user32.NewProc("SetWindowRgn")
	procFillRect          = user32.NewProc("FillRect")

	procGetStockObject         = gdi32.NewProc("GetStockObject")
	procCreateFontW            = gdi32.NewProc("CreateFontW")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
	procSetBkMode              = gdi32.NewProc("SetBkMode")
	procSetTextColor           = gdi32.NewProc("SetTextColor")
	procCreateSolidBrush       = gdi32.NewProc("CreateSolidBrush")
	procCreatePen              = gdi32.NewProc("CreatePen")
	procRectangle              = gdi32.NewProc("Rectangle")
	procRoundRect              = gdi32.NewProc("RoundRect")
	procEllipse                = gdi32.NewProc("Ellipse")
	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procCreateRoundRectRgn     = gdi32.NewProc("CreateRoundRectRgn")
	procGetDC                  = user32.NewProc("GetDC")
	procReleaseDC              = user32.NewProc("ReleaseDC")

	procGetCurrentThreadId    = kernel32.NewProc("GetCurrentThreadId")
	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
)

const progressClassName = "partner-wLauncherProgress"

var (
	windowClassOnce       sync.Once
	windowClassRegistered bool
	progressWndProc       = syscall.NewCallback(windowProc)
)

type point struct {
	x int32
	y int32
}

type rect struct {
	left   int32
	top    int32
	right  int32
	bottom int32
}

type paintStruct struct {
	hdc         uintptr
	fErase      int32
	rcPaint     rect
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}

type windowMessage struct {
	handle  uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
}

type wndClassExW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  uintptr
	lpszClassName uintptr
	hIconSm       uintptr
}

type commandKind int

const (
	commandShow commandKind = iota
	commandProgress
	commandUpdate
	commandClose
	commandError
)

type command struct {
	kind    commandKind
	title   string
	message string
	percent int
	note    string
	done    chan struct{}
}

type windowScreen struct {
	commands chan command
	// ---- 以下字段只由 UI owner goroutine 读写（测试在收到回执后读取）----
	handle              uintptr
	ownerThreadID       uint32
	lastCommandThreadID uint32

	mainText string
	percent  int
	note     string
	hint     string
	marquee  int

	brandFont   uintptr
	titleFont   uintptr
	noteFont    uintptr
	bgBrush     uintptr
	trackBrush  uintptr
	accentBrush uintptr
	borderPen   uintptr
}

func NewScreen() Screen {
	screen := &windowScreen{commands: make(chan command, 64), percent: -1}
	go screen.runUI()
	return screen
}

func currentThreadID() uint32 {
	id, _, _ := procGetCurrentThreadId.Call()
	return uint32(id)
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

func ensureWindowClass() bool {
	windowClassOnce.Do(func() {
		className, ok := utf16(progressClassName)
		if !ok {
			return
		}
		cursor, _, _ := procLoadCursorW.Call(0, 32512) // IDC_ARROW
		class := wndClassExW{
			cbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
			style:         csHRedraw | csVRedraw,
			lpfnWndProc:   progressWndProc,
			hCursor:       cursor,
			hbrBackground: 0,
			lpszClassName: className,
		}
		atom, _, _ := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class)))
		windowClassRegistered = atom != 0
	})
	return windowClassRegistered
}

// All Screen instances share this registry; hold its lock only for get/set/delete.
// Never hold the registry lock while calling Win32 or rendering.
var screenRegistryMu sync.RWMutex
var screenByHandle = map[uintptr]*windowScreen{}

func windowProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	screenRegistryMu.RLock()
	screen := screenByHandle[hwnd]
	screenRegistryMu.RUnlock()
	if screen != nil {
		switch message {
		case wmEraseBkgnd:
			return 1
		case wmPaint:
			screen.paint(hwnd)
			return 0
		case wmDestroy:
			screen.releaseGdi()
			screen.handle = 0
			screenRegistryMu.Lock()
			delete(screenByHandle, hwnd)
			screenRegistryMu.Unlock()
			return 0
		}
	}
	result, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
	return result
}

func (screen *windowScreen) runUI() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	screen.ownerThreadID = currentThreadID()
	for {
		select {
		case cmd, ok := <-screen.commands:
			if !ok {
				screen.destroyWindow()
				return
			}
			screen.executeAndAck(cmd)
			continue
		default:
		}
		if screen.handle != 0 && screen.percent < 0 {
			screen.marquee += marqueeStep
			if screen.marquee > windowWidth-48+marqueeWidth {
				screen.marquee = -marqueeWidth
			}
			procInvalidateRect.Call(screen.handle, 0, 0)
		}
		screen.pumpOnce()
		time.Sleep(pumpInterval)
	}
}

// executeAndAck 保证每条命令**恰好关闭一次** done（panic 也走 defer）。
func (screen *windowScreen) executeAndAck(cmd command) {
	defer close(cmd.done)
	screen.lastCommandThreadID = currentThreadID()
	switch cmd.kind {
	case commandShow:
		screen.showWindow()
		if screen.handle != 0 {
			screen.mainText = cmd.message
			screen.percent = -1
			screen.note = ""
			screen.hint = cmd.title // Show 的 title 槽位 = 底部常驻提示（如"请勿拔出 U 盘"）
			screen.marquee = -marqueeWidth
			screen.applyText()
		}
	case commandProgress:
		if screen.handle == 0 {
			return
		}
		restartMarquee := screen.percent >= 0 || screen.mainText != cmd.title
		screen.mainText = cmd.title
		screen.percent = cmd.percent
		if screen.percent >= 0 {
			screen.percent = clampPercent(screen.percent)
		}
		screen.note = cmd.note
		if screen.percent < 0 && restartMarquee {
			screen.marquee = -marqueeWidth
		}
		screen.applyText()
	case commandUpdate:
		if screen.handle == 0 {
			return
		}
		screen.mainText = cmd.message
		screen.applyText()
	case commandClose:
		screen.destroyWindow()
	case commandError:
		title, ok := utf16(cmd.title)
		if !ok {
			return
		}
		message, ok := utf16(cmd.message)
		if !ok {
			return
		}
		procMessageBoxW.Call(
			0,
			message,
			title,
			mbOK|mbIconError|mbSetForeground|mbTopmost,
		)
	}
}

func clampPercent(value int) int {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

// applyText 把主文案同步进窗口标题（无障碍/测试可经 WM_GETTEXT 读回）并请求重绘。
func (screen *windowScreen) applyText() {
	if screen.handle == 0 {
		return
	}
	if text, ok := utf16(screen.mainText); ok {
		procSetWindowTextW.Call(screen.handle, text)
	}
	procInvalidateRect.Call(screen.handle, 0, 0)
}

func (screen *windowScreen) showWindow() {
	if screen.handle != 0 {
		return
	}
	if !ensureWindowClass() {
		return
	}
	className, ok := utf16(progressClassName)
	if !ok {
		return
	}
	x := (metric(smCxScreen) - windowWidth) / 2
	y := (metric(smCyScreen) - windowHeight) / 2
	handle, _, _ := procCreateWindowExW.Call(
		wsExTopmost,
		className,
		0,
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
	screenRegistryMu.Lock()
	screenByHandle[handle] = screen
	screenRegistryMu.Unlock()
	screen.createGdi()
	// 圆角：Win11 优先交给 DWM（抗锯齿）；失败回退到窗口区域裁角。
	dwmResult, _, _ := procDwmSetWindowAttribute.Call(
		handle,
		uintptr(dwmaWindowCornerPreference),
		uintptr(unsafe.Pointer(&[]int32{dwmcpRound}[0])),
		uintptr(4),
	)
	if dwmResult != 0 {
		region, _, _ := procCreateRoundRectRgn.Call(0, 0, windowWidth+1, windowHeight+1, 18, 18)
		if region != 0 {
			procSetWindowRgn.Call(handle, region, 1)
		}
	}
	procShowWindow.Call(handle, swShow)
	procUpdateWindow.Call(handle)
}

func (screen *windowScreen) createGdi() {
	face, ok := utf16("Microsoft YaHei UI")
	if !ok {
		return
	}
	screen.brandFont = createFont(face, -14, fwSemibold)
	screen.titleFont = createFont(face, -20, fwSemibold)
	screen.noteFont = createFont(face, -13, fwNormal)
	screen.bgBrush, _, _ = procCreateSolidBrush.Call(colorBackground)
	screen.trackBrush, _, _ = procCreateSolidBrush.Call(colorTrack)
	screen.accentBrush, _, _ = procCreateSolidBrush.Call(colorAccent)
	screen.borderPen, _, _ = procCreatePen.Call(0, 1, colorBorder)
}

func createFont(face uintptr, height, weight int32) uintptr {
	font, _, _ := procCreateFontW.Call(
		uintptr(int64(height)), 0, 0, 0,
		uintptr(int64(weight)), 0, 0, 0,
		defaultCharset, 0, 0, cleartypeQuality, 0,
		face,
	)
	return font
}

func (screen *windowScreen) releaseGdi() {
	for _, object := range []*uintptr{
		&screen.brandFont, &screen.titleFont, &screen.noteFont,
		&screen.bgBrush, &screen.trackBrush, &screen.accentBrush, &screen.borderPen,
	} {
		if *object != 0 {
			procDeleteObject.Call(*object)
			*object = 0
		}
	}
}

func (screen *windowScreen) destroyWindow() {
	if screen.handle != 0 {
		procDestroyWindow.Call(screen.handle) // WM_DESTROY 里释放 GDI 并清 handle
		screen.handle = 0
	}
	screen.releaseGdi()
}

// paint：双缓冲整帧绘制（WM_PAINT 经由 DispatchMessage 在 owner 线程进入）。
func (screen *windowScreen) paint(hwnd uintptr) {
	var ps paintStruct
	hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	if hdc == 0 {
		return
	}
	defer procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))

	var client rect
	procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&client)))
	width := client.right - client.left
	height := client.bottom - client.top

	memDC, _, _ := procCreateCompatibleDC.Call(hdc)
	if memDC == 0 {
		return
	}
	memBitmap, _, _ := procCreateCompatibleBitmap.Call(hdc, uintptr(width), uintptr(height))
	if memBitmap == 0 {
		procDeleteDC.Call(memDC)
		return
	}
	oldBitmap, _, _ := procSelectObject.Call(memDC, memBitmap)
	defer func() {
		procSelectObject.Call(memDC, oldBitmap)
		procDeleteObject.Call(memBitmap)
		procDeleteDC.Call(memDC)
	}()

	// 背景
	background := rect{0, 0, width, height}
	procFillRect.Call(memDC, uintptr(unsafe.Pointer(&background)), screen.bgBrush)
	// 细边框
	oldPen, _, _ := procSelectObject.Call(memDC, screen.borderPen)
	nullBrushHandle, _, _ := procGetStockObject.Call(nullBrush)
	nullPenHandle, _, _ := procGetStockObject.Call(8) // NULL_PEN; NULL_BRUSH only changes the brush
	oldBrush, _, _ := procSelectObject.Call(memDC, nullBrushHandle)
	procRectangle.Call(memDC, 0, 0, uintptr(width), uintptr(height))
	procSelectObject.Call(memDC, oldBrush)
	procSelectObject.Call(memDC, oldPen)

	procSetBkMode.Call(memDC, 1) // TRANSPARENT

	// 品牌行：红点 + 产品名
	oldBrush2, _, _ := procSelectObject.Call(memDC, screen.accentBrush)
	oldPen2, _, _ := procSelectObject.Call(memDC, nullPenHandle)
	procEllipse.Call(memDC, 24, 20, 34, 30)
	procSelectObject.Call(memDC, oldPen2)
	procSelectObject.Call(memDC, oldBrush2)
	screen.drawText(memDC, "Partner-W", rect{42, 16, width - 24, 36}, screen.brandFont, colorBrand, dtLeft)

	// 主文案 + 百分比
	screen.drawText(memDC, screen.mainText, rect{24, 48, width - 120, 78}, screen.titleFont, colorTitle, dtLeft|dtSingleLine|dtVCenter|dtEndEllipsis|dtNoPrefix)
	if screen.percent >= 0 {
		text := strconv.Itoa(screen.percent) + "%"
		screen.drawText(memDC, text, rect{width - 116, 48, width - 24, 78}, screen.titleFont, colorAccent, dtRight|dtSingleLine|dtVCenter|dtNoPrefix)
	}

	// 进度条（圆角胶囊）
	trackLeft, trackRight := int32(24), width-24
	trackTop, trackBottom := int32(98), int32(110)
	procSelectObject.Call(memDC, screen.trackBrush)
	oldPen3, _, _ := procSelectObject.Call(memDC, nullPenHandle)
	procRoundRect.Call(memDC, uintptr(trackLeft), uintptr(trackTop), uintptr(trackRight), uintptr(trackBottom), 11, 11)
	if screen.percent >= 0 {
		fill := trackLeft + int32((trackRight-trackLeft)*int32(screen.percent)/100)
		if fill > trackLeft {
			procSelectObject.Call(memDC, screen.accentBrush)
			procRoundRect.Call(memDC, uintptr(trackLeft), uintptr(trackTop), uintptr(fill), uintptr(trackBottom), 11, 11)
		}
	} else {
		segmentLeft := int32(screen.marquee) + trackLeft
		segmentRight := segmentLeft + marqueeWidth
		if segmentLeft < trackLeft {
			segmentLeft = trackLeft
		}
		if segmentRight > trackRight {
			segmentRight = trackRight
		}
		if segmentRight > segmentLeft {
			procSelectObject.Call(memDC, screen.accentBrush)
			procRoundRect.Call(memDC, uintptr(segmentLeft), uintptr(trackTop), uintptr(segmentRight), uintptr(trackBottom), 11, 11)
		}
	}
	procSelectObject.Call(memDC, oldPen3)

	// 底部：左提示 + 右附加说明
	bottomRow := rect{24, height - 42, width - 24 - 300, height - 18}
	if screen.hint != "" {
		screen.drawText(memDC, screen.hint, bottomRow, screen.noteFont, colorNote, dtLeft|dtSingleLine|dtVCenter|dtNoPrefix)
	}
	if screen.note != "" {
		noteRow := rect{width - 320, height - 42, width - 24, height - 18}
		screen.drawText(memDC, screen.note, noteRow, screen.noteFont, colorNote, dtRight|dtSingleLine|dtVCenter|dtNoPrefix)
	}

	procBitBlt.Call(hdc, 0, 0, uintptr(width), uintptr(height), memDC, 0, 0, srcCopy)
}

// drawText 在给定矩形里绘制文本（字体按需选入并还原；owner 线程专用）。
func (screen *windowScreen) drawText(hdc uintptr, text string, box rect, font uintptr, color uint32, flags uint32) {
	pointer, ok := utf16(text)
	if !ok {
		return
	}
	oldFont, _, _ := procSelectObject.Call(hdc, font)
	procSetTextColor.Call(hdc, uintptr(color))
	procDrawTextW.Call(hdc, pointer, ^uintptr(0) /* -1 */, uintptr(unsafe.Pointer(&box)), uintptr(flags))
	procSelectObject.Call(hdc, oldFont)
}

func (screen *windowScreen) pumpOnce() {
	var message windowMessage
	for {
		present, _, _ := procPeekMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0, pmRemove)
		if present == 0 {
			return
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func (screen *windowScreen) submit(cmd command) {
	cmd.done = make(chan struct{})
	screen.commands <- cmd
	<-cmd.done
}

func (screen *windowScreen) Show(title, message string) {
	screen.submit(command{kind: commandShow, title: title, message: message})
}

func (screen *windowScreen) Progress(view ProgressView) {
	screen.submit(command{kind: commandProgress, title: view.Title, percent: view.Percent, note: view.Note})
}

func (screen *windowScreen) Update(message string) {
	screen.submit(command{kind: commandUpdate, message: message})
}

func (screen *windowScreen) Close() {
	screen.submit(command{kind: commandClose})
}

func (screen *windowScreen) Error(title, message string) {
	screen.submit(command{kind: commandError, title: title, message: message})
}

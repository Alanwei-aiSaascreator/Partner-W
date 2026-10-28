//go:build windows

package ui

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// BUG-063 回归矩阵（真实窗口，不 mock Screen）：
//   - 线程归属：Create/Send/Update/Destroy/Pump 恒在同一个 owner OS 线程；
//   - 有界响应：Show 后 SendMessageTimeoutW(WM_NULL) 必须在超时内得到处理；
//     文本可读；Close 后窗口消失；
//   - 生命周期：重复 Show/Close、Close 前后 Update、30 次开关、创建失败、
//     并发调用——全部有硬超时看门狗，任何一处卡死即 FAIL（这正是原故障的形状）。

const (
	wmNull          = 0x0000
	wmGetText       = 0x000D
	smtoAbortIfHung = 0x0002
)

var (
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	procSendMessageTimeoutW      = user32.NewProc("SendMessageTimeoutW")
	procIsWindow                 = user32.NewProc("IsWindow")
)

// withWatchdog 跑 fn 并施加硬超时：超时即 t.Fatal（死锁/卡死的直接判据）。
func withWatchdog(t *testing.T, what string, timeout time.Duration, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		fn()
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatalf("%s: 超过 %s 未完成（疑似死锁/卡死）", what, timeout)
	}
}

func newTestScreen(t *testing.T) *windowScreen {
	t.Helper()
	screen := NewScreen().(*windowScreen)
	t.Cleanup(func() { close(screen.commands) })
	return screen
}

func showAndCheck(t *testing.T, screen *windowScreen) uintptr {
	t.Helper()
	withWatchdog(t, "Show", 5*time.Second, func() { screen.Show("Partner-W", "正在更新，请勿拔出 U 盘。") })
	handle := screen.handle
	if handle == 0 {
		t.Fatal("Show 之后窗口应存在")
	}
	return handle
}

func windowOwnerThread(t *testing.T, handle uintptr) uint32 {
	t.Helper()
	thread, _, _ := procGetWindowThreadProcessId.Call(handle, 0)
	return uint32(thread)
}

func assertResponsive(t *testing.T, handle uintptr) {
	t.Helper()
	var result uintptr
	ok, _, _ := procSendMessageTimeoutW.Call(
		handle, wmNull, 0, 0, smtoAbortIfHung, 5000, uintptr(unsafe.Pointer(&result)),
	)
	if ok == 0 {
		t.Fatal("窗口在 5 秒内未处理 WM_NULL（无响应）")
	}
}

func TestScreenOwnerThreadAffinity(t *testing.T) {
	screen := newTestScreen(t)
	handle := showAndCheck(t, screen)

	owner := screen.ownerThreadID
	if owner == 0 {
		t.Fatal("owner 线程号不应为 0")
	}
	if got := windowOwnerThread(t, handle); got != owner {
		t.Fatalf("窗口属主线程=%d，owner=%d —— CreateWindow 必须发生在 owner 线程", got, owner)
	}
	if screen.lastCommandThreadID != owner {
		t.Fatalf("Show 处理线程=%d，owner=%d", screen.lastCommandThreadID, owner)
	}

	// 从多个 goroutine 猛推 Update，强制调度器折腾：所有命令仍必须落在 owner 线程。
	var wait sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wait.Add(1)
		go func(n int) {
			defer wait.Done()
			for i := 0; i < 10; i++ {
				screen.Update(fmt.Sprintf("更新中 %d-%d", n, i))
			}
		}(worker)
	}
	finished := make(chan struct{})
	go func() { wait.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(15 * time.Second):
		t.Fatal("并发 Update 卡死")
	}
	if screen.lastCommandThreadID != owner {
		t.Fatalf("并发 Update 处理线程=%d，owner=%d", screen.lastCommandThreadID, owner)
	}
	if got := windowOwnerThread(t, handle); got != owner {
		t.Fatalf("折腾后窗口属主线程变了：%d != %d", got, owner)
	}

	// 关闭再重开：新窗口仍必须归属同一个 owner 线程。
	withWatchdog(t, "Close", 5*time.Second, func() { screen.Close() })
	handle2 := showAndCheck(t, screen)
	if got := windowOwnerThread(t, handle2); got != owner {
		t.Fatalf("重开窗口属主线程=%d，owner=%d", got, owner)
	}
}

func TestScreenWindowRespondsAndTextReadable(t *testing.T) {
	screen := newTestScreen(t)
	handle := showAndCheck(t, screen)

	// 三次有界响应探测（每次 5 秒预算）。
	for i := 0; i < 3; i++ {
		assertResponsive(t, handle)
	}

	withWatchdog(t, "Update", 5*time.Second, func() { screen.Update("状态：正在校验更新包…") })

	buffer := make([]uint16, 256)
	var copied uintptr
	ok, _, _ := procSendMessageTimeoutW.Call(
		handle, wmGetText,
		uintptr(len(buffer)), uintptr(unsafe.Pointer(&buffer[0])),
		smtoAbortIfHung, 5000, uintptr(unsafe.Pointer(&copied)),
	)
	if ok == 0 {
		t.Fatal("WM_GETTEXT 在 5 秒内未得到处理")
	}
	if got := syscall.UTF16ToString(buffer); got != "状态：正在校验更新包…" {
		t.Fatalf("窗口文本=%q，期望 %q", got, "状态：正在校验更新包…")
	}

	withWatchdog(t, "Close", 5*time.Second, func() { screen.Close() })
	if alive, _, _ := procIsWindow.Call(handle); alive != 0 {
		t.Fatal("Close 之后窗口应已被销毁")
	}
}

func TestScreenLifecycleNeverBlocks(t *testing.T) {
	screen := newTestScreen(t)

	// Close 之前 / Show 之前的 Update：确定性 no-op，但必须返回。
	withWatchdog(t, "Update before Show", 5*time.Second, func() { screen.Update("早到") })

	first := showAndCheck(t, screen)
	withWatchdog(t, "Show again", 5*time.Second, func() { screen.Show("Partner-W", "再来一次") })
	if screen.handle != first {
		t.Fatal("重复 Show 不应重建窗口")
	}

	withWatchdog(t, "Update", 5*time.Second, func() { screen.Update("进行中") })
	withWatchdog(t, "Close", 5*time.Second, func() { screen.Close() })
	withWatchdog(t, "Update after Close", 5*time.Second, func() { screen.Update("关闭后") })
	withWatchdog(t, "Close again", 5*time.Second, func() { screen.Close() })

	// 有界多次开关（间歇性路径的放大器）。
	for cycle := 0; cycle < 30; cycle++ {
		cycle := cycle
		withWatchdog(t, fmt.Sprintf("cycle %d Show", cycle), 5*time.Second, func() {
			screen.Show("Partner-W", "正在更新，请勿拔出 U 盘。")
		})
		if screen.handle == 0 {
			t.Fatalf("cycle %d：Show 后窗口不存在", cycle)
		}
		withWatchdog(t, fmt.Sprintf("cycle %d Update", cycle), 5*time.Second, func() { screen.Update("校验中") })
		withWatchdog(t, fmt.Sprintf("cycle %d Close", cycle), 5*time.Second, func() { screen.Close() })
	}

	// 非法文本路径：含 NUL ⇒ 文本转换失败 ⇒ 命令必须确定返回、不卡死；
	// 窗口照常可用（新设计不依赖文案建窗），随后开关与更新都正常。
	withWatchdog(t, "Show with invalid message", 5*time.Second, func() { screen.Show("Partner-W", "坏\x00消息") })
	withWatchdog(t, "Update with invalid message", 5*time.Second, func() { screen.Update("坏\x00消息") })
	withWatchdog(t, "Close after invalid message", 5*time.Second, func() { screen.Close() })
	showAndCheck(t, screen)
}

func TestScreenConcurrentOpsDoNotDeadlock(t *testing.T) {
	screen := newTestScreen(t)
	handle := showAndCheck(t, screen)

	var wait sync.WaitGroup
	for worker := 0; worker < 16; worker++ {
		wait.Add(1)
		go func(n int) {
			defer wait.Done()
			for i := 0; i < 5; i++ {
				switch (n + i) % 3 {
				case 0:
					screen.Update("并发更新")
				case 1:
					screen.Show("Partner-W", "并发 Show")
				default:
					screen.Update("并发 Update")
				}
			}
		}(worker)
	}
	finished := make(chan struct{})
	go func() { wait.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(20 * time.Second):
		t.Fatal("并发 Show/Update 卡死")
	}
	assertResponsive(t, handle)
}

func TestScreenProgressViews(t *testing.T) {
	screen := newTestScreen(t)
	handle := showAndCheck(t, screen)

	withWatchdog(t, "Progress 确定进度", 5*time.Second, func() {
		screen.Progress(ProgressView{Title: "正在校验更新文件…", Percent: 62, Note: "200/323"})
	})
	if screen.mainText != "正在校验更新文件…" || screen.percent != 62 || screen.note != "200/323" {
		t.Fatalf("progress state wrong: text=%q percent=%d note=%q", screen.mainText, screen.percent, screen.note)
	}
	assertResponsive(t, handle)

	withWatchdog(t, "Progress 流动条", 5*time.Second, func() {
		screen.Progress(ProgressView{Title: "正在启动新版本…", Percent: -1, Note: "已等待 3 秒（最多 90 秒）"})
	})
	if screen.percent != -1 {
		t.Fatalf("indeterminate progress must keep percent=-1, got %d", screen.percent)
	}
	assertResponsive(t, handle)

	withWatchdog(t, "Progress 越界收敛", 5*time.Second, func() {
		screen.Progress(ProgressView{Title: "正在校验更新文件…", Percent: 250})
	})
	if screen.percent != 100 {
		t.Fatalf("percent must clamp to 100, got %d", screen.percent)
	}
	assertResponsive(t, handle)
}

func TestScreenMultipleInstances(t *testing.T) {
	screens := make([]*windowScreen, 3)
	for i := range screens {
		screens[i] = newTestScreen(t)
	}
	for i, screen := range screens {
		i, screen := i, screen
		withWatchdog(t, fmt.Sprintf("screen %d Show", i), 5*time.Second, func() {
			screen.Show("Partner-W", "多实例")
		})
	}
	for i, screen := range screens {
		i, screen := i, screen
		withWatchdog(t, fmt.Sprintf("screen %d Update", i), 5*time.Second, func() { screen.Update("进行中") })
		withWatchdog(t, fmt.Sprintf("screen %d Close", i), 5*time.Second, func() { screen.Close() })
	}
}

// —— 2026-10-09 复审整改正式化（L1，来源 review_probe_test.go）——
// 品牌点与进度轨道底色曾被 NULL_BRUSH 误当 NULL_PEN 选入绘制笔（SelectObject
// 按类型替换，撤销的是填充），点与轨道变成空心。真实窗口像素断言：
// 品牌点 = COLORREF 4F38E8，轨道 = 332B26。
func TestWindowPaintKeepsBrandDotAndTrackFill(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if colorAccent != 0x004F38E8 || colorTrack != 0x00332B26 {
		t.Fatalf("palette drifted: accent=%#08x track=%#08x", colorAccent, colorTrack)
	}

	screen := &windowScreen{percent: 0, mainText: "回归", hint: ""}
	screen.showWindow()
	if screen.handle == 0 {
		t.Fatal("window missing")
	}
	defer screen.destroyWindow()

	screen.percent = 0
	screen.applyText()
	procUpdateWindow.Call(screen.handle)

	dc, _, _ := procGetDC.Call(screen.handle)
	defer procReleaseDC.Call(screen.handle, dc)
	getPixel := gdi32.NewProc("GetPixel")
	dot, _, _ := getPixel.Call(dc, 29, 25)
	track, _, _ := getPixel.Call(dc, 400, 104)
	const clrInvalid = 0xFFFFFFFF
	if uint32(dot) == clrInvalid || uint32(track) == clrInvalid {
		t.Fatalf("GetPixel failed: dot=%#x track=%#x", uint32(dot), uint32(track))
	}
	t.Logf("brand=%06x wanted=%06x; track=%06x wanted=%06x", uint32(dot), uint32(colorAccent), uint32(track), uint32(colorTrack))
	if uint32(dot) != uint32(colorAccent) {
		t.Error("brand dot lost its accent fill (NULL_PEN regression)")
	}
	if uint32(track) != uint32(colorTrack) {
		t.Error("progress track lost its fill (NULL_PEN regression)")
	}
}

// —— 2026-10-09 复审整改正式化（L2，来源 review_probe_test.go）——
// 不确定进度的流动条位置只在「进入新阶段」时重置；同一阶段（健康等待每
// 250ms 刷新一次备注）必须保持位置，否则动画每帧被推回起点。
func TestWindowMarqueeKeepsPositionOnSamePhaseRefresh(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	screen := &windowScreen{percent: -1}
	screen.showWindow()
	if screen.handle == 0 {
		t.Fatal("window missing")
	}
	defer screen.destroyWindow()

	screen.executeAndAck(command{kind: commandProgress, title: "health", percent: -1, note: "1", done: make(chan struct{})})
	screen.marquee = 200
	screen.executeAndAck(command{kind: commandProgress, title: "health", percent: -1, note: "2", done: make(chan struct{})})
	if screen.marquee != 200 {
		t.Fatalf("same-phase note refresh reset the marquee: before=200 after=%d", screen.marquee)
	}

	screen.executeAndAck(command{kind: commandProgress, title: "restoring", percent: -1, note: "", done: make(chan struct{})})
	if screen.marquee != -marqueeWidth {
		t.Fatalf("phase change must restart the marquee: got=%d want=%d", screen.marquee, -marqueeWidth)
	}
}

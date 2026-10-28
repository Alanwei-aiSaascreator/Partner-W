package update

import "time"

// 进度上报（2026-10-09 启动器进度窗改造）：Apply 全流程可观测。
// 回调为**可选**——nil 时所有 report 都是 no-op，既有调用方行为零变化；
// 不改变任何签名/事务/回滚语义。

type ProgressPhase string

const (
	PhaseVerify   ProgressPhase = "verify"   // 校验更新文件（Done/Total = 已核对文件数）
	PhaseSwap     ProgressPhase = "swap"     // 替换文件目录（通常很快）
	PhaseHealth   ProgressPhase = "health"   // 等待新版本健康回执（Elapsed/Budget）
	PhaseRollback ProgressPhase = "rollback" // 更新未成，正在恢复更新前版本
	PhaseRestored ProgressPhase = "restored" // 已恢复更新前版本
)

type Progress struct {
	Phase   ProgressPhase
	Done    int           // verify：已核对文件数
	Total   int           // verify：总文件数（0 = 未知）
	Elapsed time.Duration // health：已等待
	Budget  time.Duration // health：预算（默认 90s）
}

// ProgressFunc 由启动器（main）注入，把事件映射成界面文案；update 包不感知 UI。
type ProgressFunc func(Progress)

func report(progress ProgressFunc, event Progress) {
	if progress != nil {
		progress(event)
	}
}

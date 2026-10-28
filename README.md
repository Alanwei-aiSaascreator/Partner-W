# Partner-W

> 面向 Windows 大众用户的 AI 桌面工作台：以 U 盘为入口、联网调用云端模型，
> 用「用途引导 + 任务模板 + 文件处理 + 模型服务」让用户从「不知道怎么问」走到「完成了一件事」。

## 定位

Partner-W 面向第一次接触 AI 工具的 Windows 用户，也服务于内容创作者、
短视频从业者、职场用户、电商运营者、学习研究者和家庭用户。

产品克制、可信、易用：不堆 Agent / Token / 网关这类术语，不用游戏化包装，让用户
登录后三分钟内完成第一次真实 AI 任务，并能清楚看到余额、使用记录和下一步操作。

## 核心能力

- **任务工作台**：三栏界面（任务 / 对话 / 进度），多任务并行、各自独立会话，可归档、可导出
- **用途引导**：首屏给出可执行的预设任务与能力入口，先问用途再推荐助手、模型与任务
- **专业助手与团队**：多个预设助手；支持把多个智能体组成团队（协调者 + 工作者）协作完成
- **文件生成**：直接产出 Word、Excel、PPT
- **图片与视频生成**：文生图 / 图生图 / 文生视频 / 图生视频
- **模型服务**
  - 内置云端模型（中转）
  - 自配模型端点（BYOK）：支持多个 url / key，每个端点多个模型，每个模型 4 档推理功率（低 / 中 / 高 / 最高），可一键拉取中转站模型列表
- **U 盘便携运行**：从 U 盘启动，数据本地落盘
- **本地数据与检索**：SQLite + 全文搜索，任务 / 消息 / 产物可查

## 快速开始

### 环境要求

- Node ≥ 20
- pnpm ≥ 9

### 开发运行

```bash
pnpm install
pnpm dev
```

Windows 上也可双击仓库根目录的 `start-partner-w.bat`（自动清理旧进程后启动）。

### 打包

```bash
# Windows 安装包（NSIS）
pnpm --filter @clawwork/desktop build:win

# macOS / Linux
pnpm --filter @clawwork/desktop build:mac
pnpm --filter @clawwork/desktop build:linux
```

### U 盘交付

```bash
pnpm udisk:delivery
```

## 技术栈

Electron 34 · React 19 · TypeScript · Tailwind CSS v4 · Zustand · SQLite（better-sqlite3 + Drizzle）· Framer Motion

## 仓库结构

```
packages/shared/   协议类型与常量
packages/core/     共享业务逻辑（stores / services / ports）
packages/desktop/  Electron 客户端（main / preload / renderer）
packages/pwa/      移动端应用
launcher/          U 盘便携启动器（Go）
scripts/           构建与校验脚本
docs/              设计文档与架构不变量
e2e/               Playwright 端到端测试
```

## 开发与验证

```bash
pnpm dev         # 开发运行
pnpm typecheck   # 类型检查
pnpm lint        # lint
pnpm test        # 单元测试
pnpm check       # 提交前完整校验（lint + 架构 + UI 契约 + i18n + 死代码 + 格式化 + 类型 + 测试）
```

更完整的开发说明见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## 许可

[Apache 2.0](LICENSE)

## 版本

- **2026-10-28** — Partner-W 全新发布，独立仓库、干净历史。

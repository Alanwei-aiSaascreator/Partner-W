import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  Megaphone,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Users,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import WindowTitlebar from '@/components/semantic/WindowTitlebar';
import { Button } from '@/components/ui/button';
import { BETA_MODULES, useBetaStore, type BetaModule } from './beta-store';
import { betaRoute, parseBetaRoute } from './beta-route';
import { describeUpdateError } from './update-errors';
import { createInternalBetaUpdateService, type InternalBetaUpdateState } from './update-service';

/**
 * ⚠️ P4 毕业后这里只剩两项。**别把埋点分析 / 隐私与合规加回来**：
 *    真实现分别在运营看板与设置页「隐私与数据」，加回来 = 界面上同时挂真入口和假入口。
 */
const ICONS: Record<BetaModule, typeof Users> = {
  operations: Wrench,
  updates: RefreshCw,
};

function Badge({ children, tone = 'accent' }: { children: ReactNode; tone?: 'accent' | 'warning' | 'success' }) {
  const color =
    tone === 'warning'
      ? 'text-[var(--warning)] bg-[var(--bg-warning)]'
      : tone === 'success'
        ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
        : 'text-[var(--accent)] bg-[var(--accent-soft)]';
  return <span className={`type-support inline-flex rounded-full px-2 py-0.5 font-medium ${color}`}>{children}</span>;
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 shadow-[var(--shadow-card)] ${className}`}
    >
      {children}
    </section>
  );
}

function OperationsModule() {
  const operations = useBetaStore((s) => s.operations);
  const adjust = useBetaStore((s) => s.adjustCredits);
  const toggle = useBetaStore((s) => s.toggleModel);
  const setRate = useBetaStore((s) => s.setModelRate);
  const setAnnouncement = useBetaStore((s) => s.setAnnouncement);
  const [showLogs, setShowLogs] = useState(false);
  const configuredAdminUrl = (() => {
    const candidate = import.meta.env.VITE_ADMIN_CONSOLE_URL?.trim();
    if (!candidate) return null;
    try {
      const url = new URL(candidate);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
    } catch {
      return null;
    }
  })();
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <Badge tone={configuredAdminUrl ? 'success' : 'warning'}>{configuredAdminUrl ? '已配置' : '待配置'}</Badge>
            <h3 className="type-section-title mt-2">运营管理后台</h3>
            <p className="type-body mt-1 text-[var(--text-muted)]">
              {configuredAdminUrl
                ? '在独立后台管理真实用户、发卡、套餐和运营配置。'
                : '设置 VITE_ADMIN_CONSOLE_URL 后开放入口；桌面端不保存后台密钥。'}
            </p>
          </div>
          <Button
            data-action="open-admin"
            disabled={!configuredAdminUrl}
            onClick={() => configuredAdminUrl && window.open(configuredAdminUrl, '_blank', 'noopener,noreferrer')}
          >
            <ShieldCheck />
            打开后台
          </Button>
        </div>
      </Card>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['用户总览', operations.users],
          ['有效激活码', operations.activeCodes],
          ['默认额度', operations.credits],
          ['错误日志', operations.errorCount],
        ].map(([label, value]) => (
          <Card key={String(label)}>
            <p className="type-body text-[var(--text-muted)]">{label}</p>
            <strong className="type-page-title mt-2 block">{value}</strong>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h3 className="mb-4 font-semibold">模型与价格</h3>
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
            <span>DeepSeek V4 Flash</span>
            <Button size="sm" variant={operations.modelEnabled ? 'soft' : 'outline'} onClick={toggle}>
              {operations.modelEnabled ? '已启用' : '已关闭'}
            </Button>
          </div>
          <label className="type-body mt-4 block">计费倍率：{operations.modelRate.toFixed(1)}×</label>
          <input
            aria-label="模型倍率"
            className="mt-2 w-full accent-[var(--accent)]"
            type="range"
            min="0.5"
            max="3"
            step="0.1"
            value={operations.modelRate}
            onChange={(e) => setRate(Number(e.target.value))}
          />
          <div className="mt-4 flex gap-2">
            <Button variant="outline" onClick={() => adjust(100)}>
              额度 +100
            </Button>
            <Button variant="outline" onClick={() => adjust(-100)}>
              额度 -100
            </Button>
          </div>
        </Card>
        <Card>
          <h3 className="mb-4 font-semibold">版本公告</h3>
          <textarea
            value={operations.announcement}
            onChange={(e) => setAnnouncement(e.target.value)}
            className="min-h-28 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-3 outline-none"
          />
          <Button className="mt-3" onClick={() => window.alert('内测公告已保存到本机')}>
            <Megaphone />
            保存公告
          </Button>
        </Card>
      </div>
      <Card>
        <button
          className="flex w-full items-center justify-between text-left"
          onClick={() => setShowLogs((value) => !value)}
        >
          <span>
            <strong>错误日志入口</strong>
            <small className="mt-1 block text-[var(--text-muted)]">最近 24 小时 · {operations.errorCount} 条</small>
          </span>
          <ChevronRight className={showLogs ? 'rotate-90 transition-transform' : 'transition-transform'} />
        </button>
        {showLogs && (
          <div className="type-body mt-3 space-y-2 border-t border-[var(--border)] pt-3">
            <p className="rounded-lg bg-[var(--bg-tertiary)] p-2">11:20 · UPDATE_CHECK_TIMEOUT · 已自动重试</p>
            <p className="rounded-lg bg-[var(--bg-tertiary)] p-2">10:41 · MODEL_GATEWAY_RECONNECT · 已恢复</p>
            <p className="rounded-lg bg-[var(--bg-tertiary)] p-2">09:58 · FILE_PREVIEW_UNSUPPORTED · 已提示用户</p>
          </div>
        )}
      </Card>
      <p className="type-support text-[var(--text-muted)]">
        本页统计卡和调节项是公司内测数据；真实用户、账单和卡密只在独立后台中管理。
      </p>
    </div>
  );
}

function UpdatesModule() {
  const service = useMemo(() => createInternalBetaUpdateService(window.clawwork), []);
  const [update, setUpdate] = useState<InternalBetaUpdateState>(service.getState());

  useEffect(() => {
    const unsubscribe = service.subscribe(setUpdate);
    void service.loadVersion();
    return () => {
      unsubscribe();
      service.dispose();
    };
  }, [service]);

  const action =
    update.status === 'available'
      ? '下载更新'
      : update.status === 'downloaded'
        ? '安装并重启'
        : update.status === 'checking'
          ? '正在检查…'
          : update.status === 'downloading'
            ? `正在下载 ${Math.round(update.percent)}%`
            : update.status === 'installing'
              ? '正在启动安装…'
              : '检查更新';
  const busy = update.status === 'checking' || update.status === 'downloading' || update.status === 'installing';
  const runPrimaryAction = () => {
    if (update.status === 'available') return void service.download();
    if (update.status === 'downloaded') return void service.install();
    return void service.check();
  };

  return (
    <div className="mx-auto max-w-[var(--content-max-width)] space-y-4">
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <Badge tone="success">桌面更新服务</Badge>
            <h3 className="type-dialog-title mt-3">当前版本 {update.currentVersion ?? '读取中'}</h3>
            <p className="type-body mt-1 text-[var(--text-muted)]">
              使用已签名安装包检查、下载并安装更新；安装前会明确提示重启。
            </p>
          </div>
          <PackageCheck className="text-[var(--accent)]" size={36} />
        </div>
      </Card>
      {(update.status === 'available' || update.status === 'downloading' || update.status === 'downloaded') && (
        <Card>
          <p className="type-body text-[var(--text-muted)]">
            {update.status === 'downloaded' ? '更新已下载，等待安装' : '发现可用版本'}
          </p>
          <h3 className="type-page-title mt-1">{update.latestVersion}</h3>
          {update.releaseNotes && <p className="type-body mt-3 text-[var(--text-secondary)]">{update.releaseNotes}</p>}
          {update.status === 'downloading' && (
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--bg-hover)]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-[width]"
                style={{ width: `${update.percent}%` }}
              />
            </div>
          )}
        </Card>
      )}
      {update.status === 'error' && (
        <Card>
          <Badge tone="warning">更新未完成</Badge>
          {/* ⚠️ 不能直接渲染 `update.message`：那是 electron-updater 的英文原文
              （`HttpError: 404 … latest.yml`）。翻译层见 update-errors.ts。 */}
          <p className="type-body mt-3 text-[var(--text-secondary)]">
            {describeUpdateError(update.message, update.operation)}
          </p>
        </Card>
      )}
      <div className="flex gap-2">
        <Button data-action="check-update" disabled={busy} onClick={runPrimaryAction}>
          {action}
        </Button>
      </div>
      <p className="type-support text-[var(--text-muted)]">
        如新版本异常，请从管理员发布的上一稳定版本安装包恢复；客户端不会伪装已经完成回滚。
      </p>
    </div>
  );
}

/**
 * ⚠️ P4：`AnalyticsModule`（埋点分析）与 `ComplianceModule`（隐私与合规）**已删除**。
 *    它们原来只是 Zustand + localStorage 的模拟：埋点数据搬到运营看板、隐私与数据
 *    搬到设置页（`layouts/Settings/sections/PrivacySection.tsx`，走 main 的隐私 IPC）。
 *    留在这里会变成和真入口同名的第二个假入口 —— 用户点哪个、运营看到什么全凭运气。
 */
const MODULE_COMPONENTS: Record<BetaModule, () => ReactNode> = {
  operations: OperationsModule,
  updates: UpdatesModule,
};

export default function InternalBetaHub() {
  const { t } = useTranslation();
  const active = useBetaStore((s) => s.activeModule);
  const setActive = useBetaStore((s) => s.setActiveModule);
  const reset = useBetaStore((s) => s.resetDemo);
  useEffect(() => {
    const routed = parseBetaRoute(window.location.hash);
    if (routed) setActive(routed);
    else window.history.replaceState(null, '', betaRoute(active));
  }, [active, setActive]);
  // ⚠️ 第二道防线：store 里已经 clamp 过（见 beta-store.ts 的 safeLoad），但界面
  //    不能假设"内存里一定是认识的模块" —— 认不出来就回落到清单里的第一个，
  //    而不是 `find(...)!` 加 `MODULE_COMPONENTS[active]` 双双 undefined
  //    （那会当场抛 TypeError，被根 ErrorBoundary 接成整应用错误页）。
  const ActiveModule = MODULE_COMPONENTS[active] ?? MODULE_COMPONENTS[BETA_MODULES[0].id];
  const selected = useMemo(() => BETA_MODULES.find((item) => item.id === active) ?? BETA_MODULES[0], [active]);
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
      <WindowTitlebar
        left={
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-[var(--accent)]" />
            <h2 className="font-semibold">{t('beta.title')}</h2>
            <Badge tone="warning">{t('beta.demoBadge')}</Badge>
          </div>
        }
        right={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              // 复位后回到清单里的第一个模块（原来写死 'team'，
              // 而广场/团队已经毕业出去了 —— 写死会指向一个不存在的模块）
              window.history.replaceState(null, '', betaRoute(BETA_MODULES[0].id));
              reset();
            }}
          >
            <RotateCcw />
            {t('beta.reset')}
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <nav
          aria-label={t('beta.navigation')}
          className="w-56 flex-shrink-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--bg-secondary)] p-3"
        >
          {BETA_MODULES.map((module) => {
            const Icon = ICONS[module.id];
            return (
              <button
                data-module={module.id}
                key={module.id}
                onClick={() => {
                  setActive(module.id);
                  window.history.replaceState(null, '', betaRoute(module.id));
                }}
                className={`mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${active === module.id ? 'bg-[var(--state-selected)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
              >
                <Icon size={18} />
                <span className="min-w-0">
                  <strong className="type-body block truncate">{module.label}</strong>
                  <small className="block truncate text-[var(--text-muted)]">{module.description}</small>
                </span>
              </button>
            );
          })}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl p-5 lg:p-7">
            <header className="mb-5">
              <div className="flex items-center gap-2">
                <h1 className="type-page-title">{selected.label}</h1>
                {/* ⚠️ 本机模拟的模块必须**当场**标出来：内测 1.0 不许把这些当"已完成"讲。 */}
                {selected.preview && <Badge tone="warning">{t('beta.previewBadge')}</Badge>}
              </div>
              {/*
                ⚠️ 「本机数据」提示**只给本机模拟的模块**：`updates` 调的是真更新接口
                （electron-updater），给它挂一句"当前为本机持久化内测数据"是假话。
                真接口模块这里不加提示 —— 它的正文已经写明用的是已签名安装包，
                而"不标预览"本身也不是在宣称已完成（交接单只要求模拟模块必须标出来）。
              */}
              <p className="type-body mt-1 text-[var(--text-muted)]">
                {selected.description}
                {selected.preview ? ` · ${t('beta.previewHint')}` : null}
              </p>
            </header>
            <ActiveModule />
          </div>
        </main>
      </div>
    </div>
  );
}

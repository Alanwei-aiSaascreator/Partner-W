import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BadgeCheck,
  BarChart3,
  Bot,
  Check,
  ChevronRight,
  CircleDollarSign,
  Download,
  Gamepad2,
  Gift,
  Heart,
  LayoutGrid,
  Megaphone,
  MessageCircle,
  PackageCheck,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Store,
  Users,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import WindowTitlebar from '@/components/semantic/WindowTitlebar';
import { Button } from '@/components/ui/button';
import { BETA_MODULES, MARKET_TEMPLATES, useBetaStore, type BetaModule } from './beta-store';
import { betaRoute, parseBetaRoute } from './beta-route';
import { createInternalBetaUpdateService, type InternalBetaUpdateState } from './update-service';

const ICONS: Record<BetaModule, typeof Users> = {
  team: Users,
  market: Store,
  bounty: CircleDollarSign,
  square: LayoutGrid,
  creator: Bot,
  game: Gamepad2,
  operations: Wrench,
  updates: RefreshCw,
  analytics: BarChart3,
  compliance: ShieldCheck,
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

function Field({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
}) {
  return (
    <input
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="type-body h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
    />
  );
}

function TeamModule() {
  const team = useBetaStore((s) => s.team);
  const createTeam = useBetaStore((s) => s.createTeam);
  const joinTeam = useBetaStore((s) => s.joinTeam);
  const leaveTeam = useBetaStore((s) => s.leaveTeam);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  if (!team)
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <Users className="mb-3 text-[var(--accent)]" />
          <h3 className="type-section-title">创建团队</h3>
          <p className="type-body mb-4 text-[var(--text-muted)]">为公司成员建立共享协作空间。</p>
          <div className="flex gap-2">
            <Field label="beta.teamName" value={name} onChange={setName} placeholder="例如：销售增长组" />
            <Button data-action="create-team" onClick={() => createTeam(name)}>
              <Plus />
              创建
            </Button>
          </div>
        </Card>
        <Card>
          <PackageCheck className="mb-3 text-[var(--accent)]" />
          <h3 className="type-section-title">加入团队</h3>
          <p className="type-body mb-4 text-[var(--text-muted)]">输入同事发来的邀请码。</p>
          <div className="flex gap-2">
            <Field value={code} onChange={setCode} placeholder="RY123456" />
            <Button variant="outline" onClick={() => joinTeam(code)}>
              加入
            </Button>
          </div>
        </Card>
      </div>
    );
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Badge tone="warning">内测团队数据</Badge>
            <h3 className="type-dialog-title mt-2">{team.name}</h3>
            <p className="type-body mt-1 text-[var(--text-muted)]">{team.members.length} 位成员 · 本机持久化</p>
          </div>
          <Button variant="danger" onClick={leaveTeam}>
            退出团队
          </Button>
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h3 className="mb-3 font-semibold">成员列表</h3>
          {team.members.map((member) => (
            <div
              key={member.id}
              className="flex items-center justify-between border-b border-[var(--border-subtle)] py-3 last:border-0"
            >
              <div className="flex items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
                  {member.name.slice(0, 1)}
                </div>
                <span>{member.name}</span>
              </div>
              <Badge>{member.role}</Badge>
            </div>
          ))}
        </Card>
        <Card>
          <h3 className="font-semibold">邀请成员</h3>
          <p className="type-body my-2 text-[var(--text-muted)]">把邀请码发给同事</p>
          <div
            data-invite-code
            className="type-dialog-title rounded-xl bg-[var(--bg-tertiary)] p-4 text-center font-mono tracking-widest"
          >
            {team.inviteCode}
          </div>
          <Button
            className="mt-3 w-full"
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(team.inviteCode);
              setCopied(true);
            }}
          >
            {copied ? <Check /> : <PackageCheck />}
            {copied ? '已复制' : '复制邀请码'}
          </Button>
        </Card>
      </div>
    </div>
  );
}

function MarketModule() {
  const installed = useBetaStore((s) => s.installedTemplateIds);
  const install = useBetaStore((s) => s.installTemplate);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const filtered = MARKET_TEMPLATES.filter(
    (item) => (category === '全部' || item.category === category) && item.name.includes(query),
  );
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="flex min-w-64 flex-1 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索助手模板"
            className="h-9 flex-1 bg-transparent outline-none"
          />
        </div>
        {['全部', '内容创作', '电商运营', '学习研究'].map((item) => (
          <Button
            key={item}
            size="sm"
            variant={category === item ? 'default' : 'outline'}
            onClick={() => setCategory(item)}
          >
            {item}
          </Button>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((item) => (
          <Card key={item.id}>
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
              <Bot />
            </div>
            <Badge>{item.category}</Badge>
            <h3 className="type-section-title mt-2">{item.name}</h3>
            <p className="type-body my-3 min-h-10 text-[var(--text-muted)]">{item.description}</p>
            <div className="flex items-center justify-between">
              <span className="type-support text-[var(--text-muted)]">{item.installs.toLocaleString()} 次安装</span>
              <Button size="sm" disabled={installed.includes(item.id)} onClick={() => install(item.id)}>
                {installed.includes(item.id) ? (
                  <>
                    <Check />
                    已安装
                  </>
                ) : (
                  <>
                    <Download />
                    安装
                  </>
                )}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function BountyModule() {
  const bounties = useBetaStore((s) => s.bounties);
  const publish = useBetaStore((s) => s.publishBounty);
  const claim = useBetaStore((s) => s.claimBounty);
  const submit = useBetaStore((s) => s.submitBounty);
  const [title, setTitle] = useState('');
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex gap-2">
          <Field value={title} onChange={setTitle} placeholder="描述需要协作完成的任务" />
          <Button
            onClick={() => {
              publish(title);
              setTitle('');
            }}
          >
            <Plus />
            发布悬赏
          </Button>
        </div>
        <p className="type-support mt-2 text-[var(--text-muted)]">内测流程：积分仅作展示，不产生付款或真实结算。</p>
      </Card>
      {bounties.map((item) => (
        <Card key={item.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Gift className="text-[var(--warning)]" />
                <h3 className="font-semibold">{item.title}</h3>
              </div>
              <p className="type-body mt-2 text-[var(--text-muted)]">
                奖励 {item.reward} 积分 · 状态：
                {item.status === 'open' ? '待领取' : item.status === 'claimed' ? '进行中' : '已提交待审核'}
              </p>
            </div>
            {item.status === 'open' ? (
              <Button onClick={() => claim(item.id)}>领取任务</Button>
            ) : item.status === 'claimed' ? (
              <Button onClick={() => submit(item.id)}>提交成果</Button>
            ) : (
              <Badge tone="success">已提交</Badge>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function SquareModule() {
  const feed = useBetaStore((s) => s.feed);
  const publish = useBetaStore((s) => s.publishPost);
  const like = useBetaStore((s) => s.likePost);
  const comment = useBetaStore((s) => s.commentPost);
  const [text, setText] = useState('');
  const [comments, setComments] = useState<Record<string, string>>({});
  return (
    <div className="mx-auto max-w-[var(--content-max-width)] space-y-4">
      <Card>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="分享一个进展、问题或灵感…"
          className="min-h-24 w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-3 outline-none"
        />
        <div className="mt-2 flex justify-end">
          <Button
            onClick={() => {
              publish(text);
              setText('');
            }}
          >
            <Send />
            发布
          </Button>
        </div>
      </Card>
      {feed.map((post) => (
        <Card key={post.id}>
          <div className="flex items-center justify-between">
            <strong>{post.author}</strong>
            <span className="type-support text-[var(--text-muted)]">{post.createdAt}</span>
          </div>
          <p className="my-4">{post.content}</p>
          <div className="type-body flex items-center gap-4">
            <button
              onClick={() => like(post.id)}
              className="flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--accent)]"
            >
              <Heart size={16} />
              {post.likes}
            </button>
            <span className="flex items-center gap-1 text-[var(--text-secondary)]">
              <MessageCircle size={16} />
              {post.comments.length}
            </span>
          </div>
          {post.comments.map((item, index) => (
            <p key={index} className="type-body mt-2 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2">
              {item}
            </p>
          ))}
          <div className="mt-3 flex gap-2">
            <Field
              value={comments[post.id] ?? ''}
              onChange={(value) => setComments((old) => ({ ...old, [post.id]: value }))}
              placeholder="写评论"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                comment(post.id, comments[post.id] ?? '');
                setComments((old) => ({ ...old, [post.id]: '' }));
              }}
            >
              评论
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function CreatorModule() {
  const templates = useBetaStore((s) => s.creatorTemplates);
  const create = useBetaStore((s) => s.createCreatorTemplate);
  const rename = useBetaStore((s) => s.renameCreatorTemplate);
  const toggle = useBetaStore((s) => s.toggleCreatorPublished);
  const [name, setName] = useState('');
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex gap-2">
          <Field value={name} onChange={setName} placeholder="新助手模板名称" />
          <Button
            onClick={() => {
              create(name);
              setName('');
            }}
          >
            <Plus />
            创建模板
          </Button>
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        {templates.map((item) => (
          <Card key={item.id}>
            <div className="flex items-start justify-between">
              <div>
                <Badge tone={item.status === 'published' ? 'success' : 'warning'}>
                  {item.status === 'published' ? '已发布' : '草稿'}
                </Badge>
                <input
                  aria-label="编辑模板名称"
                  className="type-section-title mt-2 block w-full bg-transparent outline-none"
                  value={item.name}
                  onChange={(e) => rename(item.id, e.target.value)}
                />
              </div>
              <Sparkles className="text-[var(--accent)]" />
            </div>
            <div className="type-body my-4 grid grid-cols-2 rounded-xl bg-[var(--bg-tertiary)] p-3 text-center">
              <div>
                <b className="type-section-title block">{item.views}</b>浏览
              </div>
              <div>
                <b className="type-section-title block">{item.installs}</b>安装
              </div>
            </div>
            <Button
              className="w-full"
              variant={item.status === 'published' ? 'outline' : 'default'}
              onClick={() => toggle(item.id)}
            >
              {item.status === 'published' ? '下架模板' : '发布模板'}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

function GameModule() {
  const game = useBetaStore((s) => s.game);
  const checkIn = useBetaStore((s) => s.checkIn);
  const progress = (game.points % 200) / 2;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="bg-gradient-to-br from-[var(--accent-soft)] to-[var(--bg-secondary)]">
        <Badge>Lv.{game.level}</Badge>
        <h3 className="type-page-title mt-3">{game.points} 积分</h3>
        <div className="my-4 h-2 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
          <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${progress}%` }} />
        </div>
        <p className="type-body text-[var(--text-muted)]">距离下一等级还需 {200 - (game.points % 200)} 积分</p>
        <Button className="mt-5" disabled={game.checkedInToday} onClick={checkIn}>
          {game.checkedInToday ? (
            <>
              <Check />
              今日已签到
            </>
          ) : (
            <>
              <Gift />
              每日签到 +20
            </>
          )}
        </Button>
      </Card>
      <Card>
        <h3 className="mb-3 font-semibold">我的徽章</h3>
        {game.badges.map((badge) => (
          <div key={badge} className="flex items-center gap-3 rounded-xl bg-[var(--bg-tertiary)] p-3">
            <BadgeCheck className="text-[var(--warning)]" />
            <div>
              <strong>{badge}</strong>
              <p className="type-support text-[var(--text-muted)]">参与公司首轮体验</p>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function OperationsModule() {
  const operations = useBetaStore((s) => s.operations);
  const adjust = useBetaStore((s) => s.adjustCredits);
  const toggle = useBetaStore((s) => s.toggleModel);
  const setRate = useBetaStore((s) => s.setModelRate);
  const setAnnouncement = useBetaStore((s) => s.setAnnouncement);
  const [showLogs, setShowLogs] = useState(false);
  return (
    <div className="space-y-4">
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
      <p className="type-support text-[var(--warning)]">
        内测模拟后台：当前操作只影响本机演示数据，不修改生产用户、账单或模型配置。
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
          <p className="type-body mt-3 text-[var(--text-secondary)]">{update.message}</p>
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

function AnalyticsModule() {
  const analytics = useBetaStore((s) => s.analytics);
  const labels: Record<keyof typeof analytics, string> = {
    launch: '启动',
    login: '登录',
    activation: '激活',
    chat: '对话',
    file: '文件',
    artifact: '成果',
    error: '错误',
  };
  const max = Math.max(...Object.values(analytics));
  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="font-semibold">今日核心事件</h3>
          <p className="type-body text-[var(--text-muted)]">本地 seed + 内测采集视图</p>
        </div>
        <Badge tone="warning">内测采集</Badge>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Object.entries(analytics).map(([key, value]) => (
          <Card key={key}>
            <div className="flex items-center justify-between">
              <span className="type-body text-[var(--text-muted)]">{labels[key as keyof typeof analytics]}</span>
              <BarChart3 size={16} className="text-[var(--accent)]" />
            </div>
            <strong className="type-page-title my-3 block">{value}</strong>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
              <div className="h-full bg-[var(--accent)]" style={{ width: `${(value / max) * 100}%` }} />
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function ComplianceModule() {
  const state = useBetaStore((s) => s.compliance);
  const agree = useBetaStore((s) => s.agreeCompliance);
  const exportData = useBetaStore((s) => s.requestDataExport);
  const remove = useBetaStore((s) => s.requestDeletion);
  const [openPolicy, setOpenPolicy] = useState<'privacy' | 'terms' | 'permissions' | null>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <ShieldCheck className="mb-3 text-[var(--accent)]" />
        <h3 className="type-section-title">协议与权限</h3>
        <div className="type-body my-4 space-y-2">
          <button
            onClick={() => setOpenPolicy('privacy')}
            className="flex w-full items-center justify-between rounded-lg bg-[var(--bg-tertiary)] p-3"
          >
            隐私政策 <ChevronRight size={16} />
          </button>
          <button
            onClick={() => setOpenPolicy('terms')}
            className="flex w-full items-center justify-between rounded-lg bg-[var(--bg-tertiary)] p-3"
          >
            服务条款 <ChevronRight size={16} />
          </button>
          <button
            onClick={() => setOpenPolicy('permissions')}
            className="flex w-full items-center justify-between rounded-lg bg-[var(--bg-tertiary)] p-3"
          >
            电脑与文件权限说明 <ChevronRight size={16} />
          </button>
        </div>
        <Button disabled={state.agreed} onClick={agree}>
          {state.agreed ? (
            <>
              <Check />
              已记录同意
            </>
          ) : (
            '同意并继续'
          )}
        </Button>
      </Card>
      <Card>
        <h3 className="type-section-title">我的数据权利</h3>
        <p className="type-body my-3 text-[var(--text-muted)]">正式上线后由服务端工单处理；内测版仅保存申请状态。</p>
        <div className="space-y-3">
          <Button className="w-full" variant="outline" disabled={state.exportRequested} onClick={exportData}>
            {state.exportRequested ? '导出申请已提交' : '申请导出我的数据'}
          </Button>
          <Button className="w-full" variant="danger" disabled={state.deletionRequested} onClick={remove}>
            {state.deletionRequested ? '删除申请已提交' : '申请删除账号与数据'}
          </Button>
        </div>
      </Card>
      {openPolicy && (
        <Card className="lg:col-span-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Badge>
                {openPolicy === 'privacy' ? '隐私政策摘要' : openPolicy === 'terms' ? '服务条款摘要' : '权限说明'}
              </Badge>
              <p className="type-body mt-3 leading-6 text-[var(--text-secondary)]">
                {openPolicy === 'privacy'
                  ? '仅采集提供登录、计费和故障分析所需的数据；敏感文件不会在未授权时上传。'
                  : openPolicy === 'terms'
                    ? '公司内测账号仅限授权员工体验，生成内容需由使用者复核后再对外使用。'
                    : '读取文件、写入成果或调用电脑工具前，会显示操作范围并请求确认；你可以随时撤销授权。'}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setOpenPolicy(null)}>
              关闭
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

const MODULE_COMPONENTS: Record<BetaModule, () => ReactNode> = {
  team: TeamModule,
  market: MarketModule,
  bounty: BountyModule,
  square: SquareModule,
  creator: CreatorModule,
  game: GameModule,
  operations: OperationsModule,
  updates: UpdatesModule,
  analytics: AnalyticsModule,
  compliance: ComplianceModule,
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
  const ActiveModule = MODULE_COMPONENTS[active];
  const selected = useMemo(() => BETA_MODULES.find((item) => item.id === active)!, [active]);
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
              window.history.replaceState(null, '', betaRoute('team'));
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
              <h1 className="type-page-title">{selected.label}</h1>
              <p className="type-body mt-1 text-[var(--text-muted)]">
                {selected.description} · {t('beta.localDataHint')}
              </p>
            </header>
            <ActiveModule />
          </div>
        </main>
      </div>
    </div>
  );
}

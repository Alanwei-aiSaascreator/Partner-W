import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { userMdContentFromReadResult } from '@/lib/identity-persona';
import { buildAboutYouSkeleton, isKernelDefaultUserMd, todayLocalIsoDate } from '@/lib/user-md-template';
import { Button } from '@/components/ui/button';
import SettingGroup from '@/components/semantic/SettingGroup';
import SettingRow from '@/components/semantic/SettingRow';
import { useUiStore } from '@/stores/uiStore';
import MemoryEntriesSection from './MemoryEntriesSection';

/**
 * **记忆一期：第一层（"关于你"）。**
 *
 * 这一页做的事只有一件：让用户**看得见、改得动**助手每轮都会读到的那份「关于你」。
 *
 * ## 为什么是这一层
 *
 * 运行时每轮会注入 6 个固定文件，其中 `USER.md` 就是"关于你"那一份
 * （见 [[runtime-injection-and-memory-facts]]）。它是记忆系统里**唯一**一层
 * 不需要模型参与、也不需要判断"什么值得记"的东西 —— 所以从它开始风险最低、
 * 收益最直接：用户今天就能把自己想让助手知道的事写进去。
 *
 * ## ✅ 另一半（2026-10-16 已补）
 *
 * 决策记录里"助手只提草案、用户点头才落盘"那一半现在住在 `MemoryEntriesSection`
 * （本页下方）：助手在回复里给 ```` ```memory ```` 块 ⇒ 落一条**待确认草案** ⇒
 * 用户确认/改/拒 ⇒ 才写进 `MEMORY.md`（运行时每轮全文注入的召回通道）。
 *
 * ⚠️ 两个区块管的**不是一个文件**，别混：
 *   · 本组件 · `USER.md`「关于你」—— 每轮注入，**写给盘上每个助手**（这块盘懂我）；
 *   · 下方区块 · `MEMORY.md` 长期记忆 —— 同一份注入通道，但**按当前账号**过滤。
 *
 * ## ⚠️ 为什么写的是"这块盘"而不是"这个助手"
 *
 * 运行时的文件是**按助手**存的，而用户的心智是"**这块盘**懂我"（决策记录原话）。
 * 所以保存时**写给盘上每一个助手**：用户写一次，所有助手都记得。
 */
export default function MemorySection() {
  const { t } = useTranslation();
  const gatewayId = useUiStore((s) => s.defaultGatewayId);
  const agentCatalogByGateway = useUiStore((s) => s.agentCatalogByGateway);
  const defaultAgentId = useUiStore((s) => (gatewayId ? s.agentCatalogByGateway[gatewayId]?.defaultId : undefined));

  const agents = useMemo(
    () => (gatewayId ? (agentCatalogByGateway[gatewayId]?.agents ?? []) : []),
    [gatewayId, agentCatalogByGateway],
  );

  /**
   * **读**哪一份：默认助手那一份（用户实际在用的那个），不是数组第一个。
   *
   * ⚠️ 目录的**顺序不是契约**，而库里别处（`AgentBuilderDialog` / `TeamBuilderDialog` /
   *    `useGatewaySelector`）一律用 `defaultId ?? 'main'` —— 只有这里用 `agents[0]` 的话，
   *    一旦两者不是同一个助手，这一页展示的就是**另一个助手**的「关于你」。
   *    默认助手不在目录里（目录还没加载全、或它被删了）退回第一个，不给空白页。
   *
   * ⚠️ **写**不受影响：仍然是写给盘上每一个助手（见文件头"这块盘懂我"）。
   */
  const readAgentId = useMemo(() => {
    if (agents.length === 0) return null;
    const preferred = defaultAgentId ?? 'main';
    return agents.some((agent) => agent.id === preferred) ? preferred : agents[0].id;
  }, [agents, defaultAgentId]);

  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /**
   * 读失败 ⇒ **不给**可编辑的空输入框（2026-10-07 体检问题 1/2 的同族）。
   *
   * 以前读失败时 `content` 落在 `''`：输入框看着"空荡荡"，用户补一句再点保存，
   * 就把盘上真实存在、只是没读出来的记忆**整份覆盖**了。读不出来就别给编辑口。
   */
  const [readFailed, setReadFailed] = useState(false);
  /**
   * ⚠️ 存的是**翻译 key 或原始报文**，不是翻好的句子。
   *
   * 为什么：翻好的话就得在 effect 里调 `t`，而 `t` 一旦进了依赖数组，
   * 任何"每渲染新建一个翻译函数"的场合都会变成
   * 「setState → 重渲染 → 新 t → 再跑」的**无限循环**（写这一版时测试夹具就是这么挂住的，
   * 5 个用例全超时）。**渲染时再翻**就没有这个问题。
   */
  const [error, setError] = useState<{ key: string } | { raw: string } | null>(null);

  /**
   * ## 🔴 内核英文模板的本地化（2026-10-18 用户反馈「这个记忆为什么自带了英文」）
   *
   * 内核 OpenClaw 2026.9.3 在工作区首次准备时，会把
   * `docs/reference/templates/USER.md` 的英文正文**落成盘上真实的 `USER.md`**
   * （runtime `dist/workspace-*.mjs` 的 `FALLBACK_DOCS_TEMPLATE_DIR`）——
   * 所以这不是"网关缺省回包"，而是一份真实文件，且**每轮注入给助手**。
   *
   * 处置：识别到**一字未改**的内核模板（判据在 `lib/user-md-template.ts`）就当成空，
   * 输入框换成按当前语言拼的骨架；用户一保存，写回的就是这份骨架 + 他自己写的内容。
   * ⚠️ 判据只认"一字未改"：用户动过一行 ⇒ 按真实内容处理，**一个字节都不动**。
   *
   * ⚠️ 骨架走 ref 送进 effect：`t` **不能**进 effect 依赖（见下方 effect 末尾的说明），
   *    否则任何"每渲染新建翻译函数"的场合都会变成 setState 死循环。
   */
  const skeleton = useMemo(
    () =>
      buildAboutYouSkeleton(
        {
          title: t('settings.memoryUserMdTitle'),
          observed: (date) => t('settings.memoryUserMdObserved', { date }),
          sampleDirective: t('settings.memoryUserMdSampleDirective'),
        },
        todayLocalIsoDate(),
      ),
    [t],
  );
  const skeletonRef = useRef(skeleton);
  skeletonRef.current = skeleton;

  /** 上限来自运行时那一侧（`USER.md` 是 4,000 字符硬上限）。超了不许存。 */
  const MAX_CHARS = 4000;
  const overLimit = content.length > MAX_CHARS;
  const dirty = content !== savedContent;

  useEffect(() => {
    if (!gatewayId || !readAgentId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReadFailed(false);
    // 读**默认助手**那一份当作这份盘上的记忆（保存时会写给全部 —— 见 readAgentId 与文件头）
    window.clawwork
      .getAgentFile(gatewayId, readAgentId, 'USER.md')
      .then((res) => {
        if (cancelled) return;
        /**
         * 🔴 2026-10-07 体检问题 1（同 IdentityCenter）：真机载荷是 `{ file: { content } }`，
         * 老写法读 `result.content` 恒得空串 ⇒ 记忆页永远显示为空、一保存就把真内容覆盖。
         * 读不出来（ok=false / 形状不认识）**不当空文件** —— 见 `readFailed` 的说明。
         */
        const text = res.ok ? userMdContentFromReadResult(res.result) : null;
        if (text === null) {
          setReadFailed(true);
          setError(res.error ? { raw: res.error } : { key: 'settings.memoryReadFailed' });
          setLoading(false);
          return;
        }
        /**
         * 一字未改的内核英文模板 ⇒ 展示本地化骨架（并当作"没改过"，保存按钮保持禁用）。
         * 真实内容（含 missing:true 的空串）原样展示 —— 判据见 `lib/user-md-template.ts`。
         */
        const shown = isKernelDefaultUserMd(text) ? skeletonRef.current : text;
        setContent(shown);
        setSavedContent(shown);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReadFailed(true);
        setError(err instanceof Error ? { raw: err.message } : { key: 'settings.memoryReadFailed' });
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // ⚠️ 依赖里**不放 `t`**：i18next 的 `t` 通常是稳定的，但一旦哪里给了个每渲染
    //    新建的翻译函数，这个 effect 就会「setState → 重渲染 → 新 t → 再跑」**无限循环**
    //    （写这一版时测试夹具就是这么挂住的，5 个用例全超时）。
  }, [gatewayId, agents, readAgentId]);

  const handleSave = useCallback(() => {
    if (!gatewayId || agents.length === 0) return;
    // ⚠️ 这里**刻意没有**第二道"超限就拒绝"的守卫：按钮在超限时是 `disabled` 的，
    //    那句话永远弹不出来 —— 变异电池实测它是**不可证伪的死代码**，删掉。
    //    超限的拦截由两处承担：按钮 `disabled` + 输入框下面**常驻**的那句说明。
    setSaving(true);
    const targets = agents.map((agent) => window.clawwork.setAgentFile(gatewayId, agent.id, 'USER.md', content));
    void Promise.all(targets)
      .then((results) => {
        const failed = results.filter((r) => !r.ok).length;
        if (failed > 0) {
          // ⚠️ 部分失败要说**几个没写成**，不许报"保存成功"
          toast.error(t('settings.memorySavePartial', { failed, total: results.length }));
          return;
        }
        setSavedContent(content);
        toast.success(t('settings.memorySaved', { count: results.length }));
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : t('settings.memorySaveFailed'));
      })
      .finally(() => setSaving(false));
  }, [agents, content, gatewayId, t]);

  const noAgents = !loading && agents.length === 0;

  return (
    <div className="space-y-8">
      <div>
        <h3 className="type-section-title mb-1 text-[var(--text-primary)]">{t('settings.memory')}</h3>
        <p className="type-meta mb-4 text-[var(--text-muted)]">{t('settings.memoryIntro')}</p>
        <SettingGroup>
          <SettingRow label={t('settings.memoryAboutYou')} description={t('settings.memoryAboutYouHint')}>
            <span className="type-mono-data text-[var(--text-muted)]" data-testid="memory-counter">
              {t('settings.memoryCounter', { used: content.length, max: MAX_CHARS })}
            </span>
          </SettingRow>
        </SettingGroup>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-10">
          <Loader2 size={18} className="animate-spin text-[var(--text-muted)]" />
        </div>
      )}

      {noAgents && <p className="type-support text-[var(--text-muted)]">{t('settings.memoryNoAgents')}</p>}

      {error && <p className="type-support text-[var(--danger)]">{'key' in error ? t(error.key) : error.raw}</p>}

      {!loading && !noAgents && !readFailed && (
        <div className="space-y-3">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            aria-label={t('settings.memoryAboutYou')}
            data-testid="memory-about-you-input"
            rows={12}
            className="glow-focus type-body w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-[var(--text-primary)]"
            placeholder={t('settings.memoryPlaceholder')}
          />
          <div className="flex items-center gap-3">
            <Button
              variant="default"
              size="sm"
              onClick={handleSave}
              disabled={saving || !dirty || overLimit}
              data-testid="memory-save"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              {t('settings.memorySave')}
            </Button>
            {overLimit && (
              <span className="type-meta text-[var(--danger)]" data-testid="memory-over-limit">
                {t('settings.memoryTooLong', { max: MAX_CHARS })}
              </span>
            )}
            {dirty && !overLimit && (
              <span className="type-meta text-[var(--text-muted)]">{t('settings.memoryUnsaved')}</span>
            )}
          </div>
          {/* ⚠️ 这句**不许**再写"助手不能提草案"——2026-10-16 起草案轨道就在下方。
              这里只说清本框写的是哪一份文件，免得用户以为它等于长期记忆。 */}
          <p className="type-meta text-[var(--text-muted)]">{t('settings.memoryAboutYouScope')}</p>
        </div>
      )}

      {/* 长期记忆（确认轨道）：助手提草案 → 用户点头 → `MEMORY.md` → 助手每轮读到 */}
      <MemoryEntriesSection />
    </div>
  );
}

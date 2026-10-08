import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { userMdContentFromReadResult } from '@/lib/identity-persona';
import { Button } from '@/components/ui/button';
import SettingGroup from '@/components/semantic/SettingGroup';
import SettingRow from '@/components/semantic/SettingRow';
import { useUiStore } from '@/stores/uiStore';

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
 * ## ⚠️ 这一期**没有**做的那半
 *
 * 决策记录里的另一半是「助手只提草案、用户点头才落盘」。**这一期没做** ——
 * 这里只有**用户自己写**这一条路。界面上如实说明，不许让用户以为助手会自己记。
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

  const agents = useMemo(
    () => (gatewayId ? (agentCatalogByGateway[gatewayId]?.agents ?? []) : []),
    [gatewayId, agentCatalogByGateway],
  );

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

  /** 上限来自运行时那一侧（`USER.md` 是 4,000 字符硬上限）。超了不许存。 */
  const MAX_CHARS = 4000;
  const overLimit = content.length > MAX_CHARS;
  const dirty = content !== savedContent;

  useEffect(() => {
    if (!gatewayId || agents.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReadFailed(false);
    // 读**第一个**助手的当作这份盘上的记忆（保存时会写给全部 —— 见文件头说明）
    window.clawwork
      .getAgentFile(gatewayId, agents[0].id, 'USER.md')
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
        setContent(text);
        setSavedContent(text);
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
  }, [gatewayId, agents]);

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
          {/* ⚠️ 如实说明这一期**没有**做的另一半，不许让用户以为助手会自己记 */}
          <p className="type-meta text-[var(--text-muted)]">{t('settings.memoryDraftTrackNotYet')}</p>
        </div>
      )}
    </div>
  );
}

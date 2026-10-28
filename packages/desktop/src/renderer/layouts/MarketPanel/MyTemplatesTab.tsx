import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { describeTemplateErrorKey, normalizeMyTemplates } from '@clawwork/core';
import {
  TEMPLATE_CATEGORIES,
  type CreatorTemplate,
  type TemplateCategory,
  type TemplateStatus,
} from '@clawwork/shared';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import EmptyState from '@/components/semantic/EmptyState';

/**
 * 创作者中心（"我的模板"）。
 *
 * 发布即上架（不审核，用户已拍板）：本组织成员立刻能在市场里看到并在罗盘助手中使用。
 * 管理员能下架别人的，但**不能替别人发布** —— 那条规则在服务端（迁移 40），
 * 这里只是不给虚假的入口。
 *
 * ⚠️ 已经有人用过的模板只能下架、不能删除 —— 别人本地那份助手的"来源"不该凭空消失。
 */
interface TemplateForm {
  name: string;
  description: string;
  category: TemplateCategory;
  emoji: string;
  instructions: string;
}

const EMPTY_FORM: TemplateForm = { name: '', description: '', category: 'other', emoji: '🧩', instructions: '' };

const CATEGORY_SUFFIX: Record<TemplateCategory, 'Content' | 'Ecommerce' | 'Research' | 'Office' | 'Other'> = {
  content: 'Content',
  ecommerce: 'Ecommerce',
  research: 'Research',
  office: 'Office',
  other: 'Other',
};

const STATUS_KEY: Record<TemplateStatus, string> = {
  draft: 'market.statusDraft',
  published: 'market.statusPublished',
  archived: 'market.statusArchived',
};

function toForm(row: CreatorTemplate): TemplateForm {
  return {
    name: row.name,
    description: row.description,
    category: row.category,
    emoji: row.emoji,
    instructions: row.instructions,
  };
}

export default function MyTemplatesTab() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<CreatorTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateForm>(EMPTY_FORM);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setFailed(false);
    const res = await window.clawwork.marketMyTemplates();
    if (!res.ok) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setRows(normalizeMyTemplates(res.result));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async (): Promise<void> => {
    if (!form.name.trim() || !form.instructions.trim()) return;
    setCreating(true);
    const res = await window.clawwork.marketCreateTemplate({ ...form });
    setCreating(false);
    if (!res.ok) {
      toast.error(t(describeTemplateErrorKey(res.errorCode)));
      return;
    }
    setForm(EMPTY_FORM);
    toast.success(t('market.createDone'));
    await load();
  }, [form, load, t]);

  const save = useCallback(
    async (id: string): Promise<void> => {
      const res = await window.clawwork.marketUpdateTemplate({ id, ...form });
      if (!res.ok) {
        toast.error(t(describeTemplateErrorKey(res.errorCode)));
        return;
      }
      setEditingId(null);
      toast.success(t('market.saveDone'));
      await load();
    },
    [form, load, t],
  );

  const setStatus = useCallback(
    async (id: string, status: TemplateStatus): Promise<void> => {
      const res = await window.clawwork.marketSetTemplateStatus(id, status);
      if (!res.ok) {
        toast.error(t(describeTemplateErrorKey(res.errorCode)));
        return;
      }
      toast.success(status === 'published' ? t('market.publishDone') : t('market.unpublishDone'));
      await load();
    },
    [load, t],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (!window.confirm(t('market.deleteConfirm'))) return;
      const res = await window.clawwork.marketDeleteTemplate(id);
      if (!res.ok) {
        toast.error(t(describeTemplateErrorKey(res.errorCode)));
        return;
      }
      toast.success(t('market.deleteDone'));
      await load();
    },
    [load, t],
  );

  const categoryOptions = useMemo(
    () => TEMPLATE_CATEGORIES.map((value) => ({ value, label: t(`market.category${CATEGORY_SUFFIX[value]}`) })),
    [t],
  );

  const renderForm = (target: 'new' | 'edit'): React.ReactNode => (
    <div className="space-y-2">
      <input
        data-field={target === 'new' ? 'new-name' : 'edit-name'}
        value={form.name}
        onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
        placeholder={t('market.nameLabel')}
        className="glow-focus h-[var(--density-control-height-sm)] w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
      />
      <input
        data-field={target === 'new' ? 'new-description' : 'edit-description'}
        value={form.description}
        onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
        placeholder={t('market.descriptionLabel')}
        className="glow-focus h-[var(--density-control-height-sm)] w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
      />
      <div className="flex items-center gap-2">
        <input
          data-field={target === 'new' ? 'new-emoji' : 'edit-emoji'}
          value={form.emoji}
          onChange={(event) => setForm((current) => ({ ...current, emoji: event.target.value }))}
          aria-label={t('market.emojiLabel')}
          className="glow-focus h-[var(--density-control-height-sm)] w-16 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-center type-body text-[var(--text-primary)]"
        />
        <select
          data-field={target === 'new' ? 'new-category' : 'edit-category'}
          value={form.category}
          onChange={(event) => setForm((current) => ({ ...current, category: event.target.value as TemplateCategory }))}
          className="glow-focus h-[var(--density-control-height-sm)] rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 type-body text-[var(--text-primary)]"
        >
          {categoryOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <textarea
        data-field={target === 'new' ? 'new-instructions' : 'edit-instructions'}
        value={form.instructions}
        onChange={(event) => setForm((current) => ({ ...current, instructions: event.target.value }))}
        placeholder={t('market.instructionsLabel')}
        rows={4}
        className="glow-focus w-full resize-none rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
      />
    </div>
  );

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        <section className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
          <h3 className="type-label text-[var(--text-primary)]">{t('market.createTitle')}</h3>
          {renderForm('new')}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={creating || !form.name.trim() || !form.instructions.trim()}
              onClick={() => void create()}
            >
              <Plus />
              {t('market.create')}
            </Button>
          </div>
        </section>

        {loading && rows.length === 0 && <p className="type-support text-[var(--text-muted)]">{t('market.loading')}</p>}

        {failed && (
          <div className="flex items-center gap-2">
            <p className="type-support text-[var(--text-secondary)]">{t('market.loadFailed')}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              {t('market.retry')}
            </Button>
          </div>
        )}

        {!loading && !failed && rows.length === 0 && <EmptyState title={t('market.mineEmpty')} />}

        {rows.map((row) => {
          const editing = editingId === row.id;
          const installed = row.installCount > 0;
          return (
            <article
              key={row.id}
              data-template={row.id}
              className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4"
            >
              <header className="flex items-center gap-2">
                <span className="type-section-title">{row.emoji}</span>
                <h3 className="type-label flex-1 text-[var(--text-primary)]">{row.name}</h3>
                <span className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5 type-support text-[var(--text-secondary)]">
                  {t(STATUS_KEY[row.status])}
                </span>
              </header>

              {editing ? (
                <>
                  {renderForm('edit')}
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
                      {t('market.cancel')}
                    </Button>
                    <Button size="sm" onClick={() => void save(row.id)}>
                      {t('market.save')}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="type-support text-[var(--text-muted)]">{row.description}</p>
                  <div className="flex items-center gap-3 type-support text-[var(--text-muted)]">
                    <span>{t('market.views', { count: row.viewCount })}</span>
                    <span>{t('market.usageCount', { count: row.installCount })}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingId(row.id);
                        setForm(toForm(row));
                      }}
                    >
                      <Pencil />
                      {t('market.edit')}
                    </Button>
                    {row.status === 'published' ? (
                      <Button size="sm" variant="outline" onClick={() => void setStatus(row.id, 'archived')}>
                        {t('market.unpublish')}
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => void setStatus(row.id, 'published')}>
                        {t('market.publish')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      data-action="delete"
                      disabled={installed}
                      title={installed ? t('market.deleteBlocked') : undefined}
                      onClick={() => void remove(row.id)}
                    >
                      <Trash2 />
                      {t('market.delete')}
                    </Button>
                  </div>
                </>
              )}
            </article>
          );
        })}
      </div>
    </ScrollArea>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, Loader2, MessageSquare, Plus, Rocket, Search, Sparkles, Trash2, Users, Wrench, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { gatewayToken, mobileFetch } from '../lib/remote-api';
import { useTaskStore, useUiStore } from '../stores/hooks';
import { ensureHydrationReady } from '../stores';

interface BundledSkill {
  slug: string;
  name?: string;
  description?: string;
  emoji?: string;
  installed?: boolean;
}

interface TeamMember {
  agentId: string;
  role?: string;
  position?: string;
  isManager?: number;
}

interface TeamRow {
  id: string;
  name: string;
  emoji?: string;
  description?: string;
  memberCount?: number;
  members?: TeamMember[];
  gatewayId?: string;
}

/**
 * 团队（手机端）—— 对齐桌面端 TeamsPanel：
 * 「我的团队 / TeamsHub」两个 tab、空态给「AI 创建」「创建团队」两个入口、
 * 有团队时按岗位展示成员。
 *
 * 创建团队要在电脑上完成：它是一次多助手的编排（建 agent、写工作区、绑技能），
 * 手机上做这套流程只会做出半个团队，所以这里如实提示而不是给个点了没反应的按钮。
 */
interface DraftMember {
  /** 职位（显示在团队卡片上，如图中「主持人 / 领域专家」）。 */
  position: string;
  /** 智能体名称（用于生成 id，中文会自动哈希成合法 id）。 */
  name: string;
  /** 编排角色：协调者 / 执行者。 */
  role: 'coordinator' | 'executor';
  /** 职责，写进 IDENTITY.md。 */
  duties: string;
  /** 绑定到该智能体的技能 slug 列表（对齐桌面端 AgentDraftCard 的 skills 勾选）。 */
  skills: string[];
}

interface CreateResult {
  name: string;
  agentId?: string;
  ok: boolean;
  reused?: boolean;
  error?: string;
  skillWarnings?: string[];
}

/** 岗位人设模板（与桌面端 IDENTITY.md 同一份结构：身份 + 职责 + 工作方式）。 */
function buildIdentity(teamName: string, member: DraftMember): string {
  return `# 身份

你是「${member.name || member.position}」，团队「${teamName}」中的${member.role === 'coordinator' ? '协调者' : '执行者'}，职位是「${member.position}」。

## 职责

${member.duties.trim() || '按团队目标承担对应环节的执行工作。'}

## 工作方式

- 先确认目标与验收标准，再动手
- 输出可直接使用的结果，不空谈
- 需要决策时列清选项、取舍与建议
- 不确定的事实先查证，不编造
`;
}

export function TeamsPanelView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'mine' | 'hub'>('mine');
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 创建面板（对齐桌面端 TeamBuilderDialog 的**执行段**：建 agent + 写 IDENTITY.md）
  const [creating, setCreating] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [teamDescription, setTeamDescription] = useState('');
  const [members, setMembers] = useState<DraftMember[]>([
    { position: '主持人', name: '负责人', role: 'coordinator', duties: '统筹目标、拆解任务、验收交付', skills: [] },
    { position: '领域专家', name: '执行', role: 'executor', duties: '按拆解结果完成具体工作，输出结果', skills: [] },
    { position: '审核', name: '质检', role: 'executor', duties: '检查事实、口径与质量，指出风险', skills: [] },
  ]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CreateResult[] | null>(null);

  // 技能选择 sheet：给当前正在编辑的成员挑技能（对齐桌面端 AgentDraftCard 的 skills 勾选）
  const [skillPickerFor, setSkillPickerFor] = useState<number | null>(null);
  const [allSkills, setAllSkills] = useState<BundledSkill[] | null>(null);
  const [skillQuery, setSkillQuery] = useState('');
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);

  const loadTeams = useCallback(async () => {
    const token = await gatewayToken();
    if (!token) {
      setError(t('gateway.disconnected'));
      return;
    }
    try {
      const response = await mobileFetch('/api/mobile/teams', token);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { teams?: TeamRow[] };
      setTeams(data.teams ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'teams failed');
      setTeams([]);
    }
  }, [t]);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  const loadSkills = useCallback(async (): Promise<void> => {
    const token = await gatewayToken();
    if (!token) return;
    setSkillLoading(true);
    setSkillError(null);
    try {
      const response = await mobileFetch('/api/mobile/skills', token);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { skills?: BundledSkill[] };
      setAllSkills(data.skills ?? []);
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : 'skills failed');
      setAllSkills([]);
    } finally {
      setSkillLoading(false);
    }
  }, []);

  useEffect(() => {
    if (skillPickerFor === null) return;
    setSkillQuery('');
    if (allSkills === null) void loadSkills();
  }, [skillPickerFor, allSkills, loadSkills]);

  const toggleSkill = (index: number, slug: string): void => {
    setMembers((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item;
        const has = item.skills.includes(slug);
        return { ...item, skills: has ? item.skills.filter((s) => s !== slug) : [...item.skills, slug] };
      }),
    );
  };

  const filteredSkills = (allSkills ?? []).filter((skill) => {
    const keyword = skillQuery.trim().toLowerCase();
    if (!keyword) return true;
    return (
      (skill.name ?? '').toLowerCase().includes(keyword) ||
      skill.slug.toLowerCase().includes(keyword) ||
      (skill.description ?? '').toLowerCase().includes(keyword)
    );
  });

  /**
   * 开始团队对话 —— 主管（isManager）优先，没有主管就第一个成员；
   * `teamId` 透传给任务，会话标题与团队挂钩。进主界面后顶部有
   * 「当前助手」横滑条可切换对话成员（对齐桌面端）。
   */
  const handleStartTeamChat = useCallback(
    async (team: TeamRow): Promise<void> => {
      const members = team.members ?? [];
      const entry = members.find((m) => m.isManager === 1) ?? members[0];
      if (!entry?.agentId) {
        setError('这个团队还没有成员，无法开始对话');
        return;
      }
      const gatewayId = useUiStore.getState().defaultGatewayId || team.gatewayId || '';
      if (!gatewayId) {
        setError('网关未就绪，无法开始对话');
        return;
      }
      await ensureHydrationReady();
      useTaskStore.getState().startNewTask({ gatewayId, agentId: entry.agentId, teamId: team.id });
      onClose();
    },
    [onClose],
  );

  const submit = async (): Promise<void> => {
    const token = await gatewayToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const response = await mobileFetch('/api/mobile/teams/create', token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          teamName: teamName.trim(),
          description: teamDescription.trim(),
          members: members
            .filter((m) => m.name.trim() || m.position.trim())
            .map((m) => ({
              name: (m.name.trim() || m.position.trim()),
              position: m.position.trim() || m.name.trim(),
              role: m.role,
              skills: m.skills,
              identity: buildIdentity(teamName.trim(), m),
            })),
        }),
      });
      const data = (await response.json()) as { members?: CreateResult[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setResults(data.members ?? []);
      setNotice('已提交创建，正在同步团队列表');
      await loadTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="module-sheet fixed inset-0 z-[60] flex flex-col" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <header className="safe-area-top flex shrink-0 items-center gap-2 px-3 py-2">
        <button
          onClick={onClose}
          aria-label={t('files.close')}
          className="rounded-lg p-2"
          style={{ color: 'var(--text-secondary)', minHeight: 44, minWidth: 44 }}
        >
          <ArrowLeft size={20} />
        </button>
        <p className="type-label min-w-0 flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
          {t('modules.team')}
        </p>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 type-support"
          style={{ backgroundColor: 'var(--accent-dim)', color: 'var(--accent)', minHeight: 36 }}
        >
          <Plus size={14} />
          创建团队
        </button>
      </header>

      <div className="flex shrink-0 gap-2 px-3 pb-2">
        {(
          [
            ['mine', '我的团队'],
            ['hub', 'TeamsHub'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="type-support rounded-full px-3 py-1"
            style={{
              backgroundColor: tab === key ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
              color: tab === key ? 'var(--accent)' : 'var(--text-secondary)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-8">
        {tab === 'hub' ? (
          <p className="type-body py-10 text-center" style={{ color: 'var(--text-muted)' }}>
            团队模板库请在电脑端浏览与下载（需要写入本机助手工作区）
          </p>
        ) : (
          <>
            {teams === null && (
              <div className="flex justify-center py-10">
                <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
              </div>
            )}

            {error && (
              <p className="type-body my-3 rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}>
                {error}
              </p>
            )}

            {notice && (
              <p className="type-support my-2 px-1" style={{ color: 'var(--accent)' }}>
                {notice}
              </p>
            )}

            {teams !== null && teams.length === 0 && !error && (
              <div className="flex flex-col items-center justify-center py-16">
                <div
                  className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
                  style={{ backgroundColor: 'var(--bg-tertiary)' }}
                >
                  <Users size={26} style={{ color: 'var(--text-muted)' }} />
                </div>
                <p className="type-section-title" style={{ color: 'var(--text-primary)' }}>
                  还没有团队
                </p>
                <p className="type-body mt-1" style={{ color: 'var(--text-muted)' }}>
                  创建一个团队以开始
                </p>
                <p className="type-support mt-3 max-w-xs text-center" style={{ color: 'var(--text-muted)' }}>
                  创建团队后，这里会按五个岗位显示真实的协作状态。
                </p>
                <div className="mt-5 flex gap-3">
                  <button
                    onClick={() => setCreating(true)}
                    className="type-body flex items-center gap-1.5 rounded-xl px-4 py-2"
                    style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
                  >
                    <Sparkles size={14} />
                    AI 创建
                  </button>
                  <button
                    onClick={() => setCreating(true)}
                    className="type-body flex items-center gap-1.5 rounded-xl px-4 py-2"
                    style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)' }}
                  >
                    <Plus size={14} />
                    创建团队
                  </button>
                </div>
              </div>
            )}

            {(teams ?? []).map((team) => (
              <div
                key={team.id}
                className="ui-card mt-2 px-3 py-3"
              >
                <button
                  onClick={() => void handleStartTeamChat(team)}
                  className="flex w-full items-start gap-3 text-left"
                  aria-label={`开始与 ${team.name} 对话`}
                >
                  <span className="text-xl" aria-hidden="true">
                    {team.emoji || '👥'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="type-body truncate" style={{ color: 'var(--text-primary)' }}>
                      {team.name}
                    </p>
                    {team.description && (
                      <p className="type-support line-clamp-2 mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {team.description}
                      </p>
                    )}
                  </div>
                  <span className="type-support shrink-0" style={{ color: 'var(--text-muted)' }}>
                    {team.memberCount ?? 0} 成员
                  </span>
                </button>

                {(team.members ?? []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(team.members ?? []).map((member) => (
                      <span
                        key={member.agentId}
                        className="type-support rounded px-1.5 py-0.5"
                        style={{
                          backgroundColor: 'var(--bg-tertiary)',
                          color: member.isManager ? 'var(--accent)' : 'var(--text-secondary)',
                        }}
                      >
                        {member.agentId}
                        {member.role ? ` · ${member.role}` : ''}
                      </span>
                    ))}
                  </div>
                )}

                <button
                  onClick={() => void handleStartTeamChat(team)}
                  className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 type-body"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)', minHeight: 40 }}
                >
                  <MessageSquare size={14} />
                  开始对话
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      {/* ── 创建团队面板：名称 + 岗位（可增删）→ 真建 agent + 写 IDENTITY.md ── */}
      {creating && (
        <div className="absolute inset-0 z-10 flex flex-col" style={{ backgroundColor: 'var(--bg-primary)' }}>
          <header className="safe-area-top flex shrink-0 items-center gap-2 px-3 py-2">
            <button
              onClick={() => {
                setCreating(false);
                setResults(null);
              }}
              aria-label={t('files.close')}
              className="rounded-lg p-2"
              style={{ color: 'var(--text-secondary)', minHeight: 44, minWidth: 44 }}
            >
              <X size={20} />
            </button>
            <p className="type-label flex-1" style={{ color: 'var(--text-primary)' }}>
              创建团队
            </p>
          </header>

          <div className="flex-1 overflow-y-auto px-3 pb-28">
            <label className="type-support" style={{ color: 'var(--text-muted)' }}>
              团队名称
            </label>
            <input
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
              placeholder="例如：内容增长小队"
              className="ui-card mt-1 w-full px-3 type-body outline-none"
              style={{ color: 'var(--text-primary)', minHeight: 44, borderRadius: 14 }}
            />

            <label className="mt-3 block type-support" style={{ color: 'var(--text-muted)' }}>
              团队描述（TEAM.md）
            </label>
            <textarea
              value={teamDescription}
              onChange={(event) => setTeamDescription(event.target.value)}
              placeholder="这个团队是干什么的、边界在哪"
              rows={3}
              className="ui-card mt-1 w-full resize-none px-3 py-2 type-support outline-none"
              style={{ color: 'var(--text-secondary)', borderRadius: 14 }}
            />

            <div className="mt-4 flex items-center justify-between">
              <p className="type-support" style={{ color: 'var(--text-muted)' }}>
                智能体（{members.length}）
              </p>
              <button
                onClick={() =>
                  setMembers((prev) => [
                    ...prev,
                    { position: '领域专家', name: '', role: 'executor', duties: '', skills: [] },
                  ])
                }
                className="type-support flex items-center gap-1 rounded-lg px-2 py-1"
                style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              >
                <Plus size={12} />
                加一个
              </button>
            </div>

            {members.map((member, index) => (
              <div key={index} className="ui-card mt-2 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <input
                    value={member.position}
                    onChange={(event) =>
                      setMembers((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, position: event.target.value } : item)),
                      )
                    }
                    placeholder="职位（如：主持人）"
                    className="w-24 shrink-0 bg-transparent type-support outline-none"
                    style={{ color: 'var(--text-muted)' }}
                  />
                  <input
                    value={member.name}
                    onChange={(event) =>
                      setMembers((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)),
                      )
                    }
                    placeholder="智能体名称"
                    className="min-w-0 flex-1 bg-transparent type-body outline-none"
                    style={{ color: 'var(--text-primary)' }}
                  />
                  {members.length > 1 && (
                    <button
                      onClick={() => setMembers((prev) => prev.filter((_, i) => i !== index))}
                      aria-label="删除智能体"
                      className="rounded p-1"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>

                <div className="mt-1.5 flex gap-1.5">
                  {(
                    [
                      ['coordinator', '协调者'],
                      ['executor', '执行者'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() =>
                        setMembers((prev) => prev.map((item, i) => (i === index ? { ...item, role: key } : item)))
                      }
                      className="type-support rounded-full px-2 py-0.5"
                      style={{
                        backgroundColor: member.role === key ? 'var(--accent)' : 'var(--bg-tertiary)',
                        color: member.role === key ? 'var(--accent-foreground)' : 'var(--text-muted)',
                        fontWeight: member.role === key ? 600 : 400,
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <textarea
                  value={member.duties}
                  onChange={(event) =>
                    setMembers((prev) =>
                      prev.map((item, i) => (i === index ? { ...item, duties: event.target.value } : item)),
                    )
                  }
                  placeholder="职责：这个人负责什么（写进 IDENTITY.md）"
                  rows={2}
                  className="mt-1 w-full resize-none bg-transparent type-support outline-none"
                  style={{ color: 'var(--text-secondary)' }}
                />

                {/* 技能 —— 对齐桌面端 AgentDraftCard 的 skills 勾选 */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {member.skills.length > 0 &&
                    member.skills.map((slug) => (
                      <span
                        key={slug}
                        className="type-support inline-flex items-center gap-1 rounded-full px-2 py-0.5"
                        style={{ backgroundColor: 'var(--accent-dim)', color: 'var(--accent)' }}
                      >
                        {slug}
                        <button
                          onClick={() => toggleSkill(index, slug)}
                          aria-label="移除技能"
                          className="inline-flex"
                          style={{ color: 'var(--accent)' }}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  <button
                    onClick={() => setSkillPickerFor(index)}
                    className="type-support inline-flex items-center gap-1 rounded-full px-2 py-0.5"
                    style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                  >
                    <Wrench size={10} />
                    + 技能
                  </button>
                </div>
              </div>
            ))}

            {results && (
              <div className="mt-4">
                <p className="type-support" style={{ color: 'var(--text-muted)' }}>
                  创建结果
                </p>
                {results.map((result) => (
                  <p
                    key={result.name}
                    className="type-support mt-1"
                    style={{ color: result.ok ? 'var(--accent)' : 'var(--danger)' }}
                  >
                    {result.ok ? (result.reused ? '↻' : '✓') : '✗'} {result.name}
                    {result.agentId ? ` · ${result.agentId}` : ''}
                    {result.reused ? ' · 已存在，已加入团队' : ''}
                    {result.error ? ` · ${result.error}` : ''}
                    {result.skillWarnings ? ` · ${result.skillWarnings.join('; ')}` : ''}
                  </p>
                ))}
              </div>
            )}
          </div>

          {/* ── 技能选择 sheet：给单个智能体绑技能（对齐桌面端 AgentDraftCard 的 skills 勾选） ── */}
          {skillPickerFor !== null && (
            <div className="absolute inset-0 z-20 flex flex-col" style={{ backgroundColor: 'var(--bg-primary)' }}>
              <header className="safe-area-top flex shrink-0 items-center gap-2 px-3 py-2">
                <button
                  onClick={() => setSkillPickerFor(null)}
                  aria-label="关闭"
                  className="rounded-lg p-2"
                  style={{ color: 'var(--text-secondary)', minHeight: 44, minWidth: 44 }}
                >
                  <ArrowLeft size={20} />
                </button>
                <p className="type-label flex-1" style={{ color: 'var(--text-primary)' }}>
                  选择技能
                </p>
                <p className="type-support shrink-0" style={{ color: 'var(--text-muted)' }}>
                  已选 {(members[skillPickerFor]?.skills ?? []).length}
                </p>
              </header>

              <div
                className="mx-3 flex shrink-0 items-center gap-2 rounded-xl px-3"
                style={{ backgroundColor: 'var(--bg-secondary)', minHeight: 44 }}
              >
                <Search size={15} style={{ color: 'var(--text-muted)' }} />
                <input
                  value={skillQuery}
                  onChange={(event) => setSkillQuery(event.target.value)}
                  placeholder="搜索技能"
                  className="min-w-0 flex-1 bg-transparent type-support outline-none"
                  style={{ color: 'var(--text-primary)' }}
                />
              </div>

              <div className="flex-1 overflow-y-auto px-3 pb-10 pt-2">
                {skillLoading && (
                  <div className="flex justify-center py-10">
                    <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
                  </div>
                )}

                {skillError && (
                  <p className="type-support my-3 rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}>
                    {skillError}
                  </p>
                )}

                {!skillLoading && !skillError && (
                  <div className="flex flex-col gap-2">
                    {filteredSkills.map((skill) => {
                      const selected = (members[skillPickerFor]?.skills ?? []).includes(skill.slug);
                      return (
                        <button
                          key={skill.slug}
                          onClick={() => toggleSkill(skillPickerFor, skill.slug)}
                          className="ui-card flex items-start gap-2.5 rounded-2xl px-3.5 py-3 text-left"
                          style={{ borderColor: selected ? 'var(--accent)' : undefined }}
                        >
                          <span className="text-[20px] leading-none" aria-hidden="true">
                            {skill.emoji ?? '🧩'}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="min-w-0 flex-1 truncate type-body" style={{ color: 'var(--text-primary)' }}>
                                {skill.name || skill.slug}
                              </span>
                              {selected && (
                                <span
                                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                                  style={{ backgroundColor: 'var(--accent)' }}
                                >
                                  <Check size={12} style={{ color: 'var(--accent-foreground)' }} />
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 line-clamp-2 type-support" style={{ color: 'var(--text-muted)' }}>
                              {skill.description ?? skill.slug}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {!skillLoading && !skillError && filteredSkills.length === 0 && (
                  <p className="type-body py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                    没有匹配的技能
                  </p>
                )}
              </div>

              <div
                className="absolute inset-x-0 bottom-0 px-3 pb-3 pt-2"
                style={{
                  backgroundColor: 'color-mix(in srgb, var(--bg-primary) 88%, transparent)',
                  backdropFilter: 'blur(14px)',
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                <button
                  onClick={() => setSkillPickerFor(null)}
                  className="flex w-full items-center justify-center rounded-xl py-3 type-label"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)', minHeight: 46 }}
                >
                  完成
                </button>
              </div>
            </div>
          )}

          <div
            className="absolute inset-x-0 bottom-0 px-3 pb-3 pt-2"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--bg-primary) 88%, transparent)',
              backdropFilter: 'blur(14px)',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <button
              onClick={() => void submit()}
              disabled={busy || !teamName.trim()}
              className="composer-send flex w-full items-center justify-center gap-1.5 rounded-xl py-3 type-label disabled:opacity-40"
              style={{ minHeight: 46 }}
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />}
              {busy ? '正在创建…' : '创建团队'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

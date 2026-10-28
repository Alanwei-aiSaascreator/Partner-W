import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Pencil, RotateCcw, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import SectionCard from '@/components/semantic/SectionCard';
import { toast } from '@/lib/toast';
import { useUiStore } from '@/stores/uiStore';
import { useSelectAgent } from '@/hooks/useSelectAgent';
import { fetchAgentsForGateway } from '@/hooks/useGatewayBootstrap';
import AgentMissingNotice from '@/components/AgentMissingNotice';
import PortraitRadar from '@/components/PortraitRadar';
import { displayPortraitLetters } from '@/lib/user-portrait';
import { mbtiCardArtworkFor } from '@/lib/mbti-artwork';
import { portraitArtworkFor } from '@/lib/portrait-artwork';
import type { OnboardingProfile } from '@/lib/user-onboarding';
import { resolveRequestedAgentForAction } from '@/lib/requested-agent';
import { PRESET_AGENT_DEFINITIONS, STARTER_AGENT_BY_ID, resolveAssistantWorkspace } from '@/lib/preset-agents';
import type { StarterId } from '@/lib/user-onboarding';
import {
  IDENTITY_DEFAULT_TAGS,
  IDENTITY_PERSONA_TAGS,
  USER_MD_MAX_CHARS,
  buildIdentityBlock,
  mergeIdentityIntoUserMd,
  nextTagSelection,
  readStoredIdentityTags,
  saveStoredIdentityTags,
  userMdContentFromReadResult,
  type IdentityTagId,
} from '@/lib/identity-persona';
import { buildIndustryBriefing, buildIndustryBriefingDisplay, resolveIndustryMethod } from '@/lib/industry-method';

/**
 * 个性化中心（v3，2026-10-06；原名「身份中心」）。
 *
 * ## 为什么改
 *
 * v2 把六个预置能力（内容/拍摄/办公/电商/研究/家庭）做成了**七张可点的客群卡**，
 * "选客群 = 选身份"——那六个其实是 **Skill（能力）**，不是身份。于是这一版把
 * 身份选择整块拿掉，页面变成"你的东西放给你看"的五个区块：
 *
 * | 区块 | 内容 | 交互 |
 * | --- | --- | --- |
 * | ① 我的画像 | 六角色立绘 + 名字/描述 + 趣味四字码 + 五维雷达 | 只读（数据来自首跑） |
 * | ② 我的工作身份 | 昵称 / 岗位 / 主营行业 | 只读（编辑走「编辑我的资料」） |
 * | ③ 我的 AI 团队 | 主罗盘 + 五岗位静态名单 | 无 |
 * | ④ 我的常用技能 | 六类能力 → 技能标签（六组 × 每组四条） | **无**（不是身份选择） |
 * | ⑤ 我的偏好 | 五个画像标签 | 可改（喂给下方保存） |
 *
 * ## 保住的既有行为（不许破）
 *
 * 底部「保存并应用」= 把身份块**合并写进每个助手的 `USER.md`**（各读各的、各写各的；
 * 超限一个字不写、部分失败如实报几个没写成），写前先过"点名的助手不在本机"的判据
 * （`resolveRequestedAgentForAction`，不静默换人）。拿掉的只是六张卡的选中/切换交互与
 * 「用它开任务」出口 —— 它们服务的"选身份"已经不存在了。
 *
 * ⚠️ 读回载荷是 `result.file.content`（**不是** `result.content`）—— 2026-10-07 体检问题 1
 *    抓到的字段错位会"恒读成空串"，把用户记忆整份覆盖；`userMdContentFromReadResult`
 *    （`lib/identity-persona.ts`）是这一页唯一的读法，读不出来就跳过、绝不写回。
 */

/** 团队结构的五个岗位（显示名）。本页只做静态名单，团队运行细节在「我的 AI 团队」页。 */
const TEAM_POSITION_IDS = ['researcher', 'analyst', 'creator', 'producer', 'inspector'] as const;

interface IdentityCenterProps {
  /** 首跑向导落盘的档案（`App.tsx` → `MainArea` → 这里）。没有档案时画像块显示空态。 */
  profile?: OnboardingProfile | null;
  /**
   * 「编辑我的资料」入口 → App 的 onboarding edit 模式（`setEditingOnboardingProfile(true)`）。
   * ⚠️ 可选：不传就不渲染这个入口（这一页的既有测试都是 `<IdentityCenter />` 直挂）。
   */
  onEditProfile?: () => void;
}

export default function IdentityCenter({ profile = null, onEditProfile }: IdentityCenterProps) {
  const { t } = useTranslation();
  const gatewayId = useUiStore((s) => s.defaultGatewayId);
  const selectAgent = useSelectAgent();
  /**
   * 档案的 userId = 这台机器上当前的账号（App 加载档案时用的就是它）。
   * 偏好标签的本地回读缓存按它分键 —— 换账号不会读到上一位用户的勾选。
   */
  const userId = profile?.userId ?? null;
  /**
   * ⚠️ 进页面先**回读上次保存的标签**（2026-10-07 体检问题 4）：以前恒从
   *    `IDENTITY_DEFAULT_TAGS` 起步，重进一次页面再保存 = 静默把用户的勾选改回默认四个。
   */
  const [selected, setSelected] = useState<IdentityTagId[]>(
    () => readStoredIdentityTags(userId) ?? IDENTITY_DEFAULT_TAGS,
  );
  /** ① 立绘坏图降级（素材在、内容坏 ⇒ 回占位，与 `PortraitCard` 同一条路）。 */
  const [artworkFailed, setArtworkFailed] = useState(false);
  /** ① 16 型全身卡坏图降级（⇒ 退回六角色立绘，再坏才占位）。 */
  const [mbtiArtworkFailed, setMbtiArtworkFailed] = useState(false);
  /** 目录**已加载**但点名的助手不在里面时，提示里要显示的 id（`null` = 没有这回事）。 */
  const [missingAgentId, setMissingAgentId] = useState<string | null>(null);
  const catalogEntry = useUiStore((s) => (gatewayId ? s.agentCatalogByGateway[gatewayId] : undefined));
  const setMainView = useUiStore((s) => s.setMainView);
  const selectedAgentByGateway = useUiStore((s) => s.selectedAgentByGateway);

  /**
   * 当前助手 = 应用里**正在用的那个**（与左侧「我的助手」同一份状态）。
   * 「保存并应用」最后"切到它"用的是这个 —— 不另立一份选择状态。
   * ⚠️ 它**不再**是身份块里的"客群"（那是用户自己的行业/岗位，见 `groupLabel`）。
   */
  const currentAgentId =
    (gatewayId ? selectedAgentByGateway[gatewayId] : undefined) || catalogEntry?.defaultId || 'main';
  const compassWorkspace = resolveAssistantWorkspace('main')!;

  const tagLabels = selected.map((id) => t(`identity.tag.${id}`));
  /** ② 的三个展示值（缺档案显示 —）。身份块的「客群」也从它们来。 */
  const nickname = profile?.nickname?.trim() || '—';
  const roleLabel = profile
    ? profile.role === 'custom' && profile.customRole
      ? profile.customRole
      : t(`onboarding.roles.${profile.role ?? 'custom'}.title`)
    : '—';
  const industryLabel = profile?.industry
    ? t(`onboarding.firstRun.industries.${profile.industry.code ?? 'general'}`)
    : '—';
  const introduction = profile?.introduction?.trim() ?? '';
  /**
   * ⭐ N2（2026-10-16）**「用户确认过的团队」的真实消费者在这里**。
   *
   * `selectedAssistantIds` 是首跑「团队确认」那一步用户勾选并落盘的名单（`StarterId`）。
   * 在此之前它只写不读：这一页把六个能力组静态列全，用户看不到自己确认过谁。
   *
   * 语义边界（`PRODUCT_ARCHITECTURE.md` §1）：它属于 **Skill 能力层**（六个能力组），
   * **不是** 执行结构（主罗盘 + 五岗位）。所以：
   *   - §③「我的 AI 团队」用它只**提一句**（清楚标明是能力），岗位名单一个字不动；
   *   - §④「我的常用技能」用它把对应的能力组标出来（名单真正的归属层）。
   * 没有档案 / 没确认过 ⇒ 两个地方都不渲染、不编默认值。
   */
  const confirmedSkillIds: StarterId[] = (profile?.selectedAssistantIds ?? []).filter((id): id is StarterId =>
    Boolean(STARTER_AGENT_BY_ID[id]),
  );
  /** starter → 六能力组的 preset id（§④ 的 `data-skill-group` 用的是 preset id 映射后的 workspaceKey）。 */
  const confirmedPresetIds = new Set(confirmedSkillIds.map((id) => STARTER_AGENT_BY_ID[id]));
  /**
   * 行业方法那三行（2026-10-16，全量总单第 23 行）。
   *
   * ⚠️ **不缓存、不另存一份**：每次都从首跑档案的行业现算，档案改了它跟着改。
   *    这就是"选行业真的影响了产出"的那条链：`profile.industry` → 这三行 →
   *    每个助手的 `USER.md` → 每轮全文注入的提示词。
   * `null`（没选行业 / 选的是「暂不确定」）⇒ 空数组 ⇒ 身份块一个字都不加。
   */
  const industryLines = buildIndustryBriefing(resolveIndustryMethod(profile?.industry), t) ?? [];
  /**
   * 界面上那三行的**本地化标签 + 正文**（2026-10-16，T32）。正文与上面 `industryLines`
   * 写的**逐字相同**（同一份算法），只有标签按当前语言走 —— 修掉"英文界面上屏中文前缀"。
   */
  const industryDisplay = buildIndustryBriefingDisplay(resolveIndustryMethod(profile?.industry), t) ?? [];
  /**
   * 身份块里的「客群」= **用户自己的行业 · 岗位**（首跑档案），不是当前助手的名字。
   * 2026-10-07 体检问题 10：旧值 `t(workspace.titleKey)` 把"客群：内容助手"写进了
   * **每个**助手的 `USER.md`（六份提示词都在说"你服务的是内容助手"）。
   * 没有档案时如实写「未配置」—— 不拿助手名顶上。
   */
  const groupLabel =
    [industryLabel !== '—' ? industryLabel : '', roleLabel !== '—' ? roleLabel : ''].filter(Boolean).join(' · ') ||
    t('common.notConfigured');

  /**
   * ⭐ **判据只此一处**（2026-09-29）：目录**已加载**、而点名的助手不在里面 ⇒
   * 如实说明，并且**不做那件事**（不切、不开任务）。返回 `true` = 已被拒绝。
   * 目录 `loading` 也不是放行证：必须强制刷新一次，重读 store 里的权威目录。
   */
  const refuseIfAgentUnavailable = useCallback(
    async (agentId: string): Promise<boolean> => {
      if (!gatewayId) return true;
      const decision = await resolveRequestedAgentForAction({
        requestedAgentId: agentId,
        readCatalog: () => useUiStore.getState().agentCatalogByGateway[gatewayId],
        refresh: () => fetchAgentsForGateway(gatewayId, { force: true }),
      });
      if (decision === 'ok') {
        setMissingAgentId(null);
        return false;
      }
      if (decision === 'missing') {
        setMissingAgentId(agentId);
      } else {
        setMissingAgentId(null);
        toast.error(t('errors.failed'));
      }
      return true;
    },
    [gatewayId, t],
  );

  const applyPersona = useCallback(async (): Promise<boolean> => {
    if (!gatewayId) {
      toast.error(t('identity.applyFailed'));
      return false;
    }
    if (await refuseIfAgentUnavailable(currentAgentId)) return false;
    setMissingAgentId(null);
    selectAgent(currentAgentId);
    return true;
  }, [gatewayId, currentAgentId, refuseIfAgentUnavailable, selectAgent, t]);

  const toggleTag = (id: IdentityTagId) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  /**
   * 「保存并应用」= 切助手 + **把身份写进每个助手的记忆**（`USER.md`）。
   *
   * ⚠️ 每个助手**各读各的、各写各的**：记忆页那种"读第一个、写给全部"在这里会把
   *    别的助手自己写的记忆冲掉 —— 那是不可逆的损坏，不是省一次调用。
   * ⚠️ 写在前、切在后：切助手会把主区切走（页面卸载），先写才不会半途而废。
   * ⚠️ 部分失败/超限**如实报**（几个没写成、超了上限），**不许**报"已保存"。
   * ⚠️ 目录还没拉回来时**先强制刷新一次**再判"有没有助手"：这一页原来的刷新入口是
   *    「应用此画像」那颗按钮（v3 已移除），不补这一步就会把 loading 误报成
   *    "盘上一个助手都没有"（本项目栽过"把不确定说成确定"）。
   */
  const onSave = useCallback(() => {
    if (selected.length === 0) {
      toast.error(t('identity.needTag'));
      return;
    }
    if (!gatewayId) {
      toast.error(t('identity.applyFailed'));
      return;
    }
    const block = buildIdentityBlock({ groupLabel, tagLabels, introduction, industryLines });

    void (async () => {
      let entry = catalogEntry;
      if (!entry) {
        await fetchAgentsForGateway(gatewayId, { force: true });
        entry = useUiStore.getState().agentCatalogByGateway[gatewayId];
      }
      const agents = entry?.agents ?? [];
      if (agents.length === 0) {
        toast.error(t('settings.memoryNoAgents'));
        return;
      }

      let failed = 0;
      let overLimit = 0;
      for (const agent of agents) {
        const read = await window.clawwork.getAgentFile(gatewayId, agent.id, 'USER.md');
        /**
         * 🔴 2026-10-07 体检问题 1/2：真机载荷是 `{ file: { content } }`，老写法读
         * `result.content` 恒得空串 ⇒ 合并从空串起算 ⇒ **把用户记忆整份冲掉**。
         * 读不出来（ok=false / 形状不认识）**不当空文件**：计入失败并跳过这个助手，
         * 宁可少写一个，也不写坏一个。
         */
        const existing = read.ok ? userMdContentFromReadResult(read.result) : null;
        if (existing === null) {
          failed += 1;
          continue;
        }
        const merged = mergeIdentityIntoUserMd(existing, block);
        if (!merged.ok) {
          overLimit += 1;
          failed += 1;
          continue;
        }
        const write = await window.clawwork.setAgentFile(gatewayId, agent.id, 'USER.md', merged.content);
        if (!write.ok) failed += 1;
      }

      const applied = await applyPersona();

      // 标签回读缓存：只在**每个助手的 USER.md 都真的写成了**时才记（部分失败不记，
      // 免得下次回读出一个与盘上不一致的选择）。
      if (failed === 0) saveStoredIdentityTags(userId, selected);

      if (overLimit === agents.length) {
        toast.error(t('settings.memoryTooLong', { max: USER_MD_MAX_CHARS }));
        return;
      }
      if (failed > 0) {
        toast.error(t('settings.memorySavePartial', { failed, total: agents.length }));
        return;
      }
      // ⚠️ 2026-10-07 体检问题 12a：`applyPersona` 说了没切成（点名助手不在本机 /
      //    目录刷新失败）就**不许**再报"已保存"。失败原因在那边已经如实给出
      //    （缺失走页内提示，刷新失败走错误 toast），这里只负责闭嘴。
      if (!applied) return;
      toast.success(t('settings.memorySaved', { count: agents.length }));
    })();
  }, [selected, tagLabels, groupLabel, introduction, industryLines, gatewayId, catalogEntry, applyPersona, t, userId]);

  const portrait = profile?.portrait ?? null;
  /**
   * 「我的画像」的形象位（2026-10-08，16 型形象；同日按用户实测反馈调整为**全身卡**）：
   * 完整四字码 + 性别 ⇒ 16 型全身卡（`mbtiCardArtworkFor`，与 `PortraitCard` 同一张）；
   * 否则 ⇒ 六角色立绘（旧链）；再坏图 ⇒ 占位。三级降级都不破图。
   *
   * ⚠️ 这里**不用** 256 的圆头像（`mbtiAvatarArtworkFor`）：那是聊天气泡那颗小圆的料，
   *    摆进本区会变成一个小圆图 + 一大片空白（用户截图实证）。全身卡不裁、不圆。
   */
  const mbtiArtwork =
    portrait && !mbtiArtworkFailed ? mbtiCardArtworkFor(portrait.letters, portrait.gender ?? null) : null;
  const artwork = portrait && !artworkFailed ? portraitArtworkFor(portrait.role) : null;

  return (
    <div data-testid="identity-center" className="flex h-full flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="type-page-title text-[var(--text-primary)]">{t('identity.title')}</h1>
              <p className="type-support mt-1 text-[var(--text-muted)]">{t('identity.subtitle')}</p>
            </div>
            {onEditProfile ? (
              <Button
                variant="outline"
                size="sm"
                className="type-support flex-shrink-0"
                data-action="edit-profile"
                onClick={onEditProfile}
              >
                <Pencil />
                {t('identity.editProfile')}
              </Button>
            ) : null}
          </div>

          {/* ── ① 我的画像：首跑固化的六角色 + 五维雷达，**只读** ── */}
          <SectionCard className="mt-4" title={t('identity.section.profile')} subtitle={t('identity.portraitHint')}>
            <div data-section="profile">
              {portrait ? (
                <div
                  data-field="portrait"
                  data-portrait-role={portrait.role}
                  data-artwork-source={mbtiArtwork ? 'mbti' : artwork ? 'persona' : 'placeholder'}
                  className="grid gap-5 sm:grid-cols-3"
                >
                  <div className="flex items-center justify-center">
                    {/* ⭐ 2026-10-12：与 `PortraitCard` 同一套"装裱"（素材白底=卡面本身；
                        不动素材，见 PortraitCard 的注释）。两处必须同步改。 */}
                    {mbtiArtwork ? (
                      <div className="mx-auto w-full max-w-xs overflow-hidden rounded-xl border border-[var(--border)] shadow-[var(--shadow-card-layered)]">
                        <img
                          data-mbti-artwork
                          src={mbtiArtwork}
                          alt=""
                          onError={() => setMbtiArtworkFailed(true)}
                          className="block h-auto w-full"
                        />
                      </div>
                    ) : artwork ? (
                      <div className="mx-auto w-full max-w-xs overflow-hidden rounded-xl border border-[var(--border)] shadow-[var(--shadow-card-layered)]">
                        <img
                          data-portrait-artwork
                          src={artwork}
                          alt=""
                          onError={() => setArtworkFailed(true)}
                          className="block h-auto w-full"
                        />
                      </div>
                    ) : (
                      <div data-portrait-fallback className="flex flex-col items-center gap-3">
                        <UserRound size={64} className="text-[var(--text-muted)]" />
                        <p className="type-support text-[var(--text-muted)]">
                          {t('onboarding.firstRun.personaUnavailable')}
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="space-y-3 sm:col-span-2">
                    <p data-portrait-role-name className="type-section-title text-[var(--text-primary)]">
                      {t(`onboarding.portrait.roles.${portrait.role}.name`)}
                    </p>
                    <p className="type-support text-[var(--text-secondary)]">
                      {t(`onboarding.portrait.roles.${portrait.role}.description`)}
                    </p>
                    <p className="type-support text-[var(--text-muted)]">
                      {t('onboarding.portrait.letters')}
                      {': '}
                      <span data-portrait-letters className="type-label text-[var(--text-primary)]">
                        {displayPortraitLetters(portrait.letters)}
                      </span>
                    </p>
                    <PortraitRadar axes={portrait.axes} className="mx-auto max-w-xs" />
                  </div>
                </div>
              ) : (
                <p data-field="portrait-empty" className="type-support text-[var(--text-secondary)]">
                  {t('identity.profileEmpty')}
                </p>
              )}
            </div>
          </SectionCard>

          {/* ── ② 我的工作身份：首跑填的三项，只读；改资料走右上角入口 ── */}
          <SectionCard className="mt-3" title={t('identity.section.work')}>
            <div data-section="work" className="grid gap-3 sm:grid-cols-3">
              <div>
                <p className="type-support text-[var(--text-muted)]">{t('identity.nickname')}</p>
                <p data-field="nickname" className="type-label mt-1 break-words text-[var(--text-primary)]">
                  {nickname}
                </p>
              </div>
              <div>
                <p className="type-support text-[var(--text-muted)]">{t('onboarding.firstRun.role')}</p>
                <p data-field="job-role" className="type-label mt-1 break-words text-[var(--text-primary)]">
                  {roleLabel}
                </p>
              </div>
              <div>
                <p className="type-support text-[var(--text-muted)]">{t('onboarding.firstRun.industry')}</p>
                <p data-field="industry" className="type-label mt-1 break-words text-[var(--text-primary)]">
                  {industryLabel}
                </p>
              </div>
              {/* 2026-10-07 体检问题 11：首跑填的「一句话介绍」以前只写不读 —— 这里读回来，
                  和下面的身份块用同一个值（`groupLabel`/`introduction` 同源）。 */}
              <div className="sm:col-span-3">
                <p className="type-support text-[var(--text-muted)]">{t('onboarding.firstRun.introduction')}</p>
                <p data-field="introduction" className="type-label mt-1 break-words text-[var(--text-primary)]">
                  {introduction || '—'}
                </p>
              </div>
              {/* ⭐ 2026-10-16（第 23 行）：把「行业到底影响了什么」摆在台面上。
                  ⚠️ 这里显示的正文**就是**「保存并应用」写进每个助手 `USER.md` 的那三行
                     （同一个算法 `buildIndustryBriefingDisplay`，不是另写一份说明）——
                     否则用户看到的和助手读到的会是两套话。标签按当前语言出（T32：修掉
                     "英文界面上屏中文前缀"）。没选行业时如实说明"不写入"，不留空白。 */}
              <div data-field="industry-method" className="sm:col-span-3">
                <p className="type-support text-[var(--text-muted)]">{t('identity.industryMethod')}</p>
                {industryDisplay.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {industryDisplay.map(({ label, text }) => (
                      <li key={label} className="type-label break-words text-[var(--text-primary)]">
                        {label}
                        {text}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="type-label mt-1 text-[var(--text-muted)]">{t('identity.industryMethodNone')}</p>
                )}
              </div>
            </div>
          </SectionCard>

          {/* ── ③ 我的 AI 团队：主罗盘 + 五岗位（静态名单，不选、不切） ── */}
          <SectionCard className="mt-3" title={t('identity.section.team')}>
            <div data-section="team" className="space-y-2.5">
              <div data-team-member="main" className="flex items-start gap-2.5">
                <span aria-hidden="true" className="type-body leading-none text-[var(--accent)]">
                  {compassWorkspace.emoji}
                </span>
                <div className="min-w-0">
                  <p className="type-label text-[var(--text-primary)]">
                    {t(compassWorkspace.titleKey)}
                    <span className="type-badge ml-2 inline-flex items-center rounded-full bg-[var(--accent-dim)] px-2 py-0.5 text-[var(--accent)]">
                      {t('identity.teamLead')}
                    </span>
                  </p>
                  <p className="type-support mt-0.5 text-[var(--text-muted)]">{t(compassWorkspace.descriptionKey)}</p>
                </div>
              </div>
              {TEAM_POSITION_IDS.map((positionId) => (
                <div key={positionId} data-team-position={positionId} className="flex items-start gap-2.5">
                  <span aria-hidden="true" className="mt-1.5 size-1.5 flex-shrink-0 rounded-full bg-[var(--accent)]" />
                  <div className="min-w-0">
                    <p className="type-label text-[var(--text-primary)]">
                      {t(`identity.teamPosition.${positionId}.name`)}
                    </p>
                    <p className="type-support mt-0.5 text-[var(--text-muted)]">
                      {t(`identity.teamPosition.${positionId}.duty`)}
                    </p>
                  </div>
                </div>
              ))}
              {/* N2：用户**确认过**的能力在这里如实提一句。它们不是岗位（不能混进上面的名单），
                  所以只作为一条独立说明列在末尾；没确认过就一个字都不加。 */}
              {confirmedSkillIds.length > 0 && (
                <div
                  data-confirmed-skills
                  className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 border-t border-[var(--border-subtle)] pt-2.5"
                >
                  <span className="type-support text-[var(--text-muted)]">{t('identity.skillsConfirmed')}</span>
                  {confirmedSkillIds.map((id) => (
                    <span
                      key={id}
                      data-confirmed-skill={id}
                      className="type-badge inline-flex items-center rounded-md bg-[var(--accent-dim)] px-2 py-0.5 text-[var(--accent)]"
                    >
                      {t(`onboarding.firstRun.result.capabilities.${id}`)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </SectionCard>

          {/* ── ④ 我的常用技能：六类能力 = 技能标签（**不是身份选择**，没有点击） ── */}
          <SectionCard className="mt-3" title={t('identity.section.skills')} subtitle={t('identity.skillsHint')}>
            <div data-section="skills" className="grid gap-3 sm:grid-cols-2">
              {PRESET_AGENT_DEFINITIONS.map((preset) => {
                const presetWorkspace = resolveAssistantWorkspace(preset.id);
                if (!presetWorkspace) return null;
                // N2：首跑里用户确认过的能力组在这里标出来（**名单的真实归属层**）。
                const confirmed = confirmedPresetIds.has(preset.id);
                return (
                  <div
                    key={preset.id}
                    data-skill-group={preset.workspaceKey}
                    data-confirmed={confirmed ? 'true' : 'false'}
                    className={
                      'rounded-lg border bg-[var(--bg-secondary)] p-3 ' +
                      (confirmed ? 'border-[var(--accent)]' : 'border-[var(--border-subtle)]')
                    }
                  >
                    <p className="type-label text-[var(--text-primary)]">
                      <span aria-hidden="true" className="mr-1.5">
                        {presetWorkspace.emoji}
                      </span>
                      {t(presetWorkspace.titleKey)}
                      {confirmed && (
                        <Check aria-hidden="true" className="ml-1.5 inline size-3.5 text-[var(--accent)]" />
                      )}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {presetWorkspace.starters.map((starter) => (
                        <span
                          key={starter.id}
                          data-skill={starter.id}
                          className="type-badge inline-flex items-center rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1 text-[var(--text-secondary)]"
                        >
                          {t(starter.titleKey)}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionCard>

          {/* ── ⑤ 我的偏好：五个画像标签（唯一可改的部分，喂给下面的保存） ── */}
          <SectionCard className="mt-3" title={t('identity.section.preferences')}>
            <div data-section="preferences">
              <p className="type-support text-[var(--text-muted)]">{t('identity.tagsLabel')}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {IDENTITY_PERSONA_TAGS.map((id) => {
                  const on = selected.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      data-tag={id}
                      data-selected={on ? 'true' : 'false'}
                      aria-pressed={on}
                      onClick={() => toggleTag(id)}
                      className={
                        'type-badge glow-focus inline-flex items-center rounded-full px-2.5 py-1 transition-colors ' +
                        (on
                          ? 'bg-[var(--accent-dim)] font-semibold text-[var(--accent)]'
                          : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')
                      }
                    >
                      {t(`identity.tag.${id}`)}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="type-support"
                  data-action="reset"
                  onClick={() => setSelected([])}
                >
                  <RotateCcw />
                  {t('identity.reselect')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="type-support"
                  data-action="shuffle"
                  onClick={() => setSelected((prev) => nextTagSelection(prev))}
                >
                  {t('identity.shuffle')}
                </Button>
              </div>
            </div>
          </SectionCard>

          {missingAgentId ? (
            <div className="mt-3">
              <AgentMissingNotice
                agentId={missingAgentId}
                // ⚠️ 罗盘自己也不在目录里时不给这个出口（同 `WelcomeScreen`，复核 M-2）。
                onSwitchAssistant={
                  catalogEntry?.agents.some((agent) => agent.id === 'main')
                    ? () => {
                        setMissingAgentId(null);
                        selectAgent('main');
                      }
                    : undefined
                }
                onOpenTeams={() => setMainView('teams')}
              />
            </div>
          ) : null}
        </div>
      </ScrollArea>

      {/* ── 固定底栏 ── */}
      <div className="flex flex-none items-center gap-3 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-5 py-2">
        <span className="type-support flex-1 text-[var(--text-muted)]">{t('settings.memoryAboutYouHint')}</span>
        <Button size="sm" className="type-support" data-action="save" onClick={onSave}>
          <Check />
          {t('identity.save')}
        </Button>
      </div>
    </div>
  );
}

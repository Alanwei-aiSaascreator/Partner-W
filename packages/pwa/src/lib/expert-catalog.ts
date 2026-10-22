/**
 * 「专家库」的**渲染层投影**（2026-10-16，全量总单第 24 行）。
 *
 * ## 这一层是什么
 *
 * 随包发出去 18 份 Octop 专家技能（`packages/desktop/our-skills/octop-*`），
 * 它们是**随包发给用户的全部专家提示词**。但渲染层**读不到**那个目录
 * （那是主进程的磁盘路径），于是界面上根本没有"专家"这个面 —— 用户只能看到
 * 「技能市场」里一行行待安装的技能，看不到"这些人是谁、能帮我干什么"。
 *
 * 这份目录就是它的一份**只读投影**：把 slug / 名字 / 一句话能力 / 头像字搬进渲染层。
 *
 * ## 三条不许破的纪律
 *
 * 1. **不编造人名与履历。** 专家的"名字"就是技能的 `name`，"能力"就是它的
 *    `description` —— 都是随包内容里**本来就有**的中文。这一层不写"张工，10 年经验"
 *    这类没有出处的话。
 * 2. **不取上游头像。** 上游头像在 `dashboard/public/experts/avatars/`，
 *    **不在**专家库 Apache-2.0 许可目录内（`test/octop-provenance-integrity.test.ts`
 *    写明"本包一个字节都没有取"）。所以卡片的"头像"用的是 SKILL.md frontmatter
 *    自带的那个 emoji，**不引入任何图片素材**，也就没有权利问题。
 * 3. **它是投影，不是第二个真源。** 改 SKILL.md 不回填这里 ⇒
 *    `test/expert-catalog.test.ts` 会红（它拿**产品解析器**逐条比对磁盘）。
 *
 * ## 为什么名字不写成 i18n 键
 *
 * 与「技能市场」同一个既有口径（见 `OurSkillEntry` 的注释）：
 * **技能自带内容，不随界面语言变**。翻译一份中文技能名只会让"界面上的名字"和
 * "助手实际读到的技能名"对不上。界面的**外壳文案**（标题、提示、按钮）才走 i18n。
 */

export const EXPERT_DOMAINS = ['engineering', 'design', 'knowledge', 'news'] as const;
export type ExpertDomain = (typeof EXPERT_DOMAINS)[number];

/**
 * 领域 ← slug 前缀。**领域不是第五张手工表**：它由 slug 前缀推出来，
 * 这样"新增一个 `octop-design-*` 技能"不可能被漏掉领域。
 */
export const DOMAIN_PREFIXES: Record<ExpertDomain, readonly string[]> = {
  engineering: ['octop-engineering-'],
  design: ['octop-design-'],
  knowledge: ['octop-knowledge-'],
  news: ['octop-news-'],
};

export interface ExpertEntry {
  /** 稳定 id —— 与随包技能 slug 一一对应（专家 = 这份技能背后的人）。 */
  id: string;
  skillSlug: string;
  domain: ExpertDomain;
  /** 卡片头像上的那个字（SKILL.md frontmatter 的 emoji）。 */
  glyph: string;
  /** 内容自带语言（见文件头「为什么名字不写成 i18n 键」）。 */
  name: string;
  /** 一句话能力 —— SKILL.md 的 description。 */
  capability: string;
}

/**
 * 18 位专家。顺序 = 领域顺序，领域内按 slug 升序（**确定性**：卡片顺序不许每次刷新都变）。
 *
 * ⚠️ 逐条与 `our-skills/<slug>/SKILL.md` 的 frontmatter 相等，由
 *    `test/expert-catalog.test.ts` 用产品解析器比对；改技能正文就要回来改这里。
 */
export const EXPERT_CATALOG: readonly ExpertEntry[] = [
  {
    id: 'octop-engineering-architecture',
    skillSlug: 'octop-engineering-architecture',
    domain: 'engineering',
    glyph: '🛠️',
    name: '架构决策记录',
    capability: '需要比较技术方案、评审架构提案或记录设计决策时使用：明确约束、比较成本与复杂度、写出ADR及后续验证点。',
  },
  {
    id: 'octop-engineering-code-review',
    skillSlug: 'octop-engineering-code-review',
    domain: 'engineering',
    glyph: '🛠️',
    name: '代码变更审查',
    capability:
      '审查用户提供的diff、文件或PR，检查正确性、安全边界、性能与可维护性，输出有文件行号、可达触发及验证依据的问题。',
  },
  {
    id: 'octop-engineering-debug',
    skillSlug: 'octop-engineering-debug',
    domain: 'engineering',
    glyph: '🛠️',
    name: '结构化故障调试',
    capability:
      '行为偏离预期、错误堆栈或环境差异难以定因时，按复现、隔离、诊断和修复建议推进，以最小实验定位根因并设计回归测试。',
  },
  {
    id: 'octop-engineering-deploy-checklist',
    skillSlug: 'octop-engineering-deploy-checklist',
    domain: 'engineering',
    glyph: '🛠️',
    name: '发布前核验清单',
    capability:
      '准备发布或涉及数据库迁移、功能开关、破坏性API变更时，生成发布前中后核验与回滚判据，只提供清单和建议，不授权部署。',
  },
  {
    id: 'octop-engineering-documentation',
    skillSlug: 'octop-engineering-documentation',
    domain: 'engineering',
    glyph: '🛠️',
    name: '技术文档编写',
    capability:
      '编写或维护README、API说明、Runbook、架构文档与入职指南；依据实际代码和证据组织面向读者的可验证步骤，不虚构接口与执行结果。',
  },
  {
    id: 'octop-engineering-incident-response',
    skillSlug: 'octop-engineering-incident-response',
    domain: 'engineering',
    glyph: '🛠️',
    name: '事故响应与复盘',
    capability:
      '针对告警、服务异常或事故复盘，整理分级、影响、沟通草稿、缓解建议、时间线及无责复盘；不自动执行生产处置或发送通知。',
  },
  {
    id: 'octop-engineering-system-design',
    skillSlug: 'octop-engineering-system-design',
    domain: 'engineering',
    glyph: '🛠️',
    name: '系统设计分析',
    capability:
      '从需求与约束设计系统、服务边界、API和数据模型，分析容量、可靠性与方案权衡，输出明确假设、图示及后续验证点。',
  },
  {
    id: 'octop-engineering-tech-debt',
    skillSlug: 'octop-engineering-tech-debt',
    domain: 'engineering',
    glyph: '🛠️',
    name: '技术债盘点',
    capability:
      '盘点代码健康与维护积压，按代码、架构、测试、依赖、文档和基础设施分类，对影响、风险、工作量评分并制定分阶段治理建议。',
  },
  {
    id: 'octop-engineering-testing-strategy',
    skillSlug: 'octop-engineering-testing-strategy',
    domain: 'engineering',
    glyph: '🛠️',
    name: '测试策略设计',
    capability:
      '为功能或系统制定测试策略，平衡覆盖、速度和维护成本，按组件选择单元、集成、契约和E2E测试，列出关键反例及现有覆盖缺口。',
  },
  {
    id: 'octop-design-accessibility-review',
    skillSlug: 'octop-design-accessibility-review',
    domain: 'design',
    glyph: '🎨',
    name: '设计无障碍审查',
    capability: '在审查页面、截图或设计稿的对比度、键盘导航、焦点、表单标签与读屏可用性，或准备无障碍交接清单时使用。',
  },
  {
    id: 'octop-design-design-critique',
    skillSlug: 'octop-design-design-critique',
    domain: 'design',
    glyph: '🎨',
    name: '设计稿结构化评审',
    capability:
      '当用户要求点评设计稿、页面或交互流程，检查可用性、视觉层级、一致性与无障碍，或按探索、细化、交付阶段给出设计反馈时使用。',
  },
  {
    id: 'octop-design-design-handoff',
    skillSlug: 'octop-design-design-handoff',
    domain: 'design',
    glyph: '🎨',
    name: '设计开发交接',
    capability:
      '当设计准备交给开发，需要整理布局、设计变量、组件属性、交互状态、响应式规则、边界情况与动效规格时使用。',
  },
  {
    id: 'octop-design-design-system',
    skillSlug: 'octop-design-design-system',
    domain: 'design',
    glyph: '🎨',
    name: '设计系统审计与规范',
    capability: '当用户要审计组件命名与硬编码样式、补充组件变体和状态文档，或设计符合现有体系的新模式时使用。',
  },
  {
    id: 'octop-design-research-synthesis',
    skillSlug: 'octop-design-research-synthesis',
    domain: 'design',
    glyph: '🎨',
    name: '用户研究资料综合',
    capability:
      '当已有访谈记录、问卷数据、可用性测试笔记、支持反馈或满意度材料，需要提炼主题、证据、用户分群与优先建议时使用。',
  },
  {
    id: 'octop-design-user-research',
    skillSlug: 'octop-design-user-research',
    domain: 'design',
    glyph: '🎨',
    name: '用户研究计划与访谈',
    capability:
      '当用户需要制定研究问题、选择方法、设计访谈提纲或问卷、规划可用性测试，或整理研究执行与分析方案时使用。',
  },
  {
    id: 'octop-design-ux-copy',
    skillSlug: 'octop-design-ux-copy',
    domain: 'design',
    glyph: '🎨',
    name: '界面微文案设计',
    capability:
      '当用户需要编写或审查按钮、错误提示、空状态、确认弹窗、加载反馈、提示文本和引导文案，或统一产品语气与术语时使用。',
  },
  {
    id: 'octop-knowledge-wiki',
    skillSlug: 'octop-knowledge-wiki',
    domain: 'knowledge',
    glyph: '🗂️',
    name: '可追溯知识库',
    capability:
      '用户明确要把资料整理成持续维护的知识库、向既有知识库添加来源、带出处查询或检查知识冲突时使用；普通聊天不自动归档。',
  },
  {
    id: 'octop-news-brief',
    skillSlug: 'octop-news-brief',
    domain: 'news',
    glyph: '📰',
    name: '有来源热点简报',
    capability:
      '用户要热点简报、行业动态、指定平台新闻或跨来源趋势分析时使用；无法实时检索时只分析用户提供的资料并标明时效。',
  },
];

const BY_ID: ReadonlyMap<string, ExpertEntry> = new Map(EXPERT_CATALOG.map((expert) => [expert.id, expert]));

/** 按 id 取专家；**不认识的 id 返回 `undefined`**（不猜一个"最像的"）。 */
export function findExpert(id: string): ExpertEntry | undefined {
  return BY_ID.get(id);
}

/** 取某个领域的全部专家（顺序 = `EXPERT_CATALOG` 里的顺序，稳定）。 */
export function expertsByDomain(domain: ExpertDomain): readonly ExpertEntry[] {
  return EXPERT_CATALOG.filter((expert) => expert.domain === domain);
}

/**
 * 点一位专家之后**填进输入框**的那句话。
 *
 * ⚠️ 这里**只拼一句话**，不走任何新的执行通道：调用方把它交给既有的
 *    `requestDraft`（`layouts/MainArea`）—— 与欢迎屏的任务预设、目标路由
 *    是同一条路。专家的"可执行"到此为止，真正干活仍是既有的任务/团队机制。
 *
 * 骨架文案走 i18n（`experts.launchPrompt`，含 `{{name}}` 插值），
 * 这样 9 种语言能靠键位对等一起上；专家名字本身是内容自带的（见文件头）。
 */
export function buildExpertLaunchPrompt(
  expert: ExpertEntry,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return t('experts.launchPrompt', { name: expert.name });
}

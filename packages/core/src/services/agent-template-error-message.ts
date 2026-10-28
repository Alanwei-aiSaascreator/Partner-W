/**
 * 助手市场 / 创作者中心的 RPC 机器码 → **i18n 键**（+ 无 i18n 场景的中文回落）。
 *
 * 与 `describeCommunityError` / `describeGatewayError` 同一套路，但多一层：
 * 映射表给的是 `market.error.*` 的键，UI 一律 `t(describeTemplateErrorKey(code))`；
 * `describeTemplateError` 保留**中文回落**，给没有 i18n 的调用方（纯函数层，如
 * `lib/template-install.ts` 的 `message` 字段）用 —— 两边都由本表驱动，不许各写一套。
 *
 * ⚠️ 2026-10-07（质检 P1-2）：以前这里直接产中文 ⇒ 9 语言里有 7 种用户看到的是中文。
 * ⚠️ 码必须和迁移 40 里的 `raise exception '<码>'` 逐字对齐。
 * ⚠️ 键必须同时出现在 9 个 locale 里（`check:i18n` 的键位对等门禁钉着）。
 */
interface TemplateErrorMessage {
  /** `market.error.*` 下的 i18n 键。 */
  key: string;
  /** 拿不到 i18n 时给用户看的中文（与键一一对应；绝不出现机器码或英文原文）。 */
  fallback: string;
}

const MESSAGES: Record<string, TemplateErrorMessage> = {
  not_authenticated: { key: 'market.error.notAuthenticated', fallback: '请先登录再试。' },
  no_organization: { key: 'market.error.noOrganization', fallback: '你还没有团队，先创建一个再试。' },
  template_not_found: { key: 'market.error.templateNotFound', fallback: '这个助手模板不存在，或者你看不到它。' },
  forbidden: { key: 'market.error.forbidden', fallback: '这个操作只有模板作者或团队管理员能做。' },
  invalid_name: { key: 'market.error.invalidName', fallback: '名字要在 1 到 60 个字之间。' },
  invalid_description: { key: 'market.error.invalidDescription', fallback: '描述太长了，控制在 300 字以内。' },
  invalid_category: { key: 'market.error.invalidCategory', fallback: '请选择一个有效的分类。' },
  invalid_emoji: { key: 'market.error.invalidEmoji', fallback: '请填一个表情符号（最多 8 个字符）。' },
  invalid_instructions: { key: 'market.error.invalidInstructions', fallback: '提示词要在 1 到 8000 字之间。' },
  invalid_status: { key: 'market.error.invalidStatus', fallback: '不支持的状态。' },
  template_installed_cannot_delete: {
    key: 'market.error.templateInstalledCannotDelete',
    fallback: '已经有人装过这个模板了，只能下架、不能删除。',
  },
  // 公开市场关闭期间的上架被拒（W07-57）。措辞必须带上"私有模板不受影响"——
  // 只说"不能上架"会让创作者以为自己的模板出了问题。
  public_market_closed: {
    key: 'market.error.publicMarketClosed',
    fallback: '公开市场已关闭，暂时不能上架；你的私有模板不受影响。',
  },
  network: { key: 'market.error.network', fallback: '连不上服务器，请检查网络后重试。' },
  unknown: { key: 'market.error.unknown', fallback: '操作没成功，请稍后重试。' },
};

/** 认不出的码一律落这一条（`describeTemplateError` 的既有兜底语义保持不变）。 */
const UNKNOWN: TemplateErrorMessage = { key: 'market.error.unknown', fallback: '操作没成功，请稍后重试。' };

function lookup(code: string | undefined): TemplateErrorMessage {
  const key = (code ?? '').trim();
  // ⚠️ 不能写 `MESSAGES[key] ?? UNKNOWN`：查表会走原型链，`constructor` / `__proto__`
  //    这类码会命中 Object.prototype 上的成员（函数/对象），而映射表只该认自己的键。
  return Object.prototype.hasOwnProperty.call(MESSAGES, key) ? (MESSAGES[key] as TemplateErrorMessage) : UNKNOWN;
}

/** 这个码对应的 i18n 键（认不出 ⇒ `market.error.unknown`）。UI：`t(describeTemplateErrorKey(code))`。 */
export function describeTemplateErrorKey(code: string | undefined): string {
  return lookup(code).key;
}

/** 无 i18n 场景的中文回落（认不出的码也给中文，**绝不把机器码或英文原文摆到界面上**）。 */
export function describeTemplateError(code: string | undefined): string {
  return lookup(code).fallback;
}

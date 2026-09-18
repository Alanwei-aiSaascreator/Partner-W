/**
 * 助手市场 / 创作者中心的 RPC 机器码 → 中文。
 *
 * 与 `describeCommunityError` / `describeGatewayError` 同一套路：
 * 认得的给中文，认不出的给兜底中文，**绝不把机器码或英文原文摆到界面上**。
 *
 * ⚠️ 码必须和迁移 40 里的 `raise exception '<码>'` 逐字对齐。
 */
const MESSAGES: Record<string, string> = {
  not_authenticated: '请先登录再试。',
  no_organization: '你还没有团队，先创建一个再试。',
  template_not_found: '这个助手模板不存在，或者你看不到它。',
  forbidden: '这个操作只有模板作者或团队管理员能做。',
  invalid_name: '名字要在 1 到 60 个字之间。',
  invalid_description: '描述太长了，控制在 300 字以内。',
  invalid_category: '请选择一个有效的分类。',
  invalid_emoji: '请填一个表情符号（最多 8 个字符）。',
  invalid_instructions: '提示词要在 1 到 8000 字之间。',
  invalid_status: '不支持的状态。',
  template_installed_cannot_delete: '已经有人装过这个模板了，只能下架、不能删除。',
  network: '连不上服务器，请检查网络后重试。',
  unknown: '操作没成功，请稍后重试。',
};

export function describeTemplateError(code: string | undefined): string {
  const key = (code ?? '').trim();
  // ⚠️ 不能写 `MESSAGES[key] ?? fallback`：查表会走原型链，`constructor` / `__proto__`
  //    这类码会命中 Object.prototype 上的成员（函数/对象），而签名声称返回 string。
  const message = Object.prototype.hasOwnProperty.call(MESSAGES, key) ? MESSAGES[key] : undefined;
  return message ?? '操作没成功，请稍后重试。';
}

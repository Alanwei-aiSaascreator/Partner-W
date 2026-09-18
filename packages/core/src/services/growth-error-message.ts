/**
 * 成长值 / 悬赏的 RPC 机器码 → 中文。
 *
 * 与 `describeCommunityError` / `describeTemplateError` 同一套路：认得的给中文，
 * 认不出的给兜底中文，**绝不把机器码或英文原文摆到界面上**。
 *
 * ⚠️ 码必须与迁移 45/46/47 里的 `raise exception '<码>'` 逐字对齐：
 *    not_authenticated / no_organization / invalid_title / invalid_description /
 *    invalid_reward / invalid_status / insufficient_growth / bounty_not_found /
 *    invalid_state / cannot_claim_own / forbidden / append_only_violation
 */
const MESSAGES: Record<string, string> = {
  not_authenticated: '请先登录再试。',
  no_organization: '你还没有团队，先创建一个再试。',
  invalid_title: '标题要在 1 到 80 个字之间。',
  invalid_description: '说明太长了，控制在 1000 字以内。',
  invalid_reward: '奖励要在 10 到 1000 成长值之间。',
  invalid_status: '不支持的状态。',
  insufficient_growth: '成长值不够托管这笔奖励，先做任务或签到攒一些。',
  bounty_not_found: '这条悬赏不存在，或者你看不到它。',
  invalid_state: '这条悬赏的状态已经变了，刷新一下再试。',
  cannot_claim_own: '不能领取自己发布的悬赏。',
  forbidden: '这个操作只有发布者或领取人能做。',
  append_only_violation: '这条记录不允许修改。',
  network: '连不上服务器，请检查网络后重试。',
  unknown: '操作没成功，请稍后重试。',
};

export function describeGrowthError(code: string | undefined): string {
  const key = (code ?? '').trim();
  // ⚠️ 不能写 `MESSAGES[key] ?? fallback`：查表会走原型链，`constructor` / `__proto__`
  //    这类码会命中 Object.prototype 上的成员（函数/对象），而签名声称返回 string。
  const message = Object.prototype.hasOwnProperty.call(MESSAGES, key) ? MESSAGES[key] : undefined;
  return message ?? '操作没成功，请稍后重试。';
}

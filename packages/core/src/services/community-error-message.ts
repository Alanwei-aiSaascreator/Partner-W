/**
 * 把数据库 RPC 抛出的机器码翻成用户看得懂的中文。
 *
 * 为什么需要：RPC 里一律 `raise exception 'post_not_found'`（见迁移 35–38），
 * 错误码是给代码看的；界面上一旦漏出 `post_not_found`，用户既看不懂、
 * 又像 bug。与 `gateway-error-message.ts` / `update-errors.ts` 同一套路：
 * 认得的给中文，认不出的给兜底中文，**绝不回显原文**。
 *
 * ⚠️ 刻意不走 i18n：错误文案在这个仓库里是硬编码中文
 *    （`describeGatewayError` 就是这么做的），保持一致。
 *
 * ⚠️ 码必须和迁移里的 `raise exception '<码>'` 逐字对齐。加新码时
 *    先在这里补一条，否则用户会看到兜底文案（不会被回显，但也没信息量）。
 *    两边都有人手写，好在 `community_handlers` 只放行裸机器码，
 *    多写/写错一条也泄漏不了英文原文。
 */

const MESSAGES: Record<string, string> = {
  not_authenticated: '请先登录再试。',
  no_organization: '你还没有团队，先创建一个再试。',
  body_empty: '内容不能为空。',
  body_too_long: '内容太长了，精简一下再发。',
  visibility_not_supported: '暂不支持这种可见范围。',
  post_not_found: '这条内容不存在，或者你看不到它。',
  forbidden: '只有团队管理员能做这个操作。',
  role_not_allowed: '不能设置成这个角色。',
  invalid_usage: '可用次数要在 1 到 50 之间。',
  invalid_expiry: '有效期要在 1 到 720 小时之间。',
  invalid_code: '邀请码不对，检查一下再试。',
  invite_expired: '这个邀请码已经过期了。',
  invite_exhausted: '这个邀请码已经用完了。',
  already_member: '你已经是这个团队的成员了。',
  cannot_change_self: '不能修改自己的角色。',
  cannot_remove_self: '不能把自己移出团队，请用「退出团队」。',
  last_owner: '团队至少要有一个人是所有者。',
  owner_cannot_leave: '所有者不能退出团队。',
  member_not_found: '找不到这位成员，可能已经退出。',
  invite_not_found: '找不到这个邀请码，可能已经撤销。',
  not_a_member: '你还不是这个团队的成员。',
  // 网络/I-O：handler 在 RPC 抛异常时给这个码（`community-handlers.ts`）
  network: '连不上服务器，请检查网络后重试。',
  unknown: '操作没成功，请稍后重试。',
};

export function describeCommunityError(code: string | undefined): string {
  const key = (code ?? '').trim();
  // ⚠️ 不能写 `MESSAGES[key] ?? fallback`：查表会走原型链，`constructor` / `__proto__`
  //    这类码会命中 Object.prototype 上的成员（函数/对象），而签名声称返回 string。
  const message = Object.prototype.hasOwnProperty.call(MESSAGES, key) ? MESSAGES[key] : undefined;
  return message ?? '操作没成功，请稍后重试。';
}

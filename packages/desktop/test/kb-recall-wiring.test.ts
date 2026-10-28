import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 结构守卫：资料库必须真的接到「发送」这一环（2026-10-19）。
 *
 * 这条缺口存在了很久：`kbSearch` 全仓只有资料库面板自己在调，模型从来没收到过
 * 检索结果（设计文档 `docs/plan/2026-09-19-自主任务队列.md:218` 明确记录）。
 * 业务真值由 `kb-context.test.ts` 的纯函数用例钉住；这里只守住接线不被静默删掉：
 *   · 发送前用**用户原话**查一次资料库；
 *   · 结果经 `buildKbContextBlock` 限预算后进 `contextPrefix`（只给模型）；
 *   · 有超时兜底，不能拖住发送。
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'renderer', 'components', 'ChatInput', 'useChatSend.ts'), 'utf8');

describe('资料库 → 模型 的接线契约', () => {
  it('发送前用用户原话检索资料库', () => {
    expect(source).toContain('window.clawwork.kbSearch({ query: content');
    expect(source).toMatch(/content\.length\s*>=\s*2/u);
  });

  it('检索结果必须经过注入块构建器（带预算与安全声明）', () => {
    expect(source).toContain('buildKbContextBlock(kbResult.outcome');
  });

  it('注入块进入 contextPrefix（不进气泡、不落库）', () => {
    const prefixBlock = source.slice(source.indexOf('contextPrefix = ['), source.indexOf('contextPrefix = [') + 500);
    expect(prefixBlock).toContain('kbContext');
  });

  it('资料库检索有超时兜底，失败不得拦住发送', () => {
    expect(source).toContain('800');
    expect(source).toContain('资料库召回失败（不影响发送）');
  });
});

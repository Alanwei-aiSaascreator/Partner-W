import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeSendRefusal, SEND_REFUSAL_COPY } from '../src/services/send-refusal-message';
import { UnknownAgentError } from '../src/stores/task-store';

/**
 * 假的 `t`：**包一层方括号**再透出来。
 *
 * ⚠️ 刻意**不用恒等桩**（`key => key`）：恒等的话，"函数到底有没有真的调 `t`"就看不见 ——
 *    2026-09-24 我改常量表时漏掉了 `t(...)`，函数从"返回译文"变成"返回 key"，
 *    而恒等桩下的断言**全绿**，是 eslint 的 `no-unused-vars` 抓到的。
 *    包一层之后，少调一次 `t` 会当场变红。
 */
const t = (key: string): string => `[${key}]`;

describe('describeSendRefusal', () => {
  it('助手不在本机 ⇒ 说「不在本机」（有确定的下一步：换一个助手）', () => {
    expect(describeSendRefusal(new UnknownAgentError('team-agent-x'), t)).toBe('[errors.agentMissing]');
  });

  it('其它错误 ⇒ 仍是「助手无响应」（临时的，下一步是重试）', () => {
    expect(describeSendRefusal(new Error('boom'), t)).toBe('[errors.agentNotResponding]');
    expect(describeSendRefusal(undefined, t)).toBe('[errors.agentNotResponding]');
    expect(describeSendRefusal('boom', t)).toBe('[errors.agentNotResponding]');
  });

  it('两句话必须是**两个不同的** key（压成一句就退化成误导）', () => {
    expect(describeSendRefusal(new UnknownAgentError('x'), t)).not.toBe(describeSendRefusal(new Error('x'), t));
    expect(SEND_REFUSAL_COPY.agentMissing).not.toBe(SEND_REFUSAL_COPY.notResponding);
  });
});

/**
 * ⭐ 2026-09-24（复核**复验**抓到的**新缺陷**）：`errors.agentMissing` 当时只加进了 desktop 的
 * 九份语言，而 `chat-composer` 在 **core**、PWA 也用它 ⇒ **PWA 用户会看到裸 key**（`fallbackLng: 'en'`
 * 也缺，所以连英文兜底都没有）。
 *
 * 为什么门禁没红：`scripts/check-i18n.mjs` 的提取正则要求引号**紧跟** `t(`，而这里的 key 在一个
 * 三元里（`t(cond ? 'a' : 'b')`）⇒ 它**看不见**。所以这条按名钉住盲区本身：
 * **两个包、九份语言，`describeSendRefusal` 可能返回的每个 key 都必须在。**
 */
describe('describeSendRefusal 的 key 在两个包里都齐全', () => {
  /**
   * ⚠️ **不手抄清单**：直接遍历 `SEND_REFUSAL_COPY` —— 那张表是"可能返回哪些 key"的唯一定义，
   * 将来加第三种错误时这里自动被盖住（手抄的话就是仓库栽过的"清单不更新"形状）。
   */
  const KEYS = Object.values(SEND_REFUSAL_COPY);
  const DIRS: Array<[string, string]> = [
    ['desktop', '../../desktop/src/renderer/i18n/locales/'],
    ['pwa', '../../pwa/src/i18n/locales/'],
  ];

  it('这张表本身不是空的（空的清单会让下面的循环全绿）', () => {
    expect(KEYS.length).toBeGreaterThanOrEqual(2);
  });

  it.each(DIRS)('%s 的九份语言都带这些 key', (pkg, relative) => {
    const dir = fileURLToPath(new URL(relative, import.meta.url));
    const files = readdirSync(dir).filter((file) => file.endsWith('.json'));

    expect(files.length, '九份语言').toBe(9);
    for (const file of files) {
      const json = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const key of KEYS) {
        const [namespace, leaf] = key.split('.');
        expect(json[namespace ?? '']?.[leaf ?? ''], `${pkg}/${file} 缺 ${key}`).toBeTruthy();
      }
    }
  });
});

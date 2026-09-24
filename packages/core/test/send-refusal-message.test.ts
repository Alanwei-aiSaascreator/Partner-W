import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeSendRefusal } from '../src/services/send-refusal-message';
import { UnknownAgentError } from '../src/stores/task-store';

/** 假的 `t`：直接把 key 透出来，这样断言绑的是"说了哪句话"而不是译文。 */
const t = (key: string): string => key;

describe('describeSendRefusal', () => {
  it('助手不在本机 ⇒ 说「不在本机」（有确定的下一步：换一个助手）', () => {
    expect(describeSendRefusal(new UnknownAgentError('team-agent-x'), t)).toBe('errors.agentMissing');
  });

  it('其它错误 ⇒ 仍是「助手无响应」（临时的，下一步是重试）', () => {
    expect(describeSendRefusal(new Error('boom'), t)).toBe('errors.agentNotResponding');
    expect(describeSendRefusal(undefined, t)).toBe('errors.agentNotResponding');
    expect(describeSendRefusal('boom', t)).toBe('errors.agentNotResponding');
  });

  it('两句话必须是**两个不同的** key（压成一句就退化成误导）', () => {
    expect(describeSendRefusal(new UnknownAgentError('x'), t)).not.toBe(describeSendRefusal(new Error('x'), t));
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
  const KEYS = ['errors.agentMissing', 'errors.agentNotResponding'];
  const DIRS: Array<[string, string]> = [
    ['desktop', '../../desktop/src/renderer/i18n/locales/'],
    ['pwa', '../../pwa/src/i18n/locales/'],
  ];

  it.each(DIRS)('%s 的九份语言都带这两个 key', (pkg, relative) => {
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

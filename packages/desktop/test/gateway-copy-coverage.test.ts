import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_PHASE_IDS } from '@clawwork/core';

/**
 * 网关给的那些 **id**，在**每个语言**里都得有文案。
 *
 * ## 为什么值得单独钉
 *
 * 这些 id 的**清单在别处**（`run_status` 的相位在 core 里；`errorKind` 在协议 schema 里），
 * 文案却在 9 个 locale 文件里 —— **两边分居**，中间没有东西连着。少一个语言的后果是：
 * 那个语言的用户看到的是**泛化兜底**、或者干脆是**英文原文**，而这种缺失
 * **在代码里看不出来**（`t()` 拿不到 key 时只是回退，不报错）。
 *
 * 两处都对着"用户正在难受"的时刻：
 * - **准备阶段**全发生在"还没有任何可见活动"的那段（用户抱怨的「卡住好久」）；
 * - **错误类别**是失败时唯一能给用户的那句话。
 *
 * ⚠️ 这个文件把**分居的两边**绑在一起：将来加相位/加类别忘了加文案，
 * 或者加了文案忘了加 id，这里都会红。
 */
const localeDir = join(__dirname, '../src/renderer/i18n/locales');

function localeJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(localeDir, file), 'utf8')) as Record<string, unknown>;
}

/** 取嵌套值（`errors.kind` 这种）。 */
function at(obj: unknown, path: string): Record<string, string> {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return {};
    cur = (cur as Record<string, unknown>)[seg];
  }
  return (cur ?? {}) as Record<string, string>;
}

/**
 * 网关 `errorKind` 里**给了文案**的四个（协议闭集里还有 `unknown` ——
 * 那个**故意不给**：认不出就退回网关原文，宁可给英文也不要给一句错的中文）。
 */
const ERROR_KINDS_WITH_COPY = ['refusal', 'timeout', 'rate_limit', 'context_length'] as const;

describe('网关 id 的文案覆盖', () => {
  const locales = readdirSync(localeDir).filter((f) => f.endsWith('.json'));

  it('语言文件都在（少了这条，下面的遍历会变成空跑还照样绿）', () => {
    expect(locales.length, 'locale 目录下应有 9 个语言文件').toBe(9);
    expect(locales, '英文是基准，必须有').toContain('en.json');
  });

  it('两份 id 清单都非空（上游被清空时不该静默通过）', () => {
    // 7 个准备相位 + 1 个重试相位（`retrying`，2026-09-09 实测新增的那个）。
    // ⚠️ 这个数字是**灵敏度哨兵**：上游把清单清空了，这条要红。
    expect(RUN_PHASE_IDS.length).toBe(8);
    expect(ERROR_KINDS_WITH_COPY.length).toBe(4);
  });

  it('⭐ 每个相位在**每个**语言里都有文案，且**不是**泛化兜底那句', () => {
    for (const file of locales) {
      const runPhase = at(localeJson(file), 'chatInput.runPhase');
      const fallback = runPhase.unknown;

      for (const phase of RUN_PHASE_IDS) {
        const text = runPhase[phase];
        expect(text, `${file} 缺 chatInput.runPhase.${phase}`).toBeTypeOf('string');
        expect(text, `${file} 的 ${phase} 是空串`).toBeTruthy();
        expect(text, `${file} 的 ${phase} 直接抄了泛化兜底「${fallback}」⇒ 等于没加`).not.toBe(fallback);
      }
    }
  });

  it('七个准备阶段**互不相同**（两个阶段同一句话 = 用户照样看不出区别）', () => {
    for (const file of locales) {
      const runPhase = at(localeJson(file), 'chatInput.runPhase');
      const texts = RUN_PHASE_IDS.map((p) => runPhase[p]);
      expect(new Set(texts).size, `${file} 里有阶段共用同一句文案：${texts.join(' / ')}`).toBe(texts.length);
    }
  });

  it('⭐ 四个错误类别在**每个**语言里都有文案', () => {
    for (const file of locales) {
      const kind = at(localeJson(file), 'errors.kind');
      for (const k of ERROR_KINDS_WITH_COPY) {
        const text = kind[k];
        expect(text, `${file} 缺 errors.kind.${k}`).toBeTypeOf('string');
        expect(text, `${file} 的 errors.kind.${k} 是空串`).toBeTruthy();
      }
    }
  });

  it('四个错误类别**互不相同**，且**不给 `unknown` 写文案**', () => {
    for (const file of locales) {
      const kind = at(localeJson(file), 'errors.kind');
      const texts = ERROR_KINDS_WITH_COPY.map((k) => kind[k]);
      expect(new Set(texts).size, `${file} 里有类别共用同一句文案：${texts.join(' / ')}`).toBe(texts.length);
      // `unknown` 有文案 = 认不出也硬给一句，那就违背了"宁可给原文"
      expect(kind.unknown, `${file} 不该给 unknown 写文案（认不出要退回网关原文）`).toBeUndefined();
    }
  });
});

/**
 * BUG-077（2026-10-14 真实用户 1.0.6 截图「推流: LLM request failed: provider rejected
 * the request schema or tool payload.」）的**九语言产品文案覆盖**。
 *
 * 运行时把"上游判请求不合法"统一成那句英文包装话；客户端在
 * `packages/core/src/services/gateway-error-message.ts` 对它做**确切措辞**的窄匹配，
 * 返回 i18n key `errors.wrapper.providerRequestRejected`（**不硬塞中文** ——
 * 那样只有中文用户受益），真实文案就在这里、9 个语言文件里。
 *
 * 两边分居、中间没有东西连着 —— 少一个语言 = 那个语言的用户继续看英文原文，
 * 而这**在代码里看不出来**（`t()` 拿不到 key 只回退，不报错）。所以钉在这里。
 */
const GATEWAY_WRAPPER_KEYS = ['errors.wrapper.providerRequestRejected'] as const;

describe('已知英文包装句的产品文案覆盖（BUG-077）', () => {
  const locales = readdirSync(localeDir).filter((f) => f.endsWith('.json'));

  it('清单非空（上游把识别表清空时不该静默通过）', () => {
    expect(GATEWAY_WRAPPER_KEYS.length).toBe(1);
  });

  it('⭐ 每个语言都有这套文案，且非空、不等于泛化兜底', () => {
    for (const file of locales) {
      const wrapper = at(localeJson(file), 'errors.wrapper');
      const unknown = at(localeJson(file), 'errors').unknown;
      for (const key of GATEWAY_WRAPPER_KEYS) {
        const leaf = key.split('.').pop() as string;
        const text = wrapper[leaf];
        expect(text, `${file} 缺 ${key}`).toBeTypeOf('string');
        expect(text, `${file} 的 ${key} 是空串`).toBeTruthy();
        expect(text, `${file} 的 ${key} 直接抄了泛化兜底「${unknown}」⇒ 等于没加`).not.toBe(unknown);
      }
    }
  });
});

/**
 * **本机运行时部署**那四个阶段（+ 慢盘提示）的文案覆盖（2026-10-07 体检问题 2/5）。
 *
 * 为什么和上面那组同一个文件：它们分居的两边是同一种 —— 阶段清单在主进程代码里
 * （`DeployProgress['phase']`），文案在 9 个 locale 文件里，中间没有东西连着。
 * 少一个语言的后果同样是"那个语言的用户看到裸 key 或泛化兜底"，而**代码里看不出来**。
 *
 * ⚠️ 前四个是**阶段**（要能在同一块屏幕上区分开："解压中"和"装 Node"不是一回事）；
 *    第五个 `deployStalled` 是**慢盘提示**（不中止，只说"在等系统响应"），
 *    它天然与阶段不同类，所以分开钉。
 */
const DEPLOY_PHASE_KEYS = ['deployVerify', 'deployExtract', 'deployNode', 'deployFinalize'] as const;

describe('部署阶段文案覆盖（每个语言都要有四阶段 + 停滞提示）', () => {
  const locales = readdirSync(localeDir).filter((f) => f.endsWith('.json'));

  it('⭐ 四个阶段在**每个**语言里都有文案，且互不相同', () => {
    for (const file of locales) {
      const entry = at(localeJson(file), 'entryPreparation');
      for (const key of DEPLOY_PHASE_KEYS) {
        const text = entry[key];
        expect(text, `${file} 缺 entryPreparation.${key}`).toBeTypeOf('string');
        expect(text, `${file} 的 entryPreparation.${key} 是空串`).toBeTruthy();
      }
      const texts = DEPLOY_PHASE_KEYS.map((k) => entry[k]);
      expect(new Set(texts).size, `${file} 里有阶段共用同一句文案：${texts.join(' / ')}`).toBe(texts.length);
    }
  });

  it('停滞提示每个语言也得有（它说的是"慢"，不是"失败"）', () => {
    for (const file of locales) {
      const entry = at(localeJson(file), 'entryPreparation');
      expect(entry.deployStalled, `${file} 缺 entryPreparation.deployStalled`).toBeTypeOf('string');
      expect(entry.deployStalled, `${file} 的 entryPreparation.deployStalled 是空串`).toBeTruthy();
    }
  });
});

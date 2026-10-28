/**
 * 版式质检结论的「细说」必须本地化。
 *
 * ## 为什么有这个文件（2026-10-16 集成人真机截图）
 * 用户在中文界面看到：
 *   `#33: Text #33 has 2.13:1 contrast on the measured solid background (target 3:1). Change text or background color.`
 * —— 主进程 `main/slidegen/validate.ts` 里 4 条 warning 的 `detail` 有 2 条是**英文硬编码**，
 *    而界面是 `#${element}: ${detail}` 直拼 ⇒ 整段英文上屏。
 *
 * 这与 `slidegen-copy.ts` 里 2026-10-06（图12）已判过的「内部诊断码 + 英文解析器原文裸奔」
 * 是同一类，当时只修了失败文案，**警告这条漏了**。
 *
 * ## 这个文件守住什么
 * 1. 有语言无关载荷（`data`）⇒ **绝不出现**原始 `detail` 的英文；
 * 2. 载荷缺失（老数据）⇒ **回落** `detail`，不清空、不崩；
 * 3. 载荷存在但**翻译键缺失** ⇒ 不许把 i18n 键名当文案渲染（那是最坏的一种"上屏"）。
 */
import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { layoutWarningDetail } from '../src/renderer/lib/slidegen-copy';

const EN_RAW =
  'Text #33 has 2.13:1 contrast on the measured solid background (target 3:1). Change text or background color.';

/** 用真实 i18n 资源（zh）跑，避免"假 t"掩盖缺键。 */
async function zhT() {
  const i18n = createInstance();
  const zh = (await import('../src/renderer/i18n/locales/zh.json')).default as Record<string, unknown>;
  await i18n.init({ lng: 'zh', resources: { zh: { translation: zh } }, interpolation: { escapeValue: false } });
  return { t: (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts), has: (k: string) => i18n.exists(k) };
}

describe('layoutWarningDetail —— 版式警告细说本地化', () => {
  it('有 data 时给出中文本地化句子，且**不出现**主进程的英文原文', async () => {
    const { t, has } = await zhT();
    // 键必须先存在：缺键时 i18next 会原样返回键名，那也是一种"上屏垃圾"。
    for (const k of ['slidegen.detail.lowContrast', 'slidegen.who.withText', 'slidegen.kind.text']) {
      expect(has(k), `缺 i18n 键 ${k}（键没写入时这条断言会红，这是有意的）`).toBe(true);
    }

    const text = layoutWarningDetail(
      {
        code: 'layout-text-low-contrast',
        element: 33,
        detail: EN_RAW,
        data: { kind: 'text', snippet: '本季度营收同比', ratio: 2.13, minimum: 3 },
      },
      t,
    );

    expect(text, '不许把英文原文透出去').not.toContain('contrast on the measured solid background');
    expect(text, '不许把键名当文案').not.toContain('slidegen.');
    expect(text).toContain('2.13');
    expect(text).toContain('3');
    expect(text).toContain('本季度营收同比');
  });

  it('页脚侵入那条也不出英文', async () => {
    const { t } = await zhT();
    const text = layoutWarningDetail(
      {
        code: 'layout-footer-overlap',
        element: 7,
        detail:
          'Footer #7 enters body region #3. Reserve space above the footer or move the body region; keep all text.',
        data: { footer: 7, body: 3 },
      },
      t,
    );
    expect(text).not.toContain('enters body region');
    expect(text).not.toContain('slidegen.');
    expect(text).toContain('7');
    expect(text).toContain('3');
  });

  it('冲出画布：多边拼得出来、不出现英文', async () => {
    const { t } = await zhT();
    const text = layoutWarningDetail(
      {
        code: 'layout-out-of-bounds',
        element: 12,
        detail: '文字「abc」（#12） 冲出画布：右边超出 30px。这一块导出后在幻灯片外面，放映时看不到。',
        data: { kind: 'text', snippet: 'abc', overflow: [{ side: 'right', px: 30 }] },
      },
      t,
    );
    expect(text).not.toContain('slidegen.');
    expect(text).toContain('30');
  });

  it('data 缺失（老数据）⇒ 回落原始 detail，不清空', async () => {
    const { t } = await zhT();
    const text = layoutWarningDetail({ code: 'layout-text-low-contrast', element: 33, detail: EN_RAW }, t);
    expect(text).toBe(EN_RAW);
  });

  it('data 不完整（只有 kind、缺 ratio/minimum）⇒ 同样回落，不拼半句', async () => {
    const { t } = await zhT();
    const text = layoutWarningDetail(
      { code: 'layout-text-low-contrast', element: 33, detail: EN_RAW, data: { kind: 'text', snippet: 'x' } },
      t,
    );
    expect(text).toBe(EN_RAW);
  });
});

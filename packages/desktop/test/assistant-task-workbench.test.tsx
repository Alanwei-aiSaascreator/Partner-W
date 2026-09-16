// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../src/renderer/i18n';
import { resolveAssistantWorkspace } from '../src/renderer/lib/preset-agents';

import AssistantTaskWorkbench from '../src/renderer/layouts/MainArea/AssistantTaskWorkbench';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage('zh');
});

function render(ui: ReactElement): {
  container: HTMLDivElement;
  rerender: (nextUi: ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (nextUi) => act(() => root.render(nextUi)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function renderWorkbench(
  assistantId = 'rongying-content',
  overrides: Partial<React.ComponentProps<typeof AssistantTaskWorkbench>> = {},
) {
  const definition = resolveAssistantWorkspace(assistantId)!;
  const props: React.ComponentProps<typeof AssistantTaskWorkbench> = {
    definition,
    modelLabel: 'DeepSeek V4 Flash',
    ready: true,
    recentPresetIds: [],
    onSelectPreset: vi.fn(),
    onCustomTask: vi.fn(),
    ...overrides,
  };
  return { definition, props, ...render(<AssistantTaskWorkbench {...props} />) };
}

describe('AssistantTaskWorkbench', () => {
  it('defines complete, non-empty workbench copy in the real Chinese and English resources', () => {
    const sharedKeys = [
      'recentTasks',
      'materialHint',
      'output',
      'customTask',
      'draftConflictTitle',
      'draftConflictDescription',
      'appendDraft',
      'replaceDraft',
    ];
    const definitions = [
      'main',
      'rongying-content',
      'rongying-video',
      'rongying-office',
      'rongying-ecommerce',
      'rongying-research',
      'rongying-family',
    ].map((id) => resolveAssistantWorkspace(id)!);

    for (const locale of ['zh', 'en']) {
      const t = i18n.getFixedT(locale);
      for (const key of sharedKeys) {
        const translationKey = `taskWorkbench.${key}`;
        expect(t(translationKey), `${locale}: ${translationKey}`).not.toBe(translationKey);
        expect(t(translationKey).trim(), `${locale}: ${translationKey}`).not.toBe('');
      }

      for (const definition of definitions) {
        for (const preset of definition.starters) {
          for (const key of [preset.materialHintKey, preset.outputKey]) {
            expect(t(key), `${locale}: ${key}`).not.toBe(key);
            expect(t(key).trim(), `${locale}: ${key}`).not.toBe('');
          }
        }
      }
    }
  });

  it.each([
    [
      'assistantWorkspaces.compass.starters.2',
      ['授权文件或文件夹、整理范围和希望解决的问题（可选）', '按主题归类的资料重点、摘要和待办事项'],
      [
        'Approved files or folders, organization scope, and intended use (optional)',
        'Materials grouped by theme, with key points, summaries, and action items',
      ],
    ],
    [
      'assistantWorkspaces.compass.starters.4',
      ['需求说明、使用对象、交付格式和参考资料（可选）', '可继续编辑的文档、表格或清单结构与内容初稿'],
      [
        'Request details, intended audience, delivery format, and reference material (optional)',
        'Editable document, table, or checklist structure with a working draft',
      ],
    ],
    [
      'assistantWorkspaces.content.starters.3',
      ['原文、发布平台、目标受众、目标语气和需要保留的事实（可选）', '保留原意的优化稿、修改说明和可选标题'],
      [
        'Original copy, platform, audience, target tone, and facts to preserve (optional)',
        'Revised copy that preserves meaning, with change notes and title options',
      ],
    ],
    [
      'assistantWorkspaces.content.starters.4',
      ['账号或品牌、计划周期、栏目方向、发布时间和现有素材（可选）', '按日期、栏目、素材需求和内容目标整理的发布日历'],
      [
        'Account or brand, planning period, content pillars, publishing cadence, and available assets (optional)',
        'Publishing calendar organized by date, content pillar, asset needs, and objective',
      ],
    ],
    [
      'assistantWorkspaces.ecommerce.starters.2',
      ['自家商品、竞品资料、价格、页面内容和用户评价（可选）', '定位、价格、卖点、页面和评价差异的竞品分析报告'],
      [
        'Your product, competitor materials, prices, page content, and customer reviews (optional)',
        'Competitor report covering positioning, price, claims, page content, and review differences',
      ],
    ],
    [
      'assistantWorkspaces.ecommerce.starters.3',
      ['商品资料、目标人群、卖点证据和页面限制（可选）', '首屏标题、核心卖点、信任证明、使用场景和行动引导结构'],
      [
        'Product details, audience, evidence for claims, and page constraints (optional)',
        'Page structure with a hero headline, key benefits, trust proof, use cases, and call to action',
      ],
    ],
    [
      'assistantWorkspaces.ecommerce.starters.4',
      ['商品或店铺信息、常见问题、价格物流和售后规则（可选）', '覆盖售前、价格异议、催付、物流和售后的客服话术'],
      [
        'Product or store details, FAQs, pricing, shipping, and after-sales policies (optional)',
        'Customer-service scripts for presales, price objections, payment, shipping, and after-sales',
      ],
    ],
    [
      'assistantWorkspaces.family.starters.1',
      ['用餐人数、饮食偏好、过敏或忌口、预算和现有食材（可选）', '7 天菜谱、合并采购清单和备餐建议'],
      [
        'Household size, food preferences, allergies or restrictions, budget, and available ingredients (optional)',
        'Seven-day meal plan, combined shopping list, and preparation guidance',
      ],
    ],
    [
      'assistantWorkspaces.family.starters.2',
      ['目的地、家庭成员、日期、预算、出行偏好和限制（可选）', '路线、时间、费用、预订事项和雨天备选方案'],
      [
        'Destination, family members, dates, budget, travel preferences, and constraints (optional)',
        'Routes, timing, costs, bookings, and a rainy-day alternative',
      ],
    ],
    [
      'assistantWorkspaces.family.starters.3',
      ['孩子年龄、活动时长、场地、可用材料和安全限制（可选）', '活动目标、材料清单、执行步骤和安全提示'],
      [
        'Child age, activity duration, location, available materials, and safety constraints (optional)',
        'Activity goal, materials list, step-by-step instructions, and safety notes',
      ],
    ],
    [
      'assistantWorkspaces.research.starters.4',
      ['授权资料、总结目的、目标读者和重点问题（可选）', '区分事实、作者观点和推断的核心概念、重点与行动建议'],
      [
        'Approved source material, summary purpose, audience, and priority questions (optional)',
        'Core concepts, key points, and actions separated into facts, author views, and inferences',
      ],
    ],
    [
      'assistantWorkspaces.video.starters.3',
      ['脚本或拍摄主题、场景、人物、道具和可用设备（可选）', '按场景合并的镜头、人物、道具、设备和拍摄顺序清单'],
      [
        'Script or shooting topic, locations, people, props, and available equipment (optional)',
        'Shot list grouped by scene with people, props, equipment, and shooting order',
      ],
    ],
    [
      'assistantWorkspaces.video.starters.4',
      ['视频素材、发布平台、目标时长、风格和参考作品（可选）', '结构节奏、素材取舍、转场、字幕、音效和配乐方案'],
      [
        'Video footage, platform, target duration, style, and references (optional)',
        'Editing plan for structure, pacing, footage choices, transitions, captions, sound, and music',
      ],
    ],
  ])('keeps metadata aligned with the current preset at %s', (root, zhExpected, enExpected) => {
    for (const [locale, expected] of [
      ['zh', zhExpected],
      ['en', enExpected],
    ] as const) {
      const t = i18n.getFixedT(locale);
      expect([t(`${root}.materialHint`), t(`${root}.output`)]).toEqual(expected);
    }
  });

  it('renders the identity and four complete task presets for all seven assistants', () => {
    const assistantIds = [
      'main',
      'rongying-content',
      'rongying-video',
      'rongying-office',
      'rongying-ecommerce',
      'rongying-research',
      'rongying-family',
    ];

    for (const assistantId of assistantIds) {
      const { container, definition, unmount } = renderWorkbench(assistantId);
      expect(container.textContent).toContain(definition.emoji);
      expect(container.textContent).toContain(i18n.t(definition.titleKey));
      expect(container.textContent).toContain(i18n.t(definition.descriptionKey));

      const cards = container.querySelectorAll<HTMLButtonElement>('[data-testid="assistant-task-preset"]');
      expect(cards).toHaveLength(4);
      expect(cards[0]?.parentElement?.className).toContain('grid-cols-1');
      expect(cards[0]?.parentElement?.className).toContain('sm:grid-cols-2');
      expect(container.textContent).toContain('建议资料');
      expect(container.textContent).toContain('预期成果');
      expect(container.textContent).toContain('自定义任务');

      for (const [index, card] of Array.from(cards).entries()) {
        const preset = definition.starters[index]!;
        expect(card.dataset.presetId).toBe(preset.id);
        expect(card.textContent).toContain(i18n.t(preset.titleKey));
        expect(card.textContent).toContain(i18n.t(preset.descriptionKey));
        expect(card.textContent).toContain(i18n.t(preset.materialHintKey));
        expect(card.textContent).toContain(i18n.t(preset.outputKey));
      }
      unmount();
    }
  });

  it('returns the selected preset object instead of only its prompt', () => {
    const onSelectPreset = vi.fn();
    const { container, definition, unmount } = renderWorkbench('rongying-video', { onSelectPreset });

    const secondPreset = container.querySelectorAll<HTMLButtonElement>('[data-testid="assistant-task-preset"]')[1]!;
    act(() => secondPreset.click());

    expect(onSelectPreset).toHaveBeenCalledOnce();
    expect(onSelectPreset).toHaveBeenCalledWith(definition.starters[1]);
    unmount();
  });

  it('shows unique recent presets only when they belong to the current assistant', () => {
    const content = resolveAssistantWorkspace('rongying-content')!;
    const ecommerce = resolveAssistantWorkspace('rongying-ecommerce')!;
    const { container, unmount } = renderWorkbench('rongying-content', {
      recentPresetIds: [
        content.starters[1]!.id,
        ecommerce.starters[0]!.id,
        content.starters[1]!.id,
        'unknown:preset',
        content.starters[3]!.id,
      ],
    });

    const recent = container.querySelectorAll<HTMLButtonElement>('[data-testid="assistant-task-recent-preset"]');
    expect(Array.from(recent, (button) => button.dataset.presetId)).toEqual([
      content.starters[1]!.id,
      content.starters[3]!.id,
    ]);
    expect(container.textContent).toContain('最近使用');
    unmount();
  });

  it('exposes readiness details and the custom task action as keyboard buttons', () => {
    const onCustomTask = vi.fn();
    const { container, props, rerender, unmount } = renderWorkbench('main', { ready: false, onCustomTask });

    expect(container.textContent).toContain('DeepSeek V4 Flash');
    expect(container.textContent).toContain(i18n.t('startupReadiness.aiStarting'));
    const readinessStatus = container.querySelector<HTMLElement>('[role="status"]');
    expect(readinessStatus?.getAttribute('aria-live')).toBe('polite');
    expect(readinessStatus?.getAttribute('aria-atomic')).toBe('true');
    expect(container.querySelector('.animate-spin')?.getAttribute('class')).toContain('motion-reduce:animate-none');

    rerender(<AssistantTaskWorkbench {...props} ready />);
    expect(readinessStatus?.textContent).toContain(i18n.t('startupReadiness.aiReady'));
    expect(readinessStatus?.textContent).not.toContain(i18n.t('startupReadiness.aiStarting'));

    const buttons = container.querySelectorAll<HTMLButtonElement>('button');
    expect(Array.from(buttons).every((button) => button.type === 'button')).toBe(true);
    expect(Array.from(buttons).every((button) => button.className.includes('glow-focus'))).toBe(true);
    expect(Array.from(buttons).every((button) => button.className.includes('motion-reduce:transition-none'))).toBe(
      true,
    );
    const customButton = container.querySelector<HTMLButtonElement>('[data-testid="assistant-task-custom"]')!;
    act(() => customButton.click());
    expect(onCustomTask).toHaveBeenCalledOnce();
    unmount();
  });

  it('does not put invented metrics, income, online status, or absolute privacy claims in workbench copy', () => {
    const forbidden =
      /\d+(?:\.\d+)?\s*(?:万|k|m|\+)?\s*(?:(?:人|用户|users?|people)\s*)?(?:在线|online)|(?:评分|评级|rating)\s*[:：]?\s*\d(?:\.\d+)?|\d(?:\.\d+)?\s*(?:分|星|stars?)\s*(?:好评)?|(?:月入|年入|income|revenue)\s*(?:(?:￥|¥|\$)?\s*\d+|过万|上万|百万)|(?:收入|income|revenue)(?:提升|增长|增加|growth|increase)\s*\d+|(?:数据|文件|内容|data|files?|content)(?:绝不|不会|不|never|will not|won't)(?:上传|离开本地|出本地|upload|leave (?:your )?(?:device|computer))|(?:完全|百分之百|100%|completely|fully)\s*(?:离线|本地|私密|安全|offline|local|private|secure)|(?:隐私|privacy)(?:绝对|完全|百分之百|100%|guaranteed|absolute)保障?/iu;
    const definitions = [
      'main',
      'rongying-content',
      'rongying-video',
      'rongying-office',
      'rongying-ecommerce',
      'rongying-research',
      'rongying-family',
    ].map((id) => resolveAssistantWorkspace(id)!);
    const sharedKeys = [
      'recentTasks',
      'materialHint',
      'output',
      'customTask',
      'draftConflictTitle',
      'draftConflictDescription',
      'appendDraft',
      'replaceDraft',
    ];

    for (const locale of ['zh', 'en']) {
      const t = i18n.getFixedT(locale);
      for (const key of sharedKeys) expect(t(`taskWorkbench.${key}`), `${locale}: ${key}`).not.toMatch(forbidden);
      for (const definition of definitions) {
        for (const preset of definition.starters) {
          for (const key of [preset.materialHintKey, preset.outputKey]) {
            expect(t(key), `${locale}: ${key}`).not.toMatch(forbidden);
          }
        }
      }
    }
  });
});

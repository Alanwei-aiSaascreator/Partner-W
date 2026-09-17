import { describe, expect, it } from 'vitest';
import i18n from '../src/renderer/i18n';
import expectedPresetCopy from './fixtures/assistant-task-preset-copy.json';
import {
  ASSISTANT_ID_BY_WORKSPACE,
  ASSISTANT_TASK_IDS,
  ASSISTANT_TASK_PRESETS,
  resolveAssistantTaskPresets,
} from '../src/renderer/lib/assistant-task-presets';

const EXPECTED_PRESET_ROOTS = [
  ['compass:goal-breakdown', 'assistantWorkspaces.compass.starters.1'],
  ['compass:execution-plan', 'assistantWorkspaces.compass.starters.2'],
  ['compass:option-comparison', 'assistantWorkspaces.compass.starters.3'],
  ['compass:comprehensive-analysis', 'assistantWorkspaces.compass.starters.4'],
  ['content:topic-planning', 'assistantWorkspaces.content.starters.1'],
  ['content:long-form-writing', 'assistantWorkspaces.content.starters.2'],
  ['content:short-video-script', 'assistantWorkspaces.content.starters.3'],
  ['content:rewrite-polish', 'assistantWorkspaces.content.starters.4'],
  ['video:shooting-script', 'assistantWorkspaces.video.starters.1'],
  ['video:storyboard', 'assistantWorkspaces.video.starters.2'],
  ['video:editing-rhythm', 'assistantWorkspaces.video.starters.3'],
  ['video:title-cover', 'assistantWorkspaces.video.starters.4'],
  ['ecommerce:product-copy', 'assistantWorkspaces.ecommerce.starters.1'],
  ['ecommerce:campaign-plan', 'assistantWorkspaces.ecommerce.starters.2'],
  ['ecommerce:competitor-analysis', 'assistantWorkspaces.ecommerce.starters.3'],
  ['ecommerce:review-customer-service', 'assistantWorkspaces.ecommerce.starters.4'],
  ['office:document-writing', 'assistantWorkspaces.office.starters.1'],
  ['office:spreadsheet-analysis', 'assistantWorkspaces.office.starters.2'],
  ['office:meeting-minutes', 'assistantWorkspaces.office.starters.3'],
  ['office:presentation-outline', 'assistantWorkspaces.office.starters.4'],
  ['research:source-organization', 'assistantWorkspaces.research.starters.1'],
  ['research:viewpoint-comparison', 'assistantWorkspaces.research.starters.2'],
  ['research:learning-plan', 'assistantWorkspaces.research.starters.3'],
  ['research:research-report', 'assistantWorkspaces.research.starters.4'],
  ['family:travel-plan', 'assistantWorkspaces.family.starters.1'],
  ['family:family-checklist', 'assistantWorkspaces.family.starters.2'],
  ['family:purchase-comparison', 'assistantWorkspaces.family.starters.3'],
  ['family:schedule-plan', 'assistantWorkspaces.family.starters.4'],
] as const;
const COPY_FIELDS = ['title', 'description', 'prompt', 'materialHint', 'output', 'followUpPrompt'] as const;
type CopyField = (typeof COPY_FIELDS)[number];
type PresetCopy = Record<CopyField, string>;
type LocalePresetCopy = Record<string, PresetCopy>;

const COPY_PROFILE_BY_LOCALE = {
  zh: 'zh',
  'zh-TW': 'zh-TW',
  en: 'en',
  de: 'en',
  es: 'en',
  fr: 'en',
  ja: 'en',
  ko: 'en',
  pt: 'en',
} as const;

const ZH_TW_REMAPPED_METADATA_MARKERS = {
  'compass:execution-plan': {
    materialHint: ['目標', '可用資源'],
    output: ['執行計畫', '風險預案'],
  },
  'compass:comprehensive-analysis': {
    materialHint: ['待分析的問題', '背景資料'],
    output: ['現況判斷', '行動建議'],
  },
  'content:short-video-script': {
    materialHint: ['影片時長', '產品資訊'],
    output: ['短影音腳本', '畫面提示'],
  },
  'content:rewrite-polish': {
    materialHint: ['原文', '發布平台'],
    output: ['潤色稿', '修改說明'],
  },
  'video:editing-rhythm': {
    materialHint: ['腳本或素材', '參考節奏'],
    output: ['剪輯節奏', '情緒曲線'],
  },
  'video:title-cover': {
    materialHint: ['影片主題', '封面素材'],
    output: ['標題備選', '視覺重點'],
  },
  'ecommerce:campaign-plan': {
    materialHint: ['活動目標', '歷史資料'],
    output: ['通路動作', '檢討指標'],
  },
  'ecommerce:competitor-analysis': {
    materialHint: ['競品資料', '使用者評價'],
    output: ['評價差異', '競品分析報告'],
  },
  'ecommerce:review-customer-service': {
    materialHint: ['店鋪資訊', '使用者評價'],
    output: ['評價問題分類', '客服話術'],
  },
  'family:travel-plan': {
    materialHint: ['家庭成員', '旅遊偏好'],
    output: ['旅行路線', '預訂事項'],
  },
  'family:family-checklist': {
    materialHint: ['家庭事項', '特殊需求'],
    output: ['家庭清單', '檢查狀態'],
  },
  'family:purchase-comparison': {
    materialHint: ['候選商品', '售後條件'],
    output: ['購買選項比較', '推薦結論'],
  },
  'research:source-organization': {
    materialHint: ['資料檔案或連結', '研究範圍'],
    output: ['資料目錄', '可靠性說明'],
  },
  'research:research-report': {
    materialHint: ['研究問題', '分析範圍'],
    output: ['研究背景', '結論和建議'],
  },
} as const;

const ZH_TW_WORKSPACE_DESCRIPTIONS = {
  compass: '你的綜合任務入口。說明想達成的結果，我會協助判斷任務類型並交給合適的專業助理。',
  content: '規劃內容主題，將想法整理成可發布的文章與社群內容。',
  video: '製作可直接進入拍攝與剪輯流程的腳本、分鏡和後製指引。',
  ecommerce: '以可執行的營運素材，處理商品、商店與轉換問題。',
  office: '將文件、試算表、會議紀錄與來源資料整理成可交付成果。',
  research: '整理證據、比較觀點並建立學習計畫，同時清楚標示不確定之處。',
  family: '以清楚、實用的步驟規劃居家、家庭與親子任務。',
} as const;

function readLocalePresetCopy(locale: keyof typeof COPY_PROFILE_BY_LOCALE): LocalePresetCopy {
  const t = i18n.getFixedT(locale);
  return Object.fromEntries(
    EXPECTED_PRESET_ROOTS.map(([id, root]) => [
      id,
      Object.fromEntries(COPY_FIELDS.map((field) => [field, t(`${root}.${field}`)])) as PresetCopy,
    ]),
  );
}

function validatePresetCopies(locale: string, actual: LocalePresetCopy, expected: LocalePresetCopy): string[] {
  return EXPECTED_PRESET_ROOTS.flatMap(([id]) =>
    COPY_FIELDS.filter((field) => actual[id]?.[field] !== expected[id]?.[field]).map(
      (field) => `${locale}: ${id} ${field}`,
    ),
  );
}

describe('assistant task presets', () => {
  it('defines the stable task ids for all seven built-in assistants', () => {
    expect(ASSISTANT_TASK_IDS).toEqual({
      compass: ['goal-breakdown', 'execution-plan', 'option-comparison', 'comprehensive-analysis'],
      content: ['topic-planning', 'long-form-writing', 'short-video-script', 'rewrite-polish'],
      video: ['shooting-script', 'storyboard', 'editing-rhythm', 'title-cover'],
      ecommerce: ['product-copy', 'campaign-plan', 'competitor-analysis', 'review-customer-service'],
      office: ['document-writing', 'spreadsheet-analysis', 'meeting-minutes', 'presentation-outline'],
      research: ['source-organization', 'viewpoint-comparison', 'learning-plan', 'research-report'],
      family: ['travel-plan', 'family-checklist', 'purchase-comparison', 'schedule-plan'],
    });

    expect(ASSISTANT_TASK_PRESETS).toHaveLength(28);
    const presetIds = ASSISTANT_TASK_PRESETS.map((item) => item.id);
    expect(presetIds).toEqual([
      'compass:goal-breakdown',
      'compass:execution-plan',
      'compass:option-comparison',
      'compass:comprehensive-analysis',
      'content:topic-planning',
      'content:long-form-writing',
      'content:short-video-script',
      'content:rewrite-polish',
      'video:shooting-script',
      'video:storyboard',
      'video:editing-rhythm',
      'video:title-cover',
      'ecommerce:product-copy',
      'ecommerce:campaign-plan',
      'ecommerce:competitor-analysis',
      'ecommerce:review-customer-service',
      'office:document-writing',
      'office:spreadsheet-analysis',
      'office:meeting-minutes',
      'office:presentation-outline',
      'research:source-organization',
      'research:viewpoint-comparison',
      'research:learning-plan',
      'research:research-report',
      'family:travel-plan',
      'family:family-checklist',
      'family:purchase-comparison',
      'family:schedule-plan',
    ]);
    expect(new Set(presetIds).size).toBe(28);
  });

  it('defines four complete tasks for every built-in assistant', () => {
    expect(ASSISTANT_ID_BY_WORKSPACE).toEqual({
      compass: 'main',
      content: 'rongying-content',
      video: 'rongying-video',
      ecommerce: 'rongying-ecommerce',
      office: 'rongying-office',
      research: 'rongying-research',
      family: 'rongying-family',
    });

    for (const [workspaceKey, assistantId] of Object.entries(ASSISTANT_ID_BY_WORKSPACE)) {
      const presets = resolveAssistantTaskPresets(assistantId);
      expect(presets).toHaveLength(4);
      for (const [index, preset] of presets.entries()) {
        expect(preset.assistantId).toBe(assistantId);
        expect(preset.workspaceKey).toBe(workspaceKey);
        expect(preset.id).toBe(`${workspaceKey}:${ASSISTANT_TASK_IDS[preset.workspaceKey][index]}`);

        const keyPrefix = `assistantWorkspaces.${workspaceKey}.starters.${index + 1}`;
        expect(preset.titleKey).toBe(`${keyPrefix}.title`);
        expect(preset.descriptionKey).toBe(`${keyPrefix}.description`);
        expect(preset.promptKey).toBe(`${keyPrefix}.prompt`);
        expect(preset.materialHintKey).toBe(`${keyPrefix}.materialHint`);
        expect(preset.outputKey).toBe(`${keyPrefix}.output`);
        expect(preset.followUpPromptKey).toBe(`${keyPrefix}.followUpPrompt`);
      }
    }
  });

  it('maps every stable id to the intended six-field locale slot', () => {
    expect(
      ASSISTANT_TASK_PRESETS.map(
        ({ id, titleKey, descriptionKey, promptKey, materialHintKey, outputKey, followUpPromptKey }) => ({
          id,
          titleKey,
          descriptionKey,
          promptKey,
          materialHintKey,
          outputKey,
          followUpPromptKey,
        }),
      ),
    ).toEqual(
      EXPECTED_PRESET_ROOTS.map(([id, root]) => ({
        id,
        titleKey: `${root}.title`,
        descriptionKey: `${root}.description`,
        promptKey: `${root}.prompt`,
        materialHintKey: `${root}.materialHint`,
        outputKey: `${root}.output`,
        followUpPromptKey: `${root}.followUpPrompt`,
      })),
    );
  });

  it('matches exact six-field copy for all 28 canonical ids in all nine locales', () => {
    for (const [locale, profile] of Object.entries(COPY_PROFILE_BY_LOCALE) as Array<
      [keyof typeof COPY_PROFILE_BY_LOCALE, keyof typeof expectedPresetCopy]
    >) {
      const actual = readLocalePresetCopy(locale);
      const expected = expectedPresetCopy[profile] as LocalePresetCopy;
      expect(validatePresetCopies(locale, actual, expected), `${locale} exact preset copy`).toEqual([]);
    }
  });

  it('provides a non-empty task-specific follow-up prompt for every canonical preset', () => {
    for (const locale of Object.keys(COPY_PROFILE_BY_LOCALE) as Array<keyof typeof COPY_PROFILE_BY_LOCALE>) {
      const copy = readLocalePresetCopy(locale);
      const prompts = EXPECTED_PRESET_ROOTS.map(([id]) => copy[id].followUpPrompt.trim());
      expect(prompts.every(Boolean), `${locale} missing follow-up prompt`).toBe(true);
      expect(new Set(prompts).size, `${locale} follow-up prompts must be task-specific`).toBe(28);
    }
  });

  it('keeps remapped zh-TW metadata in natural Traditional Chinese instead of English fallback', () => {
    const actual = readLocalePresetCopy('zh-TW');
    const english = readLocalePresetCopy('en');

    for (const [id, fields] of Object.entries(ZH_TW_REMAPPED_METADATA_MARKERS)) {
      for (const field of ['materialHint', 'output'] as const) {
        expect(actual[id][field], `zh-TW: ${id} ${field} English fallback`).not.toBe(english[id][field]);
        for (const marker of fields[field]) {
          expect(actual[id][field], `zh-TW: ${id} ${field} missing ${marker}`).toContain(marker);
        }
      }
    }
  });

  it('keeps all zh-TW workspace and core task copy in natural Traditional Chinese instead of English fallback', () => {
    const zhTw = i18n.getFixedT('zh-TW');
    const english = i18n.getFixedT('en');
    const actual = readLocalePresetCopy('zh-TW');
    const englishPresetCopy = readLocalePresetCopy('en');

    for (const [workspaceKey, expectedDescription] of Object.entries(ZH_TW_WORKSPACE_DESCRIPTIONS)) {
      const key = `assistantWorkspaces.${workspaceKey}.description`;
      expect(zhTw(key), `zh-TW: ${workspaceKey} workspace description`).toBe(expectedDescription);
      expect(zhTw(key), `zh-TW: ${workspaceKey} workspace description English fallback`).not.toBe(english(key));
    }

    for (const [id] of EXPECTED_PRESET_ROOTS) {
      for (const field of ['title', 'description', 'prompt'] as const) {
        expect(actual[id][field], `zh-TW: ${id} ${field} English fallback`).not.toBe(englishPresetCopy[id][field]);
      }
    }
  });

  it('detects any canonical field copied from another preset', () => {
    const expected = expectedPresetCopy.en as LocalePresetCopy;
    const targetId = 'content:short-video-script';
    const sourceId = 'family:travel-plan';

    for (const field of COPY_FIELDS) {
      const mutated = structuredClone(expected);
      mutated[targetId][field] = mutated[sourceId][field];
      expect(validatePresetCopies('en', mutated, expected), `swapped ${field}`).toEqual([`en: ${targetId} ${field}`]);
    }
  });

  it('fails closed for a custom or unknown assistant', () => {
    expect(resolveAssistantTaskPresets('customer-imported-agent')).toEqual([]);
    expect(resolveAssistantTaskPresets('rongying-content-copy')).toEqual([]);
  });
});

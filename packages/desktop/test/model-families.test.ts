import { test, expect } from 'vitest';
import {
  isModelSelectable,
  modelFamilyKey,
  modelFamilyLabel,
  relayModelsFrom,
  RELAY_PROVIDER_ID,
} from '../src/renderer/components/ChatInput/model-families.js';

/**
 * 背景（2026-09-11）：模型下拉里堆着上千个我们服务不了的模型（openclaw 全量目录），
 * 用户选到就会失败、且请求根本不发出去。要「只列能用的 + 按家族分组」。
 */

test('家族取开头的连续字母 —— 数字和点属于版本号，不是家族名', () => {
  expect(modelFamilyKey('deepseek-v4-flash')).toBe('deepseek');
  expect(modelFamilyKey('qwen3.6-plus')).toBe('qwen');
  expect(modelFamilyKey('qwen-turbo')).toBe('qwen');
  expect(modelFamilyKey('glm-4.6')).toBe('glm');
});

test('同一个家族的不同版本归到一类', () => {
  const group = new Set(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v3.2', 'deepseek-r1'].map(modelFamilyKey));
  expect([...group]).toEqual(['deepseek']);
});

test('展示名用规范大小写', () => {
  expect(modelFamilyLabel('deepseek-v4-pro')).toBe('DeepSeek');
  expect(modelFamilyLabel('qwen3-max')).toBe('Qwen');
  expect(modelFamilyLabel('glm-4.6')).toBe('GLM');
});

test('认不出来归 other，**不猜** —— 猜错会把两个不相干的模型并到一起', () => {
  expect(modelFamilyKey('4x-turbo')).toBe('other');
  expect(modelFamilyLabel('4x-turbo')).toBe('其他');
});

test('首字母大写的输入也要认（模型名可能被规范化过）', () => {
  expect(modelFamilyKey('DeepSeek-V4-Flash')).toBe('deepseek');
});

test('中转 provider 的 id 就这一个 —— 改了要同步改筛法', () => {
  expect(RELAY_PROVIDER_ID).toBe('clawrouter');
});

/**
 * 背景（2026-09-12）：新任务（还没选模型）的模型标签显示成 `Claude Opus 5 (Claude CLI)`
 * —— 那是网关全量目录的第一条，一个我们用不了的模型。
 * 根因：下拉只列 clawrouter，但「当前模型」标签仍从全量目录里解析。
 * 修法：所有用目录的地方都先过 relayModelsFrom。
 */
const entry = (provider: string, id: string, name?: string) => ({ provider, id, name: name ?? id }) as never;

test('只留 clawrouter 的模型', () => {
  const all = [
    entry('claude-cli', 'claude-opus-5', 'Claude Opus 5 (Claude CLI)'),
    entry('clawrouter', 'deepseek-v4-flash'),
    entry('deepseek', 'deepseek-chat'),
    entry('clawrouter', 'qwen3-max'),
  ];
  expect(relayModelsFrom(all).map((m) => m.id)).toEqual(['deepseek-v4-flash', 'qwen3-max']);
});

test('过滤后为空是**正常结果**，不能退回全量目录', () => {
  // 网关只配了别的 provider 时就是这个样子。退回全量 = 用户又能选到用不了的模型。
  const onlyOthers = [entry('claude-cli', 'claude-opus-5'), entry('deepseek', 'deepseek-chat')];
  expect(relayModelsFrom(onlyOthers)).toEqual([]);
});

test('保持原顺序 —— 网关返回的顺序就是下拉里的展示顺序', () => {
  const all = [entry('clawrouter', 'qwen3-max'), entry('clawrouter', 'deepseek-r1'), entry('clawrouter', 'glm-4.6')];
  expect(relayModelsFrom(all).map((m) => m.id)).toEqual(['qwen3-max', 'deepseek-r1', 'glm-4.6']);
});

test('空目录进、空目录出（客户端冷启动拿不到目录的情况）', () => {
  expect(relayModelsFrom([])).toEqual([]);
});

/**
 * 背景（2026-09-12）：模型会从目录里下架，而**已有任务还记着老模型名**。
 * 不在发送前拦，体验是「能选中 → 发出去 → 报错」。
 */
const cat = [entry('clawrouter', 'deepseek-v4-flash'), entry('clawrouter', 'qwen-plus')];

test('模型在目录里 → 可发', () => {
  expect(isModelSelectable(cat, 'deepseek-v4-flash')).toBe(true);
});

test('模型不在目录里 → 拦住（这是「下架了」的确定信号）', () => {
  expect(isModelSelectable(cat, 'deepseek-r1')).toBe(false);
});

test('没选模型（用网关默认）→ 放行 —— 它不经过本地目录', () => {
  expect(isModelSelectable(cat, undefined)).toBe(true);
});

test('⚠️ 目录为空 → 放行，不能拦', () => {
  // 冷启动时 models.list 有 750ms 超时、目录可能还没到。
  // 此时拦会把**正常用户**挡住 —— 远比放过去让上游报错更糟。
  expect(isModelSelectable([], 'deepseek-r1')).toBe(true);
});

test('全量目录里非中转的模型不算「在目录里」（传进来之前应已过滤）', () => {
  // 这个函数假定收到的已经是 relayModelsFrom 的结果。防误用的文档性断言：
  const raw = [entry('claude-cli', 'claude-opus-5')];
  expect(isModelSelectable(raw, 'claude-opus-5')).toBe(true); // 未过滤时它会放行
  expect(isModelSelectable(relayModelsFrom(raw), 'claude-opus-5')).toBe(true); // 空目录 → 放行
  // ⇒ 所以调用方**必须**传过滤后的目录，否则拦不住。
  // 真实的调用点（useChatSend）传的就是过滤后的 modelCatalog。
});

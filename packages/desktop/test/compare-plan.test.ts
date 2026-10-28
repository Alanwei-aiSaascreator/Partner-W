// 多模型对比的**纯逻辑**：开哪几路、顺序、单列状态、能不能采纳。
// 这些判据是「并发 / 失败隔离 / 采纳」三件事的对错所在，所以先在这层钉死，
// UI 那层（compare-panel.test.tsx）只再验一遍渲染接线。
import { describe, expect, it } from 'vitest';
import { buildSessionKey, isClawWorkSession, parseTaskIdFromSessionKey } from '@clawwork/shared';
import {
  MAX_COMPARE_MODELS,
  MIN_COMPARE_MODELS,
  buildComparePlan,
  compareRuntimeForTask,
  compareSessionTaskId,
  dedupeCompareModels,
  deriveCompareViews,
  failedColumnCount,
  hasRunningColumn,
  isColumnAdoptable,
  isCompareSessionKey,
  normalizeCompareModels,
  settledColumnCount,
  validateCompareModels,
  type CompareRuntime,
} from '../src/renderer/features/compare/compare-plan';

const TASK_ID = 'task-1';
const REAL_DEVICE_ID = 'device-abc';

function plan(models: string[], compareId = 'c1') {
  const result = buildComparePlan({ taskId: TASK_ID, agentId: 'main', compareId, models });
  if (!result.ok) throw new Error(`expected ok plan, got ${result.error}`);
  return result.plan;
}

function runtime(models: string[]): CompareRuntime {
  const built = plan(models);
  return { taskId: TASK_ID, compareId: 'c1', prompt: '你好', columns: built.columns, startedAt: 0 };
}

/** 一条什么都没发生的实时状态（每列都还是 pending）。 */
function emptyLive() {
  return {
    activeTurnBySession: {} as Record<string, never>,
    processingBySession: new Set<string>(),
    errorBySession: {} as Record<string, string>,
    runPhaseBySession: {} as Record<string, string | null>,
  };
}

describe('对比的列计划', () => {
  it('每个模型开一条独立会话，顺序 = 用户勾选的顺序', () => {
    const built = plan(['qwen-plus', 'glm-4.7', 'kimi-k2']);
    expect(built.columns.map((c) => c.model)).toEqual(['qwen-plus', 'glm-4.7', 'kimi-k2']);
    expect(built.columns.map((c) => c.index)).toEqual([0, 1, 2]);
    // 三条键互不相同 —— 同一句话问同一个会话 N 遍就成了自问自答，不是对比
    expect(new Set(built.columns.map((c) => c.sessionKey)).size).toBe(3);
  });

  it('会话键解析回**真**任务（事件路由要用），但不算这个设备的普通会话（发现要过滤掉）', () => {
    const [first] = plan(['a-model', 'b-model']).columns;
    expect(parseTaskIdFromSessionKey(first.sessionKey)).toBe(TASK_ID);
    expect(isCompareSessionKey(first.sessionKey)).toBe(true);
    expect(compareSessionTaskId(first.sessionKey)).toBe(TASK_ID);
    // ⚠️ 这条是"对比列不会被当成新任务导进列表"的机制：主进程按真 deviceId 过滤
    expect(isClawWorkSession(first.sessionKey, REAL_DEVICE_ID)).toBe(false);
    expect(isClawWorkSession(buildSessionKey(TASK_ID, 'main', REAL_DEVICE_ID), REAL_DEVICE_ID)).toBe(true);
  });

  it('同一轮里两列的会话键不同；换一轮（新 compareId）不复用上一轮的会话', () => {
    const first = plan(['a-model', 'b-model'], 'run-1');
    const second = plan(['a-model', 'b-model'], 'run-2');
    expect(first.columns.map((c) => c.sessionKey)).not.toEqual(second.columns.map((c) => c.sessionKey));
  });

  it('去空、保序去重：同一个模型勾两次只开一路', () => {
    expect(dedupeCompareModels([' a ', 'b', 'a', '', '  ', null, undefined])).toEqual(['a', 'b']);
    expect(plan(['a', 'b', 'a']).columns.map((c) => c.model)).toEqual(['a', 'b']);
  });

  it('少于 2 个不给跑，多于 4 个按「截断前」的数量报错（不悄悄丢掉第 5 个）', () => {
    expect(validateCompareModels([])).toBe('too-few-models');
    expect(validateCompareModels(['only-one'])).toBe('too-few-models');
    expect(validateCompareModels(['a', 'a', 'b'])).toBeNull();
    expect(validateCompareModels(['a', 'b', 'c', 'd'])).toBeNull();
    expect(validateCompareModels(['a', 'b', 'c', 'd', 'e'])).toBe('too-many-models');
    // 只勾了 4 个但因为重复算成 5 个，也不该被拦
    expect(validateCompareModels(['a', 'b', 'c', 'd', 'd'])).toBeNull();

    const tooMany = buildComparePlan({
      taskId: TASK_ID,
      agentId: 'main',
      compareId: 'c',
      models: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(tooMany).toEqual({ ok: false, error: 'too-many-models' });
    expect(normalizeCompareModels(['a', 'b', 'c', 'd', 'e'])).toHaveLength(MAX_COMPARE_MODELS);
    expect(MIN_COMPARE_MODELS).toBe(2);
  });

  it('没有任务就没有列（会话键必须有归属的任务）', () => {
    expect(buildComparePlan({ taskId: '', agentId: 'main', compareId: 'c', models: ['a', 'b'] })).toEqual({
      ok: false,
      error: 'no-task',
    });
  });

  it('普通会话键不会被误判成对比列', () => {
    expect(isCompareSessionKey(buildSessionKey(TASK_ID, 'main', REAL_DEVICE_ID))).toBe(false);
    expect(isCompareSessionKey('随便一个字符串')).toBe(false);
  });
});

describe('列的实时状态推导', () => {
  const [a, b, c] = runtime(['a-model', 'b-model', 'c-model']).columns;

  it('刚开跑：三列都是 pending，谁都还没回话', () => {
    const views = deriveCompareViews(runtime(['a-model', 'b-model', 'c-model']), emptyLive());
    expect(views.map((v) => v.status)).toEqual(['pending', 'pending', 'pending']);
    expect(views.map((v) => v.text)).toEqual(['', '', '']);
  });

  it('谁先回谁先显示，但**顺序不动**（第 2 列永远是第 2 列）', () => {
    const live = {
      ...emptyLive(),
      activeTurnBySession: {
        [c.sessionKey]: { finalized: false, content: '', streamingText: '我先出的字', streamingThinking: '' },
        [a.sessionKey]: { finalized: false, content: '', streamingText: '后出的字', streamingThinking: '' },
      },
    };
    const views = deriveCompareViews(runtime(['a-model', 'b-model', 'c-model']), live);
    expect(views.map((v) => v.sessionKey)).toEqual([a.sessionKey, b.sessionKey, c.sessionKey]);
    expect(views.map((v) => v.status)).toEqual(['streaming', 'pending', 'streaming']);
    expect(views[2].text).toBe('我先出的字');
    expect(views[0].text).toBe('后出的字');
  });

  it('跑完的列用 content（流式那份已被搬走并清空），并可以采纳', () => {
    const live = {
      ...emptyLive(),
      activeTurnBySession: {
        [a.sessionKey]: {
          finalized: true,
          content: '最终答案',
          streamingText: '',
          thinkingContent: '推理过程',
          streamingThinking: '',
        },
      },
    };
    const [viewA] = deriveCompareViews(runtime(['a-model', 'b-model']), live);
    expect(viewA.status).toBe('done');
    expect(viewA.text).toBe('最终答案');
    expect(viewA.thinking).toBe('推理过程');
    expect(isColumnAdoptable(viewA)).toBe(true);
  });

  it('跑完但正文为空不能采纳（只出了推理或什么都没出）', () => {
    const live = {
      ...emptyLive(),
      activeTurnBySession: {
        [a.sessionKey]: {
          finalized: true,
          content: '',
          streamingText: '',
          thinkingContent: '只推理了',
          streamingThinking: '',
        },
      },
    };
    const [viewA] = deriveCompareViews(runtime(['a-model', 'b-model']), live);
    expect(viewA.status).toBe('done');
    expect(isColumnAdoptable(viewA)).toBe(false);
  });

  it('一列挂掉只影响那一列：错误是终态（哪怕还残留着半截正文），其余列照跑', () => {
    const live = {
      ...emptyLive(),
      activeTurnBySession: {
        [b.sessionKey]: { finalized: false, content: '', streamingText: '它在正常出字', streamingThinking: '' },
        [c.sessionKey]: { finalized: false, content: '', streamingText: '挂之前出的半截', streamingThinking: '' },
      },
      errorBySession: { [c.sessionKey]: '额度不足' },
    };
    const views = deriveCompareViews(runtime(['a-model', 'b-model', 'c-model']), live);
    expect(views.map((v) => v.status)).toEqual(['pending', 'streaming', 'error']);
    expect(views[2].error).toBe('额度不足');
    expect(isColumnAdoptable(views[2])).toBe(false);
    // 汇总只报"几路失败"，不改任何单列状态
    expect(failedColumnCount(views)).toBe(1);
    expect(settledColumnCount(views)).toBe(1);
    expect(hasRunningColumn(views)).toBe(true);
  });

  it('全部落定（有的成、有的败）后没有在跑的列', () => {
    const live = {
      ...emptyLive(),
      activeTurnBySession: {
        [a.sessionKey]: { finalized: true, content: '答', streamingText: '', streamingThinking: '' },
      },
      errorBySession: { [b.sessionKey]: '超时', [c.sessionKey]: '上游 500' },
    };
    const views = deriveCompareViews(runtime(['a-model', 'b-model', 'c-model']), live);
    expect(settledColumnCount(views)).toBe(3);
    expect(failedColumnCount(views)).toBe(2);
    expect(hasRunningColumn(views)).toBe(false);
  });

  it('processing 标了也算在跑（还没拿到第一个 delta 的那一段）', () => {
    const live = { ...emptyLive(), processingBySession: new Set([b.sessionKey]) };
    const views = deriveCompareViews(runtime(['a-model', 'b-model']), live);
    expect(views.map((v) => v.status)).toEqual(['pending', 'streaming']);
  });
});

describe('对比归属：这一轮是不是**这个任务**的', () => {
  it('同一个任务才认；别的任务、没有任务、没有对比都不认', () => {
    const active = runtime(['a-model', 'b-model']);

    expect(compareRuntimeForTask(active, TASK_ID)).toBe(active);
    // ⚠️ 这一条是"在任务 B 里还能不能发消息"的判据：`active` 是全局唯一的，
    //    而用户可以切任务 —— 不判任务身份的话，任务 A 里跑着的一轮会让任务 B
    //    一个字都发不出去，可用户眼前这一屏根本没有对比面板。
    expect(compareRuntimeForTask(active, 'task-2')).toBeNull();
    expect(compareRuntimeForTask(active, null)).toBeNull();
    expect(compareRuntimeForTask(active, undefined)).toBeNull();
    expect(compareRuntimeForTask(null, TASK_ID)).toBeNull();
    expect(compareRuntimeForTask(undefined, TASK_ID)).toBeNull();
  });
});

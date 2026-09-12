/**
 * 思考档位「该给用户看哪些」。
 *
 * ## 为什么不能写死
 *
 * UI 原本写死 6 档（`THINKING_LEVELS`，含 `adaptive`），但**档位是逐模型的**：
 * 2026-09-11 实测 11 个中转模型里 **8 个只支持 `off`**，`adaptive` 则**没有任何模型支持**。
 * 于是用户点「中」必然失败，网关原文：
 * `thinkingLevel "minimal" is not supported for clawrouter/deepseek-r1 (use off)`。
 *
 * ⚠️ 目录里的 `thinkingLevels` **不是模型的真实能力**（见
 * `docs/superpowers/plans/2026-09-11-模型子系统.md` §1.2）：relay 只声明 `llm.chat`，
 * 档位是 openclaw 按模型 id 推导的。但它与**网关实际接受的档位**同源
 *（网关既用它生成目录，也用它校验 `sessions.patch`），所以按它渲染是**不会失败**的 ——
 * 这正是我们要的。真实能力的修复在 relay 侧，不在客户端。
 *
 * ## 数据缺失时怎么办（回滚行为）
 *
 * 拿不到 `thinkingLevels` 时**退回固定 6 档**（= 今天的行为），而不是只给 `off`：
 * 数据缺失时我们并不知道哪些档可用，只给 `off` 会平白砍掉可用功能；
 * 而在 P0-2 之后，真选错了也会看到网关原文，代价已经小得多。
 */
import type { ModelCatalogEntry } from '@clawwork/shared';
import { THINKING_LABEL_KEYS, THINKING_LEVELS } from './constants';

/** 拿不到目录数据时的回退档位（= 加上能力渲染之前的行为，可作回滚）。 */
export const FALLBACK_THINKING_LEVELS: string[] = [...THINKING_LEVELS];

export interface ThinkingMenu {
  /** 展示哪些档位（协议 id，数组顺序即展示顺序）。 */
  levels: string[];
  /**
   * 该模型只有一档 → 按钮应置灰。
   * 置灰而不是隐藏：隐藏会让用户以为界面坏了。
   */
  locked: boolean;
}

function readRawLevels(entry?: ModelCatalogEntry): unknown {
  return (entry as { thinkingLevels?: unknown } | undefined)?.thinkingLevels;
}

/**
 * 某个模型支持哪些档位。
 * 目录里可能出现我们没见过的 id（openclaw 还有 `xhigh`/`max`），**原样透传、不丢** ——
 * 丢掉会导致「档位存在但界面没有」，比多一个陌生选项更难查。
 */
export function thinkingLevelsFor(entry?: ModelCatalogEntry): string[] {
  const raw = readRawLevels(entry);
  if (!Array.isArray(raw)) return FALLBACK_THINKING_LEVELS;
  const ids = raw
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        const id = (item as { id?: unknown }).id;
        return typeof id === 'string' ? id.trim() : '';
      }
      return '';
    })
    .filter((id) => id.length > 0);
  return ids.length > 0 ? ids : FALLBACK_THINKING_LEVELS;
}

/** 该模型的默认档位；没有声明时取它的第一档。 */
export function thinkingDefaultFor(entry?: ModelCatalogEntry): string {
  const declared = (entry as { thinkingDefault?: unknown } | undefined)?.thinkingDefault;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  return thinkingLevelsFor(entry)[0] ?? 'off';
}

/** 某个档位在该模型上能不能用。拿不到目录数据时一律放行（回滚行为）。 */
export function isThinkingSupported(entry: ModelCatalogEntry | undefined, level: string): boolean {
  if (!Array.isArray(readRawLevels(entry))) return true;
  return thinkingLevelsFor(entry).includes(level);
}

/** 下拉该渲染成什么样。 */
export function thinkingMenuFor(entry?: ModelCatalogEntry): ThinkingMenu {
  const levels = thinkingLevelsFor(entry);
  return { levels, locked: levels.length <= 1 };
}

/**
 * 已知档位的 i18n key；**未知档位返回 null**，界面直接显示协议 id
 *（宁可显示 `xhigh` 也不显示空白或猜一个中文）。
 */
export function thinkingLabelKey(level: string): string | null {
  return (THINKING_LABEL_KEYS as Record<string, string>)[level] ?? null;
}

/**
 * 这个模型是不是「关不掉思考」？是的话返回该显示的说明文案 key，否则 null。
 *
 * ## 为什么要专门标这个
 *
 * 有些模型**根本没有「关闭」档** —— 它们只收 `low` 及以上（实测：
 * `deepseek-v4-pro`、`MiniMax-M2.5` 都不接受 `reasoning_effort: none`）。
 * 菜单里没有「关闭」是**真实能力**，不是 bug。
 *
 * 但用户看到「旗舰模型的菜单里居然没有关闭」时，第一反应是**我们的界面坏了**。
 * 标一句「深度思考常开」，把「能力如此」和「功能坏了」区分开。
 *
 * ⚠️ 判据是「`thinkingLevels` 里没有 `off`」，**不是**「只有一档」——
 * 只有一档是 `locked`（按钮置灰），那是另一种状态。
 * ⚠️ 拿不到目录数据时返回 null（不标）：那时候我们并不知道它支不支持。
 */
export function thinkingAlwaysOnKey(entry?: ModelCatalogEntry): string | null {
  if (!Array.isArray(readRawLevels(entry))) return null;
  return thinkingLevelsFor(entry).includes('off') ? null : 'chatInput.thinkingAlwaysOn';
}

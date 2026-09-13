import { expect, type Page } from '@playwright/test';

/**
 * 输入区**模型下拉**的交互 —— 给"同会话切模型"那类用例用。
 *
 * 基础形状取自 `commercial-activation.spec.ts` 场景 3（那份已在真机跑通），
 * 但它只解决了"目标在**第一个**分组里"的情况，本文件补上了第二个分组。
 *
 * 为什么这么啰嗦，全是实测踩出来的：
 *
 *   ⚠️ 菜单是**两级**的（一级按模型**家族**分组、叶子在二级）—— Radix 不展开
 *      二级就**根本不渲染**叶子。所以必须逐个 hover 一级，用 `aria-expanded`
 *      **断言它真的开了**，再去找叶子。
 *   ⚠️ 一级分组名是 `modelFamilyLabel`（DeepSeek/Qwen/…）**不是** provider ——
 *      按 `clawrouter` 找会白等。
 *   ⚠️ 叶子项的文本**不是干净的模型名**：实测是 `"deepseek-v4-pro\nR\n1M"`
 *      （带 reasoning / 上下文徽章）⇒ `getByText(name, {exact:true})` 必然点不中，
 *      必须 `getByRole('menuitem').filter({hasText})`。
 *   ⚠️ 每个动作都显式给 `timeout`：Playwright 的 `actionTimeout` 默认是 **0（不超时）**，
 *      元素不出现就会一直挂到用例超时，报出来完全看不出卡在哪一步。
 *   ⚠️ **换分组必须重新开一次菜单**（2026-09-13 实测踩到）：连着 hover 第二个一级
 *      分组时它**不展开** —— `aria-expanded` 连试 9 次都是 `false`，因为上一个分组的
 *      子菜单还开着、指针没有"重新进入"的事件。修法是每组之前 `Escape` 关掉再点开。
 */

/** 下拉触发器（输入区那个显示当前模型的按钮）。 */
function trigger(page: Page): ReturnType<Page['locator']> {
  return page.locator('button:has(span.max-w-36)').first();
}

/** 当前选中的模型展示名（触发器上的文本）。 */
export async function currentModelLabel(page: Page): Promise<string> {
  const t = trigger(page);
  await t.waitFor({ state: 'visible', timeout: 30_000 });
  return (await t.innerText()).trim();
}

/**
 * 打开下拉并选中展示名为 `modelName` 的模型。
 *
 * 返回**不代表生效** —— 调用方必须再断言一次触发器文本（点中了 ≠ 选中了）。
 */
export async function pickModel(page: Page, modelName: string): Promise<void> {
  const t = trigger(page);
  await t.waitFor({ state: 'visible', timeout: 30_000 });

  const leaf = (): ReturnType<Page['getByRole']> => page.getByRole('menuitem').filter({ hasText: modelName });
  const subs = page.locator('[role="menuitem"][aria-haspopup="menu"]');

  const openMenu = async (): Promise<void> => {
    // ⚠️ 菜单是**异步挂上去的**（Radix 有进出场动画）。必须等元素出现，
    //    不能只 sleep —— 实测那个点上 menuitem 数还是 0，展开循环一次都不跑。
    await t.click({ timeout: 15_000 });
    await subs.first().waitFor({ state: 'visible', timeout: 20_000 });
  };

  await openMenu();
  const subCount = await subs.count();
  expect(subCount, '模型下拉里一个分组都没有').toBeGreaterThan(0);

  for (let i = 0; i < subCount; i++) {
    if (i > 0) {
      // ⚠️ 见文件头：不重开菜单，第二个分组 hover 不开。
      await page.keyboard.press('Escape');
      await expect(subs.first()).toBeHidden({ timeout: 10_000 });
      await openMenu();
    }
    await subs.nth(i).hover({ timeout: 10_000 });
    await expect(subs.nth(i), `第 ${i + 1} 个分组 hover 之后没展开`).toHaveAttribute('aria-expanded', 'true', {
      timeout: 5_000,
    });
    if ((await leaf().count()) > 0) {
      await expect(leaf().first()).toBeVisible({ timeout: 10_000 });
      await leaf().first().click({ timeout: 15_000 });
      await expect(leaf().first()).toBeHidden({ timeout: 15_000 }); // 菜单关掉了才算点完
      return;
    }
  }
  throw new Error(`展开了全部 ${subCount} 个分组都没找到模型 ${modelName}`);
}

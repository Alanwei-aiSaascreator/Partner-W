import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUR_SKILLS_DIR_NAME, resolveOurSkillsRoot } from '../src/main/skills/locate.js';

/**
 * 「我们自己的技能」随包根目录在**两种形态**下的位置（T-a2）。
 *
 * 形状照抄 `kb/embedding/locate.ts` 与 `runtime/locate.ts`：纯函数、`isPackaged` 与路径
 * 由调用方注入、本模块不 import electron —— 这样"开发态好好的、装出来就找不到"这类问题
 * 能在单测里直接覆盖，不用真打一次包。
 */
describe('resolveOurSkillsRoot', () => {
  it('打包态 ⇒ `<resources>/our-skills`', () => {
    expect(resolveOurSkillsRoot({ isPackaged: true, resourcesPath: 'C:\\app\\resources' })).toBe(
      path.join('C:\\app\\resources', OUR_SKILLS_DIR_NAME),
    );
  });

  it('打包态但拿不到 resourcesPath ⇒ undefined（宁可没有，也不要一个瞎猜的路径）', () => {
    expect(resolveOurSkillsRoot({ isPackaged: true })).toBeUndefined();
  });

  it('开发态 ⇒ `<appPath>/our-skills`（= packages/desktop/our-skills，与 extraResources 的源同一个目录）', () => {
    expect(resolveOurSkillsRoot({ isPackaged: false, appPath: 'D:\\repo\\packages\\desktop' })).toBe(
      path.join('D:\\repo\\packages\\desktop', OUR_SKILLS_DIR_NAME),
    );
  });

  it('开发态但拿不到 appPath ⇒ undefined', () => {
    expect(resolveOurSkillsRoot({ isPackaged: false })).toBeUndefined();
  });

  it('用 path.join 而不是手拼（手拼在 Windows 上得到 `C:/a/b`，跟别处拼出来的字符串不相等）', () => {
    const root = resolveOurSkillsRoot({ isPackaged: true, resourcesPath: 'C:\\app\\resources' });
    expect(root).not.toContain('/');
  });
});

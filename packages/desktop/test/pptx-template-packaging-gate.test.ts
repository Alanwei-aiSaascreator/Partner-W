import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PPTX_BLANK_ROOT_FILE, PPTX_TEMPLATE_FILE } from '../src/main/docgen/pptx-template/catalog';
import { PPTX_TEMPLATES_DIR_NAME, resolvePptxTemplatesRoot } from '../src/main/docgen/pptx-template/locate';

/**
 * 打包门禁：**模板必须在包里、且找得到**。
 *
 * 这一类缺陷的形状是最坏的那种 —— **开发态一切正常，装出来就废**：
 * `extraResources` 漏了 → 模板目录不在 `<resources>` 下 → 每次生成都失败，
 * 而开发机上跑什么都绿。所以两边各钉一条：
 *  ① 定位函数在打包态就是 `<resources>/pptx-templates`（纯函数，不用真打包）；
 *  ② `electron-builder.yml` 里真的有一条把那个目录映射过去、
 *     且 `to:` 与 `PPTX_TEMPLATES_DIR_NAME` **一字不差**。
 */

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('模板目录定位', () => {
  it('打包态 = <resources>/pptx-templates（真机上是 process.resourcesPath）', () => {
    const root = resolvePptxTemplatesRoot({ isPackaged: true, resourcesPath: 'C:\\app\\resources' });
    expect(root).toBe(join('C:\\app\\resources', PPTX_TEMPLATES_DIR_NAME));
  });

  it('开发态 = <packages/desktop>/resources/pptx-templates', () => {
    const root = resolvePptxTemplatesRoot({ isPackaged: false, appPath: 'D:\\repo\\packages\\desktop' });
    expect(root).toBe(join('D:\\repo\\packages\\desktop', 'resources', PPTX_TEMPLATES_DIR_NAME));
  });

  it('两条路都不许"猜"一个兜底路径：给不出输入就返回 undefined', () => {
    expect(resolvePptxTemplatesRoot({ isPackaged: true })).toBeUndefined();
    expect(resolvePptxTemplatesRoot({ isPackaged: false })).toBeUndefined();
  });

  it('开发态那条真的指到一个存在的目录（定位函数与仓库布局是对上的）', () => {
    const root = resolvePptxTemplatesRoot({ isPackaged: false, appPath: PACKAGE_ROOT });
    expect(root).toBeDefined();
    expect(existsSync(root!)).toBe(true);
  });

  it('两个模板文件都在（模板集 + 零页根）', () => {
    const root = resolvePptxTemplatesRoot({ isPackaged: false, appPath: PACKAGE_ROOT })!;
    expect(existsSync(join(root, PPTX_TEMPLATE_FILE)), `缺 ${PPTX_TEMPLATE_FILE}`).toBe(true);
    expect(existsSync(join(root, PPTX_BLANK_ROOT_FILE)), `缺 ${PPTX_BLANK_ROOT_FILE}`).toBe(true);
  });
});

describe('electron-builder.yml 的 extraResources', () => {
  const yml = readFileSync(join(PACKAGE_ROOT, 'electron-builder.yml'), 'utf8');

  it('有一条把 resources/pptx-templates 映射到 <resources>/pptx-templates', () => {
    // `from` 的基准是 projectDir（= packages/desktop），所以写 `resources/pptx-templates`。
    expect(yml).toContain('from: resources/pptx-templates');
  });

  it('⭐ `to:` 与 locate.ts 的 PPTX_TEMPLATES_DIR_NAME 一字不差', () => {
    const to = new RegExp(`from:\\s*resources/pptx-templates\\s*\\n\\s*to:\\s*(\\S+)`).exec(yml)?.[1];
    expect(to).toBe(PPTX_TEMPLATES_DIR_NAME);
  });

  it('模板走 extraResources 而不是打进 app.asar（asar 里是虚拟路径，读不了）', () => {
    // 断言它**没有**出现在 `files:` 段里 —— 那会把 .pptx 塞进 asar。
    const filesSection = yml.slice(yml.indexOf('\nfiles:'));
    expect(filesSection).not.toContain('pptx-templates');
  });
});

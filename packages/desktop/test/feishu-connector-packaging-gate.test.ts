import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 打包门禁：「连接器 · 飞书」的**自带安装**资源必须真的进包。
 *
 * 2026-10-17 用户要求「自带安装」：插件 tgz 随包发出，客户第一次接入不联网。
 * 这条断言钉住三件事 ——
 *   ① `electron-builder.yml` 里有 `resources/connectors → connectors` 这一条；
 *   ② `feishu.ts` 的目录名常量与 yml 的 `to:` 一字不差（漂移=运行时找不到 tgz）；
 *   ③ tgz 文件真的在仓库里且不是空壳（空文件会让 install 在客户盘上失败）。
 *
 * ⚠️ 故意不读 tgz 内容（4.9MB）——只验存在与大小，避免把大文件读进内存。
 */
const DESKTOP_ROOT = process.cwd();

describe('飞书连接器（自带安装）打包门禁', () => {
  it('electron-builder.yml 把 resources/connectors 发到 <resources>/connectors', () => {
    const yml = readFileSync(join(DESKTOP_ROOT, 'electron-builder.yml'), 'utf8');
    expect(yml, '缺 connectors 的 extraResources 条目 ⇒ 包里没有插件 tgz').toMatch(
      /- from: resources\/connectors\s*\n\s*to: connectors/,
    );
  });

  it('目录名常量与 yml 的 to: 一致', async () => {
    const { FEISHU_PLUGIN_DIR_NAME } = await import('../src/main/connectors/feishu.js');
    const yml = readFileSync(join(DESKTOP_ROOT, 'electron-builder.yml'), 'utf8');
    expect(yml).toContain(`to: ${FEISHU_PLUGIN_DIR_NAME}`);
  });

  it('随包插件是**已解压目录**（有 package.json + dist），不是 tgz —— 实机 tar 解压会 120s 超时', async () => {
    const { FEISHU_PLUGIN_PACKAGE_DIR } = await import('../src/main/connectors/feishu.js');
    const dir = join(DESKTOP_ROOT, 'resources', 'connectors', FEISHU_PLUGIN_PACKAGE_DIR);
    expect(existsSync(join(dir, 'package.json')), `缺 ${dir}/package.json ⇒ 自带安装退化为联网下载`).toBe(true);
    expect(existsSync(join(dir, 'dist')), '缺 dist ⇒ 插件装上也加载不了').toBe(true);
    expect(statSync(join(dir, 'package.json')).isFile()).toBe(true);
  });
});

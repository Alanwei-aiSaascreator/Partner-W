import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAWROUTER_ENTRY,
  DEPLOYMENT_STAMP_FILE,
  ensureRuntimeDeployed,
  readCurrentDeployment,
  writeCurrentPointer,
} from '../src/main/runtime/deploy.js';
import { nodeCandidates, pickNode, probeNodeVersion } from '../src/main/runtime/node-runtime.js';
import {
  SUPPORTED_NODE_RANGE,
  buildSource,
  deployOpts,
  FIXTURE_NOW,
  isSupportedNode,
  newUserData,
  sha256File,
} from './helpers/runtime-fixture.js';

/**
 * 部署**布局**的验收 —— 硬缺口 ①（Node 一起进本机缓存）与 ④（确定的指针）。
 *
 * 主线验收剧本里的第 3 幕「拔盘后重启」就靠这里钉住的形状：
 * U 盘拔掉之后，`current.json` + `deployed/<key>/` 必须**自己就能跑**。
 * 所以本文件的每一条都在问同一个问题：**这份缓存离开源目录还成不成立？**
 *
 * ⚠️ 会话安全：只在 mkdtemp 里活动，绝不触碰真实 `%APPDATA%`。
 * 「拔盘」用**重命名源目录**来模拟（不是 `rm -rf`，也不需要真插拔盘）。
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-layout-'));
});

afterEach(() => {
  if (tmpRoot && tmpRoot.includes(path.join(os.tmpdir(), 'clawwork-layout-'))) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

/** 模拟拔盘：把整个源目录挪走（内容一个字节都不动）。 */
function unplugUsb(fx: { root: string }): string {
  const gone = `${fx.root}-unplugged`;
  fs.renameSync(fx.root, gone);
  return gone;
}

describe('部署布局：本机缓存自包含', () => {
  it('⭐ 首次部署后 deployed/<key>/node/node.exe 存在，且与源逐字节一致', async () => {
    const fx = buildSource(tmpRoot);
    const userDataDir = newUserData(tmpRoot, 'u1');

    const res = await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    const deployedNode = path.join(res.deployedRoot, 'node', 'node.exe');
    expect(fs.existsSync(deployedNode)).toBe(true);
    expect(fs.readFileSync(deployedNode)).toEqual(fs.readFileSync(fx.nodeExePath));
    expect(sha256File(deployedNode)).toBe(fx.node.sha256);
    // 许可跟着一起进来（不是可选项，是合规）
    expect(fs.existsSync(path.join(res.deployedRoot, 'node', 'LICENSE'))).toBe(true);
  });

  it('⭐ 部署后运行期**完全不依赖源**：拔盘后 current.json 指向的那份仍能给出 node 与入口', async () => {
    const fx = buildSource(tmpRoot);
    const userDataDir = newUserData(tmpRoot, 'u2');
    const res = await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    unplugUsb(fx);

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('ok');
    expect(cur.deploymentKey).toBe(res.deploymentKey);

    // node 必须来自**本机缓存**，不是盘上那个（盘已经不在了）
    expect(cur.nodePath).toBe(path.join(res.deployedRoot, 'node', 'node.exe'));
    expect(cur.nodePath!.startsWith(res.deployedRoot)).toBe(true);
    expect(fs.existsSync(cur.nodePath!)).toBe(true);
    expect(sha256File(cur.nodePath!)).toBe(fx.node.sha256);

    // 入口同样在（这是 spawn 网关的两个输入）
    expect(fs.existsSync(cur.cliPath!)).toBe(true);
    expect(fs.existsSync(path.join(res.deployedRoot, CLAWROUTER_ENTRY))).toBe(true);
  });

  it('⭐ 拔盘后重跑部署走快路径（skipped）—— 热路径一次都不碰源目录', async () => {
    const fx = buildSource(tmpRoot);
    const userDataDir = newUserData(tmpRoot, 'u3');
    await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    unplugUsb(fx);

    // 源整个不在了还能 skipped ⇒ 证明快路径既不解压、也不读源上的任何文件
    const res = await ensureRuntimeDeployed({
      ...deployOpts(fx, userDataDir),
      extract: () => {
        throw new Error('快路径不该解压');
      },
    });
    expect(res.status).toBe('skipped');
    expect(fs.existsSync(res.nodePath)).toBe(true);
  });

  it('缓存里有自描述的 manifest 副本', async () => {
    const fx = buildSource(tmpRoot);
    const userDataDir = newUserData(tmpRoot, 'u4');
    const res = await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    const cached = path.join(res.deployedRoot, 'manifest.json');
    expect(fs.existsSync(cached)).toBe(true);
    expect(JSON.parse(fs.readFileSync(cached, 'utf-8'))).toEqual(JSON.parse(fs.readFileSync(fx.manifestPath, 'utf-8')));
  });

  it('⭐ 换了 Node（同一份归档）⇒ 部署到**另一个**目录，旧目录原封不动', async () => {
    const fx = buildSource(tmpRoot, { dirName: 'usb-a' });
    const userDataDir = newUserData(tmpRoot, 'u5');
    const first = await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    // 盘上换了 Node（归档一个字节没变）—— Node 是**真正被执行的东西**，必须进身份
    const fx2 = buildSource(tmpRoot, { dirName: 'usb-b', nodeContent: Buffer.from('MZ a different node\n') });
    expect(fx2.runtime.sha256).toBe(fx.runtime.sha256); // 归档确实相同
    expect(fx2.node.sha256).not.toBe(fx.node.sha256);

    const second = await ensureRuntimeDeployed(deployOpts(fx2, userDataDir));

    expect(second.deploymentKey).not.toBe(first.deploymentKey);
    expect(second.deployedRoot).not.toBe(first.deployedRoot);
    // 旧的没被清掉、也没被改（多版本共存不在本阶段范围，但"不误删"是底线）
    expect(fs.existsSync(path.join(first.deployedRoot, DEPLOYMENT_STAMP_FILE))).toBe(true);
    expect(sha256File(path.join(first.deployedRoot, 'node', 'node.exe'))).toBe(fx.node.sha256);
  });

  it('⭐ 指针指回旧的部署 ⇒ 用旧的那份 node 与入口（不是"最新的"）', async () => {
    const fx = buildSource(tmpRoot, { dirName: 'usb-a' });
    const userDataDir = newUserData(tmpRoot, 'u6');
    const first = await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    const fx2 = buildSource(tmpRoot, { dirName: 'usb-b', nodeContent: Buffer.from('MZ a different node\n') });
    const second = await ensureRuntimeDeployed(deployOpts(fx2, userDataDir));
    expect(second.deploymentKey).not.toBe(first.deploymentKey);

    // 把指针拨回 A：**指针说了算**，哪怕 B 是更晚部署的
    writeCurrentPointer(userDataDir, first.deploymentKey, () => FIXTURE_NOW);

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('ok');
    expect(cur.deploymentKey).toBe(first.deploymentKey);
    expect(sha256File(cur.nodePath!)).toBe(fx.node.sha256);
  });

  it('⭐ 拔盘后 pickNode 仍能选到**本机**那份 node（方案 #4 的字面验收）', async () => {
    const fx = buildSource(tmpRoot);
    const userDataDir = newUserData(tmpRoot, 'u8');
    await ensureRuntimeDeployed(deployOpts(fx, userDataDir));
    const unpluggedRoot = unplugUsb(fx);

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('ok');

    const res = pickNode({
      candidates: nodeCandidates({
        deployedNodePath: cur.nodePath,
        sourceNodePath: path.join(unpluggedRoot, 'node', 'node.exe'),
      }),
      // 本机那份 node.exe 是 fixture 造的假文件（真 100MB 二进制不该进单测），
      // 所以只对它注入版本号；对"盘上那份"用**真探针** —— 它确实不存在，真返回 null。
      probe: (exe) => (exe === cur.nodePath ? '26.3.1' : probeNodeVersion(exe)),
      isSupported: isSupportedNode,
      supportedRange: SUPPORTED_NODE_RANGE,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.node.origin).toBe('deployed');
    expect(res.node.exe).toBe(cur.nodePath);
    // 本机那份合格 ⇒ **根本没去探盘上那个**（短路，盘拔了也不影响）
    expect(res.attempts.some((a) => a.origin === 'source')).toBe(false);
    // 独立确认"盘上那份确实探不到"：走真 execFileSync，不是模拟
    expect(probeNodeVersion(path.join(unpluggedRoot, 'node', 'node.exe'))).toBeNull();
  });

  it('部署失败不会留下一个"看着像部署好了"的目录', async () => {
    const fx = buildSource(tmpRoot, { entries: [{ name: 'only-this.txt', content: Buffer.from('x') }] });
    const userDataDir = newUserData(tmpRoot, 'u7');

    // 归档里没有 clawrouter 入口 ⇒ 部署必须失败
    await expect(ensureRuntimeDeployed(deployOpts(fx, userDataDir))).rejects.toThrow(/clawrouter/i);
    expect(fs.existsSync(path.join(userDataDir, 'runtime', 'deployed'))).toBe(false);
  });
});

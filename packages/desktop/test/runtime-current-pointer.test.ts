import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_POINTER_FILE,
  DEPLOYMENT_STAMP_FILE,
  currentPointerPath,
  ensureRuntimeDeployed,
  readCurrentDeployment,
  writeCurrentPointer,
} from '../src/main/runtime/deploy.js';
import { buildSource, deployOpts, FIXTURE_NOW, newUserData } from './helpers/runtime-fixture.js';

/**
 * current 指针的语义 —— 硬缺口 ④：**不扫目录猜最新**。
 *
 * 这一组测试反复施加同一个压力：**只要指针说的那份不能用，就必须报错，
 * 绝不能"顺手"换一份能用的**。
 *
 * 为什么这么较真：`deployed/` 下同时存在几份是正常状态（换过 Node、换过版本、
 * 上一次部署没清）。如果装载器在这些目录里挑一份"看起来还行"的启起来，
 * 用户跑的就是**一份没人知道来历的运行时** —— 计费、模型目录、版本行为全都无从解释。
 * 宁可明确要求重插运行时盘。
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-pointer-'));
});

afterEach(() => {
  if (tmpRoot && tmpRoot.includes(path.join(os.tmpdir(), 'clawwork-pointer-'))) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

interface TwoDeployments {
  userDataDir: string;
  a: { key: string; root: string };
  b: { key: string; root: string };
}

/** 造出**两份都完好**的部署（不同 Node ⇒ 不同 key），返回目录与 key。 */
async function deployTwo(userDataDir: string): Promise<TwoDeployments> {
  const fxA = buildSource(tmpRoot, { dirName: 'usb-a' });
  const first = await ensureRuntimeDeployed(deployOpts(fxA, userDataDir));

  const fxB = buildSource(tmpRoot, { dirName: 'usb-b', nodeContent: Buffer.from('MZ a different node\n') });
  const second = await ensureRuntimeDeployed(deployOpts(fxB, userDataDir));

  return {
    userDataDir,
    a: { key: first.deploymentKey, root: first.deployedRoot },
    b: { key: second.deploymentKey, root: second.deployedRoot },
  };
}

describe('current 指针：确定性地选，绝不猜', () => {
  it('⭐ 两份都完好、指针指 A ⇒ 选 A（即使 B 是更晚部署的）', async () => {
    const userDataDir = newUserData(tmpRoot, 'u1');
    const { a, b } = await deployTwo(userDataDir);
    expect(a.key).not.toBe(b.key);

    // 刚部署完指针在 B 上，手动拨回 A
    writeCurrentPointer(userDataDir, a.key, () => FIXTURE_NOW);

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('ok');
    expect(cur.deploymentKey).toBe(a.key);
    expect(cur.deployedRoot).toBe(a.root);
    expect(cur.nodePath!.startsWith(a.root)).toBe(true);
  });

  it('⭐ 指针指 A，A 的 node 被删 ⇒ FAIL（不偷偷选完好的 B）', async () => {
    const userDataDir = newUserData(tmpRoot, 'u2');
    const { a } = await deployTwo(userDataDir);
    writeCurrentPointer(userDataDir, a.key, () => FIXTURE_NOW);

    fs.rmSync(path.join(a.root, 'node', 'node.exe'));

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('invalid');
    expect(cur.reason).toBe('node-missing');
    // ⚠️ 这是本文件的核心断言：绝不能把 B 交出去
    expect(cur.nodePath).toBeUndefined();
    expect(cur.cliPath).toBeUndefined();
    expect(cur.message).toMatch(/runtime media required/);
  });

  it('⭐ 指针指 A，A 的 stamp 被删 ⇒ FAIL（缺凭据 = 半成品，不是"可用"）', async () => {
    const userDataDir = newUserData(tmpRoot, 'u3');
    const { a } = await deployTwo(userDataDir);
    writeCurrentPointer(userDataDir, a.key, () => FIXTURE_NOW);

    fs.rmSync(path.join(a.root, DEPLOYMENT_STAMP_FILE));

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('invalid');
    expect(cur.reason).toBe('stamp-missing');
    expect(cur.nodePath).toBeUndefined();
  });

  it('指针指 A，A 的 clawrouter 入口被删 ⇒ FAIL（没有它 = 静默不计费）', async () => {
    const userDataDir = newUserData(tmpRoot, 'u4');
    const { a } = await deployTwo(userDataDir);
    writeCurrentPointer(userDataDir, a.key, () => FIXTURE_NOW);

    fs.rmSync(path.join(a.root, 'node_modules/openclaw/dist/extensions/clawrouter'), { recursive: true });

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('invalid');
    expect(cur.reason).toBe('entry-missing');
  });

  it('⭐ 没有 current.json ⇒ missing，**即使 deployed/ 下躺着一份完好的部署**', async () => {
    const userDataDir = newUserData(tmpRoot, 'u5');
    const { a } = await deployTwo(userDataDir);
    fs.rmSync(currentPointerPath(userDataDir));

    // 完好部署确实还在（这条断言让"不扫目录"变成可证伪的）
    expect(fs.existsSync(path.join(a.root, DEPLOYMENT_STAMP_FILE))).toBe(true);

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('missing');
    expect(cur.reason).toBe('pointer-missing');
  });

  it('⭐ 指针文件是半截 JSON（掉电）⇒ invalid，不猜、不回退', async () => {
    const userDataDir = newUserData(tmpRoot, 'u6');
    await deployTwo(userDataDir);
    fs.writeFileSync(currentPointerPath(userDataDir), '{ "runtimeDeploymentKey": "abc');

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('invalid');
    expect(cur.reason).toBe('pointer-invalid');
    expect(cur.deployedRoot).toBeUndefined();
  });

  it('指针形状不对（缺 key / 不是对象）⇒ 同样按 invalid 处理', async () => {
    const userDataDir = newUserData(tmpRoot, 'u7');
    await deployTwo(userDataDir);

    fs.writeFileSync(currentPointerPath(userDataDir), JSON.stringify({ updatedAt: 'x' }));
    expect(readCurrentDeployment(userDataDir).reason).toBe('pointer-invalid');

    fs.writeFileSync(currentPointerPath(userDataDir), JSON.stringify([1, 2, 3]));
    expect(readCurrentDeployment(userDataDir).reason).toBe('pointer-invalid');
  });

  it('⭐ 指针指向一个**不存在**的 key ⇒ invalid（不回退到任何现存目录）', async () => {
    const userDataDir = newUserData(tmpRoot, 'u8');
    const { a } = await deployTwo(userDataDir);
    writeCurrentPointer(userDataDir, 'this-key-was-never-deployed', () => FIXTURE_NOW);

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('invalid');
    expect(cur.reason).toBe('stamp-missing');
    // A 明明完好在旁边，但指针没说它 —— 就不选它
    expect(cur.nodePath).toBeUndefined();
    expect(fs.existsSync(path.join(a.root, DEPLOYMENT_STAMP_FILE))).toBe(true);
  });

  it('指针完好时，不产生任何 reason / message（调用方不必解析字符串）', async () => {
    const userDataDir = newUserData(tmpRoot, 'u9');
    const { b } = await deployTwo(userDataDir);

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('ok');
    expect(cur.deploymentKey).toBe(b.key);
    expect(cur.reason).toBeUndefined();
    expect(cur.message).toBeUndefined();
  });

  it('落盘的指针是**原子**的：不会出现半截文件（写完就是完整 JSON）', async () => {
    const userDataDir = newUserData(tmpRoot, 'u10');
    const { a } = await deployTwo(userDataDir);
    writeCurrentPointer(userDataDir, a.key, () => FIXTURE_NOW);

    const raw = fs.readFileSync(currentPointerPath(userDataDir), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual({ runtimeDeploymentKey: a.key, updatedAt: FIXTURE_NOW.toISOString() });
    // .tmp 不留下
    expect(fs.existsSync(`${currentPointerPath(userDataDir)}.tmp`)).toBe(false);
    expect(path.basename(currentPointerPath(userDataDir))).toBe(CURRENT_POINTER_FILE);
  });
});

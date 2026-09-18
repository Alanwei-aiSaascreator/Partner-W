import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 接线：商业客户端**必须**带着那个会自我了断的 fetch 建出来。
 *
 * 为什么单独测这一条：`request-timeout.ts` 自己的单测证明"它工作"，
 * 但证明不了"它**被用上了**" —— 而这两件事之间的缝正是这类加固最容易掉的地方
 * （模块写好了、忘了接；或者哪天有人顺手把 `global.fetch` 删了）。
 *
 * ⚠️ 这里**故意 mock `createClient`**：要钉的就是"传进去的选项长什么样"。
 *    真实建客户端那条路由 `commercial-client-defaults.test.ts` 覆盖（它刻意不 mock）。
 */

const mocks = vi.hoisted(() => ({ userDataDir: '', captured: [] as unknown[][] }));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((...args: unknown[]) => {
    mocks.captured.push(args);
    return { auth: {}, from: () => ({}) };
  }),
}));

vi.mock('ws', () => ({ default: class {} }));

let dir: string;

beforeEach(() => {
  vi.resetModules();
  mocks.captured.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'clawwork-commercial-wiring-'));
  mocks.userDataDir = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('商业客户端的 fetch 接线', () => {
  it('⭐ 建客户端时带上了 global.fetch（否则那层中止等于没接）', async () => {
    // 凭据走随包默认值（和 commercial-client-defaults.test.ts 同一前提：干净机器也要建得出来）
    const { getCommercialClient } = await import('../src/main/commercial/client.js');

    const client = getCommercialClient();

    expect(client, '干净机器上也要建得出来（否则这条用例测不到东西）').not.toBeNull();
    expect(mocks.captured, 'createClient 应当被调用一次').toHaveLength(1);

    const options = mocks.captured[0][2] as { global?: { fetch?: unknown } };
    expect(options.global?.fetch, '必须传 global.fetch —— 去掉它就退回"挂住不放"').toBeTypeOf('function');
    // ⚠️ 不能是**原始** fetch：那样等于没包
    expect(options.global?.fetch).not.toBe(globalThis.fetch);
  });
});

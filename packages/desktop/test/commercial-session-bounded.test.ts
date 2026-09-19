import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `readSessionState` 必须**一定会收场**（B7 的前提）。
 *
 * ## 为什么这条是 B7 的一部分
 *
 * B7 让界面在"本地有会话"时**继续等后台的真答案**（不再 5 秒就改判未登录）。
 * 这个做法成立的前提是：**后台那个答案一定会来**。而它原来不保证 ——
 * `readSessionState` 里 `auth.getUser()` 有 8 秒上限，**`org_members` 那次查询没有**。
 * 只要那条查询挂住，函数就永远不 resolve ⇒ 界面永远停在加载页。
 *
 * ⚠️ 今天这个洞被"5 秒改判未登录"盖住了；一旦按 B7 改成"继续等"，它就会露出来。
 *    所以补上它不是顺手扩范围，是**让 B7 的做法成立的必要条件**。
 *
 * ⚠️ 超时后仍然报 `signedIn: true`：登录**已经**被 `getUser()` 确认过了，
 *    只是团队列表没读出来 —— 说成"未登录"是另一种撒谎（会把已登录的人扔回登录页）。
 */

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  orgsSelect: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\clawwork-test-no-such-dir' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
}));

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => ({
    auth: { getUser: () => mocks.getUser() },
    from: () => ({ select: () => mocks.orgsSelect() }),
  }),
  resetCommercialClient: () => {},
}));

const { readSessionState } = await import('../src/main/commercial/auth.js');

const USER = { id: 'u-1', email: 'a@b.c', phone: null, user_metadata: { nickname: '小明' } };
const NEVER = () => new Promise(() => {});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('readSessionState —— 一定会收场', () => {
  it('⭐ 团队查询挂住 ⇒ 仍然收场：已登录为真，团队列表为空', async () => {
    vi.useFakeTimers();
    mocks.getUser.mockResolvedValue({ data: { user: USER }, error: null });
    mocks.orgsSelect.mockImplementation(NEVER);

    const pending = readSessionState();
    await vi.advanceTimersByTimeAsync(8000);
    const res = await pending;

    expect(res.ok).toBe(true);
    expect(res.result?.signedIn, '登录已经确认过了，不许因为团队读不到就改口').toBe(true);
    expect(res.result?.profile?.userId).toBe('u-1');
    expect(res.result?.orgs).toEqual([]);
  });

  it('团队正常返回 ⇒ 照常填进 orgs（正常路径不许被超时改动弄坏）', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: USER }, error: null });
    mocks.orgsSelect.mockResolvedValue({
      data: [{ role: 'owner', organizations: { id: 'o-1', name: '团队', slug: 't', plan: 'pro' } }],
    });

    const res = await readSessionState();

    expect(res.result?.orgs).toEqual([{ id: 'o-1', name: '团队', slug: 't', plan: 'pro', role: 'owner' }]);
  });

  it('鉴权那步挂住 ⇒ 收场为未登录（现状不变，回归保护）', async () => {
    vi.useFakeTimers();
    mocks.getUser.mockImplementation(NEVER);
    mocks.orgsSelect.mockResolvedValue({ data: [] });

    const pending = readSessionState();
    await vi.advanceTimersByTimeAsync(8000);
    const res = await pending;

    expect(res.result?.signedIn).toBe(false);
    expect(res.result?.profile).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  classifyPortableError,
  describePortableError,
  describeUpdateError,
  describeUpdateErrorFromState,
  portableErrorAction,
} from '../src/renderer/features/internal-beta/update-errors';
import type { PortableUpdateErrorCode, PortableUpdatePublicState } from '@clawwork/shared';

/**
 * 内测中心的更新面板以前直接把 electron-updater 的 `err.message` 摆在界面上，
 * 用户看到的是 `HttpError: 404 ...` 这种英文堆栈。
 *
 * 交接单确认过：更新服务（Nginx `/updates/`）**还没部署**，所以客户端现在必然
 * 拿到 404 —— 界面得说实话（"服务端还没提供更新清单"），而不是甩一段英文。
 */
describe('describeUpdateError', () => {
  it('服务器没有更新清单 ⇒ 说清"还没上线"，而不是甩 404', () => {
    const text = describeUpdateError('Cannot find latest.yml in the latest release artifacts', 'check');

    expect(text).toContain('更新清单');
    expect(text).not.toContain('latest.yml');
    expect(text).not.toContain('Cannot find');
  });

  it('HTTP 404 的英文原文同样不出现', () => {
    const text = describeUpdateError(
      'HttpError: 404 Not Found - GET https://api.rongyinghudong.com/updates/latest.yml',
      'check',
    );

    expect(text).not.toContain('404');
    expect(text).not.toContain('HttpError');
    expect(text).not.toContain('https://');
    expect(text).toContain('更新清单');
  });

  it('网络不通 ⇒ 提示检查网络', () => {
    for (const raw of ['getaddrinfo ENOTFOUND api.rongyinghudong.com', 'connect ETIMEDOUT 1.2.3.4:443']) {
      const text = describeUpdateError(raw, 'check');
      expect(text).toContain('网络');
      expect(text).not.toContain('ENOTFOUND');
    }
  });

  it('安装包校验失败 ⇒ 明确说停止安装', () => {
    const text = describeUpdateError('sha512 checksum mismatch, expected abc', 'install');

    expect(text).toContain('校验');
    expect(text).not.toContain('sha512');
  });

  it('用户主动取消 ⇒ 不是错误', () => {
    const text = describeUpdateError('cancelled', 'download');

    // `cancelled` 现在按**分类表**给文案（"已取消更新，当前版本可以继续使用。"）——
    // 它依旧是"这不是错误"的语气，只是把"还能继续用"说明白了。
    expect(text).toContain('已取消更新');
    expect(text).not.toMatch(/失败|出错|错误/);
  });

  it('⭐ 盘上形态没有整目录服务时，说清"重开一次"，而不是"下载没完成，请稍后重试"', () => {
    const text = describeUpdateError('portable-unavailable', 'install');

    expect(text).toContain('重新打开');
    expect(text).not.toContain('portable-unavailable');
    expect(text).not.toContain('稍后重试');
  });

  it('认不出来的错误给中文兜底，且**绝不**把英文原文带出去', () => {
    const text = describeUpdateError('ERR_UPDATER_SOMETHING_WEIRD_42', 'download');

    expect(text).toContain('下载更新');
    expect(text).not.toContain('ERR_UPDATER_SOMETHING_WEIRD_42');
  });

  it('按操作区分兜底文案（检查 / 下载 / 安装）', () => {
    expect(describeUpdateError('mystery', 'check')).toContain('检查更新');
    expect(describeUpdateError('mystery', 'install')).toContain('安装');
  });

  it('空消息也不炸', () => {
    expect(describeUpdateError(undefined, 'check')).toContain('检查更新');
    expect(describeUpdateError('', 'updater')).toContain('更新');
  });
});

describe('盘上运行的错误码 → 用户动作', () => {
  it.each([
    ['network', 'retry'],
    ['package-integrity', 'retry'],
    ['file-integrity', 'retry'],
    ['archive-unsafe', 'retry'],
    ['file-in-use', 'retry'],
    ['launcher-start-failed', 'retry'],
    ['health-timeout', 'retry'],
    ['cancelled', 'retry'],
    ['disk-space', 'free-space'],
    ['signature-invalid', 'replace-package'],
    ['manifest-invalid', 'replace-package'],
    ['unsupported-policy', 'replace-package'],
    ['launcher-incompatible', 'replace-package'],
    ['rollback-failed', 'contact-support'],
    ['volume-readonly', 'contact-support'],
  ] as const)('%s ⇒ %s', (code, action) => {
    expect(portableErrorAction(code)).toBe(action);
  });

  it('⭐ 签名类失败只给"换包"，绝不给"忽略并安装"', () => {
    const actions = (
      ['signature-invalid', 'manifest-invalid', 'unsupported-policy', 'launcher-incompatible'] as const
    ).map(portableErrorAction);

    for (const action of actions) {
      expect(action).toBe('replace-package');
    }
    expect(actions).not.toContain('retry');
    expect(actions, '用户的动作清单里不存在"忽略校验"这一项').not.toContain('ignore');
  });

  it('每个错误码都有中文、都不许把英文原文带出去', () => {
    const codes: PortableUpdateErrorCode[] = [
      'network',
      'feed-response',
      'signature-invalid',
      'manifest-invalid',
      'unsupported-policy',
      'launcher-incompatible',
      'disk-space',
      'volume-readonly',
      'package-integrity',
      'archive-unsafe',
      'file-integrity',
      'file-in-use',
      'launcher-start-failed',
      'health-timeout',
      'rollback-failed',
      'cancelled',
      'unknown',
    ];
    for (const code of codes) {
      const text = describePortableError(code);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(code);
      expect(/[a-z]{4,}/i.test(text), `${code} 的文案里不该出现英文单词：${text}`).toBe(false);
    }
  });

  it('恢复失败要说清"别拔盘、别删文件"，并给出要找谁', () => {
    const text = describePortableError('rollback-failed');

    expect(text).toContain('不要拔出');
    expect(text).toContain('技术支持');
  });
});

/**
 * 失败出口必须**说清是哪一类**，并说明"能不能重试、下一步做什么"。
 *
 * 为什么单独要这一组（2026-09-23）：以前的出口只说一个错误码，而用户真正需要的是
 * 三件不同的事，混在一起会给出**错误建议**：
 *   · 源上还没有这个版本（manifest 404）—— **不是错误**，说"当前频道暂无更新"；
 *   · 连不上/超时 —— 可以重试，说"稍后再试"；
 *   · 签名/清单不可信 —— **不可重试**，说"重新获取完整交付包"；
 *   · 空间不足 —— 可重试，但要先知道**还差多少**；
 *   · 启动器不兼容 / 不是同一个信任根 —— 要**更换基础包**（便携更新从不换启动器）；
 *   · 磁盘/文件系统问题（写失败、exFAT 限制）—— 与"空间不足"**分开**。
 */
describe('便携更新失败的分类（类别 / 可重试 / 下一步）', () => {
  const expectations: Array<[PortableUpdateErrorCode, string, boolean, string]> = [
    // [错误码, 类别, 可重试, 下一步动作]
    ['network', 'network', true, 'retry'],
    ['feed-response', 'network', true, 'retry'],
    ['update-not-published', 'no-update', true, 'retry'],
    ['signature-invalid', 'untrusted', false, 'replace-package'],
    ['manifest-invalid', 'untrusted', false, 'replace-package'],
    ['unsupported-policy', 'untrusted', false, 'replace-package'],
    ['disk-space', 'space', true, 'free-space'],
    ['launcher-incompatible', 'launcher', false, 'replace-package'],
    ['launcher-unavailable', 'launcher', false, 'replace-package'],
    ['volume-readonly', 'filesystem', true, 'contact-support'],
    ['filesystem-error', 'filesystem', true, 'retry'],
    ['file-in-use', 'filesystem', true, 'retry'],
    // 自动恢复都失败了 ⇒ 手动重试反而更危险（文案就是"别拔盘、别删文件、找支持"）。
    ['rollback-failed', 'filesystem', false, 'contact-support'],
  ];

  it.each(expectations)('%s ⇒ 类别 %s / 可重试=%s / 下一步 %s', (code, category, retryable, action) => {
    const info = classifyPortableError(code);

    expect(info.category).toBe(category);
    expect(info.retryable).toBe(retryable);
    expect(info.action).toBe(action);
  });

  it('⭐ "源上还没有这个版本"**不是错误**，文案是"当前频道暂无更新"', () => {
    const info = classifyPortableError('update-not-published');

    expect(info.category).toBe('no-update');
    expect(info.text).toContain('当前频道暂无更新');
  });

  it('⭐ 空间不足要说得出"还差多少"（只给一句"空间不足"等于没说）', () => {
    const text = describePortableError('disk-space', { requiredBytes: 5 * 1024 ** 3, availableBytes: 1 * 1024 ** 3 });

    expect(text).toContain('4.0 GiB'); // 还差 4 GiB
    expect(text).toContain('1.0 GiB'); // 现在剩 1 GiB
  });

  it('拿不到数字时退回不带数字的那句（不许因此崩或留空）', () => {
    const text = describePortableError('disk-space');

    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
  });

  it('⭐ "启动器不是配套的那把"指向更换基础包（不是让用户重试）', () => {
    const info = classifyPortableError('launcher-unavailable');

    expect(info.retryable).toBe(false);
    expect(info.text).toContain('基础包');
  });

  it('⭐ 磁盘/文件系统问题与"空间不足"是两个出口（别混成一句话）', () => {
    const space = classifyPortableError('disk-space');
    const filesystem = classifyPortableError('filesystem-error');

    expect(space.category).not.toBe(filesystem.category);
    expect(space.text).not.toBe(filesystem.text);
  });

  it('每个错误码都有类别/重试性/动作/中文文案（新增错误码忘了归类会在这里红）', () => {
    const codes: PortableUpdateErrorCode[] = [
      'network',
      'feed-response',
      'signature-invalid',
      'manifest-invalid',
      'unsupported-policy',
      'launcher-incompatible',
      'launcher-unavailable',
      'update-not-published',
      'disk-space',
      'volume-readonly',
      'filesystem-error',
      'package-integrity',
      'archive-unsafe',
      'file-integrity',
      'file-in-use',
      'launcher-start-failed',
      'health-timeout',
      'rollback-failed',
      'cancelled',
      'unknown',
    ];

    for (const code of codes) {
      const info = classifyPortableError(code);
      expect(info.category, code).toBeTruthy();
      expect(typeof info.retryable, code).toBe('boolean');
      expect(info.action, code).toBeTruthy();
      expect(info.text.length, code).toBeGreaterThan(0);
      expect(info.text, `${code} 不许把英文原文/URL 带出去`).not.toMatch(/https?:|Error:|undefined/);
    }
  });
});

describe('盘上那条链的错误码会走到分类文案（不是落到通用兜底）', () => {
  it('⭐ 错误码原样进来时给出该类的文案，而不是"请稍后重试"', () => {
    expect(describeUpdateError('disk-space', 'download')).toContain('空间不足');
    expect(describeUpdateError('launcher-unavailable', 'download')).toContain('基础包');
    expect(describeUpdateError('update-not-published', 'check')).toContain('当前频道暂无更新');
  });

  it('⭐ 不该重试的那类**不许**被建议重试（这是分类的全部意义）', () => {
    const untrusted = describeUpdateError('signature-invalid', 'download');
    const launcher = describeUpdateError('launcher-unavailable', 'install');

    for (const text of [untrusted, launcher]) {
      expect(text).not.toContain('稍后重试');
      expect(text).not.toContain('重试即可');
    }
    expect(untrusted).toContain('完整的交付包');
  });

  it('带数字时空间那句说得更具体', () => {
    const text = describeUpdateError('disk-space', 'download', {
      requiredBytes: 2 * 1024 ** 3,
      availableBytes: 1024 ** 3,
    });

    expect(text).toContain('2.0 GiB');
    expect(text).toContain('1.0 GiB');
  });

  it('electron-updater 的英文原文照旧走原来那条（新分支只认整串错误码）', () => {
    expect(describeUpdateError('HttpError: 404 Not Found - GET https://x/latest.yml', 'check')).toContain(
      '更新服务还没有提供更新清单',
    );
  });
});

/**
 * 渲染侧**唯一入口**：主进程的公开状态 → 一句人话。
 *
 * 为什么需要它（2026-09-23）：`describePortableError` 一直带得出"还差多少 GiB"，
 * 但两个面板都不传那两个数字 ⇒ 用户看到的永远是那句不带数字的"空间不足"。
 * 而数字**一直在公开状态里**（`requiredBytes` / `availableBytes`）。
 */
describe('describeUpdateErrorFromState', () => {
  const withState = (state: Partial<PortableUpdatePublicState>): PortableUpdatePublicState => ({
    phase: 'error',
    currentVersion: '0.0.25',
    updatedAt: 1,
    ...state,
  });

  it('⭐ 空间不足：要说出「还差多少」，而不是只丢一句"空间不足"', () => {
    const text = describeUpdateErrorFromState(
      undefined,
      'download',
      withState({ errorCode: 'disk-space', requiredBytes: 5 * 1024 ** 3, availableBytes: 1024 ** 3 }),
    );

    expect(text).toContain('还差 4.0 GiB');
  });

  it('公开状态认得出错误码时以它为准（不是那句过时或缺席的 errorMessage）', () => {
    const text = describeUpdateErrorFromState(
      'Download failed',
      'download',
      withState({ errorCode: 'launcher-incompatible' }),
    );

    expect(text).not.toContain('Download failed');
    expect(text).toContain('启动器版本太旧');
  });

  it('相位不是 error 时不抢话：退回按 errorMessage 那条老路', () => {
    const text = describeUpdateErrorFromState('ENOTFOUND updates.example.com', 'check', {
      phase: 'available',
      currentVersion: '0.0.25',
      errorCode: 'disk-space',
      requiredBytes: 5 * 1024 ** 3,
      availableBytes: 0,
      updatedAt: 1,
    });

    expect(text).toContain('连不上更新服务器');
    expect(text).not.toContain('GiB');
  });

  it('没有公开状态（安装态）时退回老路', () => {
    expect(describeUpdateErrorFromState('ENOTFOUND updates.example.com', 'check', null)).toContain('连不上更新服务器');
  });

  it('有错误码但没有数字 ⇒ 退回不带数字的那句，绝不编一个数出来', () => {
    const text = describeUpdateErrorFromState(undefined, 'download', withState({ errorCode: 'disk-space' }));

    expect(text).toContain('空间不足');
    expect(text).not.toContain('GiB');
  });
});

import { describe, expect, it } from 'vitest';
import {
  describePortableError,
  describeUpdateError,
  portableErrorAction,
} from '../src/renderer/features/internal-beta/update-errors';
import type { PortableUpdateErrorCode } from '@clawwork/shared';

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
    expect(describeUpdateError('cancelled', 'download')).toBe('已取消更新。');
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

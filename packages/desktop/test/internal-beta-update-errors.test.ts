import { describe, expect, it } from 'vitest';
import { describeUpdateError } from '../src/renderer/features/internal-beta/update-errors';

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

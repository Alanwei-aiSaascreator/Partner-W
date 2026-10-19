import { describe, expect, it } from 'vitest';
import {
  beginFeishuRegistration,
  pollFeishuRegistration,
  pollFeishuRegistrationOnce,
  withFeishuOnboardParams,
  type FeishuFetchImpl,
  type FeishuHttpResponse,
} from '../src/main/connectors/feishu-registration.js';

/**
 * 飞书 OAuth 设备码流程（2026-10-18，应用内扫码）。
 *
 * 语义对齐内核插件 `extensions/feishu/dist/app-registration-*.js`（只读参考）：
 * init 校验 → begin 拿设备码/二维码 → poll 处理 pending / slow_down / denied / expired / lark 切换。
 * 这些用例**不联网**：fetch / sleep / clock 全部注入。
 */

function response(body: unknown, status = 200): FeishuHttpResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

interface FetchCall {
  url: string;
  body: string;
}

function scriptedFetch(script: Array<unknown | Error>): { fetchImpl: FeishuFetchImpl; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl: FeishuFetchImpl = async (url, init) => {
    calls.push({ url, body: init.body });
    const item = script[Math.min(index, script.length - 1)];
    index += 1;
    if (item instanceof Error) throw item;
    return response(item);
  };
  return { fetchImpl, calls };
}

const INIT_OK = { supported_auth_methods: ['client_secret', 'other'] };
const BEGIN_OK = {
  device_code: 'dev-123',
  verification_uri_complete: 'https://accounts.feishu.cn/qr?code=abcd',
  user_code: 'ABCD-EFGH',
  interval: 5,
  expire_in: 600,
};
const SUCCESS = {
  client_id: 'cli_new',
  client_secret: 'secret_new',
  user_info: { open_id: 'ou_user', tenant_brand: 'feishu' },
};

describe('withFeishuOnboardParams', () => {
  it('追加 from/tp（与插件逐字一致），保留原有 query', () => {
    const url = new URL(withFeishuOnboardParams('https://accounts.feishu.cn/qr?code=abcd'));
    expect(url.searchParams.get('code')).toBe('abcd');
    expect(url.searchParams.get('from')).toBe('oc_onboard');
    expect(url.searchParams.get('tp')).toBe('ob_cli_app');
  });
});

describe('beginFeishuRegistration', () => {
  it('⭐ init + begin ⇒ 二维码地址带上 onboard 参数，秒数换算成毫秒与过期时刻', async () => {
    const { fetchImpl, calls } = scriptedFetch([INIT_OK, BEGIN_OK]);
    const result = await beginFeishuRegistration({ fetchImpl, now: () => 1_000_000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://accounts.feishu.cn/oauth/v1/app/registration');
    expect(calls[0]!.body).toBe('action=init');
    expect(calls[1]!.body).toContain('action=begin');
    expect(calls[1]!.body).toContain('archetype=PersonalAgent');
    expect(calls[1]!.body).toContain('auth_method=client_secret');
    expect(calls[1]!.body).toContain('request_user_info=open_id');

    expect(result.begin.deviceCode).toBe('dev-123');
    expect(result.begin.userCode).toBe('ABCD-EFGH');
    expect(result.begin.intervalMs).toBe(5_000);
    expect(result.begin.expireAt).toBe(1_000_000 + 600_000);
    expect(result.begin.domain).toBe('feishu');
    const qr = new URL(result.begin.qrUrl);
    expect(qr.searchParams.get('from')).toBe('oc_onboard');
    expect(qr.searchParams.get('tp')).toBe('ob_cli_app');
  });

  it('interval/expire_in 缺失或不合法 ⇒ 用插件同款默认（5s / 600s）', async () => {
    const { fetchImpl } = scriptedFetch([INIT_OK, { ...BEGIN_OK, interval: 0, expire_in: 'nope' }]);
    const result = await beginFeishuRegistration({ fetchImpl, now: () => 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.begin.intervalMs).toBe(5_000);
    expect(result.begin.expireAt).toBe(600_000);
  });

  it('环境不支持 client_secret ⇒ unsupported-auth（不进入 begin）', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ supported_auth_methods: ['authorization_code'] }]);
    const result = await beginFeishuRegistration({ fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'unsupported-auth' });
    expect(calls).toHaveLength(1);
  });

  it('服务端 error ⇒ rejected 并带 description', async () => {
    const { fetchImpl } = scriptedFetch([INIT_OK, { error: 'invalid_request', error_description: 'bad archetype' }]);
    const result = await beginFeishuRegistration({ fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'rejected', message: 'invalid_request: bad archetype' });
  });

  it('响应缺关键字段 ⇒ malformed（绝不拿半个 URL 去渲染二维码）', async () => {
    const { fetchImpl } = scriptedFetch([INIT_OK, { ...BEGIN_OK, verification_uri_complete: '' }]);
    expect(await beginFeishuRegistration({ fetchImpl })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('网络层失败（fetch reject）⇒ network', async () => {
    const { fetchImpl } = scriptedFetch([new Error('ECONNRESET')]);
    expect(await beginFeishuRegistration({ fetchImpl })).toEqual({ ok: false, reason: 'network' });
  });
});

describe('pollFeishuRegistrationOnce（单次语义）', () => {
  const make = (body: unknown) => scriptedFetch([body]).fetchImpl;

  it('client_id + client_secret ⇒ success，取 open_id 与 tenant_brand', async () => {
    const outcome = await pollFeishuRegistrationOnce({
      fetchImpl: make(SUCCESS),
      deviceCode: 'dev-123',
      domain: 'feishu',
    });
    expect(outcome).toEqual({
      status: 'success',
      credentials: { appId: 'cli_new', appSecret: 'secret_new', domain: 'feishu', openId: 'ou_user' },
    });
  });

  it('authorization_pending ⇒ pending；slow_down ⇒ slow-down', async () => {
    expect(
      await pollFeishuRegistrationOnce({
        fetchImpl: make({ error: 'authorization_pending' }),
        deviceCode: 'd',
        domain: 'feishu',
      }),
    ).toEqual({ status: 'pending' });
    expect(
      await pollFeishuRegistrationOnce({
        fetchImpl: make({ error: 'slow_down' }),
        deviceCode: 'd',
        domain: 'feishu',
      }),
    ).toEqual({ status: 'slow-down' });
  });

  it('access_denied ⇒ denied；expired_token ⇒ expired；未知 error ⇒ error 带描述', async () => {
    expect(
      await pollFeishuRegistrationOnce({
        fetchImpl: make({ error: 'access_denied' }),
        deviceCode: 'd',
        domain: 'feishu',
      }),
    ).toEqual({ status: 'denied' });
    expect(
      await pollFeishuRegistrationOnce({
        fetchImpl: make({ error: 'expired_token' }),
        deviceCode: 'd',
        domain: 'feishu',
      }),
    ).toEqual({ status: 'expired' });
    expect(
      await pollFeishuRegistrationOnce({
        fetchImpl: make({ error: 'server_error', error_description: 'boom' }),
        deviceCode: 'd',
        domain: 'feishu',
      }),
    ).toEqual({ status: 'error', message: 'server_error: boom' });
  });

  it('tenant_brand=lark ⇒ domain-switched；已经切换过则不再切换', async () => {
    const body = { user_info: { tenant_brand: 'lark' } };
    expect(await pollFeishuRegistrationOnce({ fetchImpl: make(body), deviceCode: 'd', domain: 'feishu' })).toEqual({
      status: 'domain-switched',
      domain: 'lark',
    });
    expect(
      await pollFeishuRegistrationOnce({
        fetchImpl: make(body),
        deviceCode: 'd',
        domain: 'lark',
        allowDomainSwitch: false,
      }),
    ).toEqual({ status: 'pending' });
  });
});

describe('pollFeishuRegistration（循环）', () => {
  function loopFetch(script: Array<unknown | Error>): { fetchImpl: FeishuFetchImpl; calls: FetchCall[] } {
    return scriptedFetch(script);
  }

  it('⭐ pending → success：按 interval 等待一次后拿到凭证', async () => {
    const { fetchImpl } = loopFetch([{ error: 'authorization_pending' }, SUCCESS]);
    let time = 0;
    const delays: number[] = [];
    const result = await pollFeishuRegistration({
      fetchImpl,
      deviceCode: 'dev-123',
      intervalMs: 5_000,
      expireAt: 60_000,
      domain: 'feishu',
      now: () => time,
      sleep: async (ms) => {
        delays.push(ms);
        time += ms;
      },
    });
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.credentials.appId).toBe('cli_new');
    expect(delays).toEqual([5_000]);
  });

  it('slow_down ⇒ 间隔 +5s（第二次等待 10s）', async () => {
    const { fetchImpl } = loopFetch([{ error: 'slow_down' }, SUCCESS]);
    let time = 0;
    const delays: number[] = [];
    const result = await pollFeishuRegistration({
      fetchImpl,
      deviceCode: 'd',
      intervalMs: 5_000,
      expireAt: 60_000,
      domain: 'feishu',
      now: () => time,
      sleep: async (ms) => {
        delays.push(ms);
        time += ms;
      },
    });
    expect(result.status).toBe('success');
    expect(delays).toEqual([10_000]);
  });

  it('到过期时刻 ⇒ expired（最后一次等待被剩余时间夹住）', async () => {
    const { fetchImpl } = loopFetch([{ error: 'authorization_pending' }]);
    let time = 0;
    const delays: number[] = [];
    const result = await pollFeishuRegistration({
      fetchImpl,
      deviceCode: 'd',
      intervalMs: 5_000,
      expireAt: 12_000,
      domain: 'feishu',
      now: () => time,
      sleep: async (ms) => {
        delays.push(ms);
        time += ms;
      },
    });
    expect(result).toEqual({ status: 'expired' });
    expect(delays).toEqual([5_000, 5_000, 2_000]);
  });

  it('access_denied ⇒ denied（不再继续轮询）', async () => {
    const { fetchImpl, calls } = loopFetch([{ error: 'access_denied' }]);
    const result = await pollFeishuRegistration({
      fetchImpl,
      deviceCode: 'd',
      intervalMs: 5_000,
      expireAt: 60_000,
      domain: 'feishu',
      now: () => 0,
      sleep: async () => undefined,
    });
    expect(result).toEqual({ status: 'denied' });
    expect(calls).toHaveLength(1);
  });

  it('⭐ lark 域名切换：立刻换 accounts.larksuite.com 重试，不等待', async () => {
    const { fetchImpl, calls } = loopFetch([{ user_info: { tenant_brand: 'lark' } }, SUCCESS]);
    const delays: number[] = [];
    const result = await pollFeishuRegistration({
      fetchImpl,
      deviceCode: 'd',
      intervalMs: 5_000,
      expireAt: 60_000,
      domain: 'feishu',
      now: () => 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result.status).toBe('success');
    expect(delays).toEqual([]);
    expect(calls[0]!.url).toContain('accounts.feishu.cn');
    expect(calls[1]!.url).toContain('accounts.larksuite.com');
  });

  it('取消 ⇒ cancelled（sleep 期间取消也能在下一次检查时收口）', async () => {
    const { fetchImpl } = loopFetch([{ error: 'authorization_pending' }]);
    let cancelled = false;
    let time = 0;
    const result = await pollFeishuRegistration({
      fetchImpl,
      deviceCode: 'd',
      intervalMs: 5_000,
      expireAt: 60_000,
      domain: 'feishu',
      now: () => time,
      isCancelled: () => cancelled,
      sleep: async (ms) => {
        time += ms;
        cancelled = true;
      },
    });
    expect(result).toEqual({ status: 'cancelled' });
  });
});

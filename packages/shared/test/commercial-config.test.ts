import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY,
  DEFAULT_COMMERCIAL_SUPABASE_URL,
  resolveCommercialCredentials,
} from '../src/index.js';

/**
 * 🔴 P0 回归（2026-09-18 干净机器没有登录界面）：
 *
 * 商业凭据以前**只**从 `clawwork-config.json` 里读，而干净机器上那段是空的
 * ⇒ `getCommercialClient()` 返回 null ⇒ 渲染层判定"未配置"、直接进本地模式，
 * 屏幕上根本没有登录页。修法是**读取期兜底**：config 里非空的字段优先，
 * 空的回落到随包下发的生产默认值。
 *
 * 这几个用例钉死兜底规则本身；"handler / client 真的用了它"由 desktop 包的
 * `commercial-config-defaults.test.ts` 钉。
 */

/** JWT 的 payload 段（base64url），用来验证下发的确实是哪一类 key。 */
function jwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('随包下发的生产默认值', () => {
  it('是一条像样的 supabase URL', () => {
    expect(DEFAULT_COMMERCIAL_SUPABASE_URL).toMatch(/^https:\/\/[a-z0-9]+\.supabase\.co$/);
  });

  it('🔴 必须是 anon key —— 项目纪律：service_role 绝不进客户端', () => {
    // anon key 是**设计上就对公众公开**的客户端密钥（数据由 RLS 保护）；
    // service_role 能绕过 RLS，一旦随包下发就是彻底的越权。
    expect(jwtPayload(DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY).role).toBe('anon');
  });

  it('🔴 key 与 URL 必须属于同一个项目（ref 对不上 ⇒ 每次登录都失败）', () => {
    // 抄错一把 key、或将来换项目只改一半，**什么都不会崩**：客户端建得出来、
    // 登录页也出得来，只是每次登录都失败，而且报错读不出原因 —— 正是这次 P0 的形状。
    // JWT 的 `ref` 段就是项目 ref，与 URL 主机名的首段是同一个值。
    const projectRef = new URL(DEFAULT_COMMERCIAL_SUPABASE_URL).host.split('.')[0];
    expect(jwtPayload(DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY).ref).toBe(projectRef);
  });
});

describe('resolveCommercialCredentials（读取期兜底）', () => {
  it('干净机器（配置里没有商业段）⇒ 用生产默认值', () => {
    expect(resolveCommercialCredentials(undefined)).toEqual({
      supabaseUrl: DEFAULT_COMMERCIAL_SUPABASE_URL,
      supabaseAnonKey: DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY,
    });
  });

  it('显式传 null（不只是 undefined）⇒ 同样用生产默认值', () => {
    expect(resolveCommercialCredentials(null)).toEqual({
      supabaseUrl: DEFAULT_COMMERCIAL_SUPABASE_URL,
      supabaseAnonKey: DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY,
    });
  });

  it('商业段存在但字段是空串（老 profile / 被清过）⇒ 仍然用生产默认值', () => {
    expect(resolveCommercialCredentials({ supabaseUrl: '', supabaseAnonKey: '' })).toEqual({
      supabaseUrl: DEFAULT_COMMERCIAL_SUPABASE_URL,
      supabaseAnonKey: DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY,
    });
  });

  it('只有空白字符也算空（不把 " " 当成用户填的值）', () => {
    expect(resolveCommercialCredentials({ supabaseUrl: '  ', supabaseAnonKey: '\n' })).toEqual({
      supabaseUrl: DEFAULT_COMMERCIAL_SUPABASE_URL,
      supabaseAnonKey: DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY,
    });
  });

  it('用户自己填了值 ⇒ 用户的优先，并去掉首尾空白', () => {
    expect(
      resolveCommercialCredentials({
        supabaseUrl: ' https://my-project.supabase.co ',
        supabaseAnonKey: ' my-key ',
      }),
    ).toEqual({ supabaseUrl: 'https://my-project.supabase.co', supabaseAnonKey: 'my-key' });
  });

  it('只填了其中一个 ⇒ 空的那个独立兜底（不把整对都丢掉）', () => {
    // 这种半配置只可能来自手工改文件；让它落到"url 是用户的、key 是默认的"
    // 这种明显跑不通的状态，好过静默无视用户填的 url。
    const resolved = resolveCommercialCredentials({
      supabaseUrl: 'https://my-project.supabase.co',
      supabaseAnonKey: '',
    });
    expect(resolved.supabaseUrl).toBe('https://my-project.supabase.co');
    expect(resolved.supabaseAnonKey).toBe(DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY);
  });
});

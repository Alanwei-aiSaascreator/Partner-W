import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY,
  DEFAULT_COMMERCIAL_SUPABASE_URL,
  resolveCommercialCredentials,
} from '../src/index.js';

/**
 * 私有化 / 开源版（2026-10）：默认**不内置**生产商业凭据。
 *
 * 开源客户端默认进入本地模式：无登录、无 license 校验、不发用量埋点。
 * 因此默认常量清空，`resolveCommercialCredentials` 在无配置时返回空，
 * 上层据此判定"未配置" → 本地模式（`App.tsx` 的 `entryModeFromConfig`）。
 *
 * 需要接回商业后端时，在 `clawwork-config.json` 的 `commercial` 段填入
 * `supabaseUrl` / `supabaseAnonKey` 即可（非空优先）。
 */

describe('私有化版默认不内置商业凭据', () => {
  it('默认 Supabase URL 为空（本地模式，不连商业后端）', () => {
    expect(DEFAULT_COMMERCIAL_SUPABASE_URL).toBe('');
  });

  it('默认 anon key 为空（本地模式）', () => {
    expect(DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY).toBe('');
  });
});

describe('resolveCommercialCredentials（读取期兜底）', () => {
  it('干净机器（配置里没有商业段）⇒ 空凭据（本地模式）', () => {
    expect(resolveCommercialCredentials(undefined)).toEqual({
      supabaseUrl: '',
      supabaseAnonKey: '',
    });
  });

  it('显式传 null（不只是 undefined）⇒ 同样空凭据', () => {
    expect(resolveCommercialCredentials(null)).toEqual({
      supabaseUrl: '',
      supabaseAnonKey: '',
    });
  });

  it('商业段存在但字段是空串（老 profile / 被清过）⇒ 空凭据', () => {
    expect(resolveCommercialCredentials({ supabaseUrl: '', supabaseAnonKey: '' })).toEqual({
      supabaseUrl: '',
      supabaseAnonKey: '',
    });
  });

  it('只有空白字符也算空（不把 " " 当成用户填的值）', () => {
    expect(resolveCommercialCredentials({ supabaseUrl: '  ', supabaseAnonKey: '\n' })).toEqual({
      supabaseUrl: '',
      supabaseAnonKey: '',
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

  it('只填了其中一个 ⇒ 空的那个回落到空（本地模式默认值）', () => {
    // 私有化版默认就是空：半配置时 url 是用户的、key 是空的，
    // `getCommercialClient()` 因 key 为空返回 null（不连生产）。
    const resolved = resolveCommercialCredentials({
      supabaseUrl: 'https://my-project.supabase.co',
      supabaseAnonKey: '',
    });
    expect(resolved.supabaseUrl).toBe('https://my-project.supabase.co');
    expect(resolved.supabaseAnonKey).toBe('');
  });
});

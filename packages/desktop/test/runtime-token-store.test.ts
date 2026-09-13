import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_STORE_FORMAT_VERSION,
  LOCAL_GATEWAY_AUTH_FILE,
  authStorePath,
  ensureLocalGatewayToken,
  readAuthStore,
} from '../src/main/runtime/token-store.js';

/**
 * ClawWork 自己持有的本机网关令牌。
 *
 * 这层存在的理由（实测，不是推测）：token 只活在**别人拥有**的
 * `openclaw.json` 里时，那份文件一被换掉/删掉，我们就"重新生成一个" ⇒
 * 拿新 token 去认证还在用旧 token 跑的网关 ⇒ 认证失败 ⇒ 被误判成 foreign。
 * ⇒ 真相源必须是**我们自己的** store，且它的生命周期不由 openclaw 的行为决定。
 *
 * ⚠️ 会话安全：只在 mkdtemp 里建删文件，绝不触碰真实 `%APPDATA%`。
 */

let tmpRoot: string;
let userDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-token-'));
  userDataDir = path.join(tmpRoot, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
});

afterEach(() => {
  if (tmpRoot && tmpRoot.includes(path.join(os.tmpdir(), 'clawwork-token-'))) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describe('ensureLocalGatewayToken', () => {
  it('首跑：生成一个 32 字节 base64url 的 token，原子落盘', () => {
    const res = ensureLocalGatewayToken({ userDataDir });

    expect(res.created).toBe(true);
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.existsSync(res.path)).toBe(true);
    // 原子写的中间文件不能留下
    expect(fs.existsSync(res.path + '.tmp')).toBe(false);

    const raw = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    expect(raw.formatVersion).toBe(AUTH_STORE_FORMAT_VERSION);
    expect(raw.token).toBe(res.token);
    expect(typeof raw.createdAt).toBe('string');
  });

  it('⭐ 二跑：**永远复用同一个 token**，且不重写文件', () => {
    const first = ensureLocalGatewayToken({ userDataDir });
    const before = fs.readFileSync(first.path, 'utf-8');

    const second = ensureLocalGatewayToken({ userDataDir });

    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
    // 不每次启动都重写（createdAt 保持不变就是没写过）
    expect(fs.readFileSync(first.path, 'utf-8')).toBe(before);
  });

  it('⭐ 落在 <userData>/runtime/ 下 —— **不是** openclaw 会迁移/清掉的目录', () => {
    const res = ensureLocalGatewayToken({ userDataDir });
    expect(res.path).toBe(path.join(userDataDir, 'runtime', LOCAL_GATEWAY_AUTH_FILE));
    expect(LOCAL_GATEWAY_AUTH_FILE).toBe('local-gateway-auth.json');
    expect(res.path).not.toContain('openclaw-state');
  });

  it('⭐ 文件是半截 JSON（掉电）⇒ 当成"还没有"重新生成，不崩', () => {
    const file = authStorePath(userDataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "formatVersion": 1, "tok');

    const res = ensureLocalGatewayToken({ userDataDir });
    expect(res.created).toBe(true);
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => JSON.parse(fs.readFileSync(file, 'utf-8'))).not.toThrow();
  });

  it('⭐ formatVersion 不认识 ⇒ 不硬读，重新生成（宁可再生也不要用一个读不懂的东西）', () => {
    const file = authStorePath(userDataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ formatVersion: 99, token: 'from-the-future' }));

    expect(readAuthStore(userDataDir)).toBeNull();
    expect(ensureLocalGatewayToken({ userDataDir }).token).not.toBe('from-the-future');
  });

  it('token 不是非空字符串 ⇒ 同上', () => {
    const file = authStorePath(userDataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const bad of [undefined, null, 42, '', {}]) {
      fs.writeFileSync(file, JSON.stringify({ formatVersion: 1, token: bad }));
      expect(readAuthStore(userDataDir)).toBeNull();
    }
  });
});

describe('adopt —— 只在 store 首次建立时接管一次', () => {
  it('⭐ store 不存在时接管已有的 token（升级场景：不能因为建 store 就换掉活着的网关的 token）', () => {
    const res = ensureLocalGatewayToken({ userDataDir, adopt: () => 'legacy-token' });

    expect(res.created).toBe(true);
    expect(res.token).toBe('legacy-token');
    expect(readAuthStore(userDataDir)?.token).toBe('legacy-token');
  });

  it('⭐ store 一旦建立，adopt **不再被问**（真相源已经定了）', () => {
    ensureLocalGatewayToken({ userDataDir, adopt: () => 'legacy-token' });

    const adopt = vi.fn(() => 'different-token');
    const res = ensureLocalGatewayToken({ userDataDir, adopt });

    expect(res.token).toBe('legacy-token');
    expect(adopt).not.toHaveBeenCalled();
  });

  it('adopt 没有可接管的（null）⇒ 生成新的', () => {
    const res = ensureLocalGatewayToken({ userDataDir, adopt: () => null });
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('adopt 自己抛 ⇒ 当成没有可接管，不让整个启动挂掉', () => {
    const res = ensureLocalGatewayToken({
      userDataDir,
      adopt: () => {
        throw new Error('config 读不了');
      },
    });
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('明文 token 绝不进日志', () => {
  it('⭐ 首次建立（含接管路径）全程不往 console 吐 token', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = ensureLocalGatewayToken({ userDataDir, adopt: () => 'legacy-token' });
      ensureLocalGatewayToken({ userDataDir });

      const printed = [...log.mock.calls, ...info.mock.calls, ...warn.mock.calls, ...error.mock.calls]
        .flat()
        .map(String)
        .join('\n');
      expect(printed).not.toContain(res.token);
      expect(printed).not.toContain('legacy-token');
    } finally {
      log.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

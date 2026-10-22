import { describe, expect, it } from 'vitest';
import { buildGatewayOriginPatch } from '../../src/main/remote-access/gateway-settings.js';

/**
 * 网关白名单补丁：公网 origin 怎么写进 `controlUi.allowedOrigins`。
 * 错了的后果很具体 —— 设备页打得开、一调接口就 403。
 */

const HOST = 'test0001.rym.rongyinghudong.com';
// 原生壳（Capacitor）加载本地资源，Origin 不是公网域名：Android 是 https://localhost，
// iOS 是 capacitor://localhost。这两条必须常驻白名单，否则 App 一连就 1008。
const NATIVE = ['https://localhost', 'capacitor://localhost'];

describe('buildGatewayOriginPatch', () => {
  it('空配置时加公网 origin 与两条原生壳 origin', () => {
    const patch = buildGatewayOriginPatch(null, HOST);
    expect(patch.gateway.controlUi.allowedOrigins).toEqual([`https://${HOST}`, ...NATIVE]);
    expect(patch.gateway.publicOrigin).toBe(`https://${HOST}`);
  });

  it('保留已有 origin，只追加（别的客户端可能正靠它们）', () => {
    const config = {
      gateway: { controlUi: { allowedOrigins: ['https://a.example.com', 'http://127.0.0.1:18789'] } },
    };
    const patch = buildGatewayOriginPatch(config, HOST);
    expect(patch.gateway.controlUi.allowedOrigins).toEqual([
      'https://a.example.com',
      'http://127.0.0.1:18789',
      `https://${HOST}`,
      ...NATIVE,
    ]);
  });

  it('已经存在时不重复添加（大小写与尾斜杠都归一）', () => {
    const config = {
      gateway: { controlUi: { allowedOrigins: [`https://${HOST.toUpperCase()}/`, ...NATIVE] } },
    };
    const patch = buildGatewayOriginPatch(config, HOST);
    expect(patch.gateway.controlUi.allowedOrigins).toEqual([`https://${HOST}`, ...NATIVE]);
  });

  it('host 带 scheme 也接受，最终只有一个 https origin', () => {
    const patch = buildGatewayOriginPatch({}, `https://${HOST}/`);
    expect(patch.gateway.controlUi.allowedOrigins).toEqual([`https://${HOST}`, ...NATIVE]);
  });

  it('非数组 / 脏值不影响生成', () => {
    const patch = buildGatewayOriginPatch(
      { gateway: { controlUi: { allowedOrigins: 'not-an-array' } } },
      HOST,
    );
    expect(patch.gateway.controlUi.allowedOrigins).toEqual([`https://${HOST}`, ...NATIVE]);

    const dirty = buildGatewayOriginPatch(
      { gateway: { controlUi: { allowedOrigins: [42, '', null, 'https://b.example.com'] } } },
      HOST,
    );
    expect(dirty.gateway.controlUi.allowedOrigins).toEqual([
      'https://b.example.com',
      `https://${HOST}`,
      ...NATIVE,
    ]);
  });

  it('不碰白名单以外的字段（返回的是补丁，不是整份配置）', () => {
    const patch = buildGatewayOriginPatch({ gateway: { bind: 'loopback', auth: { mode: 'token' } } }, HOST);
    expect(Object.keys(patch)).toEqual(['gateway']);
    expect(Object.keys(patch.gateway).sort()).toEqual(['controlUi', 'publicOrigin']);
  });

  it('空 host 直接拒绝', () => {
    expect(() => buildGatewayOriginPatch({}, '   ')).toThrow('host is required');
  });
});

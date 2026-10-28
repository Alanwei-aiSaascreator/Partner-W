import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { scanBundleText } = require('../scripts/bundle-secrets.cjs');
const { checkBundledSecrets } = require('../scripts/afterPack.cjs');

/**
 * 随包密钥门禁（2026-09-18，借鉴隔壁产品踩的坑：真模型钥匙明文随包、且换不掉）。
 *
 * 规则要**正负都钉住**：anon key 是故意的（公开客户端密钥，RLS 保护数据），
 * service_role / 私钥 / 模型钥匙才是问题。只测"有问题会被抓"会把允许项也一起误伤。
 */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.c2lnbmF0dXJlX3BhcnRfaGVyZQ`;
}

describe('scanBundleText', () => {
  it('⭐ anon key 允许随包（本来就公开，随包是设计）', () => {
    const anon = jwt({ iss: 'supabase', ref: 'qiprqsdfolcffjawkrsm', role: 'anon' });
    expect(scanBundleText(`const anonKey = '${anon}';`)).toEqual([]);
  });

  it('🔴 service_role 的 JWT ⇒ 报出来（项目纪律：绝不进客户端）', () => {
    const bad = jwt({ iss: 'supabase', role: 'service_role' });
    const findings = scanBundleText(`const k = '${bad}';`);
    expect(findings.map((f: { rule: string }) => f.rule)).toContain('jwt-non-anon');
    expect(JSON.stringify(findings)).toContain('service_role');
  });

  it('🔴 私钥 PEM ⇒ 报出来', () => {
    expect(scanBundleText('-----BEGIN RSA PRIVATE KEY-----\nMIIE...').map((f: { rule: string }) => f.rule)).toContain(
      'private-key',
    );
  });

  it('🔴 模型服务商钥匙 / 阿里云 AccessKey ⇒ 报出来', () => {
    const rules = scanBundleText(`DASHSCOPE_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345\nLTAI5tAbCdEfGhIjKlMnOp`).map(
      (f: { rule: string }) => f.rule,
    );
    expect(rules).toContain('provider-api-key');
    expect(rules).toContain('aliyun-access-key-id');
  });

  it('普通代码里的 eyJ 开头短串 / 无关字符串不误报', () => {
    expect(scanBundleText('const eyJx = "eyJhbGci"; const sk = "sk-short";')).toEqual([]);
  });

  it('⭐ 注释里写 "不许用 service_role" 不算问题（我们自己的源码里就有这句）', () => {
    // 早先按字面量扫 ⇒ 真实产物里报了 100 条全是自己写的注释。真正危险的是**钥匙**，
    // 由 jwt-non-anon 规则抓（上一条用例）。
    const text = '// 符合本项目"不许用 service_role"的纪律 —— service_role 能绕过 RLS';
    expect(scanBundleText(text)).toEqual([]);
  });
});

describe('afterPack 接线：扫到就让构建失败', () => {
  it('⭐ 有发现 ⇒ 抛错（构建中断），报错里带规则名与样例', async () => {
    const stub = () => [
      { rule: 'jwt-non-anon', detail: 'JWT 的 role=service_role（只许 anon）', sample: 'eyJhbGci…', file: 'app.asar' },
    ];
    await expect(checkBundledSecrets({ appOutDir: 'X:/no-such-dir' }, stub)).rejects.toThrow(/bundle-secrets/);
  });

  it('没发现 ⇒ 正常返回（不打扰构建）', async () => {
    await expect(checkBundledSecrets({ appOutDir: 'X:/no-such-dir' }, () => [])).resolves.toBe(0);
  });
});

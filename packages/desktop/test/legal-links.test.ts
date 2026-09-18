import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 登录页两个协议链接必须指向**各自**的页面
 * （`docs/superpowers/specs/2026-09-15-协议文本-design.md` 交付物 6）。
 *
 * 这个缺陷真实发生过：9 个语言包里 `login.termsUrl` 与 `login.privacyUrl` 取值完全相同
 * （都是 privacy.html）⇒ 用户点「服务条款」看到的是隐私政策。
 *
 * ⚠️ 语言清单从**目录**里读，不手抄：新增语言包会自动纳入对照。
 *    手抄清单是这套仓库里出过假绿的形状（少一个文件时循环根本遍历不到它）。
 */
const localeDir = join(__dirname, '../src/renderer/i18n/locales');
const localeFiles = readdirSync(localeDir)
  .filter((name) => name.endsWith('.json'))
  .sort();

const TERMS_URL = 'https://www.rongyinghudong.com/terms.html';
const PRIVACY_URL = 'https://www.rongyinghudong.com/privacy.html';

describe('登录页协议链接', () => {
  it('语言包目录里确实有文件（读不到文件时不要静默通过）', () => {
    expect(localeFiles.length).toBeGreaterThan(0);
  });

  it.each(localeFiles)('%s：服务条款→terms.html、隐私政策→privacy.html，且两者不同', (name) => {
    const json = JSON.parse(readFileSync(join(localeDir, name), 'utf8')) as {
      login?: { termsUrl?: string; privacyUrl?: string };
    };
    const login = json.login;
    expect(login, `${name} 缺 login 段`).toBeTruthy();
    expect(login?.termsUrl, `${name} 缺 login.termsUrl`).toBeTruthy();
    expect(login?.privacyUrl, `${name} 缺 login.privacyUrl`).toBeTruthy();
    expect(login?.termsUrl, `${name} 的 login.termsUrl`).toBe(TERMS_URL);
    expect(login?.privacyUrl, `${name} 的 login.privacyUrl`).toBe(PRIVACY_URL);
    // 两个 key 相同 ⇒ 服务条款链接会把用户带到隐私政策（本次修复的那个缺陷）
    expect(login?.termsUrl, `${name} 两个链接指向了同一个地址`).not.toBe(login?.privacyUrl);
  });
});

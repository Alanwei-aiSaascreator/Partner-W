'use strict';

/**
 * 打包产物里的**密钥门禁**：随包只许有 anon key（公开客户端密钥），别的一律不许出现。
 *
 * 为什么要有它（2026-09-18，借鉴别人踩的坑）：
 *   隔壁一个同类产品把**真模型钥匙**和短信设备键明文放在随包的 `config.txt` 里发出去，
 *   而且更新只换 app.asar、config 不动 ⇒ **钥匙收不回、也换不掉**。他们写了
 *   `scripts/check-no-secrets.js` 但显然没生效。
 *
 * 我们的纪律本来就是"不许用 service_role"，这条把它变成**构建期硬失败**：
 * 打包时扫一遍产物，扫到就中断构建 —— 而不是等出事。
 *
 * ⚠️ 允许项要写清楚，否则会误伤：`packages/shared/src/commercial-defaults.ts` 里的
 *    supabase URL 与 **anon key** 是**故意随包**的（RLS 保护数据，anon 本来就是公开的）。
 *    所以 JWT 的规则是"解出 payload，role 不是 anon 才算问题"，而不是"有 JWT 就报"。
 *
 * 用法：
 *   node scripts/bundle-secrets.cjs <文件或目录>        # 扫并报告（有发现则 exit 1）
 *   require('./bundle-secrets.cjs').scanBundleText(t)   # 纯函数，给单测用
 */

const fs = require('node:fs');
const path = require('node:path');

const RULES = [
  {
    id: 'private-key',
    label: '私钥（PEM）',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'aliyun-access-key-id',
    label: '阿里云 AccessKeyId',
    re: /\bLTAI[A-Za-z0-9]{12,}\b/g,
  },
  {
    id: 'provider-api-key',
    label: '模型服务商 API key（sk-…）',
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  },
];

// ⚠️ 这里**故意没有**"字面量 service_role"这条规则：我们自己的注释里就写着
//    「不许用 service_role」（`packages/shared/src/commercial-defaults.ts`），
//    而注释会被原样打进产物 ⇒ 实测一次报了 100 条全是自己写的字。
//    真正危险的是**钥匙**，由下面的 `jwt-non-anon` 规则抓（解 payload 看 role）。

/** 从 JWT 里解出 payload（不解就返回 null：格式不对的字符串不是我们的目标）。 */
function jwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 扫一段文本，返回发现列表。
 * @param {string} text
 * @returns {{ rule: string; detail: string; sample: string }[]}
 */
function scanBundleText(text) {
  const findings = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      findings.push({ rule: rule.id, detail: rule.label, sample: `${m[0].slice(0, 12)}…` });
    }
  }

  // JWT 单独判：**只有 role 存在且不是 anon 的**才算问题（anon 是允许随包的公开密钥）
  const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
  let j;
  while ((j = jwtRe.exec(text)) !== null) {
    const payload = jwtPayload(j[0]);
    const role = payload && typeof payload.role === 'string' ? payload.role : null;
    if (role && role !== 'anon') {
      findings.push({
        rule: 'jwt-non-anon',
        detail: `JWT 的 role=${role}（只许 anon）`,
        sample: `${j[0].slice(0, 12)}…`,
      });
    }
  }

  return findings;
}

/** 扫一个文件（asar 也能读：内容是原样存的）；目录则递归扫。 */
function scanBundlePath(target) {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
      return;
    }
    // 只扫可能藏字符串的东西，图片/字体/二进制跳过
    if (/\.(png|jpg|jpeg|gif|ico|ttf|woff2?|pak|dll|exe|node|db|dat)$/i.test(p)) return;
    // ⚠️ **不要**按体积跳过：早先这里写了"超过 64MB 就跳过"，而真实 app.asar 有 79MB
    //    ⇒ 门禁一次性沦为空转（还打印 ✓ 通过）。假绿比没有门禁更坏 —— 反证脚本
    //    （往真实 asar 里塞一把 service_role JWT）当场把它抓了出来。
    const text = fs.readFileSync(p).toString('latin1');
    for (const f of scanBundleText(text)) out.push({ ...f, file: p });
  };
  walk(target);
  return out;
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('用法: node scripts/bundle-secrets.cjs <文件或目录>');
    process.exit(2);
  }
  const findings = scanBundlePath(target);
  if (findings.length === 0) {
    console.log(`[bundle-secrets] ✓ ${target}：没扫到不该随包的密钥（anon key 允许）`);
    return;
  }
  console.error(`[bundle-secrets] ✗ ${target}：扫到 ${findings.length} 处不该随包的内容 ——`);
  for (const f of findings) console.error(`  · [${f.rule}] ${f.detail}  ${f.file}\n    样例: ${f.sample}`);
  console.error('  随包只允许 anon key（公开客户端密钥）。service_role / 私钥 / 模型钥匙一律不许进包。');
  process.exit(1);
}

module.exports = { scanBundleText, scanBundlePath };

if (require.main === module) main();

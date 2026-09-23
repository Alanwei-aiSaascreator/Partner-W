/**
 * 构建门禁：**内嵌的更新公钥不许为空**，空了就中止构建。
 *
 * 为什么必须有这道门（2026-09-23 取证）：
 *   `electron.vite.config.ts:9-11` 用
 *   `JSON.stringify(process.env.MOFANG_UPDATE_PUBLIC_KEY_B64 ?? '')` 注入 ——
 *   **变量没设时注入空串，构建静默通过**。而 CI 的 `release` job
 *   （`.github/workflows/release.yml`）**通 job 都没有这个变量**
 *   （只有另一个 `portable-update-release` job 在 `:216` 写它）
 *   ⇒ 今天发出去的安装器里公钥就是空的。
 *   运行期读到空串后 `update/portable-manifest.ts:31-40` 解码失败并抛
 *   `signature-invalid` —— **报错了，但报的是"签名无效"，不是"这个包没带公钥"**。
 *   用户看到的是一句永远对不上的过期文案。
 *
 * 同一个不变量在**启动器**那一侧早就是硬失败
 * （`scripts/lib/portable-launcher-build.mjs:32-39` 抛
 * `MOFANG_UPDATE_PUBLIC_KEY_B64 is required to build the portable launcher`）。
 * 这里补的是客户端这一侧缺掉的半边。
 *
 * 判据与 Go 的 `decodePublicKey`（`launcher/cmd/mofang-launcher/main.go:74-91`）
 * **逐条对齐**：非空 → base64 能解 → 是 PKIX/SPKI DER → 是 Ed25519。四条缺一即失败。
 * 对齐的理由：两侧各自独立验签、各自内嵌公钥，一边收了另一边收不了的钥匙
 * 就等于发了一份永远装不上的更新。
 *
 * 为什么挂两处：
 *   1. `package.json` 的 `build`/`build:*` 前置（`--require-env`）：秒级失败，
 *      不必等 electron-vite 吭哧吭哧打完再等 electron-builder；
 *   2. `electron-builder.yml` 的 `beforePack`：**查真正的产物**
 *      （`out/main/index.js` 里到底有没有那把钥匙）。
 *      只有第 2 处能证明"真的注进去了"——第 1 处只证明"环境里有"。
 *      `beforePack` 跑在 `electron-vite build` **之后**，所以它改不了已经注入的空串，
 *      但它**能让打包失败** —— 而"打出一个没有公钥的安装包"正是要禁止的那件事。
 *
 * ⚠️ 为什么不在 `electron.vite.config.ts` 的 define 处直接抛：
 *   那里是按 `command`（`build` / `serve`）区分的，而 `electron-vite build` 同时被
 *   **打包**（本门禁要管的）和 **e2e/CI 冒烟构建**（`.github/workflows/e2e.yml:108,151`
 *   直接用 `electron-vite build`，本来就没有钥匙也不需要）走。在 define 处抛会把
 *   e2e 一起打掉 —— 那是误伤。挂在这两个位置则能精确表达"**只有会产出安装包的路**才强制"：
 *   `electron-vite dev`、单测、e2e **都不经过**这两个挂点。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createPublicKey } = require('node:crypto');

/** 内嵌更新公钥的变量名 —— 必须与 `electron.vite.config.ts` 读的那个变量一致。 */
const ENV_VAR_NAME = 'MOFANG_UPDATE_PUBLIC_KEY_B64';

/** 主进程产物的相对路径 —— 必须与 `package.json` 的 `main` 一致（有测试钉住）。 */
const MAIN_BUNDLE_RELATIVE_PATH = path.join('out', 'main', 'index.js');

/** 与 `update/portable-manifest.ts` 的 BASE64_PATTERN 同形（严格 base64，不接受 URL-safe）。 */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeStrictBase64(value) {
  if (value.length === 0 || !BASE64_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) return null;
  return decoded;
}

/**
 * 返回问题清单；空数组 = 通过。纯函数（只看传入的 env），不碰真盘。
 */
function collectPublicKeyProblems(env) {
  const raw = env ? env[ENV_VAR_NAME] : undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [
      raw === undefined
        ? `${ENV_VAR_NAME} 没有设置（缺变量时注入处会静默写入空串，这正是事故的形状）`
        : `${ENV_VAR_NAME} 是空的（值为 ${JSON.stringify(raw)}）`,
    ];
  }

  const value = raw.trim();
  const der = decodeStrictBase64(value);
  if (der === null) {
    return [`${ENV_VAR_NAME} 不是严格 base64（值为 ${JSON.stringify(value.slice(0, 16))}…）`];
  }

  let key;
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch (error) {
    return [`${ENV_VAR_NAME} 解出来不是一份 SPKI 公钥（DER 解析失败：${(error && error.message) || error}）`];
  }

  if (key.asymmetricKeyType !== 'ed25519') {
    return [
      `${ENV_VAR_NAME} 是 ${String(key.asymmetricKeyType).toUpperCase()} 钥匙，` +
        '但更新验签用的是 ED25519 —— 换错算法的包在盘上永远验不过',
    ];
  }

  return [];
}

/**
 * 返回 `null` = 通过；返回字符串 = 给人看的中文报错（调用方直接抛它）。
 */
function checkPublicKeyEnvironment(env) {
  const problems = collectPublicKeyProblems(env);
  if (problems.length === 0) return null;

  return [
    '构建中止：这个包是个**空公钥包** —— 它没有带更新公钥，',
    '内嵌的 __MOFANG_UPDATE_PUBLIC_KEY_B64__ 会是空串。',
    '打出去以后，盘上"检查更新"永远失败，而且**报的是 signature-invalid**——',
    '用户看到的是一句"更新包的签名校验没过，这份包不是我们发布的"，跟真正的原因对不上。',
    '',
    ...problems.map((p) => `  - ${p}`),
    '',
    '怎么修：构建前设好这一对（两侧各自内嵌同一把公钥，缺一边那一侧就装不了更新）：',
    `  $env:${ENV_VAR_NAME} = '<与私钥匹配的 Ed25519 SPKI Base64 公钥>'`,
    "  $env:MOFANG_LAUNCHER_VERSION = '<版本>'",
    '⚠️ 从 CI 发布时：`release` job 必须把 `secrets.MOFANG_UPDATE_PUBLIC_KEY_B64`',
    '   写进 job env（另一个 `portable-update-release` job 已经这么做了，见 release.yml:216）。',
    '',
    '⚠️ 开发与测试路径不受影响：`electron-vite dev`、单测、e2e 都不经过这道门。',
  ].join('\n');
}

/**
 * 产物侧：`out/main/index.js` 里到底有没有那把钥匙。
 *
 * 为什么不能只查环境：环境对了但注入没生效（改了变量名、out/ 是上一把钥匙打的旧产物、
 * 构建脚本换了），打出来照样是个没有公钥的包。这条查的是**真东西**。
 */
function checkBuiltBundle(input) {
  const readFile = input.readFile || ((target) => fs.readFileSync(target, 'utf8'));
  const displayPath = input.bundlePath;
  const relativePath = MAIN_BUNDLE_RELATIVE_PATH;
  const keyBase64 = String(input.keyBase64 || '').trim();

  let source;
  try {
    source = readFile(input.bundlePath);
  } catch (error) {
    return [
      `构建中止：读不到主进程产物 ${displayPath}`,
      `（${(error && error.message) || error}）`,
      '',
      '这通常意味着 `out/` 还没构建、或者构建产物换了位置：',
      `  期望的产物 = ${relativePath}（与 package.json 的 main 一致）`,
      '先跑 `electron-vite build`，或确认构建配置没改输出目录。',
    ].join('\n');
  }

  if (keyBase64.length === 0 || !source.includes(keyBase64)) {
    return [
      `构建中止：主进程产物里**没有那把更新公钥**（${displayPath}）。`,
      '环境变量是对的，但注入没落到产物上 —— 这个包打出去同样"永远检查不到更新"。',
      '',
      `  产物 = ${relativePath}`,
      '常见原因：改了 `electron.vite.config.ts` 里 define 用的变量名、',
      '或者打的是上一把钥匙（甚至没钥匙）留下的旧 `out/`。',
      '先 `electron-vite build` 一次再打包。',
    ].join('\n');
  }

  return null;
}

/**
 * electron-builder 的 `beforePack` 入口。`readFile` 可注入（单测用）。
 */
async function beforePack(context, readFile) {
  const packager = context && context.packager;
  const projectDir = (packager && packager.projectDir) || process.cwd();

  const environmentMessage = checkPublicKeyEnvironment(process.env);
  if (environmentMessage) throw new Error(environmentMessage);

  const bundlePath = path.resolve(projectDir, MAIN_BUNDLE_RELATIVE_PATH);
  const bundleMessage = checkBuiltBundle({
    bundlePath,
    keyBase64: process.env[ENV_VAR_NAME],
    readFile: readFile || ((target) => fs.readFileSync(target, 'utf8')),
  });
  if (bundleMessage) throw new Error(bundleMessage);

  console.log('[require-update-public-key] 内嵌更新公钥已就位，且已确认注入到了主进程产物里');
}

function main(argv) {
  if (!argv.includes('--require-env')) {
    console.error(`[require-update-public-key] unknown arguments: ${argv.join(' ')}`);
    return 2;
  }
  const message = checkPublicKeyEnvironment(process.env);
  if (message) {
    console.error(message);
    return 1;
  }
  console.log('[require-update-public-key] 内嵌更新公钥已就位');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

exports.ENV_VAR_NAME = ENV_VAR_NAME;
exports.MAIN_BUNDLE_RELATIVE_PATH = MAIN_BUNDLE_RELATIVE_PATH;
exports.decodeStrictBase64 = decodeStrictBase64;
exports.collectPublicKeyProblems = collectPublicKeyProblems;
exports.checkPublicKeyEnvironment = checkPublicKeyEnvironment;
exports.checkBuiltBundle = checkBuiltBundle;
exports.beforePack = beforePack;
exports.main = main;
exports.default = beforePack;

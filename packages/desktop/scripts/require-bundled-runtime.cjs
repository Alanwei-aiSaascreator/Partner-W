/**
 * beforePack 门禁：**随安装包自带的运行时必须真的在**，缺了就中止构建。
 *
 * 为什么必须有这道门：electron-builder 对不存在的 extraResources 源**只 warn 不报错**
 * （见 app-builder-lib/out/fileMatcher.js 的 `copyFiles()`：`log.warn({from}, "file source
 * doesn't exist")` 之后直接 return）。于是"忘了产出 `runtime-out/`"照样能打出一个
 * **看起来正常**的安装包 —— 2026-09-18 事故的形状：装进 U 盘的包网关起不来，
 * 而构建日志里只有一行容易漏掉的 warn。`electron-builder.yml` 本身表达不了
 * "缺了就失败"，所以只能挂一个钩子。
 *
 * 判定基准**不重复写路径**：读的就是配置里那些 `from`，并按 electron-builder 自己的
 * 规则解析 —— `path.resolve(packager.projectDir, from)`（见 app-builder-lib 的
 * `createGetFileMatchersOptions`：`defaultSrc: this.projectDir`；而 `projectDir` =
 * 运行 electron-builder 的目录，也就是本包 `packages/desktop`）。
 * ⇒ yml 改了路径这里自动跟着变，不会两边漂移。
 *
 * ⚠️ 只有 `BUNDLED_TO`（下面那个常量）与客户端 `locate.ts` 的
 * `BUNDLED_RUNTIME_DIR_NAME` 是**天然会漂移的一对**（脚本不能 import TS）：
 * 靠 `test/runtime-packaging-gate.test.ts` 断言两者相等钉住。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** 随包运行时在 `<resources>` 下的目录名 —— 必须与 `locate.ts` 的 BUNDLED_RUNTIME_DIR_NAME 一致。 */
const BUNDLED_TO = 'runtime';

/** 认盘/认包的 marker（必须与 `locate.ts` 的 RUNTIME_MANIFEST_FILE 一致）。 */
const MARKER = 'openclaw-runtime-manifest.json';

/** 随包嵌入模型在 `<resources>` 下的目录名 —— 必须与 `kb/embedding/locate.ts` 的 KB_MODEL_DIR_NAME 一致。 */
const KB_MODEL_TO = 'kb-model';

/**
 * 模型 id —— 必须与 `kb/embedding/engine.ts` 的 `KB_EMBEDDING_MODEL_ID` 一致。
 *
 * ⚠️ 它是**子目录名**：`<resources>/kb-model/bge-small-zh-v1.5/…`。这层不能省 ——
 * `@huggingface/transformers` 要的是 `localModelPath`（=`<resources>/kb-model`）
 * 加一个模型 id，两段拼起来才是权重所在。
 * 本钩子第一版把必查路径写成了 `kb-model/config.json`（漏了这层），
 * 结果**被自己这道门禁挡在构建里** —— 挡得对，如果不挡，装出来的包里
 * 引擎会找不到模型、静默退化成纯关键词检索。
 */
const KB_MODEL_ID = 'bge-small-zh-v1.5';

/**
 * 模型目录里**必须齐**的文件（相对 `<resources>/kb-model`）。
 *
 * ⚠️ 只查"目录在不在"是不够的：`runtime-out/kb-model/` 完全可以只有半份
 *（比如 `onnx/model.onnx` 那 90MB 下载中断，而抓取脚本是**先写 .part 再改名**的，
 * 所以正常情况下不会留半个文件 —— 但手工拷、或换台机器重建时就可能）。
 * 缺 onnx 权重的表现最坏：包能装、应用能开，**只是资料库永远退化成纯关键词检索**，
 * 没有任何报错。所以这里把"齐"变成硬失败。
 */
const KB_MODEL_REQUIRED = ['manifest.json', 'config.json', 'tokenizer.json', 'onnx/model.onnx'].map(
  (file) => `${KB_MODEL_ID}/${file}`,
);

/**
 * 飞书可信安装所需的随包 npm 负载（BUG-171）。
 *
 * 缺少它时应用仍能启动，但飞书**只能发、不能收**（内核要求 npm 安装记录才能开
 * channel ingress），所以必须在构建期硬失败，而不是发到用户手里才发现。
 */
const FEISHU_NPM_REQUIRED = ['node/npm.cmd', 'node/node_modules/npm/bin/npm-cli.js', 'node/npm-cache/_cacache'];

/** 每个 `to:` 目标各自"必须存在"的路径；没有条目的目标只查目录本身。 */
const REQUIRED_UNDER = {
  [BUNDLED_TO]: [MARKER, ...FEISHU_NPM_REQUIRED],
  [KB_MODEL_TO]: KB_MODEL_REQUIRED,
};

/** 通配源（`*.png` 那类）跳过：匹配不到不一定是错，与这道门禁的意图不同。 */
function isLiteralSource(from) {
  return !/[*?[\]{}]/.test(from);
}

/**
 * 配置里那些**静态**的 extraResources 源（纯计算，不碰盘）。
 *
 * 两种写法都认：`- build/icon.png` 与 `- { from, to }`（`normalizeFiles` 会把前者
 * 统一整成对象，但这里不依赖那个细节）。
 */
function staticExtraResourceSources(config, projectDir) {
  const list = (config && config.extraResources) || [];
  const out = [];
  for (const entry of list) {
    const isObject = entry && typeof entry === 'object';
    const from = typeof entry === 'string' ? entry : isObject ? entry.from : null;
    if (typeof from !== 'string' || from.length === 0) continue;
    if (!isLiteralSource(from)) continue;
    out.push({
      from,
      to: isObject && typeof entry.to === 'string' ? entry.to : null,
      abs: path.resolve(projectDir, from),
    });
  }
  return out;
}

/**
 * 列出所有"会让装出来的包缺东西"的问题。空数组 = 通过。
 *
 * `exists` 可注入 —— 单测不必真去造一个 222MB 的 `runtime-out/`。
 */
function collectProblems(config, projectDir, exists = fs.existsSync) {
  const sources = staticExtraResourceSources(config, projectDir);
  const problems = [];

  const bundled = sources.find((s) => s.to === BUNDLED_TO);
  if (!bundled) {
    // 没这条 = 客户端认的 `<resources>/runtime` 永远不会命中 ⇒ 干净机器装上就起不来
    problems.push(
      `配置里没有 \`to: ${BUNDLED_TO}\` 的 extraResources 条目 —— 客户端只认 <resources>/${BUNDLED_TO}` +
        `（locate.ts 的 bundled 候选），换成别的目录名就等于没带运行时。`,
    );
  }

  for (const s of sources) {
    if (!exists(s.abs)) {
      problems.push(`缺源：${s.abs}   ← 配置里写的是 from: ${s.from}（基准 = ${projectDir}）`);
      continue;
    }
    const required = s.to ? REQUIRED_UNDER[s.to] : undefined;
    if (!required) continue;
    for (const file of required) {
      if (exists(path.join(s.abs, file))) continue;
      const isFeishuNpm = file.startsWith('node/npm');
      problems.push(
        s.to === BUNDLED_TO
          ? isFeishuNpm
            ? `源里缺飞书 npm 负载：${s.abs} 里没有 ${file}` +
              `（缺了飞书只能发、不能收；在仓库根跑 node packages/desktop/scripts/prepare-feishu-npm.mjs 重新产出）`
            : `源在但**不是一份运行时**：${s.abs} 里没有 ${file}（半成品/拷错了目录都会被判为"这不是运行时"）`
          : `源在但**不完整**：${s.abs} 里没有 ${file}` +
              `（模型齐不齐决定的是"资料库能不能建索引"—— 缺了不报错，只是静默退化成纯关键词检索）`,
      );
    }
  }

  return problems;
}

/**
 * 返回 `null` = 通过；返回字符串 = 给人看的中文报错（`beforePack` 直接抛它）。
 */
function checkBundledRuntime(config, projectDir, exists = fs.existsSync) {
  const problems = collectProblems(config, projectDir, exists);
  if (problems.length === 0) return null;

  return [
    '打包中止：随安装包自带的运行时（extraResources → <resources>/runtime）不完整，',
    '打出来的安装包会在**干净机器上起不来**（客户端找不到运行时，也没有任何联网下载它的代码）。',
    '（electron-builder 自己只会打一行 "file source doesn\'t exist" 的 warn 然后继续，所以这里把它变成硬失败。）',
    '',
    ...problems.map((p) => `  - ${p}`),
    '',
    '出厂运行时怎么产出：在**仓库根**跑 `node scripts/pack-runtime.mjs --version <版本>`，',
    '它会生成 `runtime-out/`（openclaw-runtime-manifest.json + node/ + win32-x64/），然后重新构建。',
    '⚠️ 从 worktree 构建时：`runtime-out/` 在 .gitignore 里、不会随 worktree 带过去 ——',
    '   得先把它拷（或 `mklink /J`）到那个 worktree 的仓库根，否则这道门禁会一直挡着。',
  ].join('\n');
}

async function beforePack(context) {
  const packager = context && context.packager;
  const projectDir = (packager && packager.projectDir) || process.cwd();
  const config = packager && packager.config;

  const message = checkBundledRuntime(config, projectDir);
  if (message) throw new Error(message);

  const { RELAY_VIDEO_RUNTIME_PATCH_ID } = await import('../../../scripts/lib/relay-video-runtime.mjs');
  const root = staticExtraResourceSources(config, projectDir).find((source) => source.to === BUNDLED_TO).abs;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MARKER), 'utf8'));
  if (!Array.isArray(manifest.runtimes) || manifest.runtimes.length === 0) {
    throw new Error('Missing runtime archive manifest entries');
  }
  for (const runtime of manifest.runtimes) {
    if (!Array.isArray(runtime.patches) || !runtime.patches.includes(RELAY_VIDEO_RUNTIME_PATCH_ID)) {
      throw new Error(`Missing required runtime patch: ${RELAY_VIDEO_RUNTIME_PATCH_ID}`);
    }
    if (typeof runtime.archive !== 'string') throw new Error('Invalid runtime archive path');
    const archive = path.resolve(root, runtime.archive);
    const relative = path.relative(root, archive);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Invalid runtime archive path outside bundled root');
    }
    const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(archive));
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error('Invalid runtime archive path through a link');
    }
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== runtime.sha256) throw new Error(`Runtime archive hash mismatch: ${runtime.archive}`);
  }

  const count = staticExtraResourceSources(config, projectDir).length;
  console.log(`[require-bundled-runtime] 随包运行时已就位（extraResources 静态源 ${count} 项全部存在）`);
}

exports.beforePack = beforePack;
exports.default = beforePack;
exports.checkBundledRuntime = checkBundledRuntime;
exports.collectProblems = collectProblems;
exports.staticExtraResourceSources = staticExtraResourceSources;
exports.BUNDLED_TO = BUNDLED_TO;
exports.MARKER = MARKER;
exports.KB_MODEL_TO = KB_MODEL_TO;
exports.KB_MODEL_ID = KB_MODEL_ID;
exports.KB_MODEL_REQUIRED = KB_MODEL_REQUIRED;

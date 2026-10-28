import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 构建门禁：**内嵌的更新公钥不许为空**，空了就中止构建。
 *
 * 为什么必须有这道门（2026-09-23 取证）：`electron.vite.config.ts:9-11` 用
 * `JSON.stringify(process.env.PARTNERW_UPDATE_PUBLIC_KEY_B64 ?? '')` 注入 ——
 * **变量没设时注入空串，构建照样成功**。而 CI 的 `release` job
 * （`.github/workflows/release.yml`）**通 job 没有这个变量**（只有另一个
 * `portable-update-release` job 在 `:216` 写它）⇒ 今天发出去的安装器里公钥就是空的。
 * 运行期读到空串后 `portable-manifest.ts:31-40` 解码失败并抛 `signature-invalid`
 * —— **报错了，但报的是"签名无效"，不是"这个包没带公钥"**。
 *
 * 同一个不变量在**启动器**那一侧早就是硬失败（`scripts/lib/portable-launcher-build.mjs:32-39`
 * 抛 `PARTNERW_UPDATE_PUBLIC_KEY_B64 is required ...`）。这里补的是客户端缺的那半边。
 *
 * 判据（与 Go 的 `decodePublicKey` 逐条对齐，见 `launcher/cmd/partner-w-launcher/main.go:74-91`）：
 *   非空 → base64 能解 → 是 PKIX/SPKI DER → 是 Ed25519。四条缺一即失败。
 *
 * 挂点有两处，**故意都要**：
 *   1. `build`/`build:win`/… 的前置（秒级失败，不必等 electron-vite 打完整棵 bundle）；
 *   2. `electron-builder.yml` 的 `beforePack`（**查真正的产物**：`out/main/index.js`
 *      里到底有没有那把钥匙）—— 只有后者能证明"真注进去了"，前者只证明"环境里有"。
 *
 * ⚠️ 纯函数部分用**注入的 env / readFile**（不碰真盘、不依赖已经构建过的 `out/`）；
 * 与**真配置**的一致性靠本文件末尾那组文本断言 —— 没有它，把 yml 里的钩子摘掉、
 * 或把前置从 package.json 里删掉时，上面所有测试**照样绿**。
 */

const requireCjs = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, '..');

interface PublicKeyGate {
  ENV_VAR_NAME: string;
  MAIN_BUNDLE_RELATIVE_PATH: string;
  collectPublicKeyProblems: (env: Record<string, string | undefined>) => string[];
  checkPublicKeyEnvironment: (env: Record<string, string | undefined>) => string | null;
  checkBuiltBundle: (input: {
    bundlePath: string;
    keyBase64: string;
    readFile?: (target: string) => string;
  }) => string | null;
  beforePack: (context: unknown, readFile?: (target: string) => string) => Promise<void>;
}

const gate = requireCjs('../scripts/require-update-public-key.cjs') as PublicKeyGate;

/** 一把真的 Ed25519 SPKI 公钥（与启动器/客户端验签用的是同一种）。 */
const ED25519_KEY = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

/** 一把合法但不是 Ed25519 的钥匙（rsa）——必须被拒，否则发出去的包永远验不过。 */
const RSA_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'der' })
  .toString('base64');

const BUNDLE_PATH = path.join(PROJECT_DIR, 'out', 'main', 'index.js');

const withKey = (value: string | undefined): Record<string, string | undefined> =>
  value === undefined ? {} : { [gate.ENV_VAR_NAME]: value };

const envKey = (value?: string): void => {
  if (value === undefined) delete process.env[gate.ENV_VAR_NAME];
  else process.env[gate.ENV_VAR_NAME] = value;
};

describe('构建门禁：内嵌更新公钥（环境侧）', () => {
  it('⭐ 变量没设 ⇒ **硬失败**，中文报错说清是"没带公钥"而不是"签名无效"', () => {
    const message = gate.checkPublicKeyEnvironment({});

    expect(message).not.toBeNull();
    const text = message as string;
    expect(text).toContain('构建中止');
    expect(text).toContain(gate.ENV_VAR_NAME); // 缺的是哪个变量
    expect(text).toContain('空公钥');
    expect(text).toContain('signature-invalid'); // 点明"运行期只会误导成签名无效"
  });

  it("变量设了但是空串 / 纯空白 ⇒ 同样失败（`?? ''` 正是事故的写法）", () => {
    expect(gate.checkPublicKeyEnvironment(withKey(''))).not.toBeNull();
    expect(gate.checkPublicKeyEnvironment(withKey('   '))).not.toBeNull();
  });

  it('不是合法 base64 ⇒ 失败', () => {
    expect(gate.checkPublicKeyEnvironment(withKey('not base64!!'))).not.toBeNull();
  });

  it('是合法 base64 但解出来不是 SPKI 公钥 ⇒ 失败（防止塞进一段随机串）', () => {
    expect(gate.checkPublicKeyEnvironment(withKey(Buffer.from('hello').toString('base64')))).not.toBeNull();
  });

  it('⭐ 是合法 SPKI 但不是 Ed25519 ⇒ 失败（与 Go 的 decodePublicKey 同一条判据）', () => {
    const message = gate.checkPublicKeyEnvironment(withKey(RSA_KEY));

    expect(message).not.toBeNull();
    expect(message as string).toContain('ED25519');
  });

  it('真的 Ed25519 SPKI 公钥 ⇒ 通过', () => {
    expect(gate.checkPublicKeyEnvironment(withKey(ED25519_KEY))).toBeNull();
  });

  it('两侧带空白（换行/空格）时也认', () => {
    expect(gate.checkPublicKeyEnvironment(withKey(`  ${ED25519_KEY}  `))).toBeNull();
  });
});

describe('构建门禁：内嵌更新公钥（产物侧 —— out/main/index.js）', () => {
  it('⭐ 产物里有那把钥匙 ⇒ 通过', () => {
    const readFile = (): string => `var k = ${JSON.stringify(ED25519_KEY)};\n`;

    expect(gate.checkBuiltBundle({ bundlePath: BUNDLE_PATH, keyBase64: ED25519_KEY, readFile })).toBeNull();
  });

  it('⭐ 产物里**没有**那把钥匙（空串注入 / out 是旧的）⇒ 硬失败，且报错指向 out 而不是签名', () => {
    const readFile = (): string => 'var k = "";\n';

    const message = gate.checkBuiltBundle({ bundlePath: BUNDLE_PATH, keyBase64: ED25519_KEY, readFile });

    expect(message).not.toBeNull();
    const text = message as string;
    expect(text).toContain('构建中止');
    expect(text).toContain(BUNDLE_PATH); // 是哪个文件里没有
    expect(text).toContain(gate.MAIN_BUNDLE_RELATIVE_PATH);
  });

  it('产物读不出来（还没构建 / 路径漂了）⇒ 硬失败，不当作"通过"', () => {
    const readFile = (): string => {
      throw new Error('ENOENT');
    };

    expect(gate.checkBuiltBundle({ bundlePath: BUNDLE_PATH, keyBase64: ED25519_KEY, readFile })).not.toBeNull();
  });
});

describe('构建门禁：beforePack 钩子（electron-builder 的入口）', () => {
  const context = { packager: { projectDir: PROJECT_DIR } };

  it('变量没设 ⇒ 抛错中止打包，报错就是环境侧那条', async () => {
    envKey(undefined);
    await expect(gate.beforePack(context, () => '')).rejects.toThrow(/构建中止/);
  });

  it('变量合法、产物里也有钥匙 ⇒ 通过', async () => {
    envKey(ED25519_KEY);
    await expect(gate.beforePack(context, () => `var k = ${JSON.stringify(ED25519_KEY)};\n`)).resolves.toBeUndefined();
  });

  it('变量合法但产物里没有钥匙 ⇒ 抛错中止打包', async () => {
    envKey(ED25519_KEY);
    await expect(gate.beforePack(context, () => 'var k = "";\n')).rejects.toThrow(/构建中止/);
  });
});

describe('public key in reachable Vite main chunks', () => {
  function checkFiles(
    files: Record<string, string> | ((root: string) => Record<string, string>),
    setup?: (root: string) => void,
  ): string | null {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-key-main-chunks-'));
    if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unexpected fixture directory');
    try {
      for (const [name, source] of Object.entries(typeof files === 'function' ? files(root) : files)) {
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
      }
      setup?.(root);
      return gate.checkBuiltBundle({ bundlePath: path.join(root, 'main/index.js'), keyBase64: ED25519_KEY });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('accepts the current Vite dynamic entry with its key in the normal app chunk', () => {
    expect(
      checkFiles({
        'main/index.js':
          'if (process.argv.includes("--royin-render-slidegen")) { await import("./render-command-Ab12.js"); } else { await import("./index-Cd34.js").then((n) => n.a); }',
        'main/render-command-Ab12.js': 'export const command = true;',
        'main/index-Cd34.js': `export const a = ${JSON.stringify(ED25519_KEY)};`,
      }),
    ).toBeNull();
  });

  it('follows transitive static imports and re-exports without looping on cycles', () => {
    expect(
      checkFiles({
        'main/index.js': 'import "./app-Ab12.js";',
        'main/app-Ab12.js': 'export { key } from "./key-Cd34.js";',
        'main/key-Cd34.js': `import "./app-Ab12.js"; export const key = ${JSON.stringify(ED25519_KEY)};`,
      }),
    ).toBeNull();
  });

  it('rejects a key found only in an unreferenced stale chunk', () => {
    expect(
      checkFiles({
        'main/index.js': 'await import("./app-Ab12.js");',
        'main/app-Ab12.js': 'export const key = "";',
        'main/stale-Cd34.js': `export const key = ${JSON.stringify(ED25519_KEY)};`,
      }),
    ).not.toBeNull();
  });

  it('does not follow import text inside comments or string literals', () => {
    expect(
      checkFiles({
        'main/index.js': '// import "./key-Ab12.js";\nconst example = \'import("./key-Ab12.js")\';',
        'main/key-Ab12.js': `export const key = ${JSON.stringify(ED25519_KEY)};`,
      }),
    ).not.toBeNull();
  });

  it('rejects relative imports outside the main output directory', () => {
    expect(
      checkFiles({
        'main/index.js': 'await import("../key-Ab12.js");',
        'key-Ab12.js': `export const key = ${JSON.stringify(ED25519_KEY)};`,
      }),
    ).not.toBeNull();
  });

  it('rejects a missing referenced chunk even when the entry contains the key', () => {
    expect(
      checkFiles({ 'main/index.js': `const key = ${JSON.stringify(ED25519_KEY)}; import "./missing.js";` }),
    ).not.toBeNull();
  });

  it('keeps external dependencies outside the local chunk traversal', () => {
    expect(
      checkFiles({ 'main/index.js': `import fs from "node:fs"; const key = ${JSON.stringify(ED25519_KEY)};` }),
    ).toBeNull();
  });

  it('rejects a directory junction that redirects a referenced chunk outside main output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-key-main-chunks-'));
    if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unexpected fixture directory');
    try {
      fs.mkdirSync(path.join(root, 'main'));
      fs.mkdirSync(path.join(root, 'outside'));
      fs.writeFileSync(path.join(root, 'main/index.js'), 'await import("./linked/key.js");');
      fs.writeFileSync(path.join(root, 'outside/key.js'), `export const key = ${JSON.stringify(ED25519_KEY)};`);
      fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'main/linked'), 'junction');
      expect(
        gate.checkBuiltBundle({ bundlePath: path.join(root, 'main/index.js'), keyBase64: ED25519_KEY }),
      ).not.toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a directory junction even when its referenced chunk stays inside main output', () => {
    expect(
      checkFiles(
        {
          'main/index.js': 'await import("./nested/linked/key.js");',
          'main/actual/key.js': `export const key = ${JSON.stringify(ED25519_KEY)};`,
        },
        (root) => {
          fs.mkdirSync(path.join(root, 'main/nested'));
          const linked = path.join(root, 'main/nested/linked');
          fs.symlinkSync(path.join(root, 'main/actual'), linked, 'junction');
          expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
        },
      ),
    ).not.toBeNull();
  });

  it('rejects a main output root that is itself a directory junction', () => {
    expect(
      checkFiles({ 'actual/index.js': `export const key = ${JSON.stringify(ED25519_KEY)};` }, (root) => {
        const linked = path.join(root, 'main');
        fs.symlinkSync(path.join(root, 'actual'), linked, 'junction');
        expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
      }),
    ).not.toBeNull();
  });

  it.each(['main/key.js', 'outside/key.js', 'missing/key.js'])(
    'rejects a literal file URL for %s even when the entry contains the key',
    (target) => {
      expect(
        checkFiles((root) => ({
          'main/index.js': `const key = ${JSON.stringify(ED25519_KEY)}; await import(${JSON.stringify(pathToFileURL(path.join(root, target)).href)});`,
          'main/key.js': 'export const present = true;',
          'outside/key.js': 'export const present = true;',
        })),
      ).not.toBeNull();
    },
  );

  it('rejects a case-insensitive file URL in a static import', () => {
    expect(
      checkFiles((root) => ({
        'main/index.js': `import ${JSON.stringify(pathToFileURL(path.join(root, 'outside/key.js')).href.replace(/^file:/, 'FILE:'))}; const key = ${JSON.stringify(ED25519_KEY)};`,
        'outside/key.js': 'export const present = true;',
      })),
    ).not.toBeNull();
  });

  it.each([' file:', '\tfile:', 'fi\tle:', 'fi\nle:'])(
    'rejects a literal file URL with the normalized protocol %j',
    (protocol) => {
      expect(
        checkFiles((root) => ({
          'main/index.js': `const key = ${JSON.stringify(ED25519_KEY)}; await import(${JSON.stringify(pathToFileURL(path.join(root, 'outside/key.js')).href.replace(/^file:/, protocol))});`,
          'outside/key.js': 'export const present = true;',
        })),
      ).not.toBeNull();
    },
  );

  it('keeps rejecting a malformed literal file URL even when standard URL parsing fails', () => {
    expect(
      checkFiles({
        'main/index.js': `const key = ${JSON.stringify(ED25519_KEY)}; await import("file://[broken-host/key.js");`,
      }),
    ).toContain('Unsupported file URL main chunk');
  });
});

describe('与真配置的一致性（真 yml / 真 package.json，不是合成配置）', () => {
  it('electron-builder.yml 的 beforePack 指向组合钩子，且这一行真的生效（不是躺在注释里）', () => {
    const raw = fs.readFileSync(path.join(PROJECT_DIR, 'electron-builder.yml'), 'utf-8');

    expect(raw).toContain('beforePack: ./scripts/before-pack.cjs');
    expect(raw.split('\n').some((line) => line.trim() === 'beforePack: ./scripts/before-pack.cjs')).toBe(true);
  });

  it('组合钩子两侧都挂着（摘掉任意一侧这里就红）', () => {
    const raw = fs.readFileSync(path.join(PROJECT_DIR, 'scripts', 'before-pack.cjs'), 'utf-8');

    expect(raw).toContain("require('./require-bundled-runtime.cjs')");
    expect(raw).toContain("require('./require-update-public-key.cjs')");
  });

  it('⭐ 每一个会打出安装包的脚本都挂了前置检查（漏一个这里就红）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };

    for (const name of ['build', 'build:win', 'build:mac', 'build:mac:x64', 'build:linux']) {
      const script = pkg.scripts[name];
      expect(script, `missing script ${name}`).toBeTruthy();
      expect(script, `${name} does not run the public key pre-check`).toContain(
        'require-update-public-key.cjs --require-env',
      );
    }
  });

  it('⭐ 产物路径与 package.json 的 main 一致（防两边漂移）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf-8')) as {
      main: string;
    };

    expect(gate.MAIN_BUNDLE_RELATIVE_PATH).toBe(path.relative(PROJECT_DIR, path.resolve(PROJECT_DIR, pkg.main)));
  });

  it('被注入的变量名与本门禁读的常量同名（防改名后门禁变成常绿）', () => {
    const raw = fs.readFileSync(path.join(PROJECT_DIR, 'electron.vite.config.ts'), 'utf-8');

    expect(raw).toContain(gate.ENV_VAR_NAME);
  });
});

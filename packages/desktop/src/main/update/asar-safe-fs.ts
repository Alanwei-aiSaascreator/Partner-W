/**
 * 解压 / 校验**程序目录**时该用的 fs。
 *
 * ## ⚠️ 为什么不能直接用 `node:fs`（2026-09-25 真机验收，发版阻断级）
 *
 * **Electron 把 `fs` 换成了带 asar 支持的版本**：路径里只要出现 `.asar` 段，
 * 它就把那个路径当成**一个只读的虚拟归档**（官方口径：*"The archives can not be
 * modified so all Node APIs that can modify files will not work with ASAR archives"*）。
 * 而我们的更新包里**就有** `resources/app.asar`，还有整棵 `resources/app.asar.unpacked/`。
 *
 * 后果：**便携更新永远解压不完** —— 真机上抓到的原始报错是
 * `failed to initialize archive` / `Invalid package …\resources\app.asar`，
 * 抛在 `createWriteStream` 的 `_construct` 里。每一台机器、每一块盘都一样，
 * 与 exFAT / 空间 / 网络全都无关。
 *
 * ⚠️ **为什么单测与本地探针抓不到**：只有 Electron 打过补丁的那个 `fs` 会这样；
 * 纯 Node（vitest、我写的排障脚本）里同一个函数**跑得好好的**。
 * 这类缺陷只有打包态真机能抓 —— 与 `[[pnpm-flattening-drops-nested-deps]]` 同一形状。
 *
 * ## 两个逃生口，为什么选这个
 *
 * Electron 官方给两条路：`original-fs`（不拦截 asar 的那个 fs）与 `process.noAsar = true`。
 * ⭐ **后者不能用**：那是**全进程**开关，而解压要跑几分钟，期间应用自己还在读它的 asar
 * ⇒ 全局关掉会把正在跑的读也一起打断。`original-fs` 只作用于我们这几处调用。
 *
 * ## 单测里怎么办
 *
 * 纯 Node 里没有 `original-fs` 这个模块 ⇒ 回落 `node:fs`，行为完全一致
 * （那边本来就没有补丁）。所以这个文件在两种环境下都给出"能正确工作的那份 fs"。
 */
import { createRequire } from 'node:module';
import * as nodeFs from 'node:fs';
import * as nodeFsPromises from 'node:fs/promises';

/** 我们用到的那部分 fs 形状（promises + 一个 createWriteStream）。 */
export interface AsarSafeFs {
  promises: {
    mkdir: typeof nodeFsPromises.mkdir;
    readdir: typeof nodeFsPromises.readdir;
    stat: typeof nodeFsPromises.stat;
    rm: typeof nodeFsPromises.rm;
    rename: typeof nodeFsPromises.rename;
    open: typeof nodeFsPromises.open;
  };
  createWriteStream: typeof nodeFs.createWriteStream;
  /** ⚠️ 校验时逐文件算哈希走的就是它 —— **读** `app.asar` 同样会被 asar 层拦。 */
  createReadStream: typeof nodeFs.createReadStream;
  /** 这份 fs 是不是 Electron 的逃生口（`true`）还是回落（`false`）。用来给人看/给测试钉。 */
  fromOriginalFs: boolean;
}

type Loader = (id: string) => unknown;

/** `original-fs` 我们只用到这几样（形状不对就当没有）。 */
interface OriginalFsLike {
  promises?: typeof nodeFsPromises;
  createWriteStream?: typeof nodeFs.createWriteStream;
  createReadStream?: typeof nodeFs.createReadStream;
}

/**
 * 造一份 asar 安全的 fs。**注入 loader 是为了可测**：单测里塞一个假的
 * `original-fs`，就能钉住"拿得到就用它、拿不到才回落"这条。
 */
export function createAsarSafeFs(
  load: Loader,
  fallback: { fs: typeof nodeFs; promises: typeof nodeFsPromises },
): AsarSafeFs {
  let original: OriginalFsLike | null = null;
  try {
    const loaded = load('original-fs') as OriginalFsLike | null;
    // 形状不对就当没有：宁可用打过补丁的 fs（至少读写普通路径没问题），
    // 也不要拿半个模块去解压。
    if (
      loaded &&
      loaded.promises &&
      typeof loaded.createWriteStream === 'function' &&
      typeof loaded.createReadStream === 'function'
    ) {
      original = loaded;
    }
  } catch {
    original = null;
  }

  const source = original ?? {
    promises: fallback.promises,
    createWriteStream: fallback.fs.createWriteStream,
    createReadStream: fallback.fs.createReadStream,
  };
  const promises = source.promises as typeof nodeFsPromises;
  return {
    promises: {
      mkdir: promises.mkdir,
      readdir: promises.readdir,
      stat: promises.stat,
      rm: promises.rm,
      rename: promises.rename,
      open: promises.open,
    },
    createWriteStream: source.createWriteStream as typeof nodeFs.createWriteStream,
    createReadStream: source.createReadStream as typeof nodeFs.createReadStream,
    fromOriginalFs: original !== null,
  };
}

/** 真程序用的那一份。Electron 里是 `original-fs`；单测/纯 Node 里回落 `node:fs`。 */
export const asarSafeFs: AsarSafeFs = createAsarSafeFs(createRequire(import.meta.url), {
  fs: nodeFs,
  promises: nodeFsPromises,
});

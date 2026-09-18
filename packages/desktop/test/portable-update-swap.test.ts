import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPortableSwap,
  finalizePortableSwap,
  recoverPortableSwap,
  stagePortableUpdate,
} from '../src/main/update/portable-swap.js';

/**
 * 便携（U 盘）形态的换包引擎（T-U2）。
 *
 * ## 这一层要钉住的是一件"错了就没救"的事
 *
 * 换包是**就地改用户盘上的文件**：换到一半没换成，用户手里那份应用就**打不开了**
 * （而且盘上往往是他唯一的一份）。所以这里的每条用例都对应一种"半成品"形态：
 *
 * - 下载到一半 / 校验不过 ⇒ **暂存区必须一个字节都不留**（否则下次会拿坏文件去换）
 * - 校验不过 / 暂存没了     ⇒ **目标一个字都不能动**（宁可不更新，也不能弄坏）
 * - 换到一半失败            ⇒ **必须回滚**（`.bak` 顶回去）
 * - 换完就断电              ⇒ 下次启动能从 `.bak` **恢复**
 *
 * ## ⚠️ sha256 的语义边界（沿用 `runtime/deploy.ts:34` 那条）
 *
 * feed 与包都在可写的盘上/可被中间人替换的信道上时，hash 一致只证明"没损坏、没被改过"，
 * **不构成发行方真实性** —— 那是签名 manifest 的事。这里不假装它是签名验证。
 */

const OLD = Buffer.from('旧版本 app.asar 的内容 —— 换包前必须能逐字节复原');
const NEW = Buffer.from('新版本 app.asar 的内容 —— 换进去的必须是这一份');

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

let root: string;
/** 目标目录（"盘上那份应用"），与暂存目录**同卷**（同一个临时根下）。 */
let appDir: string;
let stagingDir: string;
let targetFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clawwork-portable-swap-'));
  appDir = join(root, 'app');
  stagingDir = join(root, 'staging');
  targetFile = join(appDir, 'app.asar');
  rmSync(appDir, { recursive: true, force: true });
  rmSync(stagingDir, { recursive: true, force: true });
  writeFileSync(join(mkdirp(appDir), 'x'), ''); // 建目录
  mkdirp(stagingDir);
  writeFileSync(targetFile, OLD);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mkdirp(dir: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('node:fs').mkdirSync(dir, { recursive: true });
  return dir;
}

function stagingFiles(): string[] {
  try {
    return readdirSync(stagingDir).sort();
  } catch {
    return [];
  }
}

/** 造一个"下载器"：把 `content` 写进目标路径，可选在中途/之前抛错。 */
function fakeDownload(content: Buffer, mode: 'ok' | 'fail' | 'half' = 'ok') {
  return async (_url: string, dest: string): Promise<void> => {
    if (mode === 'fail') throw new Error('network down');
    if (mode === 'half') {
      writeFileSync(dest, content.subarray(0, 10));
      throw new Error('connection reset');
    }
    writeFileSync(dest, content);
  };
}

describe('暂存：下载 + 校验', () => {
  it('校验通过 ⇒ 落成正式暂存文件，`.part` 不残留', async () => {
    const result = await stagePortableUpdate({
      url: 'https://example.test/app.asar',
      expectedSha256: sha256Of(NEW),
      stagingDir,
      fileName: 'app.asar',
      download: fakeDownload(NEW),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.bytes).toBe(NEW.length);
    expect(stagingFiles(), '半截文件不能留在暂存区').toEqual(['app.asar']);
    expect(readFileSync(join(stagingDir, 'app.asar'))).toEqual(NEW);
  });

  it('⭐ 校验不过 ⇒ 拒绝，且暂存区**一个字节都不留**', async () => {
    const result = await stagePortableUpdate({
      url: 'https://example.test/app.asar',
      expectedSha256: sha256Of(NEW),
      stagingDir,
      fileName: 'app.asar',
      download: fakeDownload(Buffer.from('被中间人换掉的包')),
    });

    expect(result).toMatchObject({ ok: false, reason: 'checksum-mismatch' });
    // 留着坏文件的话，**下一次**换包会拿它去顶掉好端端的那份
    expect(stagingFiles(), '坏包必须当场删掉').toEqual([]);
  });

  it('⭐ 下载中途断掉 ⇒ 不留半截文件（否则它会冒充"下好了"）', async () => {
    const result = await stagePortableUpdate({
      url: 'https://example.test/app.asar',
      expectedSha256: sha256Of(NEW),
      stagingDir,
      fileName: 'app.asar',
      download: fakeDownload(NEW, 'half'),
    });

    expect(result).toMatchObject({ ok: false, reason: 'download-failed' });
    expect(stagingFiles()).toEqual([]);
  });

  it('⭐ 暂存区与目标不同卷 ⇒ 当场拒绝（跨卷 rename 不是原子的）', async () => {
    // 用仓库既有写法（`portable.ts` 的 `P()` + `portable-run-detection.test.ts` 的
    // `vi.spyOn(process, 'platform', 'get')`）把平台伪装成 win32 —— 这样"两个不同盘符"
    // 在任何平台上都构造得出来，不用 skip 掉这条（盘符自愈是主场景，这条同理）。
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const result = await stagePortableUpdate({
        url: 'https://example.test/app.asar',
        expectedSha256: sha256Of(NEW),
        stagingDir: 'Z:\\staging',
        fileName: 'app.asar',
        targetDir: appDir,
        download: fakeDownload(NEW),
      });

      expect(result).toMatchObject({ ok: false, reason: 'not-same-volume' });
      expect(readFileSync(targetFile), '拒绝时目标一个字都不该动').toEqual(OLD);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('默认下载器（真起一个本地 HTTP 服务，不桩）', () => {
  /**
   * ⚠️ 这条**必须**打真服务：默认下载器是线上唯一会跑的那条路，
   * 而上面所有用例都把 `download` 换成桩了 —— 不补这条的话，`downloadToFile`
   * 就是一段从没被执行过的生产代码（流式落盘、`response.ok`、没 body 的分支全没验）。
   */
  it('从 http 流式落盘，内容逐字节一致；非 2xx 抛错', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(NEW);
        return;
      }
      res.writeHead(404);
      res.end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      // 走的是真 `stagePortableUpdate`（不传 download）⇒ 默认下载器 + 校验 + 落名
      const ok = await stagePortableUpdate({
        url: `http://127.0.0.1:${port}/ok`,
        expectedSha256: sha256Of(NEW),
        stagingDir,
        fileName: 'app.asar',
      });
      expect(ok.ok, ok.ok ? '' : (ok as { message: string }).message).toBe(true);
      expect(readFileSync(join(stagingDir, 'app.asar'))).toEqual(NEW);

      rmSync(join(stagingDir, 'app.asar'), { force: true });
      const bad = await stagePortableUpdate({
        url: `http://127.0.0.1:${port}/missing`,
        expectedSha256: sha256Of(NEW),
        stagingDir,
        fileName: 'app.asar',
      });
      expect(bad).toMatchObject({ ok: false, reason: 'download-failed' });
      expect(stagingFiles(), '404 也不能留下半截文件').toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('换包：备份 + 原子替换 + 回滚', () => {
  /** 把 NEW 放进暂存区（= 上一步的产物）。 */
  function stage(content = NEW): string {
    const staged = join(stagingDir, 'app.asar');
    writeFileSync(staged, content);
    return staged;
  }

  it('成功：目标变成新内容，`.bak` 留着旧内容（逐字节）', async () => {
    const result = await applyPortableSwap({
      stagedFile: stage(),
      targetFile,
      expectedSha256: sha256Of(NEW),
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(targetFile)).toEqual(NEW);
    expect(readFileSync(`${targetFile}.bak`), '备份必须是**旧的**那一份，不是新的').toEqual(OLD);
    expect(existsSync(join(stagingDir, 'app.asar')), '换进去之后暂存那份就没了（是 rename 不是 copy）').toBe(false);
  });

  it('⭐ 校验不过 ⇒ 目标**一个字都不动**，也不留 `.bak`（没动过就不该有备份）', async () => {
    const result = await applyPortableSwap({
      stagedFile: stage(Buffer.from('坏包')),
      targetFile,
      expectedSha256: sha256Of(NEW),
    });

    expect(result).toMatchObject({ ok: false, reason: 'checksum-mismatch' });
    expect(readFileSync(targetFile), '宁可不更新，也不能弄坏').toEqual(OLD);
    expect(existsSync(`${targetFile}.bak`)).toBe(false);
  });

  it('⭐ 暂存文件在换包前没了 ⇒ 目标不动（早期的校验失败路径）', async () => {
    const result = await applyPortableSwap({
      stagedFile: join(stagingDir, '不存在.asar'),
      targetFile,
      expectedSha256: sha256Of(NEW),
    });

    expect(result).toMatchObject({ ok: false, reason: 'checksum-mismatch' });
    expect(readFileSync(targetFile)).toEqual(OLD);
    expect(existsSync(`${targetFile}.bak`)).toBe(false);
  });

  /**
   * ⭐ 回滚：失败点卡在"旧的已经挪成 `.bak`、新的还没换进来"那一瞬间。
   *
   * 这是整个流程里**唯一**一个"盘上那份应用不存在了"的窗口。真实成因不少：
   * 盘写满、U 盘被拔、杀软拦住重命名、断电。回不来的话用户手里那份就打不开了。
   */
  it('⭐ 换入失败 ⇒ 回滚：目标逐字节恢复成旧内容', async () => {
    const staged = stage();
    const result = await applyPortableSwap({
      stagedFile: staged,
      targetFile,
      expectedSha256: sha256Of(NEW),
      ops: {
        // 第一次 rename（target → .bak）放行；第二次（staged → target）失败
        rename: async (from, to) => {
          if (from === staged) throw new Error('EBUSY: 盘被占用');
          const { renameSync } = await import('node:fs');
          renameSync(from, to);
        },
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'replace-failed', restored: true });
    expect(readFileSync(targetFile), '回滚必须逐字节一致，不能是"差不多"').toEqual(OLD);
    expect(existsSync(`${targetFile}.bak`), '回滚之后备份就归位了，不该再留一份').toBe(false);
  });

  /**
   * 最坏的一种：**备份挪走了、新的没进来、回滚也失败**。
   *
   * 这时盘上只剩一个 `.bak`、目标不存在 —— 用户那份应用**当场就是打不开的**。
   * 所以这里必须报 `restored: false`：谎称回滚成功会让人以为没事，
   * 而唯一的线索（那份 `.bak`）是下次启动 `recoverPortableSwap` 唯一的指望。
   */
  it('⭐ 回滚也失败 ⇒ 如实报 restored:false（留一份 `.bak`，别谎称好了）', async () => {
    const staged = stage();
    let call = 0;
    const result = await applyPortableSwap({
      stagedFile: staged,
      targetFile,
      expectedSha256: sha256Of(NEW),
      ops: {
        rename: async (from, to) => {
          call += 1;
          // ① target → .bak 放行（旧的确实挪走了）；② 换入 与 ③ 回滚 都失败
          if (call === 1) {
            const { renameSync } = await import('node:fs');
            renameSync(from, to);
            return;
          }
          throw new Error('EACCES: 整块盘只读了');
        },
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'replace-failed', restored: false });
    expect(existsSync(`${targetFile}.bak`), '这时 `.bak` 是用户唯一的指望').toBe(true);
    expect(existsSync(targetFile), '目标就是不在的（回滚也失败了）').toBe(false);
  });

  /**
   * 只到"备份就失败"为止：目标**一个字节都没动过**，所以 `restored: true`。
   * 与上一条是**两种不同的结局**，别混成一条 —— 混淆会让最坏那种显得没事。
   */
  it('连备份都没挪成 ⇒ 目标原样，restored:true（不是"回滚成功"，是"压根没动"）', async () => {
    const result = await applyPortableSwap({
      stagedFile: stage(),
      targetFile,
      expectedSha256: sha256Of(NEW),
      ops: {
        rename: async () => {
          throw new Error('EACCES: 盘被占用');
        },
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'replace-failed', restored: true });
    expect(readFileSync(targetFile)).toEqual(OLD);
  });

  it('原来就没有目标文件（首次部署形态）⇒ 不备份，直接换入', async () => {
    rmSync(targetFile, { force: true });

    const result = await applyPortableSwap({
      stagedFile: stage(),
      targetFile,
      expectedSha256: sha256Of(NEW),
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(targetFile)).toEqual(NEW);
    expect(existsSync(`${targetFile}.bak`), '没有旧的可备份就不该凭空造一个').toBe(false);
  });
});

describe('崩溃恢复与收尾', () => {
  it('⭐ 目标缺失 + `.bak` 在 ⇒ 判为"上次换到一半倒了"，把备份顶回去', async () => {
    rmSync(targetFile, { force: true });
    writeFileSync(`${targetFile}.bak`, OLD);

    expect(recoverPortableSwap({ targetFile })).toBe('restored');

    expect(readFileSync(targetFile)).toEqual(OLD);
    expect(existsSync(`${targetFile}.bak`)).toBe(false);
  });

  it('目标在 ⇒ 不做任何事（`.bak` 是"换完了还没确认"，不是"换到一半"）', async () => {
    writeFileSync(`${targetFile}.bak`, OLD);

    expect(recoverPortableSwap({ targetFile })).toBe('no-op');

    expect(readFileSync(targetFile), '这时动目标就等于把刚换好的新版本又退回去').toEqual(OLD);
    expect(existsSync(`${targetFile}.bak`)).toBe(true);
  });

  it('目标与备份都在 → 没备份 → 三种情况都不炸', async () => {
    expect(recoverPortableSwap({ targetFile })).toBe('no-op');

    rmSync(targetFile, { force: true });
    expect(recoverPortableSwap({ targetFile }), '什么都没有 ⇒ 没什么可恢复的').toBe('no-op');
  });

  it('⭐ 跑起来的是新版本 ⇒ 收尾：删掉 `.bak` 与字条', async () => {
    writeFileSync(`${targetFile}.bak`, OLD);
    writeFileSync(targetFile, NEW);
    const marker = join(appDir, 'pending-portable-update.json');
    writeFileSync(marker, JSON.stringify({ version: '0.0.30' }));

    const result = finalizePortableSwap({ targetFile, markerPath: marker, runningVersion: '0.0.30' });

    expect(result).toBe('finalized');
    expect(existsSync(`${targetFile}.bak`), '已经确认新版本能跑起来了，备份就该清掉').toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('⭐ 跑起来的还是旧版本 ⇒ 保留 `.bak` 与字条（换包没生效，还能回退/重试）', async () => {
    writeFileSync(`${targetFile}.bak`, OLD);
    writeFileSync(targetFile, NEW);
    const marker = join(appDir, 'pending-portable-update.json');
    writeFileSync(marker, JSON.stringify({ version: '0.0.30' }));

    const result = finalizePortableSwap({ targetFile, markerPath: marker, runningVersion: '0.0.29' });

    expect(result).toBe('kept');
    expect(readFileSync(`${targetFile}.bak`), '这是用户唯一的退路').toEqual(OLD);
    expect(existsSync(marker)).toBe(true);
  });
});

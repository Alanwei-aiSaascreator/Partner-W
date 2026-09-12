/**
 * 把运行时归档解到磁盘 —— **统一走 Node stream 体系**。
 *
 * 为什么统一：小文件走一条路、大文件走另一条路，是"两条实现、两套边界情况"的经典来源。
 * 本包里最大单条 43.8MB（`dist/worker/worker.mjs`），`inflateRawSync` 会把它整条读进内存；
 * 而 main 进程同时还在跑 UI 的 IPC。所以一律：
 *
 *     readStream → createInflateRaw（store 条目跳过）→ CRC 累加 → writeStream
 *
 * 峰值内存 = 一个 chunk；错误/关闭传播交给 `pipeline`，比自己接 'error' 更不容易漏。
 *
 * ⚠️ 本模块**不写任何完成标记**。「解压完了」不等于「这份部署可用」——
 * 标记是 `deploy.ts` 的事（要等 node、entry 都验过才写）。
 */
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { crc32, dosDateTimeToDate, findEocd, isSafeEntryName, parseCentralDirectory, parseLocalHeader } from './zip.js';

const EOCD_TAIL_BYTES = 22 + 0xffff;
const DEFAULT_PROGRESS_EVERY = 500;

export interface ExtractOptions {
  archivePath: string;
  /** 解压目标目录（会被创建）。**调用方负责保证它是个临时目录**。 */
  destDir: string;
  onProgress?: (done: number, total: number) => void;
  /** 每多少条回调一次进度（默认 500 —— 不要每条都回调，35k 条会把 IPC 打爆）。 */
  progressEvery?: number;
}

export interface ExtractResult {
  fileCount: number;
  dirCount: number;
  entryCount: number;
}

/** 边转发边累加 CRC 与字节数，收尾用来跟条目头比对。 */
class CrcCounter extends Transform {
  crc = 0;
  bytes = 0;

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void): void {
    this.crc = crc32(chunk, this.crc);
    this.bytes += chunk.length;
    cb(null, chunk);
  }
}

/**
 * 解压归档到 `destDir`（已存在的目录会被合并，不会先清空 —— 调用方给的是**新建的临时目录**）。
 *
 * 任一条目失败即整体抛错，并删掉该条目的半成品文件。
 */
export async function extractArchive(opts: ExtractOptions): Promise<ExtractResult> {
  const { archivePath, destDir, onProgress, progressEvery = DEFAULT_PROGRESS_EVERY } = opts;

  const handle = await fs.open(archivePath, 'r');
  try {
    const { size } = await handle.stat();
    // 尾巴按需取：小归档就整个读进来（`Math.min`），大归档读最后 64KB+22。
    const tailLength = Math.min(size, EOCD_TAIL_BYTES);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const eocd = findEocd(tail);

    const cd = Buffer.alloc(eocd.centralDirectorySize);
    await handle.read(cd, 0, cd.length, eocd.centralDirectoryOffset);
    const entries = parseCentralDirectory(cd);

    if (entries.length !== eocd.entryCount) {
      throw new Error(`中央目录条目数与 EOCD 声明不符（解析出 ${entries.length}，声明 ${eocd.entryCount}）`);
    }

    await fs.mkdir(destDir, { recursive: true });
    const resolvedDest = path.resolve(destDir);

    let fileCount = 0;
    let dirCount = 0;

    for (const entry of entries) {
      // ① 名字安全（穿越、绝对路径、盘符、NUL 都在这里挡掉）
      if (!isSafeEntryName(entry.name)) {
        throw new Error(`归档里有不安全的条目名，拒绝解压：${JSON.stringify(entry.name)}`);
      }
      const normalized = entry.name.replace(/\\/g, '/');
      const target = path.resolve(resolvedDest, normalized);

      // ② 二次确认：解析后的绝对路径必须真的在目标目录内（不靠名字的字符串判断）
      const rel = path.relative(resolvedDest, target);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`条目越界，拒绝解压：${JSON.stringify(entry.name)}`);
      }

      if (entry.isDirectory) {
        await fs.mkdir(target, { recursive: true });
        dirCount++;
        continue;
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      await extractOne(handle, archivePath, entry.localHeaderOffset, target, entry);

      // ③ 还原 DOS 时间戳（真实解压工具会做，用户看目录属性时能看出这是"出厂包"而不是"刚下载的"）
      const when = dosDateTimeToDate(entry.dosDate, entry.dosTime);
      if (!Number.isNaN(when.getTime())) {
        await fs.utimes(target, when, when).catch(() => {
          /* 时间戳失败不该让整个部署失败 */
        });
      }

      fileCount++;
      if (onProgress && (fileCount % progressEvery === 0 || fileCount === entries.length)) {
        onProgress(fileCount, entries.length);
      }
    }

    return { fileCount, dirCount, entryCount: entries.length };
  } finally {
    await handle.close();
  }
}

/**
 * 解一条文件条目。
 *
 * ⚠️ 失败时**必须删掉半成品**：否则一个 CRC 不符的文件会留在部署目录里，
 * 而它看起来跟正常文件没区别。
 */
async function extractOne(
  handle: fs.FileHandle,
  archivePath: string,
  localHeaderOffset: number,
  target: string,
  entry: { name: string; compressionMethod: number; crc32: number; compressedSize: number; uncompressedSize: number },
): Promise<void> {
  // 本地头的长度字段**必须现读**：本包里它(0)与中央目录里的(36)不同
  const headerBuf = Buffer.alloc(30);
  const { bytesRead } = await handle.read(headerBuf, 0, 30, localHeaderOffset);
  if (bytesRead !== 30) {
    throw new Error(`读本地文件头失败（偏移 ${localHeaderOffset}，只读到 ${bytesRead} 字节）`);
  }
  const info = parseLocalHeader(headerBuf);
  // ⚠️ `parseLocalHeader().dataOffset` 是**相对本地头起点**的偏移，不是文件绝对偏移。
  //    忘了加 `localHeaderOffset` 的话，第 1 条永远是对的（偏移恰好 0）、
  //    从第 2 条起读到错位数据 —— 每条 CRC 都不符，报「归档已损坏」，很容易查错方向。
  const dataOffset = localHeaderOffset + info.dataOffset;

  const counter = new CrcCounter();

  // 空文件：没有数据段，stream 的 start>end 会报错，直接落一个空文件
  if (entry.compressedSize === 0) {
    await fs.writeFile(target, Buffer.alloc(0));
    if (entry.crc32 !== crc32(Buffer.alloc(0))) {
      await fs.rm(target, { force: true });
      throw new Error(`条目 ${entry.name} 的 CRC 不符`);
    }
    if (entry.uncompressedSize !== 0) {
      await fs.rm(target, { force: true });
      throw new Error(`条目 ${entry.name} 的长度不符（声明 ${entry.uncompressedSize}，实际 0）`);
    }
    return;
  }

  // ⚠️ **不要复用外层 handle 的 fd**。实测：多个条目共用一个 fd 时，
  //    从第二个条目起会读到错位的数据（CRC 逐条不符）。按路径各开一条流最稳，
  //    35k 次 open/close 的代价在首次部署的 1–3 分钟预算里可以忽略。
  const readStream = createReadStream(archivePath, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
  });

  const stages: Array<NodeJS.ReadableStream | NodeJS.WritableStream | Transform> = [readStream];
  if (entry.compressionMethod === 8) {
    stages.push(createInflateRaw());
  } else if (entry.compressionMethod !== 0) {
    throw new Error(`条目 ${entry.name} 用了不支持的压缩方法 ${entry.compressionMethod}（只支持 store/deflate）`);
  }
  stages.push(counter, createWriteStream(target));

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await pipeline(stages as any);
  } catch (err) {
    await fs.rm(target, { force: true });
    throw err;
  }

  if (counter.crc !== entry.crc32) {
    await fs.rm(target, { force: true });
    throw new Error(
      `条目 ${entry.name} 的 CRC 不符（期望 ${entry.crc32.toString(16)}，实际 ${counter.crc.toString(16)}）—— 归档已损坏`,
    );
  }
  if (counter.bytes !== entry.uncompressedSize) {
    await fs.rm(target, { force: true });
    throw new Error(`条目 ${entry.name} 的长度不符（期望 ${entry.uncompressedSize}，实际 ${counter.bytes}）`);
  }
}

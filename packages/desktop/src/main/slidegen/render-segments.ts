/**
 * 分段渲染账本（staged/chunked，2026-10-16 · P20 / 总单第 27 行）。
 *
 * ## 这一层解决什么
 *
 * 长稿渲染原来是一条**全有或全无**的循环：逐页排版、量框，全部页做完才写 pptx。
 * 中途关窗 / 断网 / 强杀 ⇒ 已经量过的页**整批丢掉**，重跑从第 1 页再来一遍。
 *
 * 这里把"已经做完的段"落成**真实文件**（工作区里的点前缀账本 + 每段载荷），
 * 于是：
 *   · **分段状态**：`completed()` 就是真正做完的段号，不是按总页数推出来的假进度；
 *   · **中断恢复**：`load(index)` 把上一轮做完的段原样取回，重跑不再量它；
 *   · **不重复计费**：恢复只走本机排版，**不触发任何模型调用**（源文件哈希没变才恢复）；
 *   · **不产生重复成果**：成品仍然只有一份，登记仍走原有唯一约束。
 *
 * ## 边界（刻意划清，别越界）
 *
 * - 账本**只管"这一份源的排版进度"**。它**不是**第二套完成判定：一份成品算不算交付，
 *   仍然只由既有链（`verify` 登记门 + `finalizeAssistantArtifacts` 结算 + `claim-guard`）说。
 *   这里任何时刻都产不出一件产物。
 * - 键 = 调用方给的 `planDigest`（`render-file` 用源文件 sha256）。**源一变，账本整份作废**
 *   （见 `read` 的判据）——绝不把上一份源的段套到新源上。
 * - 读不动 / 坏 / 形状不对 ⇒ **当成没有**（从零渲染），绝不因为账本坏了让这一轮失败。
 *   账本是加速器，不是真相源。
 *
 * ## 为什么落在工作区的点前缀文件上
 *
 * 与既有 `.royin-ppt-receipt-*.json` 同一个位置、同一个道理（收据也写在工作区根）。
 * `reconcile.ts` 的收编扫描**跳过一切点前缀名字**（`name.startsWith('.')`），所以这些文件
 * 不会被当成用户成果；进程被杀之后它们仍在盘上，这正是"跨进程恢复"的前提。
 * 段载荷一次性、有界（最多 200 页），成功出片后 `clear()` 全删，不留垃圾。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EmittedPage } from './pipeline.js';
import { contained } from './source-file.js';

/** 账本与段载荷的 schema 版本。形状一变就换号，旧账本自然作废。 */
const RENDER_SEGMENT_SCHEMA_VERSION = 1;

const LEDGER_PREFIX = '.royin-render-plan-';
const SEGMENT_PREFIX = '.royin-render-seg-';

/** 一段做完之后留在盘上的东西：这一段的形状 + 它自己的版式警告。 */
interface SegmentPayload {
  schemaVersion: 1;
  planDigest: string;
  index: number;
  emitted: EmittedPage;
}

interface LedgerFile {
  schemaVersion: 1;
  planDigest: string;
  total: number;
  completed: number[];
  updatedAt: string;
}

/**
 * 调用方眼里的"分段账本"。
 *
 * `render-deck` 只认这个接口 —— 于是单测能塞一个内存实现，产品里塞文件实现，
 * 渲染循环一个字都不用分叉。
 */
export interface RenderSegmentCheckpoint {
  /** 这一段账本声明的总段数（与这一轮实际页数不符 ⇒ 调用方整份作废）。 */
  total(): number;
  /** 真正做完的段号，升序、去重。 */
  completed(): readonly number[];
  /** 取回上一轮做完的段；没做过 / 读坏了返回 null（调用方照常重做这一段）。 */
  load(index: number): EmittedPage | null;
  /** 一段**做完了**才落盘。先写临时文件再 rename，半截文件不会被下一轮读到。 */
  save(index: number, emitted: EmittedPage): void;
  /** 成品已经出来了 ⇒ 账本使命完成，全清（不留垃圾）。 */
  clear(): void;
}

const digestFileName = (digest: string): string | null => (/^[a-f0-9]{64}$/.test(digest) ? digest : null);

function ledgerPath(root: string, digest: string): string {
  return path.join(root, `${LEDGER_PREFIX}${digest}.json`);
}

function segmentPath(root: string, digest: string, index: number): string {
  return path.join(root, `${SEGMENT_PREFIX}${digest}-${index}.json`);
}

/**
 * 原子写：临时文件 + rename。
 *
 * ⚠️ 临时名带 pid 与随机后缀：两条消息同时渲染同一份源时不会互相踩（与
 *    `render-deck` 的 `.slidegen-<uuid>.pptx` 同一个考虑）。
 */
function writeAtomic(file: string, bytes: string): void {
  const staging = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(staging, bytes, { flag: 'wx' });
    fs.renameSync(staging, file);
  } catch {
    try {
      fs.rmSync(staging, { force: true });
    } catch {
      /* best-effort：清理失败不影响这一次写 */
    }
  }
}

function isEmittedPage(value: unknown): value is EmittedPage {
  if (!value || typeof value !== 'object') return false;
  const emitted = value as Record<string, unknown>;
  const page = emitted.page as Record<string, unknown> | undefined;
  return (
    !!page &&
    typeof page === 'object' &&
    Array.isArray(page.shapes) &&
    typeof page.background === 'string' &&
    Array.isArray(emitted.warnings)
  );
}

function readLedger(root: string, digest: string): LedgerFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(ledgerPath(root, digest), 'utf8'));
  } catch {
    // 没见过（正常）或读坏了（当没有）—— 两种都从零渲染，绝不因此让这一轮失败。
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const ledger = parsed as Record<string, unknown>;
  if (
    ledger.schemaVersion !== RENDER_SEGMENT_SCHEMA_VERSION ||
    ledger.planDigest !== digest ||
    !Number.isSafeInteger(ledger.total) ||
    Number(ledger.total) < 1 ||
    !Array.isArray(ledger.completed)
  )
    return null;
  const total = Number(ledger.total);
  const completed = [...new Set(ledger.completed.filter((value) => Number.isSafeInteger(value)))].filter(
    (value): value is number => Number(value) >= 0 && Number(value) < total,
  );
  return {
    schemaVersion: RENDER_SEGMENT_SCHEMA_VERSION,
    planDigest: digest,
    total,
    completed: completed.sort((left, right) => left - right),
    updatedAt: typeof ledger.updatedAt === 'string' ? ledger.updatedAt : new Date().toISOString(),
  };
}

/**
 * 打开一份**文件支撑**的分段账本。
 *
 * `planDigest` 不合法（非 sha256）或工作区不可写 ⇒ 返回 `null`：调用方照常从零渲染，
 * **不因为账本开不起来而失败**（账本永远是加速器，不是前置条件）。
 */
export function openRenderSegmentCheckpoint(input: {
  workspace: string;
  planDigest: string;
  total: number;
}): RenderSegmentCheckpoint | null {
  const digest = digestFileName(input.planDigest);
  if (!digest || !Number.isSafeInteger(input.total) || input.total < 1) return null;
  let root: string;
  try {
    root = fs.realpathSync(input.workspace);
  } catch {
    return null;
  }
  const ledger = readLedger(root, digest);
  // 总段数对不上 ⇒ 整份作废（这一轮的页计划已经不是账本记的那一份了）。
  const completed = ledger && ledger.total === input.total ? ledger.completed : [];
  const done = new Set<number>(completed);
  const persistCompleted = (): void => {
    const file = ledgerPath(root, digest);
    if (!contained(root, file)) return;
    writeAtomic(
      file,
      JSON.stringify({
        schemaVersion: RENDER_SEGMENT_SCHEMA_VERSION,
        planDigest: digest,
        total: input.total,
        completed: [...done].sort((left, right) => left - right),
        updatedAt: new Date().toISOString(),
      } satisfies LedgerFile) + '\n',
    );
  };
  if (done.size > 0) persistCompleted();
  return {
    total: () => input.total,
    completed: () => [...done].sort((left, right) => left - right),
    load: (index) => {
      if (!done.has(index)) return null;
      const file = segmentPath(root, digest, index);
      if (!contained(root, file)) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // 段载荷丢了/坏了 ⇒ 这一段当没做过（重做它），并把段号从账本里摘掉。
        done.delete(index);
        persistCompleted();
        return null;
      }
      const payload = parsed as Partial<SegmentPayload> | null;
      if (
        !payload ||
        payload.schemaVersion !== RENDER_SEGMENT_SCHEMA_VERSION ||
        payload.planDigest !== digest ||
        payload.index !== index ||
        !isEmittedPage(payload.emitted)
      ) {
        done.delete(index);
        persistCompleted();
        return null;
      }
      return payload.emitted;
    },
    save: (index, emitted) => {
      const file = segmentPath(root, digest, index);
      if (!contained(root, file)) return;
      writeAtomic(
        file,
        JSON.stringify({
          schemaVersion: RENDER_SEGMENT_SCHEMA_VERSION,
          planDigest: digest,
          index,
          emitted,
        } satisfies SegmentPayload) + '\n',
      );
      // ⚠️ 次序不能反：**先落段载荷、再记账**。反过来的话崩在中间会留下
      //    "账本说做完了、载荷却不在"，下一轮读到空载荷只能重做（浪费但不出错）；
      //    现在是"载荷在、账本还没记" ⇒ 下一轮重做这一段（同样不错，只是少省一点）。
      //    两个方向都安全，选前者是因为它把**多**做一段的代价放在前面，账本永远不撒谎。
      done.add(index);
      persistCompleted();
    },
    clear: () => {
      for (const index of done) {
        try {
          fs.rmSync(segmentPath(root, digest, index), { force: true });
        } catch {
          /* best-effort */
        }
      }
      done.clear();
      try {
        fs.rmSync(ledgerPath(root, digest), { force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

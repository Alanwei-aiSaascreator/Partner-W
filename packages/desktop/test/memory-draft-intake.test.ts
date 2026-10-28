/**
 * **助手提记忆草案**的入口（2026-10-16 之前完全没实施的那一半）。
 *
 * 这一层要挡的假话：
 *   · 把坏 JSON / 空块当成"一条记忆"存进去；
 *   · 助手下一轮把**用户已经拒绝过**的同一件事又提一遍（"拒绝之后不再重复提同一件"）；
 *   · 草案当成已保存（草案只进库的 pending 栏，**绝不**进 `MEMORY.md`）；
 *   · 库没打开时假装成功。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';
import { createMemoryStore } from '../src/main/memory/store.js';
import { collectMemoryDrafts } from '../src/main/memory/draft-intake.js';

const OWNER = 'user-a';

const fence = (body: string): string => '```memory\n' + body + '\n```';

let dir = '';

function store() {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('库没打开');
  return createMemoryStore(sqlite);
}

afterEach(() => {
  closeDatabase();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('草案入口：库还没打开时', () => {
  it('如实跳过（`skipped`），不抛、也不落半条', () => {
    expect(getSqlite()).toBeNull();
    const result = collectMemoryDrafts({ content: fence('{"text":"一条草案"}'), ownerUserId: OWNER });
    expect(result).toEqual({ created: 0, duplicate: 0, discarded: 0, overflow: 0, skipped: true });
  });
});

describe('草案入口：正常路径', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-intake-'));
    initDatabase(dir);
  });

  it('⭐ 助手回复里的 ```memory 块 ⇒ 落一条 **pending** 草案（不进已确认）', () => {
    const notify = vi.fn();
    const result = collectMemoryDrafts({
      content: `我明白了。\n\n${fence('{"text":"用户希望结论先行。","reason":"反复要求"}')}\n`,
      taskId: 'task-1',
      messageId: 'msg-1',
      ownerUserId: OWNER,
      notify,
    });

    expect(result.created).toBe(1);
    expect(notify).toHaveBeenCalledWith({ count: 1 });
    const drafts = store().list({ ownerUserId: OWNER, status: 'pending' });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].text).toBe('用户希望结论先行。');
    expect(drafts[0].sourceTaskId).toBe('task-1');
    expect(drafts[0].sourceMessageId).toBe('msg-1');
    expect(drafts[0].source).toBe('assistant');
    expect(store().list({ ownerUserId: OWNER, status: 'confirmed' })).toEqual([]);
  });

  it('普通回复（没有草案块）⇒ 零副作用，也不打扰界面', () => {
    const notify = vi.fn();
    const result = collectMemoryDrafts({ content: '这一段就是正常聊天的正文。', ownerUserId: OWNER, notify });
    expect(result.created).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(store().list({ ownerUserId: OWNER })).toEqual([]);
  });

  it('⭐ 用户拒绝过的同一件事：助手再提 ⇒ duplicate，不重复打扰（也不进待确认栏）', () => {
    collectMemoryDrafts({ content: fence('{"text":"用户在做电商"}'), ownerUserId: OWNER });
    const draft = store().list({ ownerUserId: OWNER, status: 'pending' })[0];
    expect(store().reject({ ownerUserId: OWNER, id: draft.id }).ok).toBe(true);

    const notify = vi.fn();
    const again = collectMemoryDrafts({ content: fence('{"text":"用户在做电商"}'), ownerUserId: OWNER, notify });
    expect(again).toEqual({ created: 0, duplicate: 1, discarded: 0, overflow: 0, skipped: false });
    expect(notify).not.toHaveBeenCalled();
    expect(store().list({ ownerUserId: OWNER, status: 'pending' })).toEqual([]);
  });

  it('坏 JSON 块被丢掉并**如实计数**（不把一段代码当记忆存进去）', () => {
    const result = collectMemoryDrafts({ content: fence('{"text": "没写完'), ownerUserId: OWNER });
    expect(result.created).toBe(0);
    expect(result.discarded).toBe(1);
    expect(store().list({ ownerUserId: OWNER })).toEqual([]);
  });

  it('一条回复里超过上限的草案：前 N 条落库，其余如实计数为 overflow', () => {
    const content = Array.from({ length: 5 }, (_, i) => fence(`{"text":"第 ${i} 条"}`)).join('\n');
    const result = collectMemoryDrafts({ content, ownerUserId: OWNER });
    expect(result.created).toBe(3);
    expect(result.overflow).toBe(2);
    expect(store().list({ ownerUserId: OWNER, status: 'pending' })).toHaveLength(3);
  });

  it('草案按**当前账号**归属：换个账号提，落在各自名下', () => {
    collectMemoryDrafts({ content: fence('{"text":"A 的草案"}'), ownerUserId: 'user-a' });
    collectMemoryDrafts({ content: fence('{"text":"B 的草案"}'), ownerUserId: 'user-b' });
    expect(
      store()
        .list({ ownerUserId: 'user-a', status: 'pending' })
        .map((e) => e.text),
    ).toEqual(['A 的草案']);
    expect(
      store()
        .list({ ownerUserId: 'user-b', status: 'pending' })
        .map((e) => e.text),
    ).toEqual(['B 的草案']);
  });
});

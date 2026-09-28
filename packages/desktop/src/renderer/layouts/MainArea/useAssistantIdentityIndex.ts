import { useCallback, useMemo } from 'react';
import { parseAgentIdFromSessionKey } from '@clawwork/shared';
import { resolveAssistantIdentity, type AssistantIdentity } from './assistant-identity';

type PerformerLike =
  Parameters<typeof resolveAssistantIdentity>[0]['performerBySessionKey'] extends Map<string, infer P> ? P : never;
type CatalogAgentLike =
  Parameters<typeof resolveAssistantIdentity>[0]['catalogAgentById'] extends Map<string, infer C> ? C : never;

/**
 * 缓存键的分隔符：**可见、且不可能出现在会话键或助手 id 里**。
 *
 * ⚠️ 它只用来拼 map 的键，**不再用来把一串 entries 拼起来再拆开** ——
 * 我第一版就是那么干的，而外层用 `'|'`、内层用 `'||'`，外层是内层的子串 ⇒
 * `a||writer` 被拆成 `a` / `` / `writer`，键全对不上、身份全变空。
 * 现在直接遍历 `entries`（调用方 `useMemo` 保证引用稳定），根本没有"拆"这一步。
 *
 * ⚠️ 我第一版用的是不可见的 NUL，结果源码里留下了**真的 NUL 字节**：
 * `grep` 把整个文件当成二进制（"Binary file matches"），编辑器里又看不见 ——
 * 而且我还顺手把注释写得和实际值不一致（说"转义"，实际是裸字节）。
 * `||` 两边都是可见字符，同样无歧义（会话键由 `buildSessionKey` 生成、冒号分段，
 * 其中的 slug 与 UUID 都不含 `|`），出问题时一眼看得出来。
 *
 * ⚠️ 别在注释里写出会话键的**字面形状**：`check-architecture` 有一条 `[session-key]` 规则
 * （要求一律用 `buildSessionKey` 构造），它**连注释一起扫** ——
 * 2026-09-29 我就在这里把门禁弄红过一次（注释里描述格式，被当成手搓会话键）。
 */
const KEY_SEP = '||';

export interface AssistantIdentityIndexInput {
  /**
   * 画面上要出现的（会话，可选助手）组合。顺序无所谓，重复也无所谓。
   *
   * ⚠️ **`agentId` 必须带上**：旧代码在"定稿消息"那一支传的是
   * `agentId: message.agentId`（**历史消息里它是网关给的** —— 见 `session-sync.ts` 的
   * `sessionKey: message.sessionKey, agentId: message.agentId`），
   * 而另外两支传的是**从会话键解析出来的**那个。两者**可能不一致**。
   * 只按会话键算会改变那些消息显示的名字/头像（甚至变空）——
   * 所以缓存键是**（会话，助手）对**，与旧行为逐字对齐。
   */
  entries: readonly { sessionKey: string; agentId?: string }[];
  task?: { sessionKey: string; agentId?: string; ensemble?: boolean };
  gatewayId?: string;
  performerBySessionKey: Map<string, PerformerLike>;
  performerByAgentId: Map<string, PerformerLike>;
  catalogAgentById: Map<string, CatalogAgentLike>;
  conductorLabel: string;
}

/**
 * （会话，助手）→ 身份对象的**带缓存索引**（2026-09-29）。
 *
 * ## 为什么需要它（这是那条"思维链把界面拖死"的根因）
 *
 * `AssistantBlock` 是 `memo` 的，而 `MainArea` 原来在渲染循环里**每次调用**
 * `resolveAssistantIdentity()` —— 它返回一个**新的对象字面量**。React 的浅比较按引用比，
 * 于是 `memo` **每来一个 delta 都被击穿**，整棵子树（含 `MarkdownContent`）重渲一遍。
 * 真机实测一轮长思维链 **480 次整块重渲染**。
 *
 * ⭐ 判据就是"**输入没变时必须拿到同一个引用**"——这正是让 `memo` 生效的条件。
 *
 * ⚠️ 依赖必须**点名列全**：漏一个就会出现"改了目录、界面上名字永远不更新"，
 * 那种 bug 比性能问题难查得多（测试里专门有一条盯它）。
 * ⚠️ 也**别把每次渲染都换新引用的东西**（比如整个 `timelineItems` 数组、
 * 或者 `activeTurnBySession` 这种每个 delta 都换顶层的 map）放进依赖 ——
 * 那等于没缓存。这里刻意只收**字符串**与会话内容无关的那几个稳定值。
 */
export function useAssistantIdentityIndex({
  entries,
  task,
  gatewayId,
  performerBySessionKey,
  performerByAgentId,
  catalogAgentById,
  conductorLabel,
}: AssistantIdentityIndexInput): (sessionKey?: string, agentId?: string) => AssistantIdentity {
  /**
   * ⚠️ `entries` **必须引用稳定**（调用方用 `useMemo` 保证，且只依赖"值稳定"的东西）——
   * 它每次渲染都换新数组的话，下面的缓存每渲染都失效，`memo` 照样被击穿
   * （那就白改这一刀了）。这里**直接遍历它**，不做"拼一串再拆开"那种往返。
   */
  const byKey = useMemo(() => {
    const map = new Map<string, AssistantIdentity>();
    for (const entry of entries) {
      const sessionKey = entry.sessionKey;
      const agentId = entry.agentId ?? '';
      if (!sessionKey && !agentId) continue;
      const key = `${sessionKey}${KEY_SEP}${agentId}`;
      if (map.has(key)) continue;
      map.set(
        key,
        resolveAssistantIdentity({
          task,
          sessionKey: sessionKey || undefined,
          // ⚠️ 有就用给的（定稿消息那一支），没有才从会话键解析（另两支）——
          //    这正是旧代码在三处的差别，别"统一"掉。
          agentId: agentId || (sessionKey ? parseAgentIdFromSessionKey(sessionKey) : undefined),
          gatewayId,
          performerBySessionKey,
          performerByAgentId,
          catalogAgentById,
          conductorLabel,
        }),
      );
    }
    return map;
  }, [catalogAgentById, conductorLabel, entries, gatewayId, performerBySessionKey, performerByAgentId, task]);

  /**
   * **兜底**：查不到的键落到这里。`resolveAssistantIdentity` 在全 `undefined` 输入下
   * 每一项都是 `undefined`，所以一个共享对象与它等值，不必每次现造。
   *
   * ⚠️ 但这**不是**"只有系统消息会用到"——**任何没登记的键都会落到这里，
   * 而且是全空的**（2026-09-29 独立复核就是在这里抓到 P1：等待中的 worker 会话
   * 不在登记表里 ⇒ 名字和头像整块消失）。所以调用方必须把**每一处会去查的**
   * （会话，助手）都登记上；查不到就是"没登记"，不是"这个人没有身份"。
   */
  const empty = useMemo<AssistantIdentity>(
    () =>
      resolveAssistantIdentity({
        task: undefined,
        sessionKey: undefined,
        agentId: undefined,
        gatewayId: undefined,
        performerBySessionKey: new Map(),
        performerByAgentId: new Map(),
        catalogAgentById: new Map(),
        conductorLabel,
      }),
    [conductorLabel],
  );

  return useCallback(
    (sessionKey?: string, agentId?: string) => byKey.get(`${sessionKey ?? ''}${KEY_SEP}${agentId ?? ''}`) ?? empty,
    [byKey, empty],
  );
}

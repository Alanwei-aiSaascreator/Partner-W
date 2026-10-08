import { useState, useCallback, useRef, useEffect, type RefObject } from 'react';
import type { Task, Artifact } from '@clawwork/shared';
import type { TaskContextFile } from './useTaskMaterials';
import type { MentionItem, MentionTab, AgentMentionEntry } from '../MentionPicker';
import { useFileStore } from '../../stores/fileStore';
import { useTaskStore } from '../../stores/taskStore';
import { shouldResetComposerOnConversationChange } from './conversation-scope';
import { MENTION_ALL_AGENT_ID } from './constants';

interface UseMentionPickerOpts {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  hasContextSources: boolean;
  loadLocalFiles: (query?: string) => Promise<unknown>;
  hasAgents?: boolean;
}

export function useMentionPicker(opts: UseMentionPickerOpts) {
  const { textareaRef, hasContextSources, loadLocalFiles, hasAgents } = opts;

  const [mentionVisible, setMentionVisible] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionTab, setMentionTab] = useState<MentionTab>('tasks');
  const [selectedTasks, setSelectedTasks] = useState<Task[]>([]);
  const [selectedArtifacts, setSelectedArtifacts] = useState<Artifact[]>([]);
  const [selectedLocalFiles, setSelectedLocalFiles] = useState<TaskContextFile[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<AgentMentionEntry[]>([]);
  const mentionItemsRef = useRef<MentionItem[]>([]);
  const mentionWasVisible = useRef(false);

  const activeTaskId = useTaskStore((s) => s.activeTaskId);

  /**
   * ⭐ 2026-10-07（质量战役区 3）：@ 选择的清理**换成"离开一段对话"的边界规则**。
   *
   * 原来 `useEffect(..., [activeTaskId])` **无条件清** —— 于是发送时那次
   * `pending → 真任务`（`activeTaskId: null → task-1`）也被当成"换了对话"：
   * 发送失败时用户刚 @ 的任务/产物/助手**当场没了**（与 BUG-028 定义的边界直接矛盾，
   * 见 `conversation-scope.ts` 的头注：`null → X` 是"这段对话刚开始"，不是"换了一段"）。
   *
   * 判据与输入框其余会话级状态**同一份纯函数**：`null→X` 不清 / `A→B` 清 / `A→null` 清。
   * `A→A`（原地重渲染）不算切换。前一个 id 用 ref 记（只关心"上一个"）。
   */
  const previousActiveTaskIdRef = useRef<string | null>(activeTaskId);
  useEffect(() => {
    const previousTaskId = previousActiveTaskIdRef.current;
    previousActiveTaskIdRef.current = activeTaskId;
    if (!shouldResetComposerOnConversationChange(previousTaskId, activeTaskId)) return;
    setSelectedTasks([]);
    setSelectedArtifacts([]);
    setSelectedLocalFiles([]);
    setSelectedAgents([]);
  }, [activeTaskId]);

  const updateMentionPicker = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart ?? 0;
    const before = ta.value.slice(0, pos);
    const atMatch = before.match(/@([^\s@]*)$/);
    if (atMatch) {
      if (!mentionWasVisible.current) {
        if (hasAgents) {
          setMentionTab('agents');
        } else if (hasContextSources) {
          setMentionTab('local');
        } else {
          const hasArtifactsNow = useFileStore.getState().artifacts.length > 0;
          setMentionTab(hasArtifactsNow ? 'files' : 'tasks');
        }
        loadLocalFiles();
      }
      mentionWasVisible.current = true;
      setMentionVisible(true);
      setMentionQuery(atMatch[1]);
      setMentionIndex(0);
    } else {
      mentionWasVisible.current = false;
      setMentionVisible(false);
    }
  }, [textareaRef, hasContextSources, loadLocalFiles, hasAgents]);

  const closeMentionPicker = useCallback(() => {
    mentionWasVisible.current = false;
    setMentionVisible(false);
    setMentionQuery('');
    setMentionIndex(0);
  }, []);

  const stripAtQuery = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart ?? 0;
    const before = ta.value.slice(0, pos);
    const after = ta.value.slice(pos);
    const atStart = before.lastIndexOf('@');
    if (atStart === -1) return;
    const newBefore = before.slice(0, atStart);
    ta.value = newBefore + after;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    ta.setSelectionRange(newBefore.length, newBefore.length);
    ta.focus();
  }, [textareaRef]);

  const removeSelectedAgent = useCallback((agentId: string) => {
    setSelectedAgents((prev) => prev.filter((a) => a.agentId !== agentId));
  }, []);

  const commitMention = useCallback(
    (item: MentionItem) => {
      if (item.kind === 'agent') {
        if (selectedAgents.some((a) => a.agentId === item.agent.agentId)) {
          closeMentionPicker();
          return;
        }
        stripAtQuery();
        if (item.agent.agentId === MENTION_ALL_AGENT_ID) {
          setSelectedAgents([item.agent]);
        } else {
          setSelectedAgents((prev) => prev.filter((a) => a.agentId !== MENTION_ALL_AGENT_ID).concat(item.agent));
        }
        closeMentionPicker();
        return;
      }
      if (item.kind === 'task') {
        if (selectedTasks.some((t) => t.id === item.task.id)) {
          closeMentionPicker();
          return;
        }
        stripAtQuery();
        setSelectedTasks((prev) => [...prev, item.task]);
      } else if (item.kind === 'local') {
        if (
          selectedLocalFiles.some((f) => f.sourceId === item.file.sourceId && f.relativePath === item.file.relativePath)
        ) {
          closeMentionPicker();
          return;
        }
        stripAtQuery();
        setSelectedLocalFiles((prev) => [...prev, item.file]);
      } else {
        if (selectedArtifacts.some((a) => a.id === item.artifact.id)) {
          closeMentionPicker();
          return;
        }
        stripAtQuery();
        setSelectedArtifacts((prev) => [...prev, item.artifact]);
      }
      closeMentionPicker();
    },
    [selectedTasks, selectedArtifacts, selectedLocalFiles, selectedAgents, closeMentionPicker, stripAtQuery],
  );

  const removeSelectedTask = useCallback((taskId: string) => {
    setSelectedTasks((prev) => prev.filter((t) => t.id !== taskId));
  }, []);

  const removeSelectedArtifact = useCallback((id: string) => {
    setSelectedArtifacts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const removeSelectedLocalFile = useCallback((sourceId: string, relativePath: string) => {
    setSelectedLocalFiles((prev) => prev.filter((f) => f.sourceId !== sourceId || f.relativePath !== relativePath));
  }, []);

  const handleMentionItemsChange = useCallback((items: MentionItem[]) => {
    mentionItemsRef.current = items;
  }, []);

  return {
    mentionVisible,
    mentionQuery,
    mentionIndex,
    setMentionIndex,
    mentionTab,
    setMentionTab,
    selectedTasks,
    setSelectedTasks,
    selectedArtifacts,
    setSelectedArtifacts,
    selectedLocalFiles,
    setSelectedLocalFiles,
    mentionItemsRef,
    updateMentionPicker,
    closeMentionPicker,
    commitMention,
    removeSelectedTask,
    removeSelectedArtifact,
    removeSelectedLocalFile,
    selectedAgents,
    setSelectedAgents,
    removeSelectedAgent,
    handleMentionItemsChange,
  };
}

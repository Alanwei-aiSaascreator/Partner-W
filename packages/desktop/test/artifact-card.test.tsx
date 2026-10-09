// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@clawwork/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import ArtifactCard from '../src/renderer/components/ArtifactCard';
import ChatMessage from '../src/renderer/components/ChatMessage';
import { useFileStore } from '../src/renderer/stores/fileStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const artifact: Artifact = {
  id: 'artifact-1',
  taskId: 'task-1',
  messageId: 'message-1',
  type: 'file',
  name: 'report.pdf',
  filePath: 'E:\\荣盈魔方工作区\\task-1\\report.pdf',
  localPath: 'task-1/report.pdf',
  mimeType: 'application/pdf',
  size: 2048,
  createdAt: '2026-09-16T08:00:00.000Z',
  availability: 'available',
};

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('ArtifactCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    Object.assign(window, {
      clawwork: {
        saveArtifactAs: vi.fn(async () => ({ ok: true, result: { status: 'saved', filePath: 'C:/report.pdf' } })),
        openArtifactFile: vi.fn(async () => ({ ok: true })),
        showArtifactInFolder: vi.fn(async () => ({ ok: true })),
      },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('shows metadata and invokes id-scoped actions', async () => {
    const { container, unmount } = render(<ArtifactCard artifact={artifact} assistantLabel="高效办公" />);

    expect(container.textContent).toContain('report.pdf');
    expect(container.textContent).toContain('高效办公');
    expect(container.querySelector('[data-testid="artifact-path"]')?.textContent).toBe(
      'E:\\荣盈魔方工作区\\task-1\\report.pdf',
    );
    expect(container.querySelector('[data-testid="artifact-path"]')?.className).toContain('truncate');
    const save = container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.saveAs"]');
    const open = container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.open"]');
    const reveal = container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.showInFolder"]');
    const copyPath = container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.copyPath"]');
    await act(async () => save?.click());
    await act(async () => open?.click());
    await act(async () => reveal?.click());
    await act(async () => copyPath?.click());

    expect(window.clawwork.saveArtifactAs).toHaveBeenCalledWith('artifact-1', 'task-1');
    expect(window.clawwork.openArtifactFile).toHaveBeenCalledWith('artifact-1', 'task-1');
    expect(window.clawwork.showArtifactInFolder).toHaveBeenCalledWith('artifact-1', 'task-1');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('E:\\荣盈魔方工作区\\task-1\\report.pdf');
    expect(container.querySelector('[aria-label="chatMessage.copied"]')).toBeTruthy();
    unmount();
  });

  it('不把相对路径冒充成用户可复制的绝对路径', () => {
    const { container, unmount } = render(<ArtifactCard artifact={{ ...artifact, filePath: 'task-1/report.pdf' }} />);

    expect(container.querySelector('[data-testid="artifact-path"]')).toBeNull();
    expect(container.querySelector('[aria-label="artifactCard.copyPath"]')).toBeNull();
    unmount();
  });

  it.each(['missing', 'unsafe'] as const)(
    'disables file actions and gives recovery guidance for %s',
    (availability) => {
      const { container, unmount } = render(<ArtifactCard artifact={{ ...artifact, availability }} />);

      expect(container.textContent).toContain(`artifactCard.${availability}`);
      expect(container.textContent).toContain('artifactCard.recoveryHint');
      expect(
        ['artifactCard.saveAs', 'artifactCard.open', 'artifactCard.showInFolder'].every(
          (label) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.disabled,
        ),
      ).toBe(true);
      unmount();
    },
  );

  /**
   * ⭐ 2026-10-07 体检 P2-3：`unknown`（连接中）**不是** `missing`（缺失）。
   *
   * 冷启动/网关没连上时判不了，说成"文件缺失"并提示"重新生成"是在教用户修一个
   * 可能根本没坏的文件。文案单列（「暂不可用（连接中）」）、不打警告标、不给恢复提示。
   */
  it('⭐ unknown（暂不可用/连接中）：文案单列、不给"重新生成"提示，按钮仍禁用', () => {
    const { container, unmount } = render(<ArtifactCard artifact={{ ...artifact, availability: 'unknown' }} />);

    expect(container.textContent).toContain('artifactCard.unknown');
    expect(container.textContent).not.toContain('artifactCard.missing');
    expect(container.textContent).not.toContain('artifactCard.recoveryHint');
    expect(
      ['artifactCard.saveAs', 'artifactCard.open', 'artifactCard.showInFolder'].every(
        (label) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.disabled,
      ),
    ).toBe(true);
    unmount();
  });

  /**
   * ⭐ H4a（2026-10-09 复审）：预览按钮必须与打开/另存**同规**。
   *
   * 「在右侧预览」是要真去读文件的动作 —— 对 unknown（判不了）/missing（不在）/
   * unsafe（不让读）的产物开放它，就是把用户送进一个必然失败的读取（随后只看到
   * 「读取失败」，而列表 badge 明明写着"暂不可用"）。三层约束（按钮 / 导航适配层 /
   * 预览面板解析）都要按 available 把关。
   */
  it.each(['unknown', 'missing', 'unsafe'] as const)(
    '⭐ 预览按钮与打开/另存同规：availability=%s 时禁用（H4a）',
    (availability) => {
      const onPreview = vi.fn();
      const { container, unmount } = render(
        <ArtifactCard artifact={{ ...artifact, availability }} onPreview={onPreview} />,
      );

      const preview = container.querySelector<HTMLButtonElement>('[data-action="artifact-preview"]');
      expect(preview, '卡上仍要有预览入口（只是禁用）').not.toBeNull();
      expect(preview!.disabled, '非 available 不许进预览').toBe(true);
      unmount();
    },
  );

  it('对照：available 时预览按钮可用', () => {
    const onPreview = vi.fn();
    const { container, unmount } = render(<ArtifactCard artifact={artifact} onPreview={onPreview} />);

    const preview = container.querySelector<HTMLButtonElement>('[data-action="artifact-preview"]');
    expect(preview!.disabled).toBe(false);
    unmount();
  });

  /**
   * ⭐ 2026-10-07 体检 P3-8：打开失败要**带着下一步**留下。
   *
   * 改之前是 2.4 秒一闪而过的通用文案（"操作未完成"）——等于什么都没说：
   * 用户既不知道出了什么事，也不知道还能做什么。
   */
  it('⭐ 打开失败：留下明确文案与"在文件夹中显示"的提示', async () => {
    vi.mocked(window.clawwork.openArtifactFile).mockResolvedValue({ ok: false, error: 'artifact invalid' });
    const { container, unmount } = render(<ArtifactCard artifact={artifact} />);

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.open"]')?.click());

    expect(container.textContent).toContain('artifactCard.openFailed');
    expect(container.textContent).toContain('artifactCard.openFailedHint');
    unmount();
  });

  it('打开成功不留失败文案（负对照）', async () => {
    const { container, unmount } = render(<ArtifactCard artifact={artifact} />);

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.open"]')?.click());

    expect(container.textContent).not.toContain('artifactCard.openFailed');
    expect(container.textContent).not.toContain('artifactCard.openFailedHint');
    unmount();
  });

  /**
   * ⭐⭐ BUG-042-b（2026-10-08 亲验）：**"打不开"有两种，不能都说成"损坏"**。
   *
   * 机器里没装 Word/WPS ⇒ 系统没有可打开它的程序；文件本身是好的。
   * 旧界面对任何打开失败都弹「文件可能已损坏或未写完」—— 用户会白白重做一遍。
   * 判据：`artifact invalid`（复核确证坏件）才用"损坏"；`artifact no-opener`（没有关联程序）
   * 用「装个程序再试」；其余认不出的一律走中性文案，不替用户下结论。
   */
  describe('⭐ 打开失败原因分类（BUG-042-b）', () => {
    const open = (container: HTMLElement) =>
      act(async () => container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.open"]')?.click());
    /** 状态行那一格的字（`role="status"`）—— 别拿整卡 textContent 判，提示行名字里也含 openFailed。 */
    const status = (container: HTMLElement) => container.querySelector('[role="status"]')?.textContent ?? '';

    it('没有关联程序 ⇒ 说"系统里没有可打开的程序"，不说"损坏"', async () => {
      vi.mocked(window.clawwork.openArtifactFile).mockResolvedValue({ ok: false, error: 'artifact no-opener' });
      const { container, unmount } = render(<ArtifactCard artifact={artifact} />);

      await open(container);

      expect(status(container)).toContain('artifactCard.noAppToOpen');
      // 下一步照旧：去文件夹里手动打开
      expect(container.textContent).toContain('artifactCard.openFailedHint');
      unmount();
    });

    it('坏件（artifact invalid）⇒ 仍是"损坏"文案（不许被分类成 no-opener）', async () => {
      vi.mocked(window.clawwork.openArtifactFile).mockResolvedValue({ ok: false, error: 'artifact invalid' });
      const { container, unmount } = render(<ArtifactCard artifact={artifact} />);

      await open(container);

      expect(status(container)).toContain('artifactCard.openFailed');
      expect(status(container)).not.toContain('artifactCard.noAppToOpen');
      unmount();
    });

    it('认不出的系统错误 ⇒ 中性文案（不替用户说"损坏"）', async () => {
      vi.mocked(window.clawwork.openArtifactFile).mockResolvedValue({ ok: false, error: 'Access is denied.' });
      const { container, unmount } = render(<ArtifactCard artifact={artifact} />);

      await open(container);

      expect(status(container)).toContain('artifactCard.error');
      expect(status(container)).not.toContain('artifactCard.openFailed');
      expect(status(container)).not.toContain('artifactCard.noAppToOpen');
      unmount();
    });
  });

  it('renders real assistant artifacts inside the originating chat message', async () => {
    /*
      ⚠️ 2026-10-08 有意改写（T8 接线 · 总审闭环令 §4.1）：聊天内产物卡的**真源**已改为
      任务级 `fileStore + listArtifacts`（与右栏同源，先对完整任务归并、后按 messageId 分发）——
      `message.artifacts` 在生产链路**恒为空**，不再作为来源（见 AssistantBlock 的接线注释）。
      断言意图不变：**真实登记**的产物要出现在它所属的那条消息里。
    */
    useFileStore.setState({ artifacts: [artifact] });
    const { container, unmount } = render(
      <ChatMessage
        message={{
          id: 'message-1',
          taskId: 'task-1',
          role: 'assistant',
          content: '文件已经生成。',
          artifacts: [],
          toolCalls: [],
          timestamp: '2026-09-16T08:00:00.000Z',
        }}
        agentName="高效办公"
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="artifact-card"]')?.textContent).toContain('report.pdf');
    expect(container.querySelector('[aria-label="artifactCard.locateMessage"]')).toBeNull();
    useFileStore.setState({ artifacts: [] });
    unmount();
  });
});

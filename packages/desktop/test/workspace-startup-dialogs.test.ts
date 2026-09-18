/**
 * 启动期工作区对话框（T-U1）—— 中文、可操作、**退出必须是用户的显式选择**。
 *
 * 旧行为是英文 `showErrorBox('Database Error')` + 直接退出：用户只知道"坏了"，
 * 不知道能怎么办，而且换机器/换盘符时连"再选个目录"的机会都没有。
 *
 * ⚠️ 这条约束是用户原话里最硬的一条（"绝不再 app.quit()"）：所以这里逐个钉住
 *    按钮文案、按钮顺序、`cancelId`（Esc 落在哪）以及每个返回值。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  windows: [] as unknown[],
  // 参数声明成 unknown[]：真实 API 有"带父窗口 / 不带父窗口"两个重载，两个都要能调
  showMessageBox: vi.fn((..._args: unknown[]) => Promise.resolve({ response: 0, checkboxChecked: false })),
  showOpenDialog: vi.fn((..._args: unknown[]) => Promise.resolve({ canceled: false, filePaths: [] as string[] })),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => electronMock.windows,
  },
  dialog: {
    showMessageBox: electronMock.showMessageBox,
    showOpenDialog: electronMock.showOpenDialog,
  },
}));

import { createWorkspaceStartupDialogs } from '../src/main/workspace/startup-dialogs.js';

const WIN = 'C:\\Users\\u\\AppData\\Roaming';
const RECORDED = 'E:\\荣盈魔方工作区';
const CANDIDATE_A = 'F:\\荣盈魔方工作区';
const CANDIDATE_B = 'G:\\荣盈魔方工作区';

interface BoxOptions {
  type: string;
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

function lastBox(): BoxOptions {
  const call = electronMock.showMessageBox.mock.calls.at(-1);
  if (!call) throw new Error('showMessageBox 没被调用');
  return (Array.isArray(call[0]) ? call[1] : call[0]) as unknown as BoxOptions;
}

function respond(response: number): void {
  electronMock.showMessageBox.mockResolvedValue({ response, checkboxChecked: false });
}

const dialogs = createWorkspaceStartupDialogs();

beforeEach(() => {
  electronMock.windows = [];
  electronMock.showMessageBox.mockClear();
  electronMock.showOpenDialog.mockClear();
  respond(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('找不到工作区：让用户选，而不是退出', () => {
  it('零候选（盘没插）⇒ 「选择其它目录… / 新建工作区 / 退出」，并说清原来在哪', async () => {
    respond(0);
    const choice = await dialogs.askForMissingWorkspace({ recordedPath: RECORDED, candidates: [] });

    const box = lastBox();
    expect(box.buttons).toEqual(['选择其它目录…', '新建工作区', '退出']);
    expect(box.title).toBe('找不到工作区');
    expect(box.message).toContain(RECORDED);
    expect(box.detail).toContain(RECORDED);
    expect(box.detail).toContain('可以自己指定一个目录'); // 告诉用户能怎么办
    expect(box.cancelId).toBe(box.buttons.length - 1); // Esc = 退出（用户显式关掉）
    expect(choice).toEqual({ kind: 'browse' });
  });

  it('按钮的返回值：0=选目录 / 1=新建 / 2=退出', async () => {
    respond(0);
    await expect(dialogs.askForMissingWorkspace({ recordedPath: RECORDED, candidates: [] })).resolves.toEqual({
      kind: 'browse',
    });
    respond(1);
    await expect(dialogs.askForMissingWorkspace({ recordedPath: RECORDED, candidates: [] })).resolves.toEqual({
      kind: 'create',
    });
    respond(2);
    await expect(dialogs.askForMissingWorkspace({ recordedPath: RECORDED, candidates: [] })).resolves.toEqual({
      kind: 'quit',
    });
  });

  it('⚠️ 越界的 response（关窗）也当成「退出」，不许崩', async () => {
    respond(-1);
    await expect(dialogs.askForMissingWorkspace({ recordedPath: RECORDED, candidates: [] })).resolves.toEqual({
      kind: 'quit',
    });
  });

  it('多命中 ⇒ 候选路径**就是按钮**（同时在说明里编号列一遍），用户挑哪个用哪个', async () => {
    respond(1);
    const choice = await dialogs.askForMissingWorkspace({
      recordedPath: RECORDED,
      candidates: [CANDIDATE_A, CANDIDATE_B],
    });

    const box = lastBox();
    expect(box.buttons).toEqual([CANDIDATE_A, CANDIDATE_B, '选择其它目录…', '新建工作区', '退出']);
    expect(box.detail).toContain(`1. ${CANDIDATE_A}`);
    expect(box.detail).toContain(`2. ${CANDIDATE_B}`);
    expect(box.cancelId).toBe(4);
    expect(choice).toEqual({ kind: 'use', path: CANDIDATE_B });

    respond(0);
    await expect(
      dialogs.askForMissingWorkspace({ recordedPath: RECORDED, candidates: [CANDIDATE_A, CANDIDATE_B] }),
    ).resolves.toEqual({ kind: 'use', path: CANDIDATE_A });
    respond(3);
    await expect(
      dialogs.askForMissingWorkspace({ recordedPath: RECORDED, candidates: [CANDIDATE_A, CANDIDATE_B] }),
    ).resolves.toEqual({ kind: 'create' });
    respond(4);
    await expect(
      dialogs.askForMissingWorkspace({ recordedPath: RECORDED, candidates: [CANDIDATE_A, CANDIDATE_B] }),
    ).resolves.toEqual({ kind: 'quit' });
  });

  it('启动期还没窗口 ⇒ 也弹得出来（工作区是在开窗之前准备的）', async () => {
    electronMock.windows = [];
    await dialogs.askForMissingWorkspace({ recordedPath: RECORDED, candidates: [] });

    const call = electronMock.showMessageBox.mock.calls.at(-1);
    expect(call).toHaveLength(1); // 无父窗口的重载
  });

  it('已经有窗口 ⇒ 挂在窗口上（模态，不会跑到后面去）', async () => {
    const win = { id: 1 };
    electronMock.windows = [win];
    await dialogs.askForMissingWorkspace({ recordedPath: RECORDED, candidates: [] });

    const call = electronMock.showMessageBox.mock.calls.at(-1);
    expect(call?.[0]).toBe(win);
  });
});

describe('数据库打不开：选目录 / 重建 / 退出', () => {
  const WS = 'C:\\ws';

  it('三个出口都写清楚，且**不许**出现英文错误框那套', async () => {
    respond(1);
    const choice = await dialogs.askForUnusableWorkspace({ workspacePath: WS, message: 'file is not a database' });

    const box = lastBox();
    expect(box.buttons).toEqual(['选择其它目录…', '重建工作区', '退出']);
    expect(box.type).toBe('error');
    expect(box.title).toBe('打不开工作区');
    expect(box.message).toContain(WS);
    expect(box.detail).toContain('file is not a database'); // 技术原因照实说
    expect(box.detail).toContain('改名保留'); // 但把后果说清楚（不删用户文件）
    expect(box.cancelId).toBe(2);
    expect(choice).toBe('rebuild');
  });

  it('按钮的返回值：0=选目录 / 1=重建 / 2=退出（越界也算退出）', async () => {
    respond(0);
    await expect(dialogs.askForUnusableWorkspace({ workspacePath: WS, message: 'boom' })).resolves.toBe('browse');
    respond(1);
    await expect(dialogs.askForUnusableWorkspace({ workspacePath: WS, message: 'boom' })).resolves.toBe('rebuild');
    respond(2);
    await expect(dialogs.askForUnusableWorkspace({ workspacePath: WS, message: 'boom' })).resolves.toBe('quit');
    respond(-1);
    await expect(dialogs.askForUnusableWorkspace({ workspacePath: WS, message: 'boom' })).resolves.toBe('quit');
  });
});

describe('选目录 / 最后的提示', () => {
  it('选目录：标题中文、能建新目录、取消返回 null', async () => {
    electronMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(dialogs.browseForDirectory(RECORDED)).resolves.toBeNull();

    electronMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
    await expect(dialogs.browseForDirectory(RECORDED)).resolves.toBeNull();

    electronMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [WIN] });
    await expect(dialogs.browseForDirectory(RECORDED)).resolves.toBe(WIN);

    const options = electronMock.showOpenDialog.mock.calls.at(-1)?.[0] as {
      title: string;
      defaultPath: string;
      properties: string[];
    };
    expect(options.title).toBe('选择工作区目录');
    expect(options.defaultPath).toBe(RECORDED);
    expect(options.properties).toEqual(['openDirectory', 'createDirectory']);
  });

  it('最后一招：只说一句中文，一个「退出」按钮', async () => {
    await dialogs.notifyFatal?.({
      title: '打不开工作区',
      message: '试了几次都没能建好工作区。',
      detail: '请检查磁盘。',
    });

    const box = lastBox();
    expect(box.buttons).toEqual(['退出']);
    expect(box.title).toBe('打不开工作区');
  });
});

import { describe, expect, it } from 'vitest';
import { localizeInstallMessage } from '../src/renderer/lib/install-message';

const t = (key: string, options?: Record<string, unknown>): string =>
  options ? `${key}(${JSON.stringify(options)})` : key;

describe('localizeInstallMessage：安装失败不露英文', () => {
  it('ALREADY EXISTS ⇒ 人话，带上助手名', () => {
    expect(localizeInstallMessage('Failed to create agent "Manager": AGENT "Manager" ALREADY EXISTS', t)).toBe(
      'teams.wizard.errAlreadyExists({"name":"Manager"})',
    );
  });

  it('CONFIG CHANGED ⇒ 人话', () => {
    expect(
      localizeInstallMessage(
        'Failed to configure subagents: CONFIG CHANGED SINCE LAST LOAD; RE-RUN CONFIG.GET AND RETRY',
        t,
      ),
    ).toBe('teams.wizard.errConfigChanged');
  });

  it('No agents were created successfully ⇒ 人话', () => {
    expect(localizeInstallMessage('No agents were created successfully', t)).toBe('teams.wizard.errNoAgents');
  });

  it('Download failed ⇒ 人话', () => {
    expect(localizeInstallMessage('Download failed', t)).toBe('teams.wizard.errDownload');
  });

  it('已经是中文的原因原样上屏', () => {
    expect(localizeInstallMessage('工作区还没准备好，先在设置里指定工作区，再安装助手。', t)).toBe(
      '工作区还没准备好，先在设置里指定工作区，再安装助手。',
    );
  });

  it('认不出的英文 ⇒ 通用人话，不把原文摆上屏', () => {
    expect(localizeInstallMessage('quota exceeded', t)).toBe('teams.wizard.errGeneric');
  });
});

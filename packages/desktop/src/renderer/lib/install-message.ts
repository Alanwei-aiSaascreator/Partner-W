type Translate = (key: string, options?: Record<string, unknown>) => string;

const LOOKS_RUNTIME_ENGLISH =
  /failed|error|already exists|config changed|no agents|download failed|unsupported|rollback|unknown|not found|quota exceeded/i;

/**
 * 安装失败时**先说人话**：把网关原文翻成一句中文。
 *
 * 今天真机：创建团队弹出 `AGENT "…" ALREADY EXISTS` / `CONFIG CHANGED SINCE LAST LOAD`。
 * 那两句用户看不懂，看起来像「坏了」。
 *
 * ⚠️ 这里是**改写标题**，不是**拦住原文** —— 认不出的形状仍然把原文交给
 *    `<InstallMessageLine>` 弱化显示在下一行。原因不能没有：
 *    2026-09-20 实机四个助手全建失败、面板只剩一句英文，
 *    `install-progress-reason.test.tsx` 就是那次钉下来「原文必须上屏」的。
 */
export function localizeInstallMessage(message: string, t: Translate): string {
  const raw = message.trim();
  if (!raw) return t('teams.wizard.errGeneric');

  const already = raw.match(/agent\s+"([^"]+)"\s+already exists/i);
  if (already) return t('teams.wizard.errAlreadyExists', { name: already[1] });

  const create = raw.match(/failed to create agent "([^"]+)"/i);
  if (create) return t('teams.wizard.errCreateAgent', { name: create[1] });

  if (/config changed/i.test(raw)) return t('teams.wizard.errConfigChanged');
  if (/failed to configure subagents/i.test(raw)) return t('teams.wizard.errConfigureSubagents');
  if (/no agents were created/i.test(raw)) return t('teams.wizard.errNoAgents');
  if (/failed to persist team/i.test(raw)) return t('teams.wizard.errPersist');
  if (/failed to set (IDENTITY|SOUL)\.md/i.test(raw)) return t('teams.wizard.errSetFile');

  const skillFail = raw.match(/skill "([^"]+)" install failed/i);
  if (skillFail) return t('teams.wizard.errSkill', { name: skillFail[1] });

  const skillSkip = raw.match(/skill "([^"]+)" has unsupported/i);
  if (skillSkip) return t('teams.wizard.errSkillUnsupported', { name: skillSkip[1] });

  if (/download failed/i.test(raw)) return t('teams.wizard.errDownload');
  if (/failed to update team/i.test(raw)) return t('teams.wizard.errUpdate');

  if (/[\u4e00-\u9fff]/.test(raw) && !LOOKS_RUNTIME_ENGLISH.test(raw)) return raw;

  if (LOOKS_RUNTIME_ENGLISH.test(raw) || /^[\x20-\x7E]+$/.test(raw)) {
    // 原文不是被丢掉，只是让位给这句人话当标题 —— `<InstallMessageLine>` 会把它显示在下一行。
    console.debug('[teams.install] unrecognized runtime error (kept as detail line):', raw);
    return t('teams.wizard.errGeneric');
  }

  return raw;
}

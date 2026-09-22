/**
 * U 盘交付包 → 压缩包（分发给"好多 U 盘"那一步）的判据（纯函数，全可测）。
 *
 * 为什么这一步也需要闸门（不是"压一下而已"）：
 *
 * ① **最要命的一条：别把跑过的目录打包**。U 盘版第一次运行会在盘里建
 *    `荣盈魔方-运行数据\` —— 里面有 `device-identity.json`（设备私钥）、
 *    `device-tokens.json`（operator token）、`local-gateway-auth.json`（本机网关 token）、
 *    `clawwork-config.json`（中转 token）、日志（含对话）。**打包它 = 把一份凭据发给每一个客户**。
 *    所以 `findSensitiveEntries` 是这个文件里最值钱的函数（`FORBIDDEN_TOP_DIRS` + 文件名两层网）。
 * ② **解压工具会决定文件名对不对**：Explorer 自带的 zip 用本机代码页写名字，
 *    中文名（`荣盈魔方`、`使用说明.txt`）在别的语言机器上会变乱码；7-Zip 的
 *    `-mcu` 强制 UTF-8 才对。⇒ 生成时钉 UTF-8，说明里钉"用 7-Zip 解压"。
 * ③ **路径深度**：`MAX_PATH` 260 的老限制在 Explorer 解压上仍然生效。实测本交付包
 *    最长相对路径 109 字符（zip 里 244 个条目）—— 安全；但函数留着，
 *    下次往里塞别的东西时它会响（`maxPathLength` + `PATH_LENGTH_BUDGET`）。
 *
 * ⚠️ 解压出来的东西**必须落在 U 盘根目录**（`E:\荣盈魔方\…`）。落在子目录里也能跑
 *    （认盘看的是卷根），但说明与客服话术统一按"解压到 U 盘根目录"。
 */

/**
 * 这些目录名（**任意层级**）一旦出现在交付夹里 ⇒ 这个夹子被跑过，绝不能封包。
 *
 * ⚠️ 为什么敢查任意层级而不是只查顶层：实测**纯净交付包**（0.0.24，244 个条目）
 *    里这些名字**一个都没有**（`logs` / `openclaw-state` / `荣盈魔方工作区` /
 *    `荣盈魔方-运行数据` 全 0 命中）—— 也就是说这条规则不会误伤正常交付包，
 *    而漏掉它的代价是"把一份凭据发给每一个客户"。
 */
export const FORBIDDEN_DIR_NAMES = ['荣盈魔方-运行数据', '荣盈魔方工作区', '.荣盈魔方更新', 'openclaw-state', 'logs'];

/** 这些文件名（任意层级）承载凭据 —— 出现即拒绝（实测纯净包里同样 0 命中）。 */
export const SENSITIVE_FILE_NAMES = [
  'device-identity.json',
  'device-tokens.json',
  'local-gateway-auth.json',
  'clawwork-config.json',
  'commercial-session.json',
  'jwt-secret.txt',
  'backend-session.json',
];

/**
 * 相对路径清单里有没有"不该出现在交付包里"的东西（跑过的运行数据目录 + 凭据文件）。
 *
 * 入参是**相对交付夹根**的路径（`/` 或 `\` 分隔都行）。返回命中的那些（原样），
 * 空数组 = 干净。⚠️ 只看名字不看内容：这是防"手滑打包"的网，不是恶意检测。
 */
export function findSensitiveEntries(relPaths) {
  const hits = [];
  for (const raw of relPaths ?? []) {
    const rel = String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel) continue;
    const segments = rel.split('/').filter(Boolean);
    if (segments.some((s) => FORBIDDEN_DIR_NAMES.includes(s))) hits.push(rel);
    else if (SENSITIVE_FILE_NAMES.includes(segments[segments.length - 1])) hits.push(rel);
  }
  return hits;
}

/** 最长相对路径长度（`/` 计数）。 */
export function maxPathLength(relPaths) {
  let max = 0;
  for (const raw of relPaths ?? []) {
    const rel = String(raw);
    if (rel.length > max) max = rel.length;
  }
  return max;
}

/**
 * 相对路径长度的预算：盘符根按 8 字符留（`E:\` 是 3，但有人会是 `\\?\E:\` 之类），
 * 减去 `MAX_PATH` 260 的老限制。超过就提醒"用 7-Zip 解压"（它不受这条限制）。
 */
export const PATH_LENGTH_BUDGET = 240;

/** 归档条目与目录清单的差异（只比**文件**：各工具对目录条目的记法不一致）。 */
export function diffEntries(expected, actual) {
  const norm = (list) =>
    new Set(
      (list ?? [])
        .map((p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''))
        .filter((p) => p.length > 0)
        .map((p) => p.toLowerCase()),
    );
  const want = norm(expected);
  const got = norm(actual);
  return {
    missing: [...want].filter((p) => !got.has(p)),
    extra: [...got].filter((p) => !want.has(p)),
  };
}

/** 有 7z 就用 7z，没有就用 Windows 自带的 bsdtar（`tar.exe`）；都没有 ⇒ null。 */
export function pickTool(tools, format) {
  if (tools?.sevenZip && (format === '7z' || format === 'zip')) return '7z';
  if (tools?.bsdtar && format === 'zip') return 'bsdtar';
  return null;
}

/**
 * 解压命令（对账用：把刚封好的包解开，跟源夹逐项比）。
 *
 * ⚠️ 为什么连解压也放进来：`pickTool` 返回的是 `'7z'`，而 argv 里的 `bin` 是
 *    `'sevenZip'` —— 两个名字。调用方一旦把 `tool === 'sevenZip'` 当成判断条件，
 *    就会把 **bsdtar 的参数喂给 7z**（`7z -x -f …`）⇒ 7z 报 `Too short switch: -x`。
 *    实测在真交付包上栽过一次（单测全绿也照样栽：错的是"分发"这一步，不是判据）。
 *    所以**工具名到命令行的映射只留在这里**（一份实现、两个测试盯着），调用方只认 `bin`。
 */
export function extractArgv(input) {
  const { tool, out, dir } = input;
  if (tool === '7z') return { bin: 'sevenZip', args: ['x', '-y', `-o${dir}`, out] };
  if (tool === 'bsdtar') return { bin: 'bsdtar', args: ['-x', '-f', out, '-C', dir] };
  return null;
}

/**
 * 组装归档命令（argv 数组：**不走 shell**，中文路径才不会被引号/编码咬）。
 *
 * ⚠️ 两个细节是刻意的：
 *  - `-mcu`（7z）与 bsdtar 天生 UTF-8 ⇒ 中文名在别的机器上不乱码；
 *  - 压的是**交付夹里的内容**（不是夹子本身）⇒ 用户"解压到 U 盘根目录"就得到
 *    `E:\荣盈魔方\` + `E:\使用说明.txt`，与老交付包同一形态（客服话术不用改）。
 */
export function archiveArgv(input) {
  const { tool, format, out, dir } = input;
  if (tool === '7z') {
    return {
      bin: 'sevenZip',
      args: [
        'a', // add
        '-y', // 覆盖同名旧包/旧条目时不要停下来问（这个脚本要能无人值守跑）
        `-t${format}`,
        '-mcu=on', // 文件名强制 UTF-8（中文名在别的机器上不乱码）
        // `-mx=1`：**实测**过，不是图省事。拿真实的 0.0.24 交付包量了一遍
        // （`荣盈魔方\resources` + 安装包，~1GB，含随包 .7z / app.asar / NSIS）：
        //   mx=1 → 569 MB / 8 秒      mx=9 → 558 MB / 102 秒
        // 也就是"最高压缩"多花 12 倍时间只换 2% 体积 —— 那些内容本来就是压过的。
        '-mx=1',
        '-mmt=on',
        '--',
        out,
        ...(input.contents ?? []).map((n) => `${dir}\\${n}`),
      ],
    };
  }
  if (tool === 'bsdtar') {
    // `-a` = 按扩展名选格式（.zip ⇒ zip，ZIP64 + UTF-8 名字）
    return { bin: 'bsdtar', args: ['-a', '-c', '-f', out, '-C', dir, ...(input.contents ?? ['.'])] };
  }
  return null;
}

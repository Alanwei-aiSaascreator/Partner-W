import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APP_DIR_NAME,
  ASAR_REL,
  auditDelivery,
  BUNDLED_RUNTIME_MANIFEST_REL,
  EXE_REL,
  INSTALLER_DIR_PREFIX,
  LAUNCHER_BAT_NAME,
  LAUNCHER_EXE_NAME,
  README_NAME,
  RUN_DATA_DIR_NAME,
  UPDATE_DIR_NAME,
  WORKSPACE_DIR_NAME,
  walkTreeNames,
} from './udisk-delivery.mjs';

const roots = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const README_TEMPLATE = path.join(repositoryRoot, 'scripts', 'templates', 'udisk-readme.txt');
/**
 * 交付说明（`scripts/templates/udisk-readme.txt`）是**客户唯一一份说明**，
 * 而它给出的是一条**对代码行为的对外承诺**，两处会悄悄漂开：
 *
 * ① **深度数字**：`isDeliveryLayout` 里 `MAX_DELIVERY_DEPTH` 决定"程序目录埋在盘根下多深
 *    还算盘上运行"。超过了不会报错 —— 它**静默**把运行数据与工作区留在本机，
 *    用户换台电脑打开就是"数据不见了"。而用户只会照说明里写的层数去解压。
 *    数字对不上，等于**照说明做反而坏**。
 * ② **Markdown 混进 `.txt`**：这份是纯文本，`**粗体**` 会原样显示成一串星号。
 */
const portableSource = fs.readFileSync(
  path.join(repositoryRoot, 'packages', 'desktop', 'src', 'main', 'workspace', 'portable.ts'),
  'utf-8',
);
const readme = fs.readFileSync(README_TEMPLATE, 'utf-8');
// `walkNames` 必须存在：没有它 `relativeTreeEntries` 会退回只列盘根，
// 于是"嵌套 .bat"这类用例在单测里永远看不到文件、变成假绿（真实 CLI 走的是自己的递归遍历）。
const io = {
  exists: (target) => fs.existsSync(target),
  listNames: (target) => fs.readdirSync(target),
  walkNames: (root) => {
    const names = [];
    const walk = (directory, prefix) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        names.push(relative);
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(directory, entry.name), relative);
      }
    };
    walk(root, '');
    return names;
  },
  readFile: (target) => {
    try {
      return fs.readFileSync(target);
    } catch {
      return null;
    }
  },
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeDelivery(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-delivery-'));
  roots.push(root);
  const write = (relativePath, content) => {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };

  write(LAUNCHER_EXE_NAME, Buffer.from('MZlauncher'));
  write(EXE_REL, 'desktop');
  write(ASAR_REL, 'asar');
  write(BUNDLED_RUNTIME_MANIFEST_REL, '{}');
  write(
    README_NAME,
    `\u53cc\u51fb ${LAUNCHER_EXE_NAME}\u3002\u6570\u636e\u4fdd\u5b58\u5728 ${RUN_DATA_DIR_NAME}\u3002\u8bf7\u4fdd\u6301\u76d8\u7b26\u4e0d\u53d8\u3002`,
  );

  if (overrides.noLauncher) fs.rmSync(path.join(root, LAUNCHER_EXE_NAME));
  if (overrides.bat) write(LAUNCHER_BAT_NAME, '@echo off');
  if (overrides.noRuntime) fs.rmSync(path.join(root, BUNDLED_RUNTIME_MANIFEST_REL));
  if (overrides.installer) write(`${INSTALLER_DIR_PREFIX}/setup.exe`, 'installer');
  if (overrides.launcherInsideProgram) write(path.join(APP_DIR_NAME, LAUNCHER_EXE_NAME), 'wrong-place');
  if (overrides.prepopulated) {
    write(path.join(RUN_DATA_DIR_NAME, 'state.json'), '{}');
    write(path.join(WORKSPACE_DIR_NAME, 'task.txt'), 'task');
    write(path.join(UPDATE_DIR_NAME, 'update-state.json'), '{}');
  }
  return root;
}

const ids = (findings) => findings.map((finding) => finding.id);
const errors = (findings) => findings.filter((finding) => finding.level === 'error');

test('clean launcher-enabled delivery satisfies the exact base-package contract', () => {
  const root = makeDelivery();

  assert.deepEqual(auditDelivery(io, root), []);
});

test('missing root launcher is a release-blocking error', () => {
  const root = makeDelivery({ noLauncher: true });

  assert.ok(ids(auditDelivery(io, root)).includes('missing-launcher'));
});

test('any batch launcher is a release-blocking error', () => {
  const root = makeDelivery({ bat: true });
  const finding = auditDelivery(io, root).find((entry) => entry.id === 'launcher-bat');

  assert.equal(finding?.level, 'error');
});

test('a vendored npm payload may carry its own .bat helpers', () => {
  const root = makeDelivery();
  const npmBatch = path.join(
    root,
    APP_DIR_NAME,
    'resources',
    'runtime',
    'node',
    'node_modules',
    'npm',
    'node_modules',
    'node-gyp',
    'gyp',
    'gyp.bat',
  );
  fs.mkdirSync(path.dirname(npmBatch), { recursive: true });
  fs.writeFileSync(npmBatch, '@echo off');

  assert.deepEqual(
    ids(auditDelivery(io, root)).filter((id) => id === 'launcher-bat'),
    [],
  );
});

test('the npm allowlist does not leak to sibling paths', () => {
  const root = makeDelivery();
  const sibling = path.join(
    root,
    APP_DIR_NAME,
    'resources',
    'runtime',
    'node',
    'node_modules',
    'npm-evil',
    'helper.bat',
  );
  fs.mkdirSync(path.dirname(sibling), { recursive: true });
  fs.writeFileSync(sibling, '@echo off');

  assert.ok(ids(auditDelivery(io, root)).includes('launcher-bat'));
});

test('the volume’s own unreadable System Volume Information is skipped', () => {
  // 真盘上必然有盘符自带的 `System Volume Information`，普通用户读它必然 EPERM。
  // 体检工具要能对真实 U 盘跑，不能因为一个读不了的系统目录直接崩掉。
  const root = makeDelivery();
  const blocked = path.join(root, 'System Volume Information');
  fs.mkdirSync(blocked);
  const readDir = (directory, options) => {
    if (directory === blocked) {
      const error = new Error('EPERM: operation not permitted');
      error.code = 'EPERM';
      throw error;
    }
    return fs.readdirSync(directory, options);
  };

  const names = walkTreeNames(root, readDir);

  assert.ok(names.includes(`${APP_DIR_NAME}/resources/app.asar`));
  assert.ok(!names.some((name) => name.startsWith('System Volume Information/')));
});

test('any other unreadable directory fails the audit instead of being hidden', () => {
  // 2026-10-19 自审：把**所有** EPERM 都静默跳过，等于把"读不到"当成"没问题"——
  // 交付包某个子目录读不动时，里面有什么没人知道，不能判"通过机检"。
  const root = makeDelivery();
  const blocked = path.join(root, APP_DIR_NAME, 'resources', 'locked');
  fs.mkdirSync(blocked, { recursive: true });
  const readDir = (directory, options) => {
    if (directory === blocked) {
      const error = new Error('EPERM: operation not permitted');
      error.code = 'EPERM';
      throw error;
    }
    return fs.readdirSync(directory, options);
  };

  assert.throws(() => walkTreeNames(root, readDir), /无法读取目录（EPERM）/u);
});

test('delivery CLI rejects a batch file nested inside the program tree', () => {
  const root = makeDelivery();
  const nestedBatch = path.join(root, APP_DIR_NAME, 'resources', 'legacy.bat');
  fs.writeFileSync(nestedBatch, '@echo off');

  const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'udisk-delivery.mjs'), root], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /legacy\.bat/);
});

test('missing bundled runtime is a release-blocking error', () => {
  const root = makeDelivery({ noRuntime: true });

  assert.ok(ids(auditDelivery(io, root)).includes('missing-bundled-runtime'));
});

test('installer content is rejected instead of being downgraded to a warning', () => {
  const root = makeDelivery({ installer: true });
  const finding = auditDelivery(io, root).find((entry) => entry.id === 'installer-folder');

  assert.equal(finding?.level, 'error');
});

test('a loose installer cannot coexist with the portable launcher', () => {
  const root = makeDelivery();
  fs.writeFileSync(path.join(root, 'setup-1.0.4-win-x64.exe'), 'installer');

  assert.ok(ids(auditDelivery(io, root)).includes('extra-root-executable'));
});

test('legacy runtime data cannot be included in a clean portable delivery', () => {
  const root = makeDelivery();
  fs.mkdirSync(path.join(root, 'runtime', 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime', 'workspace', '.clawwork.db'), 'private-history');

  assert.ok(ids(auditDelivery(io, root)).includes('prepopulated-legacy-runtime'));
});

test('a launcher inside the replaceable program directory is rejected', () => {
  const root = makeDelivery({ launcherInsideProgram: true });

  assert.ok(ids(auditDelivery(io, root)).includes('launcher-inside-program'));
});

test('pre-populated data, workspace, and update directories are rejected', () => {
  const root = makeDelivery({ prepopulated: true });
  const findings = auditDelivery(io, root);

  assert.ok(ids(findings).includes('prepopulated-data'));
  assert.ok(ids(findings).includes('prepopulated-workspace'));
  assert.ok(ids(findings).includes('prepopulated-update'));
  assert.equal(errors(findings).length, 3);
});

test('assemble CLI copies only launcher, program, and instructions into an empty output', () => {
  const source = makeDelivery();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-assembled-'));
  roots.push(out);
  const result = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'scripts', 'assemble-udisk-delivery.mjs'),
      '--app-dir',
      path.join(source, APP_DIR_NAME),
      '--launcher',
      path.join(source, LAUNCHER_EXE_NAME),
      '--out',
      out,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(fs.readdirSync(out).sort(), [APP_DIR_NAME, LAUNCHER_EXE_NAME, README_NAME].sort());
  assert.equal(fs.existsSync(path.join(out, RUN_DATA_DIR_NAME)), false);
  assert.equal(fs.existsSync(path.join(out, WORKSPACE_DIR_NAME)), false);
  assert.equal(fs.existsSync(path.join(out, UPDATE_DIR_NAME)), false);
  assert.deepEqual(auditDelivery(io, out), []);

  // ⭐ 交付说明是**逐字节**抄模板的（组装期读模板、不进 app.asar）——
  //    所以"改说明书"只需要改 `scripts/templates/udisk-readme.txt` 一个地方。
  //    这条断言把那份便利钉住：哪天有人在组装时加工/改写过它（换行、替换、加页脚），
  //    这里会红，而不是等客户手上的说明和仓库里的模板悄悄不一样。
  assert.deepEqual(
    fs.readFileSync(path.join(out, README_NAME)),
    fs.readFileSync(README_TEMPLATE),
    '使用说明.txt 必须是模板的逐字节副本',
  );
});

/**
 * 交付说明里那几条**只有在真机踩过才知道要写**的告知，以及**唯一会漂的那个数字**。
 * 说明本身是纯文本、不参与编译，改错了没有任何门禁会拦 —— 只能靠这里。
 */
test('delivery instructions carry the filesystem requirement and the no-nesting rule', () => {
  // ⚠️ 判据必须**连着那件事的措辞**，不能只查词在不在。
  //    第一版写的是 `assert.match(readme, /exFAT/)` —— 变异验证当场戳穿：
  //    把要求那一整行删掉，测试**照样绿**，因为另一行里也有 `exFAT`。
  //    ⇒ 查的是"这个词在文件里出现过"，不是"这条要求还写着"。同
  //      [[stale-green-tests]] 那一族：标签+数字要精确串。
  //
  // 盘格式：FAT32 上程序**能启动**、助手**全失败**（`dev=0` 拿不到文件身份）。
  // ⭐ 2026-09-27 修正：原来说"exFAT 或 NTFS 都行"是**错的**。
  //    那条结论来自 `probeWorkspaceFsIdentity`，而它**只建文件 + lstat 读 dev/ino**、
  //    **从来没真写过一个文件** —— 把"dev≠0"这个**代理指标**当成了"可用"。
  //    实测（58.6GB exFAT、128KB 簇）：用随包运行时那份 `@openclaw/fs-safe` 真写，
  //    新文件 / 覆盖 / 建子目录**三个全部失败**，底层是 `inspect opened path failed with
  //    Windows error 87`；同一序列在 NTFS 上三个全过。
  //    ⇒ 现在只承诺 NTFS。同 [[grep-presence-is-not-state]]：读到的不是状态。
  assert.match(readme, /格式化成\s*NTFS/, '必须写明"格式化成 NTFS"（唯一验证过可用的）');
  assert.match(readme, /FAT32\s*不支持/, '必须点名 FAT32 不支持');
  assert.match(readme, /exFAT[^\n]*改用\s*NTFS/, '必须把 exFAT 明确导向 NTFS，不能含糊');
  assert.match(readme, /先[^\n]*备份/, '格式会清空盘 ⇒ 必须提醒先备份');

  // ⭐ 反向守卫：**不许**再把 exFAT 说成可用。
  //    这条是为了防止"照着旧结论顺手改回去"——旧结论有测试注释与记忆为它背书，
  //    不动它就会再犯一次。要恢复 exFAT 的说法，必须先有一份**真写成功**的证据。
  assert.doesNotMatch(
    readme,
    /必须使用\s*exFAT|exFAT\s*或\s*NTFS\s*格式的\s*U\s*盘|exFAT\s*可用|exFAT\s*\/\s*NTFS\s*都/,
    '说明书里不许再出现"exFAT 可以"这类说法 —— 实测它是写不进工作区的（见上）',
  );

  // 放置位置：决定了它到底算不算"盘上运行"。
  assert.match(readme, /解压到\s*U\s*盘根目录/, '必须说清解压到盘根');
  assert.match(readme, /不要先解压到电脑桌面/, '必须挡住"先解压到桌面再拷进来"这条路');
});

test('⭐ 说明里写的层数与代码里的 MAX_DELIVERY_DEPTH 是同一个数', () => {
  const declared = portableSource.match(/MAX_DELIVERY_DEPTH\s*=\s*(\d+)/);
  assert.ok(declared, 'portable.ts 里找不到 MAX_DELIVERY_DEPTH —— 判据搬走了，这个测试要重写');

  const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 };
  const stated = readme.match(/盘根下超过([一二两三四五])层/);
  assert.ok(stated, '说明里没写"盘根下超过 N 层"—— 用户不知道能套几层');

  assert.equal(
    CN[stated[1]],
    Number(declared[1]),
    `说明说"超过${stated[1]}层"，代码是 ${declared[1]} 层 —— 照说明解压会被判成非盘上运行`,
  );
});

test('交付说明是纯文本：不该出现 Markdown 标记', () => {
  // 这份文件原样落到用户盘上，`**粗体**` 不会渲染，只会显示成一串星号。
  assert.doesNotMatch(readme, /\*\*/, '使用说明.txt 是纯文本，别写 Markdown 粗体');
  assert.doesNotMatch(readme, /^\s*#{1,6}\s/m, '使用说明.txt 是纯文本，别写 Markdown 标题');
  assert.doesNotMatch(readme, /\[[^\]]+\]\([^)]+\)/, '使用说明.txt 是纯文本，别写 Markdown 链接');
});

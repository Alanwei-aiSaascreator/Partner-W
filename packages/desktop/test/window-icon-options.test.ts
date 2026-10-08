import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = ts.createSourceFile(
  'index.ts',
  readFileSync(join(projectDir, 'src/main/index.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function windowOptions(isDev: boolean): { icon?: string } {
  const createWindow = source.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'createWindow',
  );
  let optionsSource = '';
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'BrowserWindow') {
      optionsSource = node.arguments?.[0]?.getText(source) ?? '';
    }
    ts.forEachChild(node, visit);
  }
  if (createWindow) visit(createWindow);
  expect(optionsSource).not.toBe('');
  // 2026-10-07（BUG-031 尾巴）：源码已从裸 `__dirname` 改为 `import.meta.dirname`（打包产物
  // ESM 无 CJS shim）。vm 沙箱（非模块上下文）语法层不支持 `import.meta`——替换回下面注入的
  // `__dirname`（同一语义：out/main 目录）后再执行，断言与期望值不变。
  const executableSource = optionsSource.replaceAll('import.meta.dirname', '__dirname');
  return runInNewContext(`(${executableSource})`, {
    is: { dev: isDev },
    join,
    __dirname: join(projectDir, 'out/main'),
    process: { resourcesPath: join(projectDir, 'packaged/resources') },
    readConfig: () => ({ theme: 'dark' }),
    nativeTheme: { shouldUseDarkColors: true },
  }) as { icon?: string };
}

function taskbarAppId(portableReason: string | null, portableTarget: string | null): string {
  let expression = '';
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'electronApp.setAppUserModelId') {
      expression = node.arguments[0]?.getText(source) ?? '';
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(expression).not.toBe('');
  return runInNewContext(expression, { portableAppData: { reason: portableReason, target: portableTarget } }) as string;
}

describe('main window icon', () => {
  it('loads the bundled brand icon explicitly in packaged builds', () => {
    expect(windowOptions(false).icon).toBe(join(projectDir, 'packaged/resources/icon.png'));
  });

  it('loads the build brand icon explicitly during development', () => {
    expect(windowOptions(true).icon).toBe(join(projectDir, 'build/icon.png'));
  });

  it('does not group portable windows with an installed shortcut carrying the old icon', () => {
    expect(taskbarAppId('delivery-layout', 'E:\\data')).toBe('com.mofangluopan.app.portable');
    expect(taskbarAppId(null, null)).toBe('com.mofangluopan.app');
  });

  it('keeps portable taskbar identity when userData is already redirected or the drive changes', () => {
    expect(taskbarAppId('workspace-marker', null)).toBe('com.mofangluopan.app.portable');
    expect(taskbarAppId('delivery-layout', 'F:\\data')).toBe(taskbarAppId('delivery-layout', 'E:\\data'));
  });
});

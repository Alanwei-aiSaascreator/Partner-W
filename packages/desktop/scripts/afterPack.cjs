const { execSync } = require('child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { scanBundlePath } = require('./bundle-secrets.cjs');

function sign(run, targetPath, entitlements) {
  const entitlementsArg = entitlements ? ` --entitlements "${entitlements}"` : '';
  run(`codesign --sign - --force${entitlementsArg} "${targetPath}"`, {
    stdio: 'inherit',
  });
}

async function adHocSignApp(context, run = execSync, exists = existsSync) {
  if (context.electronPlatformName !== 'darwin') return;
  if (context.appOutDir.endsWith('-temp')) return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  const entitlements = path.join(__dirname, '..', 'build', 'entitlements.mac.plist');

  const nestedTargets = [
    'Electron Framework.framework/Versions/A/Libraries/libEGL.dylib',
    'Electron Framework.framework/Versions/A/Libraries/libGLESv2.dylib',
    'Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib',
    'Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib',
    'Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
    'Electron Framework.framework',
    'Mantle.framework',
    'ReactiveObjC.framework',
    'Squirrel.framework',
    `${context.packager.appInfo.productFilename} Helper.app`,
    `${context.packager.appInfo.productFilename} Helper (GPU).app`,
    `${context.packager.appInfo.productFilename} Helper (Plugin).app`,
    `${context.packager.appInfo.productFilename} Helper (Renderer).app`,
  ].map((entry) => path.join(frameworksDir, entry));

  for (const targetPath of nestedTargets) {
    if (exists(targetPath)) {
      sign(run, targetPath);
    }
  }

  sign(run, appPath, entitlements);
}

/**
 * 打包后立刻扫一遍产物里有没有**不该随包的密钥** —— 跨平台都跑，扫到就让构建失败。
 *
 * 为什么放在这里：这种事一旦发出去就收不回（隔壁同类产品就是把真模型钥匙随包发的，
 * 更新只换 asar、config 不动 ⇒ 钥匙永远换不掉）。构建期拦下来是唯一便宜的时机。
 * 扫的是 `resources/app.asar`（内容是原样存的，直接当文本扫）；允许 anon key。
 */
async function checkBundledSecrets(context, scan = scanBundlePath) {
  const resourcesDir = path.join(context.appOutDir, 'resources');
  const asar = path.join(resourcesDir, 'app.asar');
  const target = existsSync(asar) ? asar : resourcesDir;
  const findings = scan(target);
  if (findings.length > 0) {
    const lines = findings.map((f) => `  · [${f.rule}] ${f.detail}  ${f.file}\n    样例: ${f.sample}`).join('\n');
    throw new Error(`[bundle-secrets] 产物里有不该随包的密钥（随包只许 anon key）：\n${lines}`);
  }
  return findings.length;
}

async function afterPack(context) {
  await checkBundledSecrets(context);
  await adHocSignApp(context);
}

exports.adHocSignApp = adHocSignApp;
exports.checkBundledSecrets = checkBundledSecrets;
exports.default = afterPack;

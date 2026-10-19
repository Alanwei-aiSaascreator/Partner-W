if (process.argv.includes('--repair')) {
  // 修复模式（FEAT-03）：**不 import `./index.js`** —— 那条链会拉起网关、数据库、
  // 商业通道，正是 SPEC 一「不启动网关、不走正常首启链」要排除的。
  // 同一个二进制、同一个安装包，差别只在命令行开关（不新增 400MB 实体）。
  //
  // ⚠️ 必须**动态** import（与下面两条分支同款）：`entry.ts` 会被测试直接 import，
  //    顶层静态拉进 `repair/main.js` 就要求那些测试的 electron mock 里也有
  //    `BrowserWindow` / `ipcMain` / `dialog` / `shell` —— 实测打挂了
  //    `slidegen-command-entry.test.ts` 的两条用例（mock 只给了 app/session）。
  //    动态 import 同时满足"非 `--repair` 路径不把修复模式的 electron 依赖拖进启动链"。
  const repair = await import('./repair/main.js');
  repair.runRepairMode().catch(repair.reportRepairModeFailure);
} else if (process.argv.includes('--royin-render-slidegen') || process.argv.includes('--royin-render-native-ppt')) {
  await import('./slidegen/render-command.js');
} else {
  await import('./index.js');
}

export {};

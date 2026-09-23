/**
 * `beforePack` 的**组合钩子**：electron-builder 只接受一个 `beforePack`，而打包前的
 * 硬门禁有两道 —— 这里只做组合，**判定逻辑全在各自那一个文件里**，本文件不复制任何规则。
 *
 *   1. `require-bundled-runtime.cjs` —— 随包运行时在不在（缺了干净机器上起不来）；
 *   2. `require-update-public-key.cjs` —— 内嵌更新公钥在不在（缺了盘上永远检查不到更新，
 *      而且报的还是 signature-invalid）。
 *
 * 顺序有讲究：运行时门禁读的是配置里的 `extraResources` 源，最便宜；
 * 公钥门禁要读 `out/main/index.js`（可能几十 MB）。两道都失败时先报运行时那条更有信息量。
 */
'use strict';

const runtimeGate = require('./require-bundled-runtime.cjs');
const publicKeyGate = require('./require-update-public-key.cjs');

async function beforePack(context) {
  await runtimeGate.beforePack(context);
  await publicKeyGate.beforePack(context);
}

exports.beforePack = beforePack;
exports.default = beforePack;

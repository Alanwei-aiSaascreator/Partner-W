/**
 * 打包垫片：补回 `readable-stream@3` 丢掉的根级入口 `passthrough`。
 *
 * ## 为什么需要它（2026-09-25 实测，不是推测）
 *
 * 链路：`exceljs` → `archiver` → `archiver-utils` → **`lazystream`** →
 * `require('readable-stream/passthrough')`（在 `lazystream/lib/lazystream.js` **顶层**，
 * 所以 `require('exceljs')` 当场就炸，不是等到写文件才炸）。
 *
 *  - `lazystream@1.0.1` 的依赖是 `readable-stream@^2`，v2 **有**根级 `passthrough.js`
 *    （原文就是下面这一行）；v3 把它删了 —— 上游 tarball 实测根级只有
 *    `errors*.js` / `experimentalWarning.js` / `readable*.js`（`curl` 下 npm 上的
 *    `readable-stream-3.6.2.tgz` 逐文件看过）。
 *  - 开发树里没事：pnpm 把 `lazystream` 自己的 `readable-stream@2.3.8` 放在它旁边。
 *  - **打包后就出事**：electron-builder 把 pnpm 的树**压平**，`lazystream` 旁边那份 v2
 *    没了（实测 asar 里 `/node_modules/lazystream/` 只有 4 个文件、没有嵌套 `node_modules`），
 *    于是它向上解析到**顶层那份 v3** ⇒ `MODULE_NOT_FOUND`。
 *
 * 症状：打包态里 `require('exceljs')` 抛错 ⇒ **助手一个 .xlsx 都产不出来**，
 * 而开发态与单测全绿（它们走的是 pnpm 的树）。P2（Word/Excel）打包实测抓到的就是这个。
 *
 * ⚠️ 修法选择：不改依赖、不换库，只把 v2 的那个入口按**逐字相同**的内容补回去
 *    （`readable-stream@3` 仍然导得 `PassThrough`，实测 `Object.keys(require('readable-stream'))`
 *    里有它）。它在 asar 里的落点是 `node_modules/readable-stream/passthrough.js` —— 由
 *    `electron-builder.yml` 的 `files` 映射保证，`readable-stream-shim-packaging-gate.test.ts` 钉住。
 */
module.exports = require('./readable').PassThrough;

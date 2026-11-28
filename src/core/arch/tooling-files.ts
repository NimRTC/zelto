// 工具脚本识别（ADR-138）
//
// 架构扫描的核心前提：**模块归属判定的是这个项目的架构**。
// 而工具脚本（`tools/` `scripts/` 下的检查器、生成器、运维脚本）
// **不是架构的一部分** —— 它没有「依赖谁」「被谁依赖」，
// 它只是开发期用来操作这个项目的脚本。
//
// 真实项目里的证据（nimrtc-v14 靶子项目，2026-11-28）：
//
//   tools/check_engine_layering.py
//   scripts/api_freeze_scan.js
//   tools/check_unused_const.py
//   …共 91 个文件
//
// 它们不在任何设计模块的文件范围里（设计只声明 `src/**` 与 `examples/**`），
// 于是被报成「文件无归属」（`unmapped_file`，默认 deny）→ 门禁拦截。
//
// **而且是自锁**：任何一片要改工具脚本的切片，都会被
// 「这个工具脚本无归属」拦住 —— 而成因是**扫描器的归属模型覆盖不到
// 工具目录**，不是那片切片真的违反了架构。
//
// 与 ADR-066（测试文件）、ADR-065（vendor 代码）同一路子：
// **不是这个项目的架构的东西，就不是这个项目的架构偏离。**
//
// ── 为什么工具脚本反而比文档更容易被拦 ────────────────────────────────
//
// 一个不对称，是这个缺陷的真正来源：
//
//   README.md       → detectLang 返回 null → 不进扫描 → 从不被拦
//   CMakeLists.txt  → detectLang 返回 null → 不进扫描 → 从不被拦
//   tools/xxx.py    → detectLang 返回 python → 进扫描 → **被拦**
//
// 文档与构建脚本因为「扫描器读不懂」而天然躲过了归属判定，
// 而工具脚本恰好是 Python / JS —— **扫描器读得懂，于是它成了
// 唯一被拦的那一类**。这是实现细节的泄漏，不是设计。
//
// 判据必须是「**这个东西是不是架构的一部分**」，
// 而不是「**扫描器能不能读懂它**」。

/**
 * 工具脚本目录名（**顶层**目录名）。
 *
 * 只认仓库根下的这两个约定名 —— 见 `isToolingFile` 的说明。
 */
const TOOLING_DIR_NAMES = new Set(['tools', 'scripts']);

/**
 * 是不是工具脚本（相对项目根，正斜杠路径）。
 *
 * **只看第一段**：`tools/` `scripts/` 都在仓库根，是这个约定。
 *
 * 为什么不是「路径里任一段」：`src/engine/tools/` 这种嵌套位置
 * 不是「仓库的工具目录」，而是**某个模块内部的子目录** ——
 * 它理应被那个模块认领。把嵌套同名目录也排除，会让
 * 模块内部的文件悄悄失去归属检查。
 *
 * 为什么只看顶层、而不是「顶层或嵌套」都排除：同上 ——
 * 顶层那两个是**仓库级约定**（全仓库共享的开发工具），
 * 嵌套的那个是**模块自有目录**，性质不同。
 *
 * **不靠内容猜测**：看「这个文件是不是脚本」会误判 ——
 * `src/foo/scripts/run.py` 可能是真正的生产脚本；
 * 而且内容猜测会随文件演化而漂移（一个脚本加了 `import`
 * 就变得「像代码了」）。路径判定是确定性的（ADR-066 同一判据）。
 *
 * @param path 相对项目根的路径
 */
export function isToolingFile(path: string): boolean {
  const segments = path.split('/');
  // 第一段就是顶层目录名。路径为空或只有文件名时没有第一段 → 不是工具脚本。
  const top = segments[0];
  if (top === undefined) return false;
  return TOOLING_DIR_NAMES.has(top.toLowerCase());
}

/**
 * 一组路径里哪些是工具脚本。
 *
 * 单独暴露是为了让调用点把「哪些被排除」讲清楚 ——
 * 报告里要能说出「本项目有多少工具脚本不参与架构判定」。
 */
export function partitionToolingFiles(paths: string[]): {
  toolingFiles: string[];
  otherFiles: string[];
} {
  const toolingFiles: string[] = [];
  const otherFiles: string[] = [];
  for (const path of paths) {
    if (isToolingFile(path)) toolingFiles.push(path);
    else otherFiles.push(path);
  }
  return { toolingFiles, otherFiles };
}

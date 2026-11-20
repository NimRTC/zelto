// 依赖名解析 —— 把设计里写的依赖名落到真实模块上
//
// 设计文档里写的依赖名有两类：
//
//   1. **模块名**：`src/core` —— 设计里确实有这个模块
//   2. **路径**：`src/core/ports` —— 设计里没有这个模块，
//      但它指的是某个模块内部的一块（src/core 里的 ports 子目录）
//
// 第 2 类以前一律被报成「依赖指向不存在的模块」——
// 那是噪声，不是证据：设计写 `src/core/ports`，
// 实际意思是「依赖 src/core 这一片里的 ports 部分」。
//
// 解析规则（确定性，只读文件扫出来的归属结果）：
//
//   - 名字正好是某个模块            → 就是它
//   - 名字是路径，且该路径下的文件
//     全部只属于同一个模块          → 那个模块
//   - 路径下的文件分属多个模块      → 判不了，保留原名（由报告层报未知模块）
//   - 该路径下没有文件              → 保留原名
//
// 用「实际归属」而不是「名字猜」：一个模块叫 `core`，
// 它管的文件在 `lib/core/` 下，那么依赖写 `lib/core` 就该解析到它。
//
// C3: 纯计算，不调模型、不触网
// C6: core/ 内，不依赖 adapters/

import type { ModuleSpec, ScanResult } from './types.js';

/**
 * 模块名的**括号短名**。
 *
 * 设计里的模块名常写成「中文描述 (标识符)」：
 *
 *   `网络适配层 (ice)`
 *   `设备管理层 (device)`
 *   `参考实现 (examples)`
 *
 * 而**依赖模块**那一栏写的是短名（`ice` / `device` / `engine`）。
 * 于是依赖名与模块名对不上 —— 精确匹配一个都匹配不上，
 * 全被报成「未知模块」（实战 ZD-011）。
 *
 * 括号里那一段就是模块**自称的标识符**：作者把它放在括号里，
 * 就是为了让别处能用它指代这个模块。所以它必须能被依赖名匹配上。
 *
 * 认不出来的两种写法（不猜）：
 *   - 没有括号 → 没有短名
 *   - 括号里不是标识符形状（不是 `词` / `词-词`）→ 没有短名
 *
 * 形状：字母或数字开头，允许字母数字、`-`、`_`、`.`、`/`。
 *
 * **允许斜杠** —— 短名可能本身是路径（`plugins/hw`）：
 * 那是「某个目录下的子集」的写法，作者用它指代那一块。
 * 不允许斜杠的话这种写法一个都匹配不上 → 全被报成未知模块。
 */
export function moduleAliases(name: string): string[] {
  const match = name.match(/[（(]\s*([A-Za-z0-9][A-Za-z0-9._/-]*)\s*[）)]\s*$/);
  if (!match) return [];
  const alias = match[1];
  return alias === name ? [] : [alias];
}

/**
 * 解析一组依赖名。
 *
 * @returns 依赖名 → 模块名；解析不出来时值为 null（保持原样交给上层报错）
 */
export function resolveDependencyNames(
  dependencies: string[],
  modules: ModuleSpec[],
  scan: ScanResult,
): Map<string, string | null> {
  const moduleNames = new Set(modules.map((m) => m.name));

  // 短名 → 模块名。**一对一**：两个模块抢同一个短名时不算数
  // （那说明设计本身有歧义，不该由解析层替它选一个）。
  const aliasToModule = new Map<string, string>();
  const aliasConflicts = new Set<string>();
  for (const mod of modules) {
    for (const alias of moduleAliases(mod.name)) {
      if (aliasToModule.has(alias) && aliasToModule.get(alias) !== mod.name) {
        aliasConflicts.add(alias);
        continue;
      }
      aliasToModule.set(alias, mod.name);
    }
  }
  for (const alias of aliasConflicts) aliasToModule.delete(alias);

  const resolved = new Map<string, string | null>();

  for (const dep of dependencies) {
    if (moduleNames.has(dep)) {
      resolved.set(dep, dep);
      continue;
    }
    // 短名匹配 —— 必须在路径解析**之前**：
    // `ice` 既是某个模块的短名，也可能是条路径，
    // 但「作者给它起了这个短名」比「某个目录下正好有文件」更可信。
    const byAlias = aliasToModule.get(dep);
    if (byAlias) {
      resolved.set(dep, byAlias);
      continue;
    }
    resolved.set(dep, resolveByOwnership(dep, modules, scan));
  }

  return resolved;
}

/**
 * 按「路径下的文件归谁」来解析依赖名。
 *
 * 返回 null 表示判不出来。
 */
function resolveByOwnership(
  dep: string,
  modules: ModuleSpec[],
  scan: ScanResult,
): string | null {
  const prefix = `${dep.replace(/\/+$/, '')}/`;
  const owners = new Set<string>();

  for (const mod of modules) {
    for (const file of scan.moduleFiles.get(mod.name) ?? []) {
      if (file.startsWith(prefix)) owners.add(mod.name);
    }
  }

  // 文件分属多个模块 → 判不了
  if (owners.size !== 1) return null;
  return [...owners][0];
}

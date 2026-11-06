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
  const resolved = new Map<string, string | null>();

  for (const dep of dependencies) {
    if (moduleNames.has(dep)) {
      resolved.set(dep, dep);
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

// Path matching helpers — 写集重叠判定的单一实现
//
// C3: 纯字符串判定，确定性，不调模型、不触网
// C6: core/ 内，不依赖 adapters/
//
// 之前这份逻辑在 engine.ts / merge.ts / artifact.ts 里各抄了一份，
// 三处规则一旦漂移，准入、合并、工件冲突的结论就会互相打架。
// 现在统一收敛到这里。
//
// glob 语义本身不在这儿再抄一份：直接用 core/policy/engine.ts 的 matchPath。
// 那才是全代码库的判定基准（policy.yaml 的规则匹配用的是它），
// 写集匹配若另立一套，`src/**/*.ts` 在准入层与运行时层会得出不同结论
// （ADR-014 §4）。

import { matchPath } from '../policy/engine.js';

/**
 * glob 模式匹配（与 policy engine 的 matchPath 同规则）。
 *
 * 双星号后跟斜杠时匹配零层或多层目录；裸双星号匹配任意层级（含斜杠）；
 * 单星号匹配单层内的任意字符。
 */
export function pathMatches(filePath: string, pattern: string): boolean {
  return matchPath(pattern, filePath);
}

/**
 * 两个写集路径是否可能指向同一批文件。
 *
 * - 完全相同 → 重叠
 * - 目录前缀（`a/` 与 `a/b.ts`）→ 重叠
 * - 一方是 glob，另一方是具体路径 → 用 glob 匹配具体路径
 * - 双方都是 glob → 比较 `*` 之前的目录前缀
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;

  if (a.endsWith('/') && b.startsWith(a)) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;

  const hasGlobA = a.includes('*');
  const hasGlobB = b.includes('*');

  if (hasGlobA && !hasGlobB) return pathMatches(b, a);
  if (!hasGlobA && hasGlobB) return pathMatches(a, b);
  if (hasGlobA && hasGlobB) {
    const dirA = a.includes('/') ? a.slice(0, a.indexOf('*')) : '';
    const dirB = b.includes('/') ? b.slice(0, b.indexOf('*')) : '';
    if (dirA && dirB) {
      return dirA === dirB || dirA.startsWith(dirB) || dirB.startsWith(dirA);
    }
  }

  return false;
}

/**
 * 两个写集之间是否存在重叠。
 */
export function writeSetsOverlap(a: string[], b: string[]): boolean {
  for (const pa of a) {
    for (const pb of b) {
      if (pathsOverlap(pa, pb)) return true;
    }
  }
  return false;
}

/**
 * 某个具体文件是否落在写集内。
 *
 * 与 `pathsOverlap` 的区别：这里判断的是「这个确切路径是否被允许写」，
 * 而不是「两个写集是否可能指向同一批文件」。运行时强制（C9）用这个。
 *
 * 支持三种写法：
 * - glob：`src/**`、`docs/*.md`
 * - 目录前缀（带尾斜杠）：`src/core/`
 * - 裸目录：`src/core` → 视为 `src/core/` 前缀
 */
export function pathInWriteSet(filePath: string, writes: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  for (const raw of writes) {
    const pattern = raw.replace(/\\/g, '/');
    if (!pattern) continue;

    // glob 直接匹配
    if (pattern.includes('*') && pathMatches(normalized, pattern)) return true;

    // 目录前缀（含尾斜杠 / 裸目录）
    const dir = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (!dir.includes('*') && (normalized === dir || normalized.startsWith(`${dir}/`))) {
      return true;
    }
  }
  return false;
}

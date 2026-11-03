// Path matching helpers — 写集重叠判定的单一实现
//
// C3: 纯字符串判定，确定性，不调模型、不触网
// C6: core/ 内，不依赖 adapters/
//
// 之前这份逻辑在 engine.ts / merge.ts / artifact.ts 里各抄了一份，
// 三处规则一旦漂移，准入、合并、工件冲突的结论就会互相打架。
// 现在统一收敛到这里。

/**
 * glob 模式匹配（与 policy engine 的 matchPath 同规则）。
 *
 * `**` 匹配任意层级（含 `/`），`*` 匹配单层内任意字符。
 */
export function pathMatches(filePath: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DOUBLESTAR>>>/g, '.*');
  return new RegExp(`^${regexStr}$`).test(filePath);
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

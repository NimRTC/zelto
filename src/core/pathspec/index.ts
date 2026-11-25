// Path matching helpers — 路径匹配的单一实现（全代码库唯一落点）
//
// C3: 纯字符串判定，确定性，不调模型、不触网
// C2: core/ 内，不依赖 adapters/
//
// ── 为什么住在这里，而不是 sched/ ──
//
// 这份逻辑原先住在 `core/sched/paths.ts`。但它的使用者横跨：
//   gate（Executor / diagnostics）、lifecycle（门禁编排）、arch（架构护栏 / 扫描 / 报告）
// —— 其中 gate / arch **不依赖** sched。「路径怎么算」是三条线共用的基元，
// 被钉在 sched 下就会形成 arch → sched、gate → sched 这种「为了一个纯函数而
// 反向依赖调度器」的环。
//
// 现在落点是 `core/pathspec/`：它**不 import core 内任何其它模块**，
// sched（准入、合并冲突、运行后审计）与 gate / arch 一样向下依赖它。
// glob 语义本身不在这里再抄一份：直接复用 `core/policy/engine.ts` 的 `matchPath`
// —— 那才是全代码库的判定基准（policy.yaml 的规则匹配用的是它）。
// 写集匹配若另立一套，`src/**/*.ts` 在准入层与运行时层会得出不同结论（ADR-014 §4）。

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
 * - 一方是 glob，另一方是具体路径 → 试 glob 匹配具体路径
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

// ─── ADR-107：共享「只追加文档」不算硬冲突 ─────────────────────────────────

/**
 * 是否是「可并行的共享文档」路径（ADR-107 §3.1）。
 *
 * 判据（三条都要满足）：
 * 1. **具体** markdown 文件 —— 不含 glob、不含目录形态；
 * 2. 落在 `docs/` 下，或根级的 `.md`；
 * 3. 不是 `specs/` 下的 —— 规格副本归 ADR-046 / ADR-106 管，
 *    两片改同一份规格是**真冲突**（ADR-107 §3.2）。
 *
 * 为什么 glob 形态不算：一片声称「双星号 + .md」或「docs + 双星号」，
 * 是在声称**整片文档面**，不是「往这一个文件里追加一节」。
 * 那样的两片并行写就是两个 agent 同时改一片文档 —— 真冲突。
 *
 * C3: 纯字符串判定，确定性。
 */
export function isAppendOnlyDocPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized) return false;

  // 形态门槛：具体文件，不含 glob、不带目录前缀/尾斜杠。
  if (normalized.includes('*')) return false;
  if (normalized.endsWith('/')) return false;

  // 必须是 markdown。
  if (!normalized.toLowerCase().endsWith('.md')) return false;

  // 规格副本排除（ADR-046 / ADR-106）。
  if (normalized.startsWith('specs/')) return false;

  // 文档面：docs/ 下的，或根级 md。
  return normalized.startsWith('docs/') || !normalized.includes('/');
}

/**
 * 两个写集之间的冲突，区分硬与软（ADR-107 §3）。
 *
 * - **硬冲突**：共享同一份**代码**路径 —— 两片会同时改同一个源文件。
 *   拦住。
 * - **软冲突**：共享同一份**只追加文档**路径（`isAppendOnlyDocPath`）——
 *   报出来，但**不拦**。文档是追加式的，两片各写各的一节，
 *   真撞上了也是 git 合并期可见的冲突，不是代码被静默写坏。
 *
 * 与 `writeSetsOverlap` 的关系：`writeSetsOverlap` 保持原语
 * （「可能指向同一批文件」，严格），给需要严格口径的调用方用。
 * 这里给出的是**冲突判定**口径。
 */
export function writeSetsConflict(
  a: string[],
  b: string[],
): { hard: string[]; soft: string[] } {
  const hard: string[] = [];
  const soft: string[] = [];

  for (const pa of a) {
    for (const pb of b) {
      if (!pathsOverlap(pa, pb)) continue;
      // 两个写集条目**都**是只追加文档时才判软 —— 一边是 glob 就不算。
      if (isAppendOnlyDocPath(pa) && isAppendOnlyDocPath(pb)) {
        if (!soft.includes(pa)) soft.push(pa);
      } else {
        if (!hard.includes(pa)) hard.push(pa);
      }
    }
  }

  return { hard, soft };
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

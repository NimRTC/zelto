// Cross-version conflict detection — 跨版本写集/工件冲突
//
// ADR-056 §3.6 / D5-B：两个版本同时 in_progress 时，检查它们的写集是否
// 碰到同一批文件。
//
// 为什么需要：现在的工件冲突检测（artifact.ts）只在**单批次内**跑。
// 两个版本是两个批次 —— v2 与 v3 各自跑各自的批次，跨批次的冲突没人比。
// 结果是「并行跑得顺利，合主干时才炸」。
//
// **这是规则引擎，不是语义分析**（ADR-056 §3.6 明确写了这条局限）：
// - 能挡住「两个版本都改 `types.ts`」
// - 挡不住「v2 改了 `types.ts` 里的字段含义，v3 按旧语义写消费者」
//
// 后者要到 ship 时的合并冲突、或版本级验收（集成缺口）才暴露。
// 所以调用方**必须**把结论如实告诉人，不能让人以为「跨版本也安全了」。
//
// D5-B：检出 error 级冲突时**提示但不阻断** —— 与 ADR-019 把「整批 abort」
// 改成「降级为串行」同一个思路：启发式判定不硬阻断。
// 另给 `--strict` 让想硬拦的人用。
//
// C3: 确定性 —— glob 匹配 + 内置工件映射 + 集合运算，不调模型、不触网
// C6: core/ 内，不依赖 adapters/

import { pathMatches, writeSetsOverlap } from './paths.js';
import { mapPathToArtifacts, type ArtifactMapping, type ConflictSeverity } from './artifact.js';

/**
 * 跨版本判定专属的工件映射（ADR-056 真实项目验证补的）。
 *
 * 为什么单列一张表，不进 `artifact.ts` 的 `BUILTIN_MAPPINGS`：
 *
 * 1. **同批次与跨版本的粒度要求不同**。同批次判定（ADR-012）按**工件名**分组 ——
 *    两个切片碰同一类工件就算冲突。那张表是给 TypeScript 工程写的，
 *    加进 C++ 规则会让「A 改 foo.hpp、B 改 bar.hpp」被判成 error，
 *    **误伤本可以并行的两个切片**。
 *
 * 2. **跨版本判定按路径**（见 `detectCrossVersionConflicts` 的说明）：
 *    只有「两个版本动同一个文件」才是冲突。工件类别只用来给这条**具体的**
 *    冲突定级。所以这里按**具体路径**分类，不需要粗粒度工件名。
 *
 * C++ 工程的头文件承担的是与 TS `types.ts` 同一件事 —— 对外暴露类型与接口。
 * 不认它，「两个版本都改同一个 `.hpp`」这种真冲突就落进「(路径重叠)」的
 * warning 级，被降级成了提示。
 */
export const CROSS_VERSION_MAPPINGS: ArtifactMapping[] = [
  // C/C++ 头文件 = 类型与接口定义
  { pattern: '**/*.hpp', artifact: 'cxx-header', category: 'type_definition' },
  { pattern: '**/*.hh', artifact: 'cxx-header', category: 'type_definition' },
  { pattern: '**/*.h', artifact: 'cxx-header', category: 'type_definition' },
  { pattern: '**/*.hxx', artifact: 'cxx-header', category: 'type_definition' },

  // C/C++ 源文件 = 实现
  { pattern: '**/*.cpp', artifact: 'cxx-source', category: 'api_contract' },
  { pattern: '**/*.cc', artifact: 'cxx-source', category: 'api_contract' },
  { pattern: '**/*.cxx', artifact: 'cxx-source', category: 'api_contract' },
];

/** 一个版本的写集信息 */
export interface VersionWriteSet {
  /** 版本 label */
  version: string;
  /** 该版本的写集（所有切片的写集并起来） */
  writes: string[];
}

/** 跨版本冲突 */
export interface CrossVersionConflict {
  /** 冲突涉及的工件名 */
  artifact: string;
  /** 工件类别 */
  category: ArtifactMapping['category'];
  /** 严重度 */
  severity: ConflictSeverity;
  /** 两个版本 */
  versionA: string;
  versionB: string;
  /** 具体重叠的写集路径 */
  paths: string[];
  /** 面向人的说明 */
  description: string;
}

/** 写集路径之间的重叠（返回具体的重叠路径，不只是布尔） */
export function overlappingPaths(a: string[], b: string[]): string[] {
  const result: string[] = [];
  for (const pa of a) {
    for (const pb of b) {
      if (pa === pb) {
        result.push(pa);
        continue;
      }
      // glob 与具体路径的重叠：具体路径落在 glob 里
      if (pa.includes('*') && !pb.includes('*')) {
        if (pathMatches(pb, pa)) result.push(pb);
        continue;
      }
      if (!pa.includes('*') && pb.includes('*')) {
        if (pathMatches(pa, pb)) result.push(pa);
        continue;
      }
      // 两边都是目录前缀
      if (pa.endsWith('/') && pb.startsWith(pa)) {
        result.push(pa);
        continue;
      }
      if (pb.endsWith('/') && pa.startsWith(pb)) {
        result.push(pb);
      }
    }
  }
  return [...new Set(result)].sort();
}

/**
 * 检测跨版本冲突。
 *
 * 算法：
 * 1. 两两比对版本的写集，找出路径重叠
 * 2. 把重叠路径映射到工件
 * 3. 按工件类别定严重度（复用 artifact.ts 的映射表）
 *
 * @param versions 待比对的版本写集
 * @param customMappings 可选的自定义工件映射
 */
export function detectCrossVersionConflicts(
  versions: VersionWriteSet[],
  customMappings?: ArtifactMapping[],
): CrossVersionConflict[] {
  const conflicts: CrossVersionConflict[] = [];
  const mappings = [...CROSS_VERSION_MAPPINGS, ...(customMappings ?? [])];

  for (let i = 0; i < versions.length; i++) {
    for (let j = i + 1; j < versions.length; j++) {
      const a = versions[i];
      const b = versions[j];

      const paths = overlappingPaths(a.writes, b.writes);
      if (paths.length === 0) continue;

      // 路径重叠 → 映射到工件 → 定级
      //
      // **按路径逐个映射**（不按工件名合并）：
      // 工件名是**粗粒度**的（`type-definitions` 指所有 `.hpp`）。
      // 若按工件名合并，两个版本改**不同**的头文件也会被并成一条
      // 「都动 type-definitions」—— 那不是冲突，是「碰巧同类」。
      //
      // 跨版本判定的依据是**同一批文件**：两个版本动同一个文件才是冲突。
      // 工件类别只用来给这条**具体的**冲突定级。
      const byPath = new Map<string, ArtifactMapping[]>();
      for (const p of paths) {
        const found = mapPathToArtifacts(p, mappings);
        if (found.length > 0) byPath.set(p, found);
      }

      // 一个都没映射到工件 —— 只有路径重叠，没有语义关联
      if (byPath.size === 0) {
        conflicts.push({
          artifact: '(路径重叠)',
          category: 'config',
          severity: 'warning',
          versionA: a.version,
          versionB: b.version,
          paths,
          description:
            `版本 "${a.version}" 与 "${b.version}" 写集重叠（${paths.join(', ')}）` +
            `—— 没有映射到已知工件，按路径重叠报`,
        });
        continue;
      }

      // 每个重叠路径单独出一条冲突，按该路径的工件类别定级
      for (const [p, pathMappings] of byPath) {
        for (const mapping of pathMappings) {
          conflicts.push({
            artifact: mapping.artifact,
            category: mapping.category,
            severity: severityForCategory(mapping.category),
            versionA: a.version,
            versionB: b.version,
            paths: [p],
            description:
              `版本 "${a.version}" 与 "${b.version}" 都动 "${mapping.artifact}"（${mapping.category}）` +
              `：${p}`,
          });
        }
      }
    }
  }

  conflicts.sort((x, y) => {
    const rank: Record<ConflictSeverity, number> = { error: 0, warning: 1, info: 2 };
    const diff = rank[x.severity] - rank[y.severity];
    if (diff !== 0) return diff;
    return x.description.localeCompare(y.description);
  });

  return conflicts;
}

/**
 * 工件类别 → 严重度。
 *
 * 与 `artifact.ts` 的 `severityForCategory` 同一口径 —— 两处判定必须一致，
 * 否则「同批次内报 error」而「跨版本报 warning」会让人困惑。
 */
function severityForCategory(category: ArtifactMapping['category']): ConflictSeverity {
  switch (category) {
    case 'type_definition':
    case 'api_contract':
      return 'error';
    case 'schema':
    case 'config':
      return 'warning';
    case 'test_fixture':
    case 'documentation':
      return 'info';
  }
}

/**
 * 写集之间是否重叠（跨版本判定的粗判据）。
 *
 * 与 `paths.ts` 的 `writeSetsOverlap` 同语义，但只返回布尔 ——
 * 这里的用途是「要不要做详细的工件分析」。
 */
export function versionsOverlap(a: string[], b: string[]): boolean {
  return writeSetsOverlap(a, b);
}

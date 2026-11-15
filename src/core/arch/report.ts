// 架构报告 —— 把「设计的模块图」和「实际的 import 图」摆在一起比
//
// 比出来的东西分五类：
// - 依赖指向不存在的模块     —— 设计写错了，或者模块被删了没改设计
// - 声明了但代码里没有       —— 依赖删了、或者压根没实现
// - 代码里有但设计里没写     —— 架构腐化的主要来源
// - 依赖无法用 import 验证   —— 目标模块没有源文件（契约 JSON、规格 md）
// - 实际依赖成环             —— 模块边界已经烂了
//
// ─── 层级模块的处理 ─────────────────────────────────────────────────────
// 设计文档里的模块常常是**层级**的：`src/core` 是组，`src/core/events` 是成员。
// 这时候「`src/core` 声明依赖 `src/core/events`」并不是一条 import 边——
// 那条边在图上叫 `src/core/audit→src/core/events`（谁 import 谁，取决于真实归属）。
// 按字面比对会报一堆假缺失。
//
// 所以判定用**包含关系**（scope containment）：
//   A 覆盖 B ⟺ B 拥有的每个文件都落在 A 的 glob 范围内
// 包含关系从**实际归属结果**算出来，不是从名字猜的。
//
//   声明边 A→B 被满足，当且仅当存在实际边 X→Y，其中
//     X ∈ scope(A)   （A 这一片里的谁 import 的）
//     Y ∈ scope(B)   （import 的是 B，或 B 的成员）
//
// ─── 依赖名的解析 ───────────────────────────────────────────────────────
// 设计里写的依赖名可能是模块名，也可能是路径（`src/core/ports`）。
// 路径先按「该路径下的文件归谁」解析到模块，解析不出来才报未知模块。
// 见 core/arch/resolve.ts。
//
// ─── 层级内部边 vs 跨模块边 ─────────────────────────────────────────────
// scope(A) 与 scope(B) 有交集的边是**内部边**——它只是组与成员的关系，
// 不是跨模块依赖。这类边：
//   - 不算「未声明依赖」（组依赖自己的成员是废话）
//   - 不参与成环判定（组 → 成员 → 组 是层级结构，不是环）
// 只有 scope 互不相交的边才是真正的跨模块依赖。
//
// 这一层**只报告、不拦**（G-4/B）：偏离是给人看的证据，不是判定。
// 要变成硬护栏是 G-4/A，要改 policy 契约，届时单独写 ADR。

import { pathMatches } from '../sched/paths.js';
import { normalizeModuleSpecs } from './normalize.js';
import { resolveDependencyNames } from './resolve.js';
import type {
  ArchitectureReport,
  Deviation,
  DeviationKind,
  ModuleEdge,
  ModuleSpec,
  ScanResult,
} from './types.js';

/**
 * 不影响「是否一致」结论的偏离类型。
 *
 * ADR-062 §4.4：`empty_module` 也是软偏离 ——
 * 模块声明了但一个文件都没匹配上，这是**设计侧的问题**
 * （文件路径写错了 / 目录还没建），不是代码违反了架构。
 * 硬拦会挡住「设计还没写完」的正常推进。
 */
const SOFT_DEVIATIONS = new Set<DeviationKind>(['unverifiable_dependency', 'empty_module']);

/**
 * 生成架构报告。
 */
export function buildArchitectureReport(
  rawModules: ModuleSpec[],
  scan: ScanResult,
): ArchitectureReport {
  const modules = normalizeModuleSpecs(rawModules);
  const moduleNames = modules.map((m) => m.name);
  const deviations: Deviation[] = [];

  // ─── 包含关系 ──────────────────────────────────────────────────────────
  // scope[a] = a 覆盖到的模块集合（含自己）
  const patternsOf = new Map(modules.map((m) => [m.name, m.filePatterns]));
  const filesOf = new Map(modules.map((m) => [m.name, scan.moduleFiles.get(m.name) ?? []]));
  const scope = new Map<string, Set<string>>();
  for (const a of moduleNames) {
    const covered = new Set<string>([a]);
    const aPatterns = patternsOf.get(a) ?? [];
    for (const b of moduleNames) {
      if (a === b) continue;
      const bFiles = filesOf.get(b) ?? [];
      if (bFiles.length === 0) continue;
      const allInside = bFiles.every((file) =>
        aPatterns.some((pattern) => pathMatches(file, pattern)),
      );
      if (allInside) covered.add(b);
    }
    scope.set(a, covered);
  }

  const scopeOf = (a: string): Set<string> => scope.get(a) ?? new Set([a]);

  /** 两个模块的 scope 是否有交集（有交集 = 同一切片内部，不是跨模块） */
  const sameSlice = (a: string, b: string): boolean => {
    const sa = scopeOf(a);
    for (const member of scopeOf(b)) {
      if (sa.has(member)) return true;
    }
    return false;
  };

  // ─── 设计里声明的依赖 ──────────────────────────────────────────────────
  // 依赖名先按「归属」解析（core/arch/resolve.ts）：设计里写路径
  // （`src/core/ports`）时，它指的是某个模块内部的一块。
  // 解析不出来才报「未知模块」。
  const allDeps = [...new Set(modules.flatMap((m) => m.dependencies))];
  const resolved = resolveDependencyNames(allDeps, modules, scan);

  const declaredPairs: Array<[string, string]> = [];
  for (const mod of modules) {
    for (const dep of mod.dependencies) {
      const target = resolved.get(dep) ?? dep;
      if (!moduleNames.includes(target)) {
        deviations.push({
          kind: 'unknown_module',
          from: mod.name,
          to: dep,
          detail: `依赖指向的模块 "${dep}" 在设计里不存在`,
        });
        continue;
      }
      declaredPairs.push([mod.name, target]);
    }
  }
  // 解析后可能有重复边（两个依赖名指向同一个模块），去重再比对。
  // 键用 JSON 编码，避免模块名里含分隔符时撞键。
  const uniqueDeclaredPairs = [
    ...new Map(declaredPairs.map((p) => [JSON.stringify(p), p])).values(),
  ];

  // ─── 代码里实际的依赖 ──────────────────────────────────────────────────
  const actualEdges = scan.edges;
  /** 跨模块边：scope 互不相交的那些 */
  const crossEdges = actualEdges.filter((e) => !sameSlice(e.from, e.to));

  /** 实际边 X→Y 是否落在声明边 A→B 的覆盖范围内 */
  const covers = (a: string, b: string, edge: ModuleEdge): boolean =>
    scopeOf(a).has(edge.from) && scopeOf(b).has(edge.to);

  // 声明了但代码里没有对应的实际边
  for (const [from, to] of uniqueDeclaredPairs) {
    const hit = actualEdges.some((edge) => covers(from, to, edge));
    if (hit) continue;

    const targetHasCode = (scan.moduleCodeFiles.get(to) ?? []).length > 0;
    // 「目标模块有代码」不等于「这条依赖能用 import 图表达」。
    //
    // 扫描器只认 TS/JS 与 Python。C++ 项目里模块依赖靠 #include，
    // 扫不到；如果目标模块里恰好混着几个扫描器认得的脚本
    // （比如 third_party 里的 googletest Python 测试），
    // 就会被判成 missing_dependency（硬偏离，deny）——
    // 实际上「代码里没有对应的 import」只是扫描器的盲区，
    // 不是架构问题。
    //
    // 判据：目标模块的**代码**里，扫描器**读得懂**的比例够高吗？
    // 比例低 → 这条依赖本来就不可能体现在 import 图里 →
    // 降为 unverifiable_dependency（软偏离，永不拦）。
    //
    // ADR-061：分母是**代码文件数**，不是全部文件数。
    //
    // 原来的分母是 `moduleFiles`（全部文件，含文档/配置/构建脚本）。
    // 一个模块里 80% 的文件是 README 和 CMakeLists.txt 时，
    // 那个比例反映的是「文档多」，不是「代码读不懂」——
    // 用它判断会把「代码读得懂」判成「读不懂」，
    // 于是本该拦的 missing_dependency 被降级成软偏离。
    const codeFiles = (scan.moduleCodeFiles.get(to) ?? []).length;
    const verifiedFiles = (scan.moduleVerifiedFiles.get(to) ?? []).length;
    // 没有代码文件 → 不是「读不懂」，是「没有代码可读」→ 不可验证
    const readableRatio = codeFiles > 0 ? verifiedFiles / codeFiles : 0;
    const scannable = readableRatio >= 0.5;

    deviations.push({
      kind: targetHasCode && scannable ? 'missing_dependency' : 'unverifiable_dependency',
      from,
      to,
      detail: describeUnverifiable(targetHasCode, scannable, codeFiles, verifiedFiles),
    });
  }

  // 代码里有但设计里没写（只看跨模块边：组依赖自己的成员不算偏离）
  for (const edge of crossEdges) {
    const covered = uniqueDeclaredPairs.some(([a, b]) => covers(a, b, edge));
    if (covered) continue;
    deviations.push({
      kind: 'undeclared_dependency',
      from: edge.from,
      to: edge.to,
      detail:
        `代码里存在这条 import（${edge.files.slice(0, 3).join(', ')}${edge.files.length > 3 ? ' …' : ''}），设计里没声明`,
    });
  }

  // 一个文件被多个模块认领
  for (const file of scan.files) {
    if (file.ambiguousWith.length === 0) continue;
    deviations.push({
      kind: 'ambiguous_module',
      from: file.module ?? '(none)',
      to: file.ambiguousWith.join(', '),
      detail: `文件 "${file.path}" 同时落在多个模块的负责范围里`,
    });
  }

  // 没有模块认领的文件
  for (const path of scan.unmapped) {
    deviations.push({
      kind: 'unmapped_file',
      from: '(none)',
      to: path,
      detail: `文件 "${path}" 不在任何模块的负责范围里`,
    });
  }

  // ─── 实际依赖里的环 ────────────────────────────────────────────────────
  // 只在跨模块边上找环：组 → 成员 → 组 是层级结构，不是环
  const cycles = findCycles(crossEdges);
  for (const cycle of cycles) {
    deviations.push({
      kind: 'cycle',
      from: cycle[0],
      to: cycle.join(' → '),
      detail: `实际依赖成环：${cycle.join(' → ')}`,
    });
  }

  // ─── 每个模块的概况 ────────────────────────────────────────────────────
  const moduleSummaries = modules.map((mod) => ({
    name: mod.name,
    fileCount: (scan.moduleFiles.get(mod.name) ?? []).length,
    // ADR-061：`codeFileCount` 数**所有**代码文件（不限语言），
    // `verifiedFileCount` 数扫描器读得懂的。
    //
    // 原来只有一个字段，装的是「扫描器读得懂的文件」——
    // 于是 C++ 模块在报告里显示「0 源码」。`.cpp` 就是源码，
    // 只不过扫描器读不懂它的依赖语义。这两件事不能混。
    codeFileCount: (scan.moduleCodeFiles.get(mod.name) ?? []).length,
    verifiedFileCount: (scan.moduleVerifiedFiles.get(mod.name) ?? []).length,
    declaredDeps: [
      ...new Set(
        mod.dependencies
          .map((d) => resolved.get(d) ?? d)
          .filter((d) => moduleNames.includes(d)),
      ),
    ],
    // 实际依赖只看跨模块边：组依赖自己的成员不算对外依赖
    actualDeps: crossEdges
      .filter((e) => e.from === mod.name)
      .map((e) => e.to)
      .sort(),
  }));

  // ─── 模块声明了但一个文件都没匹配上（ADR-062 §4.4）─────────────────────
  //
  // 真实项目里踩到的：设计声明 `src/dtls`，代码实际在 `src/modules/dtls/`。
  // 于是 `src/dtls` 匹配到 0 个文件，报告里显示「src/dtls  0 个文件」——
  // 看着像个正常的空模块，实际是**设计里的路径写错了**。
  //
  // 不报出来的话，这个错误会一路飘到「依赖无法验证」里，
  // 人看到的是「src/dtls 验不了」，而真相是「src/dtls 根本不存在」。
  for (const mod of modules) {
    const owned = (scan.moduleFiles.get(mod.name) ?? []).length;
    if (owned > 0) continue;
    deviations.push({
      kind: 'empty_module',
      from: mod.name,
      to: mod.name,
      detail: `模块 "${mod.name}" 声明了文件路径，但一个文件都没匹配上（${mod.filePatterns.join('、') || '没有声明路径'}）—— 路径写错了，或目录还不存在`,
    });
  }

  return {
    modules: moduleSummaries,
    declaredEdges: declaredPairs.map(([a, b]) => edgeKey(a, b)).sort(),
    actualEdges: crossEdges.map((e) => edgeKey(e.from, e.to)).sort(),
    deviations,
    cycles,
    coverage: scan.coverage,
    // 「一致」= 没有任何硬偏离。软偏离（无法用 import 验证）不算不一致。
    ok: !deviations.some((d) => !SOFT_DEVIATIONS.has(d.kind)),
  };
}

/**
 * 不可验证时的说明文案。
 *
 * ADR-061：原来只有一句话 ——「目标模块没有源文件（契约 / 规格一类），
 * 无法用 import 验证」。但触发这条的原因有**三种**，排查方向完全不同：
 *
 *   1. 目标模块**根本没有代码** —— 契约/规格一类，确实无从验证
 *   2. 目标模块**有代码，但扫描器读不懂** —— C++ / Go / Rust 项目
 *      （`#include` / `use` 的语义还没实现）
 *   3. 目标模块**有代码，也读得懂**，但读懂的比例低于 0.5
 *
 * 把三种混成一句话，等于让人对着错误的方向排查 ——
 * 看到「没有源文件」会去找「是不是漏写了」，而真相是「语言不支持」。
 */
function describeUnverifiable(
  targetHasCode: boolean,
  scannable: boolean,
  codeFiles: number,
  verifiedFiles: number,
): string {
  if (targetHasCode && scannable) {
    return '设计声明了依赖，代码里没有对应的 import';
  }
  if (!targetHasCode) {
    return '目标模块没有代码文件（契约 / 规格一类），无法用 import 验证';
  }
  if (verifiedFiles === 0) {
    return `目标模块有 ${codeFiles} 个代码文件，但扫描器读不懂它们（暂只支持 TypeScript / JavaScript 与 Python），无法用 import 验证`;
  }
  return `目标模块的 ${codeFiles} 个代码文件里只有 ${verifiedFiles} 个是扫描器读得懂的，未达到 0.5 的可读比例，无法用 import 验证`;
}

/**
 * 在实际依赖图里找环。
 *
 * DFS 三色标记，返回所有找到的环（按起点字典序，结果确定）。
 */
export function findCycles(edges: ModuleEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  for (const list of adjacency.values()) list.sort();

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, number>(); // 0=未访问 1=在栈上 2=已完成
  const stack: string[] = [];

  const visit = (node: string): void => {
    state.set(node, 1);
    stack.push(node);

    for (const next of adjacency.get(node) ?? []) {
      const nextState = state.get(next) ?? 0;
      if (nextState === 0) {
        visit(next);
      } else if (nextState === 1) {
        // 找到环：从栈上 next 的位置截出来
        const start = stack.indexOf(next);
        const cycle = stack.slice(start);
        const key = canonicalCycleKey(cycle);
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      }
    }

    stack.pop();
    state.set(node, 2);
  };

  for (const node of [...adjacency.keys()].sort()) {
    if ((state.get(node) ?? 0) === 0) visit(node);
  }

  return cycles;
}

/** 环的规范键：把环按最小节点旋转后拼起来，用于去重 */
function canonicalCycleKey(cycle: string[]): string {
  if (cycle.length === 0) return '';
  let minIndex = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIndex]) minIndex = i;
  }
  const rotated = [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
  return rotated.join('→');
}

function edgeKey(from: string, to: string): string {
  return `${from}→${to}`;
}

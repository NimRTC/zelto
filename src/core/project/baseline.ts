// 基线切片的确定性生成 —— 接管既有项目时，「现有代码长什么样」这件事
// 不该依赖 LLM
//
// 为什么要有这个模块：接管既有项目的流程原本是
//
//   project scan → project init → project design（要 LLM）→ project slice
//
// 但 `project design` 需要配 LLM，没配就卡在第二步 —— 于是「接管既有
// 项目」这条对外主场景在没有 LLM 的机器上完全走不通。而基线切片要表达
// 的东西很简单：**这个模块现在有哪些文件**。这个信息 `project scan`
// 已经拿到了（`ProjectMap.modules[].files`），是确定性的，不需要模型猜。
//
// 基线切片的语义：它描述现状、不改代码。
//   - 状态直接 `completed` —— 它不是待办的活，是既成事实
//   - `trace.requirements = ['(v0 baseline)']` —— 追溯链的起点是「现状」
//   - `traceWaiver` 说明它为什么不需要契约追踪
//   - 写集覆盖该模块的全部文件 —— 之后改动这个模块的切片要跟它协调
//
// C3：只读扫描结果，纯计算，不调模型、不触网。

import type { ProjectMap, ProjectModule } from './types.js';

/** 一个待生成的基线切片 */
export interface BaselineSlicePlan {
  /** 切片 id（`v0-<模块名>`） */
  id: string;
  /** 模块名 */
  moduleName: string;
  /** 写集 —— 该模块的文件模式 */
  writes: string[];
  /** 该模块实际包含的文件（相对仓库根） */
  files: string[];
  /** 该模块的测试文件 */
  testFiles: string[];
}

/**
 * 把模块名变成一个合法的切片 id。
 *
 * 模块名是路径（`src/core`、`lib/utils`），要压成 `v0-src-core` 这种
 * 形态。非字母数字一律换成 `-`，避免 id 里出现 `/`（那是路径分隔符，
 * 会让切片文件落到子目录里去）。
 *
 * 根目录模块的名字是 `.`（扫描器把扁平项目的根当作一个模块），
 * 压出来是空的 —— 给它一个明确的名字 `v0-root`。
 */
export function baselineSliceId(moduleName: string): string {
  const slug = moduleName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `v0-${slug || 'root'}`;
}

/**
 * 展开模块树，得到叶子模块列表。
 *
 * 只有叶子模块才成为基线切片 —— 父模块的写集是子模块写集的并集，
 * 两边都建会造成写集重叠（并行调度会据此把它们判成冲突，白白降级成串行）。
 */
function flattenModules(modules: ProjectModule[]): ProjectModule[] {
  const out: ProjectModule[] = [];
  for (const mod of modules) {
    const children = mod.submodules ?? [];
    if (children.length > 0) {
      out.push(...flattenModules(children));
    } else {
      out.push(mod);
    }
  }
  return out;
}

/**
 * 从扫描结果推出基线切片计划。
 *
 * 每个叶子模块一片。写集是该模块实际含有的文件 —— 用具体文件而不是
 * 目录通配，是因为基线切片的写集要精确：它标的是「这一片涵盖哪些
 * 既有文件」，用 `src/**` 会把整个 src 都算进来。
 *
 * 没有文件的模块跳过 —— 空壳模块（只有目录没有文件）不构成基线。
 */
export function planBaselineSlices(projectMap: ProjectMap): BaselineSlicePlan[] {
  const leaves = flattenModules(projectMap.modules);
  const plans: BaselineSlicePlan[] = [];
  const seen = new Set<string>();

  for (const mod of leaves) {
    const files = (mod.files ?? []).filter(Boolean);
    const testFiles = (mod.testFiles ?? []).filter(Boolean);
    if (files.length === 0 && testFiles.length === 0) continue;

    let id = baselineSliceId(mod.name);
    // 模块名压出来可能撞车（`src/core` 与 `src-core`）——加序号区分，
    // 免得后一片把前一片覆盖掉。
    let n = 2;
    while (seen.has(id)) {
      id = `${baselineSliceId(mod.name)}-${n}`;
      n++;
    }
    seen.add(id);

    plans.push({
      id,
      moduleName: mod.name,
      writes: [...files, ...testFiles],
      files,
      testFiles,
    });
  }

  return plans;
}

/**
 * 基线切片的标题。
 *
 * 根目录模块的名字是 `.`，直接拼进标题会得到「v0 基线: .」——
 * 人看不懂。给它一个明确的名字。
 */
export function baselineSliceTitle(moduleName: string): string {
  return moduleName === '.' ? 'v0 基线: 项目根目录' : `v0 基线: ${moduleName}`;
}

/**
 * 生成基线切片的规格正文。
 *
 * 与 `project slice` 生成的规格同构 —— 同一套格式，人读起来一致。
 */
export function baselineSpecContent(plan: BaselineSlicePlan): string {
  const scope = plan.writes.map((p) => `- \`${p}\``).join('\n');
  return `# Slice: ${plan.id}

## 目的
v0 基线 — ${plan.moduleName === '.' ? '项目根目录' : plan.moduleName}

接管既有项目时映射出的基线切片：描述该模块**现状**已有的文件，
不改代码、不做实现。它是追溯链的起点（后续切片声明的写集要与它对齐）。

## 范围
${scope}

## 验收标准
1. 现有代码不变

## 风险
- 无（基线切片只描述现状）
`;
}

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
//   - 写集覆盖该模块的目录（ADR-039 §4）—— 它标的是「这一片涵盖哪些既有代码」
//
// C3：只读扫描结果，纯计算，不调模型、不触网。

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isProtectedPath } from '../policy/engine.js';
import type { EventType } from '../events/stream.js';
import type { SliceStore } from '../slice/store.js';
import type { ProjectMap, ProjectModule } from './types.js';

/** 一个待生成的基线切片 */
export interface BaselineSlicePlan {
  /** 切片 id（`v0-<模块名>`） */
  id: string;
  /** 模块名 */
  moduleName: string;
  /** 写集 —— 该模块的路径模式 */
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
 * 基线切片的写集口径（ADR-039 §4）。
 *
 * 为什么是**目录通配**而不是具体文件：
 *
 * - 基线表达的是「这个模块归这一片管」。用具体文件的话，模块里**此后新增**
 *   的文件就落在基线范围之外 —— 追溯链说「这一片涵盖 src/core」，实际却只
 *   标了建基线时存在的那几个文件，后来加的文件谁都不认。
 * - 目录通配不会造成并行降级：基线切片是 `completed` 的既成事实，
 *   准入判定（`core/sched/engine.ts`）对 `slice.baseline` 直接跳过写集
 *   预约检查，批次与执行计划也只统计人点名的切片。
 *
 * 根目录模块（名字是 `.`）例外：它的通配只能是 `*`，而 `*` 会把
 * `AGENTS.md` 这类保护域文件圈进写集（C5）。所以根模块逐文件列，
 * 并剔除保护域路径 —— 根级文件少而固定，逐文件更准。
 */
export function baselineWriteSet(moduleName: string, files: string[]): string[] {
  if (moduleName !== '.') return [`${moduleName}/**`];
  return files.filter((f) => !isProtectedPath(f));
}

/**
 * 从扫描结果推出基线切片计划。
 *
 * 每个叶子模块一片。写集按上面的口径生成（目录通配，根模块逐文件）。
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
      writes: baselineWriteSet(mod.name, [...files, ...testFiles]),
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
  const existing = plan.files.length + plan.testFiles.length;
  return `# Slice: ${plan.id}

## 目的
v0 基线 — ${plan.moduleName === '.' ? '项目根目录' : plan.moduleName}

接管既有项目时映射出的基线切片：描述该模块**现状**已有的文件，
不改代码、不做实现。它是追溯链的起点（后续切片声明的写集要与它对齐）。

## 范围
${scope}

现状文件 ${existing} 个（登记时点），模块内此后新增的文件同属本片范围。

## 验收标准
1. 现有代码不变

## 风险
- 无（基线切片只描述现状）
`;
}

/** 注册基线切片时依赖的两样东西（注入，避免 core/ 内部耦合） */
export interface BaselineRegistrationDeps {
  /** 切片状态存储 */
  store: SliceStore;
  /** 事件流（C4：每个动作都要落一条 append-only 事件） */
  events: {
    append(
      sliceId: string,
      type: EventType,
      actor: string,
      payload: Record<string, unknown>,
      runId?: string | null,
    ): Promise<unknown>;
  };
  /** 规格文件目录（相对仓库根），默认 `specs/slices` */
  specsDir?: string;
}

/** 基线切片登记时落的事件载荷 */
export interface BaselineEventPayload {
  /** 模块名 */
  module: string;
  /** 写集 */
  writes: string[];
  /** 登记时点的文件数 */
  fileCount: number;
  /** 为什么登记 */
  reason: string;
}

/**
 * 登记基线切片时落的事件（C4）。
 *
 * 抽成函数是因为基线切片有两条产生路径（`init` / `project init` 走扫描结果，
 * `project slice` 走设计文档），两条路径都必须留痕 —— 事件流是追溯的唯一
 * 证据载体（C4），漏一条就等于这段登记没发生过。
 */
export async function appendBaselineRegisteredEvent(
  events: BaselineRegistrationDeps['events'],
  sliceId: string,
  payload: BaselineEventPayload,
): Promise<void> {
  await events.append(sliceId, 'slice.baseline_registered', 'zelto', {
    module: payload.module,
    writes: payload.writes,
    fileCount: payload.fileCount,
    reason: payload.reason,
  });
}

/** 注册基线切片的结果 */
export interface BaselineRegistrationResult {
  /** 本次新建的基线切片计划 */
  created: BaselineSlicePlan[];
  /** 已存在、被跳过的切片 id */
  skipped: string[];
}

/**
 * 登记基线切片：写状态文件、写规格文件、落事件。
 *
 * 为什么把「登记」做成一个函数而不是在 CLI 里散着写：
 * `zelto init` 与 `zelto project init` 是两条入口（ADR-039 §3），
 * 它们必须产出**完全一样**的基线切片 —— 否则人先跑 init 再跑 project init
 * 会看到两份不同的登记记录（切片 id 相同但内容不同），追溯链就说不清了。
 *
 * C4：每新建一片基线切片都追加一条 `slice.baseline_registered` 事件 ——
 * 「谁在什么时候把哪些文件登记成了现状」必须事后可查。
 * C1：状态只在文件里，不持有内存状态。
 */
export async function registerBaselineSlices(
  projectMap: ProjectMap,
  deps: BaselineRegistrationDeps,
): Promise<BaselineRegistrationResult> {
  const specsDir = deps.specsDir ?? 'specs/slices';
  const plans = planBaselineSlices(projectMap);
  const created: BaselineSlicePlan[] = [];
  const skipped: string[] = [];

  await mkdir(specsDir, { recursive: true });

  for (const plan of plans) {
    if (await deps.store.exists(plan.id)) {
      skipped.push(plan.id);
      continue;
    }

    const specContent = baselineSpecContent(plan);
    const specPath = join(specsDir, `${plan.id}.md`);

    const slice = deps.store.create(plan.id, baselineSliceTitle(plan.moduleName), {
      writes: plan.writes,
      baseline: true,
    });
    // 基线切片是既成事实，不是待办的活 —— 直接落在 completed。
    slice.state = 'completed';
    slice.trace.requirements = ['(v0 baseline)'];
    slice.traceWaiver = '基线切片 — 描述现状，不改代码，无需契约追踪';
    slice.spec.path = specPath;
    slice.spec.frozenHash = `sha256:${createHash('sha256').update(specContent, 'utf-8').digest('hex')}`;
    slice.spec.frozenAt = new Date().toISOString();
    await deps.store.write(slice);

    await writeFile(specPath, specContent, 'utf-8');

    // C4：登记这件事本身也要留痕
    await appendBaselineRegisteredEvent(deps.events, plan.id, {
      module: plan.moduleName,
      writes: plan.writes,
      fileCount: plan.files.length + plan.testFiles.length,
      reason: '接管既有项目：把现状登记为追溯链的起点',
    });

    created.push(plan);
  }

  return { created, skipped };
}

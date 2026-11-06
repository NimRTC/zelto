// 架构护栏的 CLI 接线层（ADR-027）
//
// `core/arch/guard.ts` 是纯判定（C3，不碰文件）；这里是唯一碰文件的地方：
// 找确认设计 → 扫 import 图 → 出报告 → 按 policy.yaml 的 `arch:` 段定级。
// 三处执行点（deliver / batch / gate）都走这里，读法只有一份。
//
// C1: 只读文件，不写任何状态（设计、源码、policy 全是读）
// C3: 判定本身在 core/arch，确定性；这里只做 IO 与翻译

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DesignStore } from '../../core/design/store.js';
import { pickDefaultDesign } from '../../core/design/selection.js';
import type { DesignDoc } from '../../core/design/types.js';
import {
  buildArchitectureReport,
  judgeArchGuard,
  judgeSliceArchGuard,
  scanArchitecture,
  type ArchitectureReport,
  type Deviation,
  type GuardRule,
  type GuardVerdict,
  type ModuleSpec,
} from '../../core/arch/index.js';
import type { BatchIssue } from '../../core/sched/batch.js';
import { loadPolicyConfig } from './shared.js';

/** 整图护栏上下文：一次扫描，多处复用（batch 逐片判定时只扫一次图） */
export interface WholeGraphGuard {
  designId: string;
  designTitle: string;
  specs: ModuleSpec[];
  report: ArchitectureReport;
  guard: GuardVerdict;
  guardRules?: GuardRule[];
}

function toModuleSpecs(design: DesignDoc): ModuleSpec[] {
  return design.modules.map((m) => ({
    name: m.name,
    description: m.description,
    filePatterns: m.filePatterns,
    dependencies: m.dependencies,
  }));
}

/**
 * 载入整图护栏上下文。
 *
 * @param designRoot 找 `.zelto/design` 与 `policy/policy.yaml` 的根（默认 cwd）。
 *                   gate 场景下设计与策略永远读主仓，不读 worktree。
 * @param scanRoot   扫源码的根（默认 cwd）。gate 场景下传 worktree 路径，
 *                   验的是 agent 刚写出来的代码，不是主干。
 * @returns 无确认设计时返回 null —— 调用方视为「无护栏可执行」，直接跳过
 *            （老项目无感；`arch check` 那个「找不到设计就报错」是报告命令的
 *            严格语义，门禁路径不沿用）。
 */
export async function loadWholeGraphGuard(options?: {
  designRoot?: string;
  scanRoot?: string;
  /** 显式护栏规则（测试用）；缺省读 designRoot 的 policy/policy.yaml */
  guardRules?: GuardRule[];
}): Promise<WholeGraphGuard | null> {
  const designRoot = options?.designRoot ?? process.cwd();
  const scanRoot = options?.scanRoot ?? process.cwd();

  const zeltoDir = join(designRoot, '.zelto');
  // 别去 list —— list 会顺手建目录，而门禁路径不该在别人的项目里留下痕迹
  // （学 architecture.ts 的 resolveDesign）
  if (!existsSync(join(zeltoDir, 'design'))) return null;
  const store = new DesignStore(zeltoDir);
  const list = await store.list();
  // 与 `zelto arch check` 同一口径：默认挑项目基线设计，
  // 没有基线才退到最新的已确认设计（见 core/design/selection.ts）。
  const picked = pickDefaultDesign(list);
  if (!picked) return null;
  const design = await store.read(picked.id);

  const specs = toModuleSpecs(design);
  const scan = scanArchitecture(scanRoot, specs);
  const report = buildArchitectureReport(specs, scan);
  // 策略读 designRoot（主仓），不读 cwd —— gate 扫 worktree 时 cwd 在 worktree 里，
  // 那里没有 policy.yaml，读 cwd 会静默掉回默认 deny，把 ask/allow 配置丢掉。
  const guardRules = options?.guardRules ?? loadPolicyConfig(designRoot).arch;
  const guard = judgeArchGuard(report, guardRules);

  return { designId: design.id, designTitle: design.title, specs, report, guard, guardRules };
}

/**
 * 按写集算单片护栏结论（batch 准入 / 单片 gate 用）。
 * 无关模块的漂移不拦干净切片 —— 过滤语义见 ADR-027 §3.7。
 */
export function sliceGuardForWrites(
  ctx: WholeGraphGuard,
  writes: string[],
): { verdict: GuardVerdict; relevant: Deviation[] } {
  return judgeSliceArchGuard(ctx.report, ctx.specs, writes, ctx.guardRules);
}

const GUARD_KIND_LABEL: Record<string, string> = {
  missing_dependency: '缺失依赖',
  undeclared_dependency: '未声明依赖',
  ambiguous_module: '模块归属歧义',
  unmapped_file: '文件无归属',
  unknown_module: '未知模块',
  cycle: '依赖成环',
};

/** `未声明依赖×2（deny）、文件无归属×5（ask）` —— 给人看的一行摘要 */
export function describeGuardKinds(
  verdict: GuardVerdict,
  only: 'blocked' | 'pending' = 'blocked',
): string {
  const list = verdict.perKind.filter((k) =>
    only === 'blocked' ? k.blocked : k.needsConfirm && k.count > 0,
  );
  return list
    .map((k) => `${GUARD_KIND_LABEL[k.kind] ?? k.kind}×${k.count}（${k.action}）`)
    .join('、');
}

/**
 * 单片护栏结论 → 准入问题（batch 用）。
 *
 * deny → error（阻断开工）；ask → warning（只提示，不阻断）；
 * 干净 → null。code 固定，调用方与测试可断言。
 */
export function sliceGuardIssue(sliceId: string, verdict: GuardVerdict): BatchIssue | null {
  if (verdict.blocked) {
    return {
      sliceId,
      severity: 'error',
      code: 'arch_guard_blocked',
      message: `架构护栏拦截：${describeGuardKinds(verdict, 'blocked')} —— 修好或改 policy.yaml 的 arch 段后再开工`,
    };
  }
  if (verdict.needsConfirm) {
    return {
      sliceId,
      severity: 'warning',
      code: 'arch_guard_confirm',
      message: `架构护栏待确认：${describeGuardKinds(verdict, 'pending')} —— 只提示，不阻断`,
    };
  }
  return null;
}

/**
 * 单片门禁用的护栏检查（`zelto gate` 与自动门禁共用同一口径）。
 *
 * 无确认设计时返回 null —— 调用方直接跳过（老项目无感）。
 * 有设计时只返回与本片写集相关的结论（整图无关的漂移不拦）。
 */
export interface SliceGateGuard {
  designId: string;
  verdict: GuardVerdict;
  relevant: Deviation[];
}

export async function checkSliceGateGuard(
  writes: string[],
  options?: { designRoot?: string; scanRoot?: string },
): Promise<SliceGateGuard | null> {
  const ctx = await loadWholeGraphGuard(options);
  if (!ctx) return null;
  const { verdict, relevant } = sliceGuardForWrites(ctx, writes);
  return { designId: ctx.designId, verdict, relevant };
}

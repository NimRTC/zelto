// 架构护栏判定（ADR-027）—— 按 policy.yaml 的 `arch:` 段给偏离定级
//
// `report.ts` 只报告（证据齐全），这里只算结论（拦不拦）：
//   deny  → 该类出现即不一致（blocked）
//   ask   → 该类出现只待人确认（pending，不拦）
//   allow → 该类不计入结论（报告里条目仍在，证据不丢）
//
// C3: 纯计算，不调模型、不触网
// C2: core/ 内，不依赖 adapters/

import { pathInWriteSet, pathsOverlap } from '../sched/paths.js';
import type { Decision } from '../policy/types.js';
import type { ArchitectureReport, Deviation, DeviationKind, ModuleSpec } from './types.js';

/** 可配的六类硬偏离（软偏离 unverifiable_dependency 不可配、永不拦） */
export const HARD_DEVIATION_KINDS: readonly DeviationKind[] = [
  'undeclared_dependency',
  'missing_dependency',
  'unknown_module',
  'ambiguous_module',
  'unmapped_file',
  'cycle',
];

/** 护栏规则（与 policy types 对齐，core/arch 内独立一份避免循环 import） */
export interface GuardRule {
  kind: DeviationKind;
  action: Decision;
  basis: string;
  guidance?: string;
}

/** 逐类的护栏结论 */
export interface GuardKindResult {
  kind: DeviationKind;
  action: Decision;
  count: number;
  /** deny 且出现了 → 拦 */
  blocked: boolean;
  /** ask 且出现了 → 待人确认（不拦，只标注） */
  needsConfirm: boolean;
}

/** 整图护栏结论 */
export interface GuardVerdict {
  perKind: GuardKindResult[];
  /** 任一 deny 类出现即为 true */
  blocked: boolean;
  /** 任一 ask 类出现即为 true（只报告，不拦） */
  needsConfirm: boolean;
}

function actionOf(kind: DeviationKind, guard?: GuardRule[]): Decision {
  const rule = guard?.find((r) => r.kind === kind);
  return rule?.action ?? 'deny';
}

/**
 * 按护栏配置重算整图结论（不改报告本身）。
 *
 * 缺 `arch:` 段时全按 deny —— 与今天的 `--strict`（`report.ok`）完全一致。
 * 软偏离（`unverifiable_dependency`）与未知 kind 永不计入结论。
 */
export function judgeArchGuard(
  report: ArchitectureReport,
  guard?: GuardRule[],
): GuardVerdict {
  const counts = new Map<DeviationKind, number>();
  for (const dev of report.deviations) {
    counts.set(dev.kind, (counts.get(dev.kind) ?? 0) + 1);
  }

  const perKind: GuardKindResult[] = HARD_DEVIATION_KINDS.map((kind) => {
    const action = actionOf(kind, guard);
    const count = counts.get(kind) ?? 0;
    return {
      kind,
      action,
      count,
      blocked: action === 'deny' && count > 0,
      needsConfirm: action === 'ask' && count > 0,
    };
  });

  return {
    perKind,
    blocked: perKind.some((k) => k.blocked),
    needsConfirm: perKind.some((k) => k.needsConfirm),
  };
}

// ─── 切片级过滤 ────────────────────────────────────────────────────────────
// batch 准入与单片 gate 只看「与本片写集相关的偏离」：
// 无关模块的漂移不拦干净切片。

/** 写集与某个模块的 filePatterns 是否有交集 */
function moduleTouchesWrites(patterns: string[], writes: string[]): boolean {
  for (const pat of patterns) {
    for (const w of writes) {
      if (pathsOverlap(pat, w) || pathsOverlap(w, pat)) return true;
    }
  }
  return false;
}

/** 与写集相交的模块名集合 */
export function relevantModuleNames(modules: ModuleSpec[], writes: string[]): Set<string> {
  const names = new Set<string>();
  for (const mod of modules) {
    if (moduleTouchesWrites(mod.filePatterns, writes)) names.add(mod.name);
  }
  return names;
}

/** 从 `文件 "path" ...` 这类 detail 里抽出被引用的文件路径 */
function fileFromDetail(detail: string): string | null {
  const m = detail.match(/"([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * 一条偏离是否与本片写集相关。
 *
 * - `unmapped_file`：`to` 即文件路径，落在写集内才相关
 * - `ambiguous_module`：detail 里引用的文件落在写集内才相关
 * - `cycle`：`to` 是 `a → b` 的环，环上任一模块与写集相交即相关
 * - 边类（未声明 / 缺失 / 无法验证）：`from` 或 `to` 任一端是相关模块即相关
 * - `unknown_module`：`to` 在设计里不存在，只能看 `from` 端
 * - 软偏离与未知 kind：永不相关（本来就不拦）
 */
export function isDeviationRelevantToSlice(
  dev: Deviation,
  relevantModules: Set<string>,
  writes: string[],
): boolean {
  switch (dev.kind) {
    case 'unmapped_file':
      return pathInWriteSet(dev.to, writes);
    case 'ambiguous_module': {
      const file = fileFromDetail(dev.detail);
      return file !== null && pathInWriteSet(file, writes);
    }
    case 'cycle': {
      const members = dev.to.split(' → ').map((s) => s.trim()).filter(Boolean);
      if (dev.from) members.push(dev.from);
      return members.some((m) => relevantModules.has(m));
    }
    case 'unknown_module':
      return relevantModules.has(dev.from);
    case 'undeclared_dependency':
    case 'missing_dependency':
      return relevantModules.has(dev.from) || relevantModules.has(dev.to);
    default:
      return false;
  }
}

/** 只保留与本片写集相关的偏离（返回新数组，不改原报告） */
export function filterRelevantDeviations(
  deviations: Deviation[],
  modules: ModuleSpec[],
  writes: string[],
): Deviation[] {
  const relevantModules = relevantModuleNames(modules, writes);
  return deviations.filter((dev) => isDeviationRelevantToSlice(dev, relevantModules, writes));
}

/**
 * 切片级护栏结论：先按写集过滤，再按护栏配置定级。
 *
 * 返回过滤后的偏离（调用方直接拿去展示 / 计数，语义唯一）。
 */
export function judgeSliceArchGuard(
  report: ArchitectureReport,
  modules: ModuleSpec[],
  writes: string[],
  guard?: GuardRule[],
): { verdict: GuardVerdict; relevant: Deviation[] } {
  const relevant = filterRelevantDeviations(report.deviations, modules, writes);
  const verdict = judgeArchGuard({ ...report, deviations: relevant }, guard);
  return { verdict, relevant };
}

/**
 * 给报告用的可复制 `arch:` 片段（Q1 省力放开：原型期先 ask，交付前收紧为 deny）。
 *
 * 只给「出现过的、且当前会被拦（deny）的」种类出片段，避免一次全放开。
 */
export function buildArchRelaxSnippet(report: ArchitectureReport, guard?: GuardRule[]): string {
  const verdict = judgeArchGuard(report, guard);
  const blocked = verdict.perKind.filter((k) => k.blocked);
  if (blocked.length === 0) return '';
  const lines = ['arch:'];
  for (const k of blocked) {
    lines.push(`  - kind: ${k.kind}`);
    lines.push('    action: ask');
    lines.push('    basis: "policy.yaml#arch-relax"');
  }
  return lines.join('\n');
}

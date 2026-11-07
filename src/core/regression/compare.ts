// 回归对比 —— 「这个版本把上个版本的哪些行为弄坏了」
//
// 对比口径（全部以「上个版本的基线」为准）：
//
//   regressed：上版本通过，本版本失败 —— 直接的行为损坏
//   degraded ：上版本通过，本版本变成 todo / skip —— 用例还在，但没人跑了
//   missing  ：上版本通过，本版本没有这条用例 —— 用例被删了，行为没人验证
//   fixed    ：上版本失败或空壳，本版本通过 —— 修好了
//
// 只有「上版本是 pass」的用例才可能进 regressed / degraded / missing ——
// 上版本本来就是 todo 的用例，在新版本里还是 todo，那不是回归。
//
// 判据全是纯计算（C3）：读两份基线，算差集。

import { testKey, type TestResult } from './tap.js';

/** 一份回归对比报告 */
export interface RegressionReport {
  /** 有没有可比的两份基线（没有上一版基线时为 false） */
  compared: boolean;
  /** 对比的基线来自哪个版本 */
  previousVersion: string | null;
  /** 当前版本 */
  currentVersion: string;
  /** 上版本通过、本版本失败 */
  regressed: string[];
  /** 上版本通过、本版本退化成 todo / skip */
  degraded: string[];
  /** 上版本通过、本版本没有这条用例 */
  missing: string[];
  /** 上版本失败或空壳、本版本通过 */
  fixed: string[];
  /** 两边都通过、没动的用例数 */
  unchanged: number;
}

/** 空报告（没有上一版基线时用） */
export function emptyReport(currentVersion: string): RegressionReport {
  return {
    compared: false,
    previousVersion: null,
    currentVersion,
    regressed: [],
    degraded: [],
    missing: [],
    fixed: [],
    unchanged: 0,
  };
}

/**
 * 对比上一版本与当前版本的用例状态。
 */
export function compareRegression(
  previousTests: TestResult[],
  currentTests: TestResult[],
  previousVersion: string,
  currentVersion: string,
): RegressionReport {
  const report = emptyReport(currentVersion);
  report.compared = true;
  report.previousVersion = previousVersion;

  const current = new Map<string, TestResult>();
  for (const test of currentTests) current.set(testKey(test), test);

  const previous = new Map<string, TestResult>();
  for (const test of previousTests) previous.set(testKey(test), test);

  for (const [key, before] of previous) {
    const now = current.get(key);
    const label = describe(before);

    if (!now) {
      // 只在上版本是 pass 时才算回归 —— 上版本本来就红的不算。
      if (before.status === 'pass') report.missing.push(label);
      continue;
    }

    if (before.status === 'pass') {
      if (now.status === 'fail') {
        report.regressed.push(label);
      } else if (now.status === 'todo' || now.status === 'skip') {
        report.degraded.push(label);
      } else {
        report.unchanged += 1;
      }
    } else if (now.status === 'pass') {
      report.fixed.push(label);
    }
  }

  return report;
}

/** 报告里是否检出了回归 */
export function hasRegression(report: RegressionReport): boolean {
  return report.regressed.length > 0 || report.degraded.length > 0 || report.missing.length > 0;
}

/** 给人看的用例标签 */
function describe(test: TestResult): string {
  return test.file ? `${test.file} :: ${test.name}` : test.name;
}

/**
 * 把报告渲染成给人看的多行文本（中文）。
 */
export function renderRegression(report: RegressionReport): string {
  if (!report.compared) {
    return '  （没有可对比的上一版本基线）';
  }
  const lines: string[] = [];
  const push = (mark: string, title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`  ${mark} ${title}（${items.length}）`);
    for (const item of items) lines.push(`      - ${item}`);
  };
  push('✗', '行为损坏：上版本通过，本版本失败', report.regressed);
  push('✗', '验证退化：上版本通过，本版本不再执行', report.degraded);
  push('✗', '用例消失：上版本通过，本版本没有这条用例', report.missing);
  push('✓', '已修复：上版本不通过，本版本通过', report.fixed);
  if (lines.length === 0) {
    lines.push(`  ✓ 没有回归（${report.unchanged} 条用例保持通过）`);
  }
  return lines.join('\n');
}

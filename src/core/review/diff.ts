// 行级差异 —— 确定性 diff
//
// 「这一版相对上一版改了什么」需要 diff。这里的实现是最朴素的 LCS
// 行级 diff：不引第三方库（core/ 零依赖），结果只取决于输入，
// 同样的输入永远给同样的输出（C3）。
//
// 复杂度 O(n*m)，规格文档通常几百行，完全够用。

export interface DiffOp {
  type: 'add' | 'remove' | 'context';
  text: string;
}

import type { DiffSummary } from './types.js';

/**
 * 计算两段文本的行级差异。
 *
 * 返回的操作序列是「前向」的：按文本顺序排列，
 * remove 表示旧版本里有、新版本里没有的行，add 反之。
 */
export function diffOps(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;

  // dp[i * (m+1) + j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * (m + 1) + j;
      if (a[i] === b[j]) {
        dp[idx] = dp[(i + 1) * (m + 1) + (j + 1)] + 1;
      } else {
        const down = dp[(i + 1) * (m + 1) + j];
        const right = dp[i * (m + 1) + (j + 1)];
        dp[idx] = down >= right ? down : right;
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'context', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) {
      ops.push({ type: 'remove', text: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'remove', text: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', text: b[j] });
    j++;
  }
  return ops;
}

/** 统计差异 */
export function summarizeOps(ops: DiffOp[]): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'remove') removed++;
  }
  return { added, removed, changed: added > 0 || removed > 0 };
}

/**
 * 渲染成 unified diff 风格的一段文本。
 *
 * 只保留变更块附近的上下文（context 行），
 * 免得整篇规格原样重打一遍。
 *
 * hunk 头带真实的旧/新行号（`@@ -a,b +c,d @@`），跟 `git diff` 一个格式。
 */
export function renderUnifiedDiff(ops: DiffOp[], context = 3): string {
  if (ops.length === 0) return '';

  // 标记哪些位置需要显示
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type === 'context') continue;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
      keep[k] = true;
    }
  }

  // 每个操作对应的旧行号 / 新行号（1 基），用于生成 hunk 头
  const oldLineAt: number[] = new Array<number>(ops.length);
  const newLineAt: number[] = new Array<number>(ops.length);
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < ops.length; i++) {
    oldLineAt[i] = oldLine;
    newLineAt[i] = newLine;
    const op = ops[i];
    if (op.type === 'context') {
      oldLine++;
      newLine++;
    } else if (op.type === 'remove') {
      oldLine++;
    } else {
      newLine++;
    }
  }

  const out: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      i++;
      continue;
    }
    // 收集一个变更块
    const block: DiffOp[] = [];
    let j = i;
    while (j < ops.length && keep[j]) {
      block.push(ops[j]);
      j++;
    }

    const oldCount = block.filter((o) => o.type !== 'add').length;
    const newCount = block.filter((o) => o.type !== 'remove').length;
    const oldStart = oldLineAt[i];
    const newStart = newLineAt[i];

    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of block) {
      const prefix = op.type === 'add' ? '+' : op.type === 'remove' ? '-' : ' ';
      out.push(prefix + op.text);
    }
    i = j;
  }
  return out.join('\n');
}

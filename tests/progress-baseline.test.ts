// D-56：预置脏要**列出来** —— 判定 ≠ 陈述
//
// 病灶（实测 nimrtc-zelto v3-chrome-waterfall，2026-11-18）：
//
// 一片重跑了 4 轮。第 3 轮超时被砍，但**已经把 4 个文件写好了**。
// 第 4 轮开工时，那 4 个文件**已经是脏的** → 开工快照把它们记成「预置脏」
// （D-29 baseline）。
//
// 于是「做成了什么」把它们全排除了：
//
//   progress.changedFiles = []
//   progress.verdict      = "unknown"
//   summary               = "进展不明：规格要求 6 条验收标准"
//
// 而第 4 轮恰恰**是把这 4 个文件做完的那一轮** —— 门禁 ✅ 通过、签字通过、
// 合并到 version/v3。
//
// 人翻事件流看到的是「这一轮什么也没做成」，其实全做成了。
//
// 根因不是 bug，是**判据混进了陈述**：
//   - 排除预置脏是为了**不误判越界** —— 那是**判定**；
//   - 「做成了什么」是**陈述** —— 「这一轮结束时相对基线有哪些改动」。
//
// 陈述不该受判据影响。判据该影响的是「哪些算越界」那一栏。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { collectSliceProgress } from '../src/cli/commands/progress-collect.js';

const SLICE_JSON = JSON.stringify({
  id: 's1',
  title: '一片',
  state: 'running',
  spec: { path: 'specs/slices/s1.md', frozenHash: null, frozenAt: null },
  acceptance: { dir: 'tests/acceptance/s1/', frozenHash: null, oracleSrc: null },
  runs: [],
  clarifyRounds: 0,
  stall: { class: null, autoResolved: 0, gateRetries: 0 },
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
});

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'zelto-baseline-'));
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root, stdio: 'ignore' });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

function rm(root: string): void {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 残留不致命 */ }
}

async function inProject<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

describe('D-56 预置脏：判定 ≠ 陈述', () => {
  it('预置脏文件要列进改动清单（不然「做成了什么」就空了）', async () => {
    const root = makeProject({
      '.zelto/slices/s1.json': SLICE_JSON,
      'src/kept.js': 'base\n',
    });
    try {
      // 上一轮留下的改动 —— 开工快照会把它记成「预置脏」
      writeFileSync(join(root, 'src', 'kept.js'), 'changed\n', 'utf-8');

      const report = await inProject(root, () =>
        collectSliceProgress({
          sliceId: 's1',
          worktree: root,
          runAcceptance: false,
          guard: {
            managedPaths: [],
            baselineChanged: ['src/kept.js'],
          },
        }),
      );

      assert.ok(report);
      assert.ok(
        report.changedFiles.includes('src/kept.js'),
        `预置脏也要列进改动清单，实际：${JSON.stringify(report.changedFiles)}`,
      );
    } finally {
      rm(root);
    }
  });

  it('预置脏仍然不进「写集外」—— 那是判定，不能因为陈述而放松', async () => {
    // 预置脏 + 它确实是越界路径（审计没判它是越界，因为预置脏被排除了）
    // → 「写集外」这一栏必须只由审计的结论决定。
    const root = makeProject({
      '.zelto/slices/s1.json': SLICE_JSON,
      'src/evil.js': 'base\n',
    });
    try {
      writeFileSync(join(root, 'src', 'evil.js'), 'changed\n', 'utf-8');

      const report = await inProject(root, () =>
        collectSliceProgress({
          sliceId: 's1',
          worktree: root,
          runAcceptance: false,
          guard: {
            managedPaths: [],
            baselineChanged: ['src/evil.js'],
          },
          // 审计说它没越界（预置脏被审计排除了）
          violations: [],
        }),
      );

      assert.ok(report);
      assert.ok(report.changedFiles.includes('src/evil.js'), '陈述里要列出来');
      assert.deepEqual(
        report.outOfWriteSetFiles,
        [],
        '判定那栏只认审计的结论 —— 审计没判它越界就不列',
      );
    } finally {
      rm(root);
    }
  });

  it('托管文件仍然排除 —— 它是 zelto 自己写的，不是 agent 的成果', async () => {
    const root = makeProject({
      '.zelto/slices/s1.json': SLICE_JSON,
      'specs/slices/s1.md': 'base\n',
    });
    try {
      writeFileSync(join(root, 'specs', 'slices', 's1.md'), 'changed\n', 'utf-8');

      const report = await inProject(root, () =>
        collectSliceProgress({
          sliceId: 's1',
          worktree: root,
          runAcceptance: false,
          guard: {
            managedPaths: ['specs/slices/s1.md'],
            baselineChanged: [],
          },
        }),
      );

      assert.ok(report);
      assert.ok(
        !report.changedFiles.includes('specs/slices/s1.md'),
        '托管文件不该算 agent 改的',
      );
    } finally {
      rm(root);
    }
  });
});

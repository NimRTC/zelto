// D-56：采集「做成了什么」的**唯一一份实现**
//
// 为什么要单独测这一层：
//
// D-56 接了 4 条失败路径（前台失败、前台越界、成功、监督进程），
// 漏掉了第 5 条 —— **看门狗收走**。漏掉的那条，单元测试**全绿**：
// 因为每条路径都单独测了，漏的那条没人测。
//
// 看门狗路径不走 `finishRun`，所以它得自己采集一次 ——
// 于是同一个「采集」有了两份实现。而两份必然漂移，
// 漂移的方向恰好就是「漏掉一条路径」。
//
// 所以把采集抽成 `progress-collect.ts`，两条路径调同一份，
// 并在这里直接测它：改一处，两条路径同时变。
//
// 这一组用例守的是：
//   1. 采集用的是**审计的结论**（越界文件），不自己重算；
//   2. 托管文件与预置脏**不算** agent 改的（D-29）；
//   3. 采集失败返回 null，不阻断收尾（附加信息不是判据）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { collectSliceProgress } from '../src/cli/commands/progress-collect.js';

/**
 * 造一个「像样的」项目根：git 仓库 + 一个切片状态文件。
 *
 * 为什么必须是真的 git 仓库：`listChangedFiles` 读的是
 * `git status --porcelain` 的真实输出 —— 用真 git 才能覆盖到
 * 「工作区已改、暂存区没改」那种状态位含空格的情形。
 */
function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'zelto-progress-'));
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

/** 切片状态文件 —— store 读的是 `<cwd>/.zelto/slices/<id>.json`。 */
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

function rm(root: string): void {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 残留不致命 */ }
}

/** 在临时目录里跑 —— store 读的是相对路径 `.zelto/slices/`。 */
async function inProject<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

describe('D-56 采集：读不到切片时返回 null（不阻断收尾）', () => {
  it('切片不存在 → null，而不是抛异常', async () => {
    const root = makeProject({ 'README.md': 'x' });
    try {
      const report = await inProject(root, () =>
        collectSliceProgress({
          sliceId: 'never-created',
          worktree: null,
          runAcceptance: false,
        }),
      );
      assert.equal(report, null);
    } finally {
      rm(root);
    }
  });
});

describe('D-56 采集：改动清单来自 git 事实，不是猜的', () => {
  it('工作区已改、暂存区没改的文件也算改动（状态位含空格）', async () => {
    const root = makeProject({
      '.zelto/slices/s1.json': SLICE_JSON,
      'src/util.js': 'base\n',
    });
    try {
      // 改工作区、不暂存 —— `git status --porcelain` 输出 ` M src/util.js`
      writeFileSync(join(root, 'src', 'util.js'), 'changed\n', 'utf-8');

      const report = await inProject(root, () =>
        collectSliceProgress({
          sliceId: 's1',
          worktree: root,
          runAcceptance: false,
        }),
      );

      assert.ok(report);
      assert.ok(
        report.changedFiles.includes('src/util.js'),
        `工作区改动该被认出来，实际：${JSON.stringify(report.changedFiles)}`,
      );
    } finally {
      rm(root);
    }
  });
});

describe('D-56 采集：越界文件用审计的结论，不自己重算', () => {
  it('只有审计判定的越界文件才进「写集外」栏', async () => {
    const root = makeProject({
      '.zelto/slices/s1.json': SLICE_JSON,
      'src/util.js': 'base\n',
      'src/evil.js': 'base\n',
    });
    try {
      writeFileSync(join(root, 'src', 'util.js'), 'changed\n', 'utf-8');
      writeFileSync(join(root, 'src', 'evil.js'), 'changed\n', 'utf-8');

      const report = await inProject(root, () =>
        collectSliceProgress({
          sliceId: 's1',
          worktree: root,
          runAcceptance: false,
          violations: ['src/evil.js'],
        }),
      );

      assert.ok(report);
      assert.deepEqual(report.outOfWriteSetFiles, ['src/evil.js']);
      assert.ok(report.changedFiles.includes('src/util.js'));
    } finally {
      rm(root);
    }
  });
});

describe('D-56 采集：托管文件不算 agent 改的', () => {
  it('被守卫列为托管的文件不进改动清单', async () => {
    const root = makeProject({
      '.zelto/slices/s1.json': SLICE_JSON,
      'src/agent.js': 'base\n',
      'src/managed.js': 'base\n',
      'src/preexisting.js': 'base\n',
    });
    try {
      for (const f of ['agent.js', 'managed.js', 'preexisting.js']) {
        writeFileSync(join(root, 'src', f), 'changed\n', 'utf-8');
      }

      const report = await inProject(root, () =>
        collectSliceProgress({
          sliceId: 's1',
          worktree: root,
          runAcceptance: false,
          guard: {
            managedPaths: ['src/managed.js'],
            baselineChanged: ['src/preexisting.js'],
          },
        }),
      );

      assert.ok(report);
      assert.ok(
        !report.changedFiles.includes('src/managed.js'),
        '托管文件不该算 agent 改的',
      );
      assert.ok(
        report.changedFiles.includes('src/agent.js'),
        'agent 真正改的该被列出来',
      );
    } finally {
      rm(root);
    }
  });
});

describe('D-56 采集：预置脏要**列出来**（判定 ≠ 陈述）', () => {
  it('预置脏不进「写集外」，但要在改动清单里', async () => {
    // 病灶（实测 nimrtc-zelto v3-chrome-waterfall，2026-11-18）：
    // 一片重跑了 4 轮。第 3 轮超时被砍，但已经写好了 4 个文件。
    // 第 4 轮开工时那些文件**已经是脏的** → 快照把它们记成「预置脏」。
    //
    // 于是「做成了什么」把它们全排除了 → changedFiles=[] →
    // verdict=unknown → 事件里写「进展不明：规格要求 6 条验收标准」。
    //
    // 而第 4 轮恰恰**是把这 4 个文件做完的那一轮**。
    // 人翻事件流看到的是「这一轮什么也没做成」，其实全做成了。
    //
    // 排除预置脏是为了**不误判越界**（判定）；
    // 「做成了什么」是**陈述** —— 陈述不该受判据影响。
    const root = makeProject({
      '.zelto/slices/s1.json': SLICE_JSON,
      'src/kept.js': 'base\n',
    });
    try {
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
});

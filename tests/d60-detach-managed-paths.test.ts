// D-60：后台（detach）路径的写集审计必须与前台路径同源
//
// 病灶（实测于 nimrtc-zelto v3-weaknet-verdict，2026-11-17）：
//
//   `zelto run --detach` 走的是**监督进程**（supervisor.ts，D-50）。
//   监督进程调 `installRuntimeGuard` 时**没传 `managedPaths`** ——
//   前台路径（core-slice.ts / parallel-executor.ts）都传了。
//
//   后果：`managedPaths` 为空 → 写集审计不知道「规格副本是 zelto 自己
//   放进去的」→ 运行结束后拿 git status 对写集时，
//   `specs/slices/<id>.md` 落在写集之外 → 判成「agent 越界写入」
//   → `run.aborted`（reason: write-set violation）→ 整轮运行作废。
//
//   讽刺的是：**agent 一个字节都没碰那个文件**。
//   它的内容与主仓真源逐字节相同（zelto 自己复制进去的副本），
//   agent 的真产物（tools/rd_lan.py 等）反而是干净的。
//
//   所以这不是「agent 不守规矩」，而是「zelto 被自己的文件拦下」。
//
// 这一组用例守的是：
//   1. `zeltoOwnedPaths` 确实把规格副本算作 zelto 托管；
//   2. 审计时，托管文件**不算越界**，但内容被改仍算**篡改**；
//   3. 非托管、不在写集的文件仍算**真越界**（不能因为修了这条而放松）；
//   4. 监督进程那条路径确实传了 `managedPaths`（源码级锁定）。
//
// 第 4 条用源码扫描锁定 —— 因为监督进程是独立进程，
// 端到端跑一次要起真 agent，太重；而这个 bug 的本质就是
// 「一条路径传了、另一条路径没传」，源码扫描正好对着这个判据。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditWorktreeWrites } from '../src/core/sched/audit.js';
import { zeltoOwnedPaths } from '../src/cli/commands/parallel-executor.js';
import type { SliceData } from '../src/core/slice/store.js';

const SPEC_REL = 'specs/slices/v3-weaknet-verdict.md';
const WRITE_SET = [
  'tools/rd_lan.py',
  'tests/acceptance/v3-weaknet-verdict/acceptance.test.cjs',
];

function makeSlice(overrides: Partial<SliceData> = {}): SliceData {
  return {
    id: 'v3-weaknet-verdict',
    title: '弱网判定',
    state: 'frozen',
    spec: { path: SPEC_REL, frozenHash: 'sha256:x', frozenAt: null },
    acceptance: { dir: 'tests/acceptance/v3-weaknet-verdict/', frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes: WRITE_SET,
    runs: [],
    clarifyRounds: 0,
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  } as SliceData;
}

/** 建一个真的 git 仓库 —— 审计要靠 git status 才能看到未跟踪文件。 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zelto-d51-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '-q');
  git('config', 'user.email', 'test@zelto.local');
  git('config', 'user.name', 'zelto test');
  return dir;
}

describe('D-60 托管文件清单：规格副本归 zelto，不归 agent', () => {
  it('规格副本进托管清单', () => {
    const owned = zeltoOwnedPaths('D:/wt', makeSlice());
    assert.ok(
      owned.includes(SPEC_REL),
      `规格副本必须在托管清单里，实际：${JSON.stringify(owned)}`,
    );
  });

  it('写集里的验收文件**不**进托管清单（ADR-046：那是 agent 该改的）', () => {
    const owned = zeltoOwnedPaths('D:/wt', makeSlice());
    assert.ok(
      !owned.includes('tests/acceptance/v3-weaknet-verdict/acceptance.test.cjs'),
      '写集里的验收文件不能被托管 —— 那等于一边叫 agent 改、一边拦它改',
    );
  });

  it('没有 worktree 时托管清单为空', () => {
    assert.deepEqual(zeltoOwnedPaths(null, makeSlice()), []);
  });
});

describe('D-60 写集审计：托管文件不算越界，但被改算篡改', () => {
  it('规格副本（zelto 放的）不被判成越界', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, 'specs', 'slices'), { recursive: true });
      writeFileSync(join(dir, SPEC_REL), '# Slice: v3-weaknet-verdict\n', 'utf-8');

      const result = auditWorktreeWrites(dir, WRITE_SET, {
        managed: [{ path: SPEC_REL, hash: 'sha256:PLACEHOLDER' }],
      });

      assert.equal(result.error, null, `git 状态读取失败：${result.error}`);
      assert.ok(
        result.changed.includes(SPEC_REL),
        '前提：规格副本确实出现在 git 改动里（未跟踪的新文件）',
      );
      assert.ok(
        !result.violations.includes(SPEC_REL),
        `托管文件不该判成越界 —— 越界清单：${JSON.stringify(result.violations)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('托管文件内容被改 → 判篡改（不是越界）', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, 'specs', 'slices'), { recursive: true });
      writeFileSync(join(dir, SPEC_REL), '# 改了内容\n', 'utf-8');

      const result = auditWorktreeWrites(dir, WRITE_SET, {
        managed: [{ path: SPEC_REL, hash: 'sha256:WRONG' }],
      });

      assert.ok(
        result.tampered.includes(SPEC_REL),
        '托管文件内容对不上必须判篡改 —— 改规格副本等于自动改规格',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非托管、又不在写集里的文件 → 判越界（真越界不能放过）', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'sneaky.cpp'), 'int main(){}\n', 'utf-8');

      const result = auditWorktreeWrites(dir, WRITE_SET, {
        managed: [{ path: SPEC_REL, hash: 'sha256:x' }],
      });

      assert.ok(
        result.violations.includes('src/sneaky.cpp'),
        `真正的越界写入必须被抓住，越界清单：${JSON.stringify(result.violations)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('写集里的文件 → 不算越界（agent 的正当产出）', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, 'tools'), { recursive: true });
      writeFileSync(join(dir, 'tools', 'rd_lan.py'), 'print("hi")\n', 'utf-8');

      const result = auditWorktreeWrites(dir, WRITE_SET, {});

      assert.ok(
        !result.violations.includes('tools/rd_lan.py'),
        '写集里的文件不能算越界',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('D-60 监督进程路径：managedPaths 必须传（源码级锁定）', () => {
  it('supervisor.ts 的 installRuntimeGuard 调用带 managedPaths', () => {
    // 源码在仓库里，不在 dist-test 里 —— 从仓库根找。
    const repoRoot = process.cwd();
    const srcPath = join(repoRoot, 'src', 'cli', 'commands', 'supervisor.ts');
    assert.ok(existsSync(srcPath), `找不到源码：${srcPath}`);
    const src = readFileSync(srcPath, 'utf-8');

    const callIdx = src.indexOf('await installRuntimeGuard({');
    assert.ok(callIdx >= 0, 'supervisor.ts 里应有一处 installRuntimeGuard 调用');

    // 取这次调用的参数块（到匹配的右括号为止）
    const block = src.slice(callIdx, src.indexOf('});', callIdx) + 3);

    assert.match(
      block,
      /managedPaths:/,
      '监督进程必须传 managedPaths —— 少了它，zelto 自己放进 worktree 的' +
        '规格副本会被写集审计判成「agent 越界写入」（实测 v3-weaknet-verdict）',
    );
    assert.match(
      block,
      /zeltoOwnedPaths/,
      '托管清单必须用 zeltoOwnedPaths（与前台路径同源，不能另写一份）',
    );
  });
});

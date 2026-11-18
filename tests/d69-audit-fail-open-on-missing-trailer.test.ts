// D-69：trailer 丢了 → 审计认不出本片的提交 → 越界被放行（fail open）
//
// 病灶（实测 nimrtc-zelto，2026-11-18）：
//
//   Windows 上 `execSync` 走 cmd.exe，提交信息里的换行被 cmd 吞掉，
//   `Refs-Slice: <id>` trailer 静默丢失（详见 tests/d69-refs-slice-trailer-lost-in-shell.test.ts）。
//
//   而 zelto 自己的审计（ADR-067 D3）**只认 trailer** 来判断
//   「哪些提交是本片产出的」：
//
//     src/core/sched/audit.ts → commitsOfSlice() → hasRefsSlice()
//
//   trailer 一丢 → `commitsOfSlice` 返回空 → 审计的 changed 是空的
//   → violations 也是空的 → **越界提交被放行**。
//
//   这不是「记录不全」，是 C9 的兜底判据**失效** ——
//   「运行后 git 审计兜底」在 Windows 上从来没真的兜住过。
//
// 这一组用例守的是：
//   1. trailer 丢了，标题 `feat(<id>): slice approved` 仍能认出本片的提交；
//   2. 认出来之后，越界写入**照常被抓到**（兜底判据没有变成放行）；
//   3. trailer 与标题**都**认不出时 → 那些改动**仍要纳入审计**
//      （不能说「说不清」就不看 —— 那是 fail open）；
//      同时留痕「追溯链有断节」，但**不拦下**这一轮
//      （边界是确定的，只是归属没写明）；
//   4. 基点之后**没有**提交（agent 还没提交）→ 不是缺口，正常放行；
//   5. 别片的提交仍**不计入**本片（ADR-067 D3 的原意不能被破坏），
//      且**不能**被误判成「缺口」—— 那是 D-28 的正常场景；
//   6. 提交历史**读不出来**时 → 必须 fail closed（边界未知 ≠ 没有越界）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  auditWorktreeWrites,
  commitsOfSlice,
  hasRefsSlice,
  isSliceCommit,
} from '../src/core/sched/audit.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let dir: string;
let repo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zelto-d69-audit-'));
  repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@zelto.local'], repo);
  git(['config', 'user.name', 'zelto test'], repo);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** 提交一个文件，提交信息按给定的方式。 */
function commitFile(name: string, content: string, commitArgs: string[]): string {
  writeFileSync(join(repo, name), content);
  git(['add', '-A'], repo);
  execFileSync('git', ['commit', ...commitArgs], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return git(['rev-parse', 'HEAD'], repo).trim();
}

describe('D-69：认不出本片的提交时，审计必须 fail closed', () => {
  it('trailer 丢了 → 标题仍能认出本片的提交', () => {
    const base = git(['rev-parse', 'HEAD'], repo).trim();
    // trailer 丢失后的实际形态（cmd.exe 吞掉换行）
    const head = commitFile('out-of-scope.txt', 'oops\n', ['-m', 'feat(v9-demo): slice approved']);

    const commits = commitsOfSlice(repo, base, head, 'v9-demo');
    assert.equal(commits.length, 1, '标题判据应该认出本片的提交');
    assert.equal(commits[0], head);
  });

  it('认出来之后，越界写入照常被抓到（兜底判据没有变成放行）', () => {
    const base = git(['rev-parse', 'HEAD'], repo).trim();
    commitFile('out-of-scope.txt', 'oops\n', ['-m', 'feat(v9-demo): slice approved']);

    const res = auditWorktreeWrites(repo, ['allowed/**'], {
      baseCommit: base,
      sliceId: 'v9-demo',
    });

    assert.ok(
      res.violations.includes('out-of-scope.txt'),
      `越界必须被抓到，实际：${JSON.stringify(res.violations)}`,
    );
    assert.equal(res.coverageGap, null, '认出来了就不该有覆盖缺口');
  });

  it('trailer 与标题都认不出 → 改动仍纳入审计（不能因为说不清就放过）', () => {
    const base = git(['rev-parse', 'HEAD'], repo).trim();
    // 既没有 trailer，也没有 feat(<id>): 标题 —— 纯普通提交
    commitFile('out-of-scope.txt', 'oops\n', ['-m', 'chore: 说不清是谁写的']);

    const res = auditWorktreeWrites(repo, ['allowed/**'], {
      baseCommit: base,
      sliceId: 'v9-demo',
    });

    // 关键：说不清的提交 = 盲区，但它的改动**必须**被审计到。
    // 排除它 = 有可能放过真越界（fail open）。
    assert.ok(
      res.violations.includes('out-of-scope.txt'),
      `说不清归属的提交也必须被抓到，实际：${JSON.stringify(res.violations)}`,
    );
    // 同时留痕：追溯链有断节（这**不是**越界，也不该拦下这一轮）
    assert.ok(res.coverageGap, '追溯链断节必须留痕');
    assert.match(res.coverageGap, /没写明归属/);
  });

  it('说不清归属的提交也不该把这一轮判成越界（边界是确定的）', () => {
    const base = git(['rev-parse', 'HEAD'], repo).trim();
    // 说不清归属，但改的文件**在写集内**
    commitFile('in-set.txt', 'ok\n', ['-m', 'chore: 说不清是谁写的']);

    const res = auditWorktreeWrites(repo, ['in-set.txt'], {
      baseCommit: base,
      sliceId: 'v9-demo',
    });

    assert.deepEqual(res.violations, [], '写集内的改动不该算越界');
    assert.equal(res.error, null, '审计本身没失败');
    assert.ok(res.coverageGap, '但追溯链断节要留痕');
  });

  it('基点之后没有提交 → 不是缺口，正常放行', () => {
    const base = git(['rev-parse', 'HEAD'], repo).trim();

    const res = auditWorktreeWrites(repo, ['allowed/**'], {
      baseCommit: base,
      sliceId: 'v9-demo',
    });

    assert.equal(res.coverageGap, null, 'agent 还没提交东西，不是覆盖缺口');
    assert.deepEqual(res.violations, []);
  });

  it('别片的提交仍不计入本片（ADR-067 D3 的原意没被破坏）', () => {
    const base = git(['rev-parse', 'HEAD'], repo).trim();
    // 别片：trailer 与标题都指向别的切片
    commitFile('other.txt', 'other\n', [
      '-m',
      'feat(v8-other): slice approved',
      '-m',
      'Refs-Slice: v8-other',
    ]);

    const res = auditWorktreeWrites(repo, ['in-set.txt'], {
      baseCommit: base,
      sliceId: 'v9-demo',
    });

    // 别片的提交不该算成本片的越界
    assert.ok(!res.violations.includes('other.txt'), '别片的提交不算本片越界');
    assert.equal(res.coverageGap, null, '别片的提交不是「说不清归属」');
  });

  it('只有别片的提交、本片还没提交 → 不该被误判成缺口（D-28 的正常场景）', () => {
    // 这是我上一版判据的真缺陷：
    // 「基点之后有提交、但一个都认不出来」→ 报缺口 → 把一次成功的运行作废。
    //
    // 而 ADR-067 D3 的**正常场景**恰好就是这样：基点漂移 / 事后快进，
    // 让别片的提交出现在本片分支上，而本片 agent 还没提交任何东西。
    // 那时既不该报缺口，也不该把别片的提交算成本片越界。
    const base = git(['rev-parse', 'HEAD'], repo).trim();
    commitFile('other.txt', 'other\n', [
      '-m',
      'feat(v8-other): slice approved',
      '-m',
      'Refs-Slice: v8-other',
    ]);

    const res = auditWorktreeWrites(repo, ['in-set.txt'], {
      baseCommit: base,
      sliceId: 'v9-demo',
    });

    assert.deepEqual(res.violations, [], '别片的提交不算本片越界');
    assert.equal(res.coverageGap, null, '认得出归属（别片）就不是缺口');
    assert.equal(res.error, null, '审计本身没失败');
  });

  it('squash 合并的复数 trailer 也算明确声明（不算「说不清」）', () => {
    const base = git(['rev-parse', 'HEAD'], repo).trim();
    // squash 合并会把多片提交压成一条，写的是复数 trailer
    commitFile('squashed.txt', 'x\n', [
      '-m',
      'feat(demo): 端到端演示',
      '-m',
      'Refs-Slices: v8-other, v9-demo',
    ]);

    const res = auditWorktreeWrites(repo, ['allowed/**'], {
      baseCommit: base,
      sliceId: 'v9-demo',
    });

    assert.equal(res.coverageGap, null, '复数 trailer 是明确声明，不是断节');
    assert.ok(
      res.violations.includes('squashed.txt'),
      '声明了本片 id 的提交要纳入审计',
    );
  });

  it('isSliceCommit：标题精确匹配切片 id', () => {
    assert.equal(isSliceCommit('feat(v1-a): slice approved', 'v1-a'), true);
    // 前缀不能匹配
    assert.equal(isSliceCommit('feat(v1-ab): slice approved', 'v1-a'), false);
    // trailer 仍然认
    assert.equal(isSliceCommit('feat(x)\n\nRefs-Slice: v1-a', 'v1-a'), true);
    // 别的切片不认
    assert.equal(isSliceCommit('feat(v1-b): slice approved', 'v1-a'), false);
    // 合并提交算本片产物
    assert.equal(isSliceCommit('Merge slice v1-a', 'v1-a'), true);
    assert.equal(isSliceCommit('Merge slice v1-ab', 'v1-a'), false);
    // 无关提交不认
    assert.equal(isSliceCommit('chore: 无关提交', 'v1-a'), false);
  });

  it('hasRefsSlice 的老行为不变', () => {
    assert.equal(hasRefsSlice('feat(x)\n\nRefs-Slice: v1-a', 'v1-a'), true);
    assert.equal(hasRefsSlice('feat(x)\n\nRefs-Slice: v1-ab', 'v1-a'), false);
    assert.equal(hasRefsSlice('没有 trailer', 'v1-a'), false);
  });

  it('基点不可达 → 提交历史读不出来 → 必须报 error（fail closed）', () => {
    // 基点指向一个不存在的 commit → `git log` 失败。
    //
    // 这时「已提交部分」根本没被审计到 —— 但结果与「没有越界」无法区分。
    // 静默返回空 = fail open（越界提交被放行，所有记录都说正常）。
    const res = auditWorktreeWrites(repo, ['allowed/**'], {
      baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      sliceId: 'v9-demo',
    });

    assert.ok(res.error, '读不出来必须说出来 —— 边界未知 ≠ 没有越界');
    assert.match(res.error, /读取提交历史失败/);
  });

  it('基点不可达时的 error 不得被 coverageGap 掩盖', () => {
    const res = auditWorktreeWrites(repo, ['allowed/**'], {
      baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      sliceId: 'v9-demo',
    });

    // error 是「fail closed」的路，coverageGap 是「只留痕」的路 —— 不能混
    assert.ok(res.error);
    assert.equal(res.coverageGap, null);
  });
});

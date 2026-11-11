// worktree 基点回写（ADR-041 §3.2）
//
// 背景：`baseCommit` 是切片的基点 commit —— 建 worktree 分支时的主干位置。
// 合并守卫靠它判「基点漂移就拦合并」：
//
//   export function isStaleBase(baseCommit: string | null, repoRoot: string): boolean {
//     if (!baseCommit) return false;   // ← null 时判据形同虚设
//     ...
//   }
//
// 而 worktree 管理器其实知道基点（`ensureWorktree` 返回 `WorktreeInfo.baseCommit`），
// 只是没人把它写回切片状态 —— 于是 `baseCommit` 全是 null。
//
// 这里跑真实 git 仓库验证回写。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorktree, store } from '../src/cli/commands/shared.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zelto-base-commit-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  mkdirSync(join(dir, 'node_modules', 'some-pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = 1;\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('ensureWorktree — 基点回写（ADR-041 §3.2）', () => {
  let repo: string;
  let previousCwd: string;

  before(() => {
    previousCwd = process.cwd();
    repo = makeRepo();
    process.chdir(repo);
  });

  after(() => {
    process.chdir(previousCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('建完 worktree 后 baseCommit 不再是 null', async () => {
    const slice = store.create('wt-1', '带基点');
    await store.write(slice);
    assert.equal((await store.read('wt-1')).baseCommit, null);

    const info = await ensureWorktree('wt-1');
    assert.ok(info, '应在 git 仓库里建出 worktree');

    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    const after = await store.read('wt-1');
    assert.equal(after.baseCommit, head, '基点应等于建 worktree 时的主干位置');
  });

  it('已有 baseCommit 时不被覆盖（主干前进也不改）', async () => {
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();

    // 主干往前走一步 —— HEAD 已经不是基点了
    writeFileSync(join(repo, 'README2.md'), '# more\n');
    execFileSync('git', ['add', 'README2.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'second'], { cwd: repo });

    const slice = store.create('wt-2', '已有基点');
    slice.baseCommit = base;
    await store.write(slice);

    await ensureWorktree('wt-2');

    const after = await store.read('wt-2');
    assert.equal(after.baseCommit, base, '已有的基点不能被主干的新位置顶掉');
  });
});

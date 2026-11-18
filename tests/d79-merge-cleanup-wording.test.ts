// D-79：合并清理的两种失败必须**分开措辞**。
//
// 现状（D-40 之后）：判据是对的，但两处提示混着两种情况：
//
//   1. **判据没过**（`!merged`）—— 分支上还有未合入目标分支的内容。
//      这是**真需要人处理**的情形：要么去合，要么人工确认后强制删。
//   2. **git 拒绝删**（catch 分支）—— 判据过了（确实合入了），
//      但 git 自己不删（worktree 还占着 / 被别的进程锁住）。
//      这是**要人查锁**的情形。
//
// 两者的排查方向完全不同。提示长得几乎一样 → 人分不清该「去合」还是「去查锁」。
//
// 另外旧措辞 `it still has changes not merged into X` 在**版本分支场景**下
// 是不准确的假话（分支其实已经合进 `version/vN` 了，只是判据查的是别的地方）——
// 那正是 D-62/D-63 那个形态：说一个不成立的事实。
//
// 这份测试守住：
//   - 判据没过 → 提示说「还有未合入的内容」
//   - git 拒绝删 → 提示说「已合入目标分支，但 git 拒绝删除」
//   - 两者**能区分**（提示文本不同）
//   - 输出是中文（项目其它地方都是中文）

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { cleanupMergedSlices } from '../src/cli/commands/merge-runner.js';

const TEST_DIR = join(tmpdir(), `zelto-merge-cleanup-wording-${Date.now()}`);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function branches(cwd: string): string[] {
  return git(cwd, 'branch', '--format=%(refname:short)')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 抓取 `cleanupMergedSlices` 的 console 输出 */
async function captureCleanup(
  ids: string[],
  targetBranch: string | null,
  targetDir: string | null,
): Promise<{ out: string; after: string[] }> {
  const lines: string[] = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  process.chdir(TEST_DIR);
  try {
    await cleanupMergedSlices(ids, targetBranch, targetDir);
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
  }
  return { out: lines.join('\n'), after: branches(TEST_DIR) };
}

describe('D-79：合并清理的两种失败分开措辞', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, 'src'), { recursive: true });
    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 1;\n', 'utf-8');
    await writeFile(join(TEST_DIR, '.gitignore'), '.zelto/\n', 'utf-8');
    git(TEST_DIR, 'init', '-b', 'main');
    git(TEST_DIR, 'config', 'user.email', 'test@zelto.local');
    git(TEST_DIR, 'config', 'user.name', 'zelto test');
    git(TEST_DIR, 'add', '-A');
    git(TEST_DIR, 'commit', '-m', 'init');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('判据没过 → 如实说「还有未合入的内容」，且不删分支', async () => {
    // 一个有独立提交、既不在 main 也不在任何版本分支上的切片分支
    git(TEST_DIR, 'checkout', '-b', 'slice/d79-unmerged');
    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 99;\n', 'utf-8');
    git(TEST_DIR, 'add', '-A');
    git(TEST_DIR, 'commit', '-m', 'feat: unmerged work');
    git(TEST_DIR, 'checkout', 'main');

    const { out, after } = await captureCleanup(['d79-unmerged'], null, TEST_DIR);

    assert.ok(
      after.includes('slice/d79-unmerged'),
      `未合入的分支不该被删，实际分支：${after.join(', ')}`,
    );
    assert.ok(
      out.includes('未合入'),
      `应如实说「还有未合入的内容」，实际输出：${out}`,
    );
    assert.ok(
      !out.includes('merged elsewhere'),
      `不该报「已合到别处」，实际输出：${out}`,
    );
    // 旧措辞里那句「it still has changes not merged into」不该再出现
    assert.ok(
      !out.includes('it still has changes not merged'),
      `旧的英文措辞不该保留，实际输出：${out}`,
    );
  });

  it('git 拒绝删 → 说「已合入目标分支，但 git 拒绝删除」，与判据没过的措辞能区分', async () => {
    // 构造「已合入但删不掉」：
    //   分支已合进 main（判据通过），
    //   但它正被一个 worktree 占用 → git branch -d 拒绝。
    git(TEST_DIR, 'checkout', '-b', 'slice/d79-locked');
    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 42;\n', 'utf-8');
    git(TEST_DIR, 'add', '-A');
    git(TEST_DIR, 'commit', '-m', 'feat: locked work');
    git(TEST_DIR, 'checkout', 'main');
    git(TEST_DIR, 'merge', '--no-ff', 'slice/d79-locked', '-m', 'Merge d79-locked');

    // 用一个 worktree 占住这个分支
    const wtDir = join(TEST_DIR, 'wt-d79');
    await mkdir(wtDir, { recursive: true });
    git(TEST_DIR, 'worktree', 'add', wtDir, 'slice/d79-locked');

    const { out } = await captureCleanup(['d79-locked'], null, TEST_DIR);

    assert.ok(
      out.includes('已合入') && out.includes('拒绝删除'),
      `应说「已合入目标分支，但 git 拒绝删除」，实际输出：${out}`,
    );
    assert.ok(
      !out.includes('还有未合入'),
      `不该说「还有未合入的内容」—— 那是判据没过时的说法，实际输出：${out}`,
    );

    // 清理 worktree
    git(TEST_DIR, 'worktree', 'remove', '--force', wtDir);
  });

  it('两条提示都能区分（措辞不同）', async () => {
    // 再跑一遍两个场景，比对提示文本确实不同
    git(TEST_DIR, 'checkout', '-b', 'slice/d79-cmp-unmerged');
    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 7;\n', 'utf-8');
    git(TEST_DIR, 'add', '-A');
    git(TEST_DIR, 'commit', '-m', 'feat: cmp unmerged');
    git(TEST_DIR, 'checkout', 'main');

    const unmerged = await captureCleanup(['d79-cmp-unmerged'], null, TEST_DIR);

    git(TEST_DIR, 'checkout', '-b', 'slice/d79-cmp-locked');
    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 8;\n', 'utf-8');
    git(TEST_DIR, 'add', '-A');
    git(TEST_DIR, 'commit', '-m', 'feat: cmp locked');
    git(TEST_DIR, 'checkout', 'main');
    git(TEST_DIR, 'merge', '--no-ff', 'slice/d79-cmp-locked', '-m', 'Merge d79-cmp-locked');
    const wtDir2 = join(TEST_DIR, 'wt-d79-cmp');
    await mkdir(wtDir2, { recursive: true });
    git(TEST_DIR, 'worktree', 'add', wtDir2, 'slice/d79-cmp-locked');

    const locked = await captureCleanup(['d79-cmp-locked'], null, TEST_DIR);
    git(TEST_DIR, 'worktree', 'remove', '--force', wtDir2);

    assert.notEqual(
      unmerged.out.trim(),
      locked.out.trim(),
      '两种失败的提示必须能区分',
    );
    assert.ok(unmerged.out.includes('未合入'));
    assert.ok(locked.out.includes('拒绝删除'));
  });

  it('两条提示都是中文（项目其它地方的输出语言）', async () => {
    git(TEST_DIR, 'checkout', '-b', 'slice/d79-zh');
    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 11;\n', 'utf-8');
    git(TEST_DIR, 'add', '-A');
    git(TEST_DIR, 'commit', '-m', 'feat: zh');
    git(TEST_DIR, 'checkout', 'main');

    const { out } = await captureCleanup(['d79-zh'], null, TEST_DIR);

    assert.ok(
      !out.includes('Could not delete branch'),
      `不该再用英文提示「Could not delete branch」，实际输出：${out}`,
    );
    assert.ok(out.includes('未合入'), `提示应是中文，实际输出：${out}`);
  });
});

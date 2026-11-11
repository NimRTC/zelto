import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager, WorktreeError, WORKTREE_BASE_DIR } from '../../../src/core/worktree/index.js';

/** Create a throwaway git repo with one commit so worktree add can succeed. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zelto-wt-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  // node_modules exists so the manager links it into worktrees (as in the real repo)
  mkdirSync(join(dir, 'node_modules', 'some-pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = 1;\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('WorktreeManager — path conventions', () => {
  const manager = new WorktreeManager('/repo');

  it('uses a fixed path under .zelto/worktrees/<sliceId>', () => {
    assert.equal(manager.pathFor('demo'), join('/repo', WORKTREE_BASE_DIR, 'demo'));
    assert.equal(manager.relativePathFor('demo'), join(WORKTREE_BASE_DIR, 'demo'));
  });

  it('derives the branch name from the slice id', () => {
    assert.equal(manager.branchFor('demo'), 'slice/demo');
  });

  it('reports existence based on the filesystem', () => {
    assert.equal(new WorktreeManager(join(tmpdir(), 'zelto-nonexistent-repo')).exists('demo'), false);
  });
});

describe('WorktreeManager — create / list / remove', () => {
  let repo: string;

  before(() => {
    repo = makeRepo();
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('creates a worktree on a dedicated branch', async () => {
    const manager = new WorktreeManager(repo);
    const info = await manager.create('slice-a');

    assert.equal(info.branch, 'slice/slice-a');
    assert.equal(info.relativePath, join(WORKTREE_BASE_DIR, 'slice-a'));
    assert.ok(existsSync(info.path));
    assert.ok(info.baseCommit);

    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: info.path, encoding: 'utf-8',
    }).trim();
    assert.equal(head, 'slice/slice-a');
  });

  it('reuses an existing worktree instead of recreating it', async () => {
    const manager = new WorktreeManager(repo);
    const first = await manager.create('slice-b');
    const second = await manager.create('slice-b');

    assert.equal(first.path, second.path);
    assert.equal(manager.exists('slice-b'), true);
  });

  it('lists worktrees it manages', async () => {
    const manager = new WorktreeManager(repo);
    const list = await manager.list();
    const ids = list.map((w) => w.sliceId);
    assert.ok(ids.includes('slice-a'));
    assert.ok(ids.includes('slice-b'));
  });

  it('copies the spec file into the worktree', async () => {
    const manager = new WorktreeManager(repo);
    mkdirSync(join(repo, 'specs', 'slices'), { recursive: true });
    writeFileSync(join(repo, 'specs', 'slices', 'slice-c.md'), '# spec c\n');

    const info = await manager.create('slice-c', { specPath: 'specs/slices/slice-c.md' });
    assert.ok(existsSync(join(info.path, 'specs', 'slices', 'slice-c.md')));
  });

  it('removes the worktree and its git registration', async () => {
    const manager = new WorktreeManager(repo);
    await manager.create('slice-d');
    assert.ok(manager.exists('slice-d'));

    await manager.remove('slice-d');
    assert.equal(manager.exists('slice-d'), false);

    const list = await manager.list();
    assert.equal(list.some((w) => w.sliceId === 'slice-d'), false);
  });

  it('removes a worktree that has a linked node_modules', async () => {
    // A node_modules junction makes Windows paths exceed MAX_PATH — removal must
    // still succeed, otherwise the worktree leaks.
    const manager = new WorktreeManager(repo);
    const info = await manager.create('slice-with-deps');
    assert.ok(existsSync(join(info.path, 'node_modules')));

    await manager.remove('slice-with-deps', { force: true });
    assert.equal(manager.exists('slice-with-deps'), false);
  });

  it('throws WorktreeError instead of silently swallowing git failures', async () => {
    const manager = new WorktreeManager(join(repo, 'not-a-repo'));
    await assert.rejects(
      () => manager.create('slice-e'),
      (err: unknown) => err instanceof WorktreeError,
    );
  });
});

// ─── ADR-044：worktree 里的 submodule ──────────────────────────────────────

describe('WorktreeManager — submodules (ADR-044)', () => {
  /**
   * 建一个带「本地 submodule」的仓库：submodule 的源是一个本地 bare 仓库，
   * 不需要网络。子模块路径用 `vendor/lib` 这种普通目录名，避免 git 2.49
   * 对 `src/third_party/x/src` 这类嵌套路径的额外处理。
   */
  function makeRepoWithSubmodule(): { repo: string; subPath: string } {
    const root = mkdtempSync(join(tmpdir(), 'zelto-wt-sub-'));
    const subOrigin = join(root, 'sub-origin');
    const subWork = join(root, 'sub-work');

    // submodule 的源
    mkdirSync(subOrigin, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: subOrigin, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: subOrigin });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: subOrigin });
    writeFileSync(join(subOrigin, 'lib.txt'), 'vendored content\n');
    execFileSync('git', ['add', '.'], { cwd: subOrigin });
    execFileSync('git', ['commit', '-m', 'sub init'], { cwd: subOrigin });

    // 主仓
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['config', 'protocol.file.allow', 'always'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', subOrigin, 'vendor/lib'],
      { cwd: repo, stdio: 'ignore' },
    );
    execFileSync('git', ['commit', '-m', 'add submodule'], { cwd: repo });

    // 主仓里把 submodule 初始化出来（本地 objects 已就位）
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'vendor/lib'],
      { cwd: repo, stdio: 'ignore' },
    );

    void subWork;
    return { repo, subPath: 'vendor/lib' };
  }

  it('populates submodule content inside the new worktree', async () => {
    const { repo, subPath } = makeRepoWithSubmodule();
    try {
      const manager = new WorktreeManager(repo);
      const info = await manager.create('with-sub');

      // worktree 里 submodule 的源码树必须存在 —— 空目录会让配置阶段直接失败
      assert.ok(
        existsSync(join(info.path, subPath, 'lib.txt')),
        'submodule content should be present in the worktree',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(join(repo, '..'), { recursive: true, force: true });
    }
  });

  it('reports which submodules were initialized and which were skipped', async () => {
    const { repo, subPath } = makeRepoWithSubmodule();
    try {
      const manager = new WorktreeManager(repo);
      const info = await manager.create('report-sub');

      const result = manager.syncSubmodules(info.path);

      assert.deepEqual(result.initialized, [subPath]);
      assert.deepEqual(result.skipped, []);
    } finally {
      rmSync(join(repo, '..'), { recursive: true, force: true });
    }
  });

  it('skips submodules that are not populated in the main repo (no network fetch)', async () => {
    const { repo } = makeRepoWithSubmodule();
    try {
      // 删掉主仓里的 submodule 工作树 —— 它不再是「本地已有 objects」
      rmSync(join(repo, 'vendor', 'lib'), { recursive: true, force: true });

      const manager = new WorktreeManager(repo);
      const info = await manager.create('skip-sub');
      const result = manager.syncSubmodules(info.path);

      assert.deepEqual(result.initialized, []);
      assert.deepEqual(result.skipped, ['vendor/lib']);
    } finally {
      rmSync(join(repo, '..'), { recursive: true, force: true });
    }
  });

  it('does nothing when the repository has no .gitmodules', () => {
    const repo = mkdtempSync(join(tmpdir(), 'zelto-wt-nosub-'));
    try {
      const manager = new WorktreeManager(repo);
      const result = manager.syncSubmodules(manager.pathFor('anything'));

      assert.deepEqual(result.initialized, []);
      assert.deepEqual(result.skipped, []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('copies vendored submodule content that has no .git in the main repo', async () => {
    // 有些工程把 submodule 的源码当普通文件提交（或者只拷了源码、
    // 没保留 gitlink 关系）—— 主仓里没有 `.git`，但**有内容**。
    //
    // 这种情况下 worktree 里那个目录也必须是空的，但主仓里有内容可抄。
    // 不抄的话，agent 会去网络上现拉 —— 离线环境里直接卡死。
    const root = mkdtempSync(join(tmpdir(), 'zelto-wt-vendored-'));
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# test\n');

    // 登记一个 submodule，但**不初始化**它 —— 只留一份普通文件内容
    writeFileSync(
      join(repo, '.gitmodules'),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.invalid/lib.git\n',
    );
    mkdirSync(join(repo, 'vendor', 'lib'), { recursive: true });
    writeFileSync(join(repo, 'vendor', 'lib', 'lib.txt'), 'vendored content\n');

    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    try {
      const manager = new WorktreeManager(repo);
      const info = await manager.create('vendored-sub');

      assert.ok(
        existsSync(join(info.path, 'vendor', 'lib', 'lib.txt')),
        'vendored content should be copied into the worktree',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('initializes a submodule whose .gitmodules name differs from its path', async () => {
    // section 名（name）与落盘路径（path）不同时，配置键要用 name。
    // 用错了键就会「改错 submodule」—— 表面上没报错，内容却没进来。
    const root = mkdtempSync(join(tmpdir(), 'zelto-wt-subname-'));
    const subOrigin = join(root, 'sub-origin');
    mkdirSync(subOrigin, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: subOrigin, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: subOrigin });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: subOrigin });
    writeFileSync(join(subOrigin, 'lib.txt'), 'vendored content\n');
    execFileSync('git', ['add', '.'], { cwd: subOrigin });
    execFileSync('git', ['commit', '-m', 'sub init'], { cwd: subOrigin });

    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['config', 'protocol.file.allow', 'always'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'gtest-lib', subOrigin, 'vendor/lib'],
      { cwd: repo, stdio: 'ignore' },
    );
    execFileSync('git', ['commit', '-m', 'add submodule'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'vendor/lib'],
      { cwd: repo, stdio: 'ignore' },
    );

    try {
      const manager = new WorktreeManager(repo);
      const info = await manager.create('named-sub');

      assert.ok(
        existsSync(join(info.path, 'vendor', 'lib', 'lib.txt')),
        'submodule content should be present even when name != path',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

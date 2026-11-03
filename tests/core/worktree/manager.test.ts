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

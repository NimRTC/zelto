import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager, WorktreeError, WORKTREE_BASE_DIR } from '../../../src/core/worktree/index.js';
import { verifyWorktreeSpecSync } from '../../../src/cli/commands/shared.js';

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

  // ─── D-47：规格改了，复用 worktree 时必须重新同步 ─────────────────────
  //
  // 病灶（nimrtc-zelto v2-ai-decision，2026-11-17）：
  //   worktree 05:12 创建（规格 4 条验收标准）
  //   → 09:04 人把规格重写成 9 条
  //   → 10:00 重跑 agent —— agent 读到的是 worktree 里的**旧 4 条**，
  //     照着旧规格实现，缺了六项
  //
  // **判据分裂**：门禁按新规格判，agent 按旧规格干 ——
  // 拦住的不是「实现有 bug」，而是「实现的是另一个需求」。
  // 每一道闸门单独看都在正常工作，所以这种失败最难查。
  //
  // 规格是 agent 的**输入**，输入必须在每次开跑前对齐到当前真源。
  describe('D-47 · 复用 worktree 时重新同步规格与验收目录', () => {
    it('规格在 worktree 创建后被改写 → 复用时同步新版本', async () => {
      const manager = new WorktreeManager(repo);
      mkdirSync(join(repo, 'specs', 'slices'), { recursive: true });
      const specRel = 'specs/slices/slice-sync.md';
      const specAbs = join(repo, specRel);
      writeFileSync(specAbs, '# 旧规格（4 条）\n');

      const info = await manager.create('slice-sync', { specPath: specRel });
      const wtSpec = join(info.path, specRel);
      assert.equal(readFileSync(wtSpec, 'utf-8'), '# 旧规格（4 条）\n');

      // 人重写了规格（freeze --refreeze 的前置动作）
      writeFileSync(specAbs, '# 新规格（9 条）\n');

      // 复用 worktree —— 必须把新规格带进去
      await manager.create('slice-sync', { specPath: specRel });
      assert.equal(
        readFileSync(wtSpec, 'utf-8'),
        '# 新规格（9 条）\n',
        '复用 worktree 时必须同步新规格 —— agent 读到旧规格就等于实现另一个需求',
      );
    });

    it('验收目录在 worktree 创建后被改写 → 不覆盖 agent 已有的验收文件', async () => {
      const manager = new WorktreeManager(repo);
      const accRel = 'tests/acceptance/slice-sync-acc';
      mkdirSync(join(repo, accRel), { recursive: true });
      writeFileSync(join(repo, accRel, 'acceptance.test.cjs'), '// 旧断言\n');

      const info = await manager.create('slice-sync-acc', { acceptanceDir: accRel });
      const wtAcc = join(info.path, accRel, 'acceptance.test.cjs');
      assert.equal(readFileSync(wtAcc, 'utf-8'), '// 旧断言\n');

      // agent 在 worktree 里写了真断言 —— 这是 agent 的产出，真源在 worktree
      writeFileSync(wtAcc, '// agent 写的真断言\n');

      // 主仓那份被改回骨架（合并前主仓仍是旧的）
      writeFileSync(join(repo, accRel, 'acceptance.test.cjs'), '// 主仓的 todo 骨架\n');

      await manager.create('slice-sync-acc', { acceptanceDir: accRel });
      assert.equal(
        readFileSync(wtAcc, 'utf-8'),
        '// agent 写的真断言\n',
        '验收测试是 agent 的产出 —— 同步不能覆盖它（否则拿 agent 的成果换 agent 的成果）',
      );
    });

    it('主仓新增的验收文件 → 补进 worktree（那是人的产出，agent 该看到）', async () => {
      const manager = new WorktreeManager(repo);
      const accRel = 'tests/acceptance/slice-new-acc';
      mkdirSync(join(repo, accRel), { recursive: true });

      const info = await manager.create('slice-new-acc', { acceptanceDir: accRel });
      const wtAcc = join(info.path, accRel);

      // 人后来在主仓加了一个回归用例
      writeFileSync(join(repo, accRel, 'regression.test.cjs'), '// 人加的回归用例\n');

      await manager.create('slice-new-acc', { acceptanceDir: accRel });
      assert.ok(
        existsSync(join(wtAcc, 'regression.test.cjs')),
        '主仓新增的验收文件应当补进 worktree',
      );
    });

    it('同步不会覆盖 agent 在 worktree 里的代码改动', async () => {
      const manager = new WorktreeManager(repo);
      const specRel = 'specs/slices/slice-keep.md';
      mkdirSync(join(repo, 'specs', 'slices'), { recursive: true });
      writeFileSync(join(repo, specRel), '# 规格\n');

      const info = await manager.create('slice-keep', { specPath: specRel });
      // agent 在 worktree 里写的代码
      const agentFile = join(info.path, 'agent-output.cpp');
      writeFileSync(agentFile, '// agent 的产出\n');

      await manager.create('slice-keep', { specPath: specRel });
      assert.equal(
        readFileSync(agentFile, 'utf-8'),
        '// agent 的产出\n',
        '同步规格不能动 agent 的产出 —— 只同步规格与验收目录',
      );
    });
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

  it('populates submodules offline from local objects even when the main repo working tree is gone', async () => {
    const { repo, subPath } = makeRepoWithSubmodule();
    try {
      // 删掉主仓里的 submodule **工作树** —— 但 objects 还在
      // （`.git/modules/vendor/lib/objects/` 里）。
      //
      // 老判据是「主仓工作树没了 = 本地没有 objects」→ 跳过，
      // 留下一个**空 vendor 目录**，门禁②的 build 阶段才炸
      // （报错是「找不到头文件」，跟真正的原因毫无关系 —— ADR-095 §2.3）。
      //
      // 实测（2026-11-23）：**objects 一直都在** —— 删掉工作树不动对象库。
      // 真正会「本地没有 objects」的情形是 objects 也没了
      // （见下一个用例）。
      //
      // 所以这里改成：**本地有 objects 就离线同步**（不触网）。
      rmSync(join(repo, 'vendor', 'lib'), { recursive: true, force: true });

      const manager = new WorktreeManager(repo);
      const info = await manager.create('offline-sub');
      const result = manager.syncSubmodules(info.path);

      assert.deepEqual(result.skipped, [], '本地有 objects 就该同步，不该跳过');
      assert.deepEqual(result.initialized, [subPath]);
      assert.ok(
        existsSync(join(info.path, subPath, 'lib.txt')),
        '离线同步后 vendor 内容必须在 —— 空 vendor 目录会让 build 阶段炸',
      );
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

  it('skips a submodule whose local objects are genuinely gone (never touches the network)', async () => {
    const { repo } = makeRepoWithSubmodule();
    try {
      // 这次连**对象库**一起删掉 —— 才是真正的「本地没有 objects」。
      // （只删工作树的话 objects 还在，见上面那个用例。）
      rmSync(join(repo, 'vendor', 'lib'), { recursive: true, force: true });
      rmSync(join(repo, '.git', 'modules', 'vendor', 'lib'), { recursive: true, force: true });

      const manager = new WorktreeManager(repo);
      const info = await manager.create('no-objects-sub');
      const result = manager.syncSubmodules(info.path);

      // 本地真的什么都没有 → 跳过，**不联网**（C3）。
      // 失败原因要留痕（D-73），人才能知道缺什么。
      assert.deepEqual(result.initialized, []);
      assert.deepEqual(result.skipped, ['vendor/lib']);
      assert.ok(
        manager.submoduleFailures.length > 0,
        '同步失败必须留痕 —— 否则「vendor 没同步上」完全不显形（D-73）',
      );
    } finally {
      rmSync(join(repo, '..'), { recursive: true, force: true });
    }
  });

  it('initializes a submodule cloned as a standalone nested repo (.git is a directory)', async () => {
    // 有些工程不把 submodule 放进 `.git/modules/`，而是让它自带一个
    // **独立的 .git 目录**（独立嵌套克隆）。
    //
    // 原来只找 `.git/modules/<name>`，这种布局就整个漏掉 —— worktree 里
    // 那个目录是空的，或者内容来自错误的 commit（ADR-047）。
    const root = mkdtempSync(join(tmpdir(), 'zelto-wt-nested-'));
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

    // 登记 submodule，然后把它的 .git 换成**独立目录**（模拟嵌套克隆）
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', subOrigin, 'vendor/lib'],
      { cwd: repo, stdio: 'ignore' },
    );
    execFileSync('git', ['commit', '-m', 'add submodule'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'vendor/lib'],
      { cwd: repo, stdio: 'ignore' },
    );

    // 把它从共享布局搬到独立目录
    const sharedGitDir = join(repo, '.git', 'modules', 'vendor', 'lib');
    const nestedGitDir = join(repo, 'vendor', 'lib', '.git');
    if (existsSync(sharedGitDir) && existsSync(nestedGitDir)) {
      rmSync(nestedGitDir, { recursive: true, force: true });
      cpSync(sharedGitDir, nestedGitDir, { recursive: true });
      rmSync(sharedGitDir, { recursive: true, force: true });
    }

    try {
      const manager = new WorktreeManager(repo);
      const info = await manager.create('nested-sub');

      assert.ok(
        existsSync(join(info.path, 'vendor', 'lib', 'lib.txt')),
        'nested-clone submodule content should be present in the worktree',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('aligns submodules to the pointer recorded in the worktree index (ADR-047)', async () => {
    // 场景：共享 module git 目录的 HEAD 漂到了别的 commit（被别人改过），
    // 而主仓 index 记的是另一个。同步完必须检出到 index 记的那个 ——
    // 否则 `git status` 报 vendor 被改，审计误判成 agent 越界。
    const { repo, subPath } = makeRepoWithSubmodule();
    try {
      const manager = new WorktreeManager(repo);
      const info = await manager.create('align-sub');

      const recorded = execFileSync('git', ['ls-files', '-s', '--', subPath], {
        cwd: info.path, encoding: 'utf-8',
      });
      const target = recorded.match(/^160000 ([0-9a-f]{40})/)?.[1];
      assert.ok(target, 'should have a recorded gitlink');

      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: join(info.path, subPath), encoding: 'utf-8',
      }).trim();
      assert.equal(head, target, 'worktree submodule should sit on the recorded pointer');
    } finally {
      rmSync(join(repo, '..'), { recursive: true, force: true });
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

  // ── 嵌套 submodule：从主仓的 module git 目录本地克隆（不触网）─────────
  //
  // 病灶（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
  //
  //   `git submodule update --init` 只处理**顶层** submodule。
  //   嵌套层（msquic 的 googletest / quictls / openssl …）在 worktree 里
  //   就是**空目录** —— 门禁的 configure 阶段直接报「找不到 googletest」。
  //
  //   用 `--recursive` 会更糟：git 只认 `.gitmodules` 里写的 https URL，
  //   于是去**联网**克隆（实测挂起 5 分钟以上，且违反 C3）。
  //
  // 修法：把克隆源显式指到主仓的嵌套 module git 目录。
  // 布局（实测）：`<主仓>/.git/modules/<顶层path>/modules/<嵌套path>`
  //
  // 这里踩了三个坑，每一个都表现为「静默跳过」，所以必须有回归：
  //   1. 路径多拼一层 `submodules/` → 找不到克隆源 → 跳过；
  //   2. `-c` 放在子命令**之后** → git 报 usage 错误 → 跳过；
  //   3. 顶层路径用 `path` 还是 `name` → 找错 module 目录。
  it('clones nested submodules from the main repo module git dir (no network)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-wt-nested-sub-'));

    // 嵌套 submodule 的源
    const nestedOrigin = join(root, 'nested-origin');
    mkdirSync(nestedOrigin, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: nestedOrigin, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: nestedOrigin });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: nestedOrigin });
    writeFileSync(join(nestedOrigin, 'nested.txt'), 'nested content\n');
    execFileSync('git', ['add', '.'], { cwd: nestedOrigin, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'nested init'], { cwd: nestedOrigin, stdio: 'ignore' });

    // 顶层 submodule 的源（它自己又带一层 submodule）
    const topOrigin = join(root, 'top-origin');
    mkdirSync(topOrigin, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: topOrigin, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: topOrigin });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: topOrigin });
    writeFileSync(join(topOrigin, 'top.txt'), 'top content\n');
    execFileSync('git', ['add', '.'], { cwd: topOrigin, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'top init'], { cwd: topOrigin, stdio: 'ignore' });

    // 在顶层里**正规注册**嵌套 submodule（写成 gitlink，index mode 160000）
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', nestedOrigin, 'submodules/nested'],
      { cwd: topOrigin, stdio: 'ignore' },
    );
    execFileSync('git', ['commit', '-m', 'add nested submodule'], { cwd: topOrigin, stdio: 'ignore' });

    // 把嵌套的克隆源改回 https —— 模拟真实工程（msquic 的 .gitmodules 就是 https）。
    // 这样如果代码没有显式覆盖克隆源，就会去联网（C3 禁止）。
    execFileSync(
      'git',
      ['config', '-f', '.gitmodules', 'submodule.submodules/nested.url', 'https://example.invalid/nested.git'],
      { cwd: topOrigin, stdio: 'ignore' },
    );
    execFileSync('git', ['add', '.gitmodules'], { cwd: topOrigin, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'point nested at https'], { cwd: topOrigin, stdio: 'ignore' });

    // 主仓：把顶层 submodule 加进来并初始化
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['config', 'protocol.file.allow', 'always'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', topOrigin, 'vendor/top'],
      { cwd: repo, stdio: 'ignore' },
    );
    execFileSync('git', ['commit', '-m', 'add top submodule'], { cwd: repo, stdio: 'ignore' });
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'vendor/top'],
      { cwd: repo, stdio: 'ignore' },
    );

    // 把嵌套层也在主仓里初始化出来 —— 它的 module git 目录
    // 会落在 `.git/modules/vendor/top/modules/submodules/nested`
    //
    // 覆盖克隆源为本地：嵌套的 .gitmodules 里写的是 https URL，
    // 真按那个走会触网（C3 禁止），这里必须指到本地 origin。
    execFileSync(
      'git',
      [
        '-c', 'protocol.file.allow=always',
        '-c', `submodule.submodules/nested.url=${nestedOrigin}`,
        'submodule', 'update', '--init', 'submodules/nested',
      ],
      { cwd: join(repo, 'vendor', 'top'), stdio: 'ignore' },
    );

    try {
      const manager = new WorktreeManager(repo);
      const info = await manager.create('nested-sub-clone');

      assert.ok(
        existsSync(join(info.path, 'vendor', 'top', 'submodules', 'nested', 'nested.txt')),
        'nested submodule content should be cloned into the worktree from local objects',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── D-47：worktree 里的规格副本必须与主仓真源一致 ──────────────────────
//
// 病灶（实测于 nimrtc-zelto v2-ai-decision，2026-11-17）：
//
//   主仓规格 = 9 条验收标准（partial / barge_in / agent-control / framed …）
//   worktree 里的副本 = 4 条（LLM 草稿：延迟 / 准确率 / 3 种策略 / 日志）
//   → agent 老老实实实现了那 4 条
//   → 门禁按 9 条判 → **判定分裂**：拦住的不是「实现有 bug」，
//     而是「实现的是另一个需求」。每一道闸门单独看都在正常工作。
//
// 所以规格副本的对齐不能靠「同步动作跑过了」来保证 ——
// 必须**在起跑前**比对内容哈希，不一致就拦下。
describe('D-47：规格副本对齐校验', () => {
  let repo: string;

  before(() => {
    repo = makeRepo();
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('副本与主仓一致 → 通过', () => {
    const specPath = 'specs/slices/demo.md';
    mkdirSync(join(repo, 'specs', 'slices'), { recursive: true });
    writeFileSync(join(repo, specPath), '# 规格\n', 'utf-8');
    const wt = mkdtempSync(join(tmpdir(), 'zelto-wt-spec-'));
    mkdirSync(join(wt, 'specs', 'slices'), { recursive: true });
    writeFileSync(join(wt, specPath), '# 规格\n', 'utf-8');

    const cwd = process.cwd();
    try {
      process.chdir(repo);
      const result = verifyWorktreeSpecSync('demo', wt, specPath, null);
      assert.equal(result.ok, true, result.reason);
    } finally {
      process.chdir(cwd);
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('副本是旧版 → 拦下，并说清两边哈希', () => {
    const specPath = 'specs/slices/demo.md';
    mkdirSync(join(repo, 'specs', 'slices'), { recursive: true });
    writeFileSync(join(repo, specPath), '# 新规格（9 条）\n', 'utf-8');
    const wt = mkdtempSync(join(tmpdir(), 'zelto-wt-spec-'));
    mkdirSync(join(wt, 'specs', 'slices'), { recursive: true });
    writeFileSync(join(wt, specPath), '# 旧规格（4 条）\n', 'utf-8');

    const cwd = process.cwd();
    try {
      process.chdir(repo);
      const result = verifyWorktreeSpecSync('demo', wt, specPath, null);
      assert.equal(result.ok, false, '旧副本必须被拦下');
      assert.match(result.reason, /旧版/);
    } finally {
      process.chdir(cwd);
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('worktree 里没有副本 → 拦下（agent 会拿不到规格）', () => {
    const specPath = 'specs/slices/demo2.md';
    mkdirSync(join(repo, 'specs', 'slices'), { recursive: true });
    writeFileSync(join(repo, specPath), '# 规格\n', 'utf-8');
    const wt = mkdtempSync(join(tmpdir(), 'zelto-wt-spec-'));

    const cwd = process.cwd();
    try {
      process.chdir(repo);
      const result = verifyWorktreeSpecSync('demo2', wt, specPath, null);
      assert.equal(result.ok, false);
      assert.match(result.reason, /没有规格副本/);
    } finally {
      process.chdir(cwd);
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

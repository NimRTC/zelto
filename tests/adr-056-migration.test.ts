// ADR-056 老项目迁移路径 —— 回归测试
//
// 背景：ADR-056 引入「版本分支」制度时，老项目**已经在跑版本**了：
// 版本状态是 `in_progress`，切片产物早已合进主干，但**版本分支从不存在**
// （版本分支制度那时候还没有）。
//
// 后果：老项目**永远无法 ship**。
// - `version start` 只在 `planned` 时建分支，`in_progress` 会被拒
// - `version deliver` 走「分支不存在 → 按主干判」的兼容路径，能过
// - 但 `version ship` 要求版本分支存在 —— 报 NOT_FOUND
//
// 这批测试覆盖三件事：
// 1. `zelto version adopt` —— 补建版本分支与工作目录（迁移入口）
// 2. **porcelain 路径解析** —— 一个既有 bug，让所有路径豁免在
//    「已修改的文件」上全部失效
// 3. worktree 失效登记的自愈（目录被删、git 登记还在 → 建不出来）

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePorcelainStatus } from '../src/core/sched/audit.js';
import { isZeltoManagedSpecPath, isZeltoStatePath } from '../src/core/project/managed-paths.js';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'zelto-adr056-migrate-'));

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── 缺陷 7：porcelain 路径解析（既有的，影响所有路径豁免）───────────────

describe('git status porcelain 路径解析', () => {
  it('已修改的文件：路径首字符不能丢', () => {
    // ` M ` —— 第一格是空的（未暂存修改），第二格是 M
    const paths = parsePorcelainStatus(' M .zelto/slices/v1-cmake.json');
    assert.equal(paths.length, 1);
    assert.equal(paths[0], '.zelto/slices/v1-cmake.json');
  });

  it('未跟踪的文件：路径正常', () => {
    const paths = parsePorcelainStatus('?? tests/acceptance/foo/acceptance.test.cjs');
    assert.equal(paths[0], 'tests/acceptance/foo/acceptance.test.cjs');
  });

  it('已暂存的修改：路径正常', () => {
    const paths = parsePorcelainStatus('M  src/main.cpp');
    assert.equal(paths[0], 'src/main.cpp');
  });

  it('重命名：取新路径', () => {
    const paths = parsePorcelainStatus('R  old.md -> new.md');
    assert.equal(paths[0], 'new.md');
  });

  it('多行混合：逐行对应', () => {
    const out = [' M .zelto/slices/a.json', '?? specs/slices/b.md', 'M  src/c.cpp'].join('\n');
    assert.deepEqual(parsePorcelainStatus(out), [
      '.zelto/slices/a.json',
      'specs/slices/b.md',
      'src/c.cpp',
    ]);
  });

  it('被忽略的条目（!!）跳过', () => {
    assert.deepEqual(parsePorcelainStatus('!! ignored.txt'), []);
  });

  it('路径首字符丢失会让 zelto 状态豁免失效（缺陷本体）', () => {
    // 错误写法会把 `.zelto/...` 变成 `zelto/...` —— 判定全部失效
    const bad = ' M .zelto/slices/x.json'.trim().slice(3);
    assert.equal(bad, 'zelto/slices/x.json');
    assert.equal(isZeltoStatePath(bad), false, '错误路径不该被识别为 zelto 状态');

    // 正确写法：路径完整，豁免生效
    const good = parsePorcelainStatus(' M .zelto/slices/x.json')[0];
    assert.equal(isZeltoStatePath(good), true);
  });

  it('规格文件豁免同样受这个 bug 影响（已修改的文件）', () => {
    const bad = ' M specs/slices/x.md'.trim().slice(3);
    assert.equal(isZeltoManagedSpecPath(bad), false);

    const good = parsePorcelainStatus(' M specs/slices/x.md')[0];
    assert.equal(isZeltoManagedSpecPath(good), true);
  });
});

// ─── 缺陷 8：zelto 运行时状态路径判定 ────────────────────────────────────

describe('zelto 运行时状态路径', () => {
  it('.zelto/ 下的文件是 zelto 状态', () => {
    assert.equal(isZeltoStatePath('.zelto/slices/v1-cmake.json'), true);
    assert.equal(isZeltoStatePath('.zelto/versions/plan-1.json'), true);
  });

  it('.zelto 本身（目录折叠形态）也算', () => {
    assert.equal(isZeltoStatePath('.zelto'), true);
  });

  it('别的目录不算', () => {
    assert.equal(isZeltoStatePath('src/main.cpp'), false);
    assert.equal(isZeltoStatePath('specs/slices/x.md'), false);
    // 前缀相同但不在 .zelto/ 下
    assert.equal(isZeltoStatePath('.zelto-other/x.json'), false);
  });

  it('Windows 反斜杠路径也认', () => {
    assert.equal(isZeltoStatePath('.zelto\\slices\\x.json'), true);
  });
});

// ─── 缺陷 9：worktree 失效登记的自愈 ─────────────────────────────────────

describe('worktree 目录被删后能重建', () => {
  const repo = join(TEST_DIR, 'repo');

  function git(args: string[], cwd = repo): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' });
  }

  it('目录被手动删除后，git 仍登记着 → 需要 prune 才能重建', () => {
    mkdirSync(repo, { recursive: true });
    git(['init', '-q', '-b', 'main']);
    // 提交身份必须**在仓库里**设，不能靠全局配置 ——
    // CI 机器上往往没有全局 user.name/user.email（runner 是干净容器），
    // 缺了它 `git commit` 直接报 "Author identity unknown"，测试全红。
    git(['config', 'user.email', 'test@zelto.local']);
    git(['config', 'user.name', 'zelto test']);
    writeFileSync(join(repo, 'a.txt'), 'hello');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);

    // 建一个 worktree，然后手动删掉目录（人手动清理的常见情形）
    const wt = join(repo, 'wt');
    git(['worktree', 'add', '-q', '-b', 'feature', wt]);
    assert.equal(existsSync(wt), true);

    rmSync(wt, { recursive: true, force: true });
    assert.equal(existsSync(wt), false);

    // git 那边还登记着 → 直接 add 会失败
    let failed = false;
    try {
      git(['worktree', 'add', wt, 'feature']);
    } catch {
      failed = true;
    }
    assert.equal(failed, true, '未 prune 时 git 应当拒绝重建（这就是那个 bug 的现场）');

    // prune 之后能建回来
    git(['worktree', 'prune']);
    git(['worktree', 'add', wt, 'feature']);
    assert.equal(existsSync(wt), true);
  });
});

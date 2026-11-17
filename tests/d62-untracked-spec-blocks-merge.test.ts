// D-62：未跟踪的规格文件副本挡住了合并 —— 守卫豁免了，git 却硬拦
//
// 病灶（实测 nimrtc-zelto，2026-11-18，`zelto version ship v3`）：
//
//   主仓工作区里有几个**未跟踪**的规格文件：
//
//     ?? specs/slices/v3-chrome-waterfall.md
//     ?? specs/slices/v3-weaknet-verdict.md
//
//   合并守卫把它们算成「zelto 管理的规格文件」→ **豁免** →
//   报一句「4 个 zelto 管理的规格文件未提交（不影响 ship）」就放行了。
//
//   然后 git 自己不认这个豁免：
//
//     error: The following untracked working tree files would be overwritten by merge:
//             specs/slices/v3-chrome-waterfall.md
//             specs/slices/v3-weaknet-verdict.md
//
//   ship 失败。而且失败信息是 git 的原话 ——
//   人看到的是「ship 失败」，看不到「是 zelto 自己的豁免跟 git 的硬拦冲突」。
//
//   更要命的是：这不是偶发。zelto 每写一份新规格就会多一个这样的副本，
//   下次 ship 照样撞同一个坑。
//
// 这一组用例守的是：
//   1. 未跟踪的规格副本**内容一致**（只差行尾）→ 删掉，让合并能落下来；
//   2. 内容**不一致** → 不删，报出来（保守方向：误删比失败贵）；
//   3. **不是** zelto 托管规格的路径（人的代码）→ 绝不碰；
//   4. ref 上没有那个文件 → 不用管（合并不会覆盖它）；
//   5. 真的能解开 git 的硬拦：清理完 git merge 确实能过。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearUntrackedManagedSpecs } from '../src/core/project/untracked-specs.js';

const SPEC_TEXT = '# Slice: v3-x\n\n## 范围\n- tools/rd_lan.py\n';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/** 建一个仓库：main 上有一份规格，切片分支上有另一份。 */
function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@zelto.local'], dir);
  git(['config', 'user.name', 'zelto test'], dir);
  writeFileSync(join(dir, 'keep.txt'), 'keep\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  git(['checkout', '-q', '-b', 'slice/v3-x'], dir);
  mkdirSync(join(dir, 'specs', 'slices'), { recursive: true });
  writeFileSync(join(dir, 'specs', 'slices', 'v3-x.md'), SPEC_TEXT, 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'spec on branch'], dir);
  git(['checkout', '-q', 'main'], dir);
}

describe('D-62：未跟踪的规格文件副本不能挡住合并', () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-d62-'));
    repo = join(dir, 'repo');
    makeRepo(repo);
    mkdirSync(join(repo, 'specs', 'slices'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('内容一致（只差行尾）→ 删掉未跟踪副本', () => {
    // 工作区里的副本是 CRLF 的（Windows 上 zelto 写的），ref 上是 LF 的
    writeFileSync(join(repo, 'specs', 'slices', 'v3-x.md'), SPEC_TEXT.replace(/\n/g, '\r\n'), 'utf-8');

    const res = clearUntrackedManagedSpecs(repo, 'refs/heads/slice/v3-x');
    assert.deepEqual(res.removed, ['specs/slices/v3-x.md']);
    assert.deepEqual(res.conflicts, []);
    assert.equal(existsSync(join(repo, 'specs', 'slices', 'v3-x.md')), false);
  });

  it('内容不一致 → 不删，报出来', () => {
    writeFileSync(join(repo, 'specs', 'slices', 'v3-x.md'), '# 完全不同的一份\n', 'utf-8');

    const res = clearUntrackedManagedSpecs(repo, 'refs/heads/slice/v3-x');
    assert.deepEqual(res.removed, []);
    assert.deepEqual(res.conflicts, ['specs/slices/v3-x.md']);
    assert.equal(existsSync(join(repo, 'specs', 'slices', 'v3-x.md')), true);
  });

  it('不是 zelto 托管的路径（人的代码）→ 绝不碰', () => {
    writeFileSync(join(repo, 'my-code.py'), 'mine\n');

    const res = clearUntrackedManagedSpecs(repo, 'refs/heads/slice/v3-x');
    assert.deepEqual(res.removed, []);
    assert.deepEqual(res.conflicts, []);
    assert.equal(existsSync(join(repo, 'my-code.py')), true);
  });

  it('ref 上没有那个文件 → 不用管（合并不会覆盖它）', () => {
    writeFileSync(join(repo, 'specs', 'slices', 'v3-other.md'), '# 别的规格\n', 'utf-8');

    const res = clearUntrackedManagedSpecs(repo, 'refs/heads/slice/v3-x');
    assert.deepEqual(res.removed, []);
    assert.deepEqual(res.conflicts, []);
    assert.equal(existsSync(join(repo, 'specs', 'slices', 'v3-other.md')), true);
  });

  it('清理完 git merge 真的能过（原来被硬拦）', () => {
    writeFileSync(join(repo, 'specs', 'slices', 'v3-x.md'), SPEC_TEXT.replace(/\n/g, '\r\n'), 'utf-8');

    // 先确认「不清理就合不了」
    assert.throws(() => git(['merge', 'slice/v3-x'], repo), /would be overwritten by merge/);

    clearUntrackedManagedSpecs(repo, 'refs/heads/slice/v3-x');

    git(['merge', 'slice/v3-x'], repo);
    // 行尾可能被 Windows 的 autocrlf 改写 —— 比内容，不比字节
    assert.equal(
      readFileSync(join(repo, 'specs', 'slices', 'v3-x.md'), 'utf-8').replace(/\r\n/g, '\n'),
      SPEC_TEXT,
    );
  });
});

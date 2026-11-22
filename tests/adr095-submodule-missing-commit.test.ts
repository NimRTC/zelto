// ADR-095 · 真 submodule 场景（集成测试）
//
// 单元测试（adr095-worktree-build-prerequisites.test.ts）用 stub 验判据；
// 这里用**真的 submodule** 走一遍完整路径，验「缺 pinned commit → 报错带修法」
// 这条判据在真实 git 布局下确实成立。
//
// 复刻的是 nimrtc-v14 v3-n4-d6-connectivity 的现场（2026-11-22）：
//   主仓 index 钉死了子模块的某个 commit，但本地 module 仓库里**没有**那个
//   commit（只有较新的「carbon copy」）。worktree 建出来 vendor 是空的，
//   门禁②的 build 阶段才炸 —— 报错指向「找不到头文件」，与真正原因无关。
//
// 怎么造出这个状态（本地 module 仓库里真的没有那个 commit）：
//   1. `upstream` —— 一个正常的子模块仓库，有 pinned commit；
//   2. 主仓 `git submodule add upstream vendor` → 主仓 index 钉住 pinned commit，
//      主仓的 `.git/modules/vendor` 也拿到了那个 commit；
//   3. **把 `.git/modules/vendor` 换成一个无关的仓库**（只有较新的 carbon copy）——
//      这一步就是「本地 module 仓库与上游脱节」的现场。
//   4. 删掉主仓工作区里的 vendor（只留 index 里的 gitlink）。
//
// 覆盖点：
//   1. 本地**有** pinned commit → 对齐成功，vendor 有内容，不抛错
//   2. 本地**没有** pinned commit → 抛错，且信息带**三种修法**
//   3. 抛的错点名「本地没有这个 commit」—— 不是含糊的「checkout 失败」
//   4. 错误信息里有 submodule 的**路径**（人要知道是哪个 vendor）
//   5. 错误信息说清「为什么在这里停下」（vendor 会是空的、门禁会失败）

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { WorktreeManager } from '../src/core/worktree/manager.js';

/** 清理可能被占用的目录（Windows cwd lock，ZD-017）。 */
function rmWithRetry(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

interface Layout {
  root: string;
  subPath: string;
  pinned: string;
  base: string;
}

/**
 * 造一个「主仓 + submodule」布局。
 *
 * @param breakLocalModule true = 让主仓的本地 module 仓库**不含** pinned commit
 *   （复刻 ZD-026）；false = 正常（本地有那个 commit）。
 */
function makeLayout(breakLocalModule: boolean): Layout {
  const base = mkdtempSync(join(tmpdir(), 'zelto-adr095-int-'));
  const upstream = join(base, 'upstream');
  const root = join(base, 'main');

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  // ── upstream：正常的子模块仓库 ─────────────────────────────────
  mkdirSync(upstream, { recursive: true });
  git(upstream, 'init', '-b', 'main');
  git(upstream, 'config', 'user.email', 'adr095@example.com');
  git(upstream, 'config', 'user.name', 'adr095');
  writeFileSync(join(upstream, 'vendor.h'), '// v1\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-m', 'pinned');
  const pinned = git(upstream, 'rev-parse', 'HEAD').trim();

  // ── 主仓 ───────────────────────────────────────────────────────
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'adr095@example.com');
  git(root, 'config', 'user.name', 'adr095');
  git(root, 'config', 'protocol.file.allow', 'always');
  writeFileSync(join(root, 'README.md'), '# main\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'vendor');
  // 必须**提交** submodule 的 gitlink。
  //
  // 为什么：`git submodule add` 只把 gitlink **暂存**进 index，不提交。
  // 而 worktree 是从 **HEAD** 建出来的 —— HEAD 里没有那个 gitlink，
  // worktree 的 index 里也就没有。测试里不提交的话，worktree 里
  // 压根没有这个 submodule，测不到「对齐」这条路径。
  git(root, 'commit', '-m', 'add submodule');

  if (breakLocalModule) {
    // ── 让本地 module 仓库「脱节」────────────────────────────────
    //
    // 造一个**无关**的仓库（只有较新的 carbon copy commit），
    // 把它替换成主仓的 `.git/modules/vendor`。
    //
    // 为什么不能靠 `gc --prune=now` 删掉旧 commit：
    //   git 对**近期**对象有宽限期（`gc.pruneExpire`），
    //   实测 expire reflog + gc + repack 之后那个 commit 仍然可读 ——
    //   靠 gc 造不出这个状态。而「本地副本与上游脱节」本来就是更真实的
    //   故障形态（有人重新 clone 过、或 module 仓库被换掉了）。
    const carbonCopy = join(base, 'carbon-copy');
    mkdirSync(carbonCopy, { recursive: true });
    git(carbonCopy, 'init', '-b', 'main');
    git(carbonCopy, 'config', 'user.email', 'adr095@example.com');
    git(carbonCopy, 'config', 'user.name', 'adr095');
    writeFileSync(join(carbonCopy, 'vendor.h'), '// v2 carbon copy\n');
    git(carbonCopy, 'add', '.');
    git(carbonCopy, 'commit', '-m', 'newer carbon copy');

    const moduleDir = join(root, '.git', 'modules', 'vendor');
    rmSync(moduleDir, { recursive: true, force: true });
    git(carbonCopy, 'clone', '--bare', '.', moduleDir);

    // 确认：本地 module 仓库里**真的**没有那个 commit。
    let stillThere = true;
    try {
      git(moduleDir, 'cat-file', '-e', `${pinned}^{commit}`);
    } catch {
      stillThere = false;
    }
    assert.equal(
      stillThere,
      false,
      '测试设置有问题：本地 module 仓库里不该有那个 pinned commit',
    );

    // 主仓工作区里的 vendor **要留着**（`.git` 指向 module 目录）。
    //
    // 为什么不能删整个目录：zelto 靠「主仓工作区里这个 submodule 有没有
    // `.git`」判断它是不是「已初始化的 submodule」。删掉整个目录的话，
    // zelto 会把它当成「没有本地副本」而**跳过** —— 那是另一种故障，
    // 测不到「commit 存在性」这条判据。
    //
    // 所以只把 `.git` 这个**指针文件**改指向新的 module 目录。
    //
    // 要先删再写 —— git 建出来的 `.git` 文件是**只读**的，
    // 直接写会报 `EPERM`。
    const gitLink = join(root, 'vendor', '.git');
    rmSync(gitLink, { force: true });
    writeFileSync(gitLink, `gitdir: ${moduleDir.replace(/\\/g, '/')}\n`, 'utf-8');
  }

  return { root, subPath: 'vendor', pinned, base };
}

describe('ADR-095 · 真 submodule：缺 pinned commit', () => {
  let base = '';

  afterEach(() => {
    if (base) rmWithRetry(base);
    base = '';
  });

  it('本地**有** pinned commit → 对齐成功，vendor 有内容', async () => {
    const layout = makeLayout(false);
    base = layout.base;
    const manager = new WorktreeManager(layout.root);

    const info = await manager.create('s1', { initSubmodules: true });

    assert.ok(
      existsSync(join(info.path, 'vendor', 'vendor.h')),
      '本地有 pinned commit 时，worktree 的 vendor 必须有内容',
    );
  });

  it('本地**没有** pinned commit → 抛错，且信息带三种修法', async () => {
    const layout = makeLayout(true);
    base = layout.base;
    const manager = new WorktreeManager(layout.root);

    let caught: unknown = null;
    try {
      await manager.create('s1', { initSubmodules: true });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, '本地缺 pinned commit 时必须抛错（不能静默建出空的 vendor）');

    const msg = caught instanceof Error ? caught.message : String(caught);

    // ① 点名「本地没有这个 commit」—— 不是含糊的「checkout 失败」。
    assert.match(msg, /没有.*commit|commit.*不存在/, `信息要点名真正的原因：${msg}`);

    // ② 给出三种可执行的修法。
    assert.match(msg, /fetch origin/, '要给出「从远程 fetch」的修法');
    assert.match(msg, /fetch <那个副本的路径>/, '要给出「从别的本地副本 fetch」的修法');
    assert.match(msg, /submodule update --init/, '要给出「主仓 index 记错了」的修法');

    // ③ 说清是哪个 vendor。
    assert.match(msg, new RegExp(layout.subPath), '信息里要有 submodule 的路径');
  });

  it('错误信息要说明「为什么在这里停下」（vendor 会是空的）', async () => {
    const layout = makeLayout(true);
    base = layout.base;
    const manager = new WorktreeManager(layout.root);

    let caught: unknown = null;
    try {
      await manager.create('s1', { initSubmodules: true });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught);
    const msg = caught instanceof Error ? caught.message : String(caught);

    // 人得知道「不处理会怎样」—— 否则会以为是无关紧要的警告。
    assert.match(msg, /vendor/, '要说清后果（vendor 目录会是空的）');
    assert.match(msg, /门禁/, '要说清失败会在哪儿显形（门禁②）');
  });

  it('报错里带 commit 的短 sha（能直接拿去查）', async () => {
    const layout = makeLayout(true);
    base = layout.base;
    const manager = new WorktreeManager(layout.root);

    let caught: unknown = null;
    try {
      await manager.create('s1', { initSubmodules: true });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught);
    const msg = caught instanceof Error ? caught.message : String(caught);
    assert.match(msg, new RegExp(layout.pinned.slice(0, 8)), '要带 commit 的短 sha');
  });
});

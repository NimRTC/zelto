// 路径逃逸防护 —— 标识符拼进路径时不能逃出 base
//
// ## 病灶
//
// zelto 到处把**标识符**拼进路径：切片 id 进 `.zelto/slices/<id>.json`、
// 进 `specs/slices/<id>.md`、进 `tests/acceptance/<id>/`、进
// `.zelto/worktrees/<id>/`；版本 label 进 `.zelto/version-worktrees/<label>/`。
//
// `join()` 会把 `..` **归一化掉**，于是路径逃出本该在的目录：
//
// ```
// join('.zelto/worktrees', '../../evil')  →  '<repo>/evil'
// join('.zelto/slices',    '../evil.json') →  '<repo>/.zelto/evil.json'
// ```
//
// 后果不是「目录建歪了」，而是**写与删落在仓库根之外**：
// worktree 被建到仓库外，验收目录被建到仓库外，
// `rmSync(dest, { recursive: true, force: true })` 会删到仓库外。
//
// 切片 id 在 CLI 入口有白名单，版本 label 没有——同一个缺陷家族里
// 唯一还开着口的地方。本测试锁住**两层防护**：
//
// 1. 白名单（`isValidVersionLabel` / `isValidSliceId`）—— 入口就拒
// 2. 包含性（`resolveWithin`）—— 即使白名单漏了，路径也逃不出去
//
// 覆盖点：
//   1. `resolveWithin` 的基本行为与两种逃逸形态（`..` 前缀 / 跨盘绝对路径）
//   2. 前缀判据的陷阱：`C:\repo-evil` 不是 `C:\repo` 的子目录
//   3. 版本 label 白名单：允许 `v1.2.3`，拒绝 `..` / `.` / 含分隔符 / 空格
//   4. `WorktreeManager.versionPathFor` —— 逃逸时抛错，**不建目录**
//   5. `WorktreeManager.pathFor` —— 同样不逃逸
//   6. `SliceStore` —— 切片文件路径不逃出 `.zelto/slices/`
//   7. 谓词方法（`exists` / `versionExists`）—— 不抛错，返回 false
//   8. 存量数据不受影响（真实项目里的 label 全都合法）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

import { resolveWithin, isWithin, PathEscapeError } from '../src/core/io/path-safe.js';
import { isValidVersionLabel, checkVersionLabel, versionBranchName } from '../src/core/version/branch.js';
import { isValidSliceId, checkSliceId, SliceStore } from '../src/core/slice/store.js';
import { WorktreeManager } from '../src/core/worktree/manager.js';

// ─── resolveWithin：路径包含性原语 ────────────────────────────────────────

test('resolveWithin：正常标识符落在 base 之内', () => {
  const base = resolve('D:/tmp/repo', '.zelto/worktrees');
  const p = resolveWithin(base, 'v1-video-processing');
  assert.equal(p, join(base, 'v1-video-processing'));
  assert.ok(isWithin(base, 'v1-video-processing'));
});

test('resolveWithin：保留 base 原本的形态', () => {
  // 拼接用 `join` 而不是 `resolve` —— `/repo` 就还是 `/repo`，
  // 不会被强行变成 `D:\repo`。既有测试断言的正是这个形态。
  assert.equal(resolveWithin('/repo', 'demo'), join('/repo', 'demo'));
});

test('resolveWithin：`..` 逃逸被拒', () => {
  const base = resolve('D:/tmp/repo', '.zelto/worktrees');
  assert.throws(() => resolveWithin(base, '..'), PathEscapeError);
  assert.throws(() => resolveWithin(base, '../../evil'), PathEscapeError);
  assert.throws(() => resolveWithin(base, '../evil'), PathEscapeError);
  assert.equal(isWithin(base, '../../evil'), false);
});

test('resolveWithin：绝对路径标识符不能把结果带出 base', () => {
  const base = resolve('D:/tmp/repo', '.zelto/worktrees');
  // 契约（跨平台）：绝对路径标识符**要么被拒（抛 PathEscapeError），
  // 要么被安全地夹在 base 内** —— 无论哪种，结果都不得落在 base 之外。
  //
  // 注意平台差异（ADR-090 修复）：
  //   - Windows：带盘符的绝对串（如 `E:/x`）会让 join 重置根 → 逃逸 → 被拒。
  //   - POSIX：`join` 会剥掉前导 `/` 再拼进 base，绝对串**不会**逃逸 →
  //     不抛，而是安全落在 base 下。
  // 所以旧断言「绝对路径必抛」只在 Windows 成立，在 Linux CI 上漏判。
  const absIdentifier = resolve('/', 'tmp', 'elsewhere');
  assert.ok(isAbsolute(absIdentifier), `应构造出绝对路径，实际 "${absIdentifier}"`);
  let escapes = false;
  try {
    const result = resolveWithin(base, absIdentifier);
    // 没抛 —— 那就必须确实落在 base 之内
    escapes = relative(resolve(base), resolve(result)).startsWith('..');
  } catch (err) {
    assert.ok(err instanceof PathEscapeError, `只该抛 PathEscapeError，实际 ${err}`);
    return; // 被拒 = 契约成立
  }
  assert.equal(escapes, false, `绝对路径标识符不得把结果带出 base：${absIdentifier}`);
});

test('resolveWithin：前缀相同的邻居目录不算子目录', () => {
  // `C:\repo-evil` 以 `C:\repo` 开头，但**不在**它里面。
  // 字符串前缀判据（startsWith）会把它误判成子目录 ——
  // 这正是「看起来在 base 里、其实在隔壁目录」的经典形状。
  const base = resolve('C:/repo', '.zelto');
  const neighbor = resolve('C:/repo-evil', 'x');
  const rel = relative(resolve(base), neighbor);
  assert.ok(rel.startsWith('..'), `relative 应该以 .. 开头，实际是 "${rel}"`);
  assert.equal(isWithin(base, '../repo-evil/x'), false);
});

test('resolveWithin：base 自身是允许的', () => {
  // 标识符是空串时落在 base 上——不是逃逸。
  const base = resolve('D:/tmp/repo', '.zelto');
  assert.equal(resolveWithin(base, ''), base);
});

// ─── 版本 label 白名单 ───────────────────────────────────────────────────

test('isValidVersionLabel：常见 label 合法', () => {
  assert.equal(isValidVersionLabel('v1'), true);
  assert.equal(isValidVersionLabel('v1.2.3'), true);
  assert.equal(isValidVersionLabel('v2-beta'), true);
  assert.equal(isValidVersionLabel('v_2'), true);
  assert.equal(isValidVersionLabel('release-2.0'), true);
});

test('isValidVersionLabel：路径结构符号被拒', () => {
  // `.` 与 `..` 在字符上「合法」（只由点组成），但语义上是父目录 ——
  // `join('.zelto/version-worktrees', '..')` 会归一化成 `.zelto`，路径逃出 base。
  assert.equal(isValidVersionLabel('..'), false);
  assert.equal(isValidVersionLabel('.'), false);
  assert.equal(isValidVersionLabel('../../evil'), false);
  assert.equal(isValidVersionLabel('../evil'), false);
});

test('isValidVersionLabel：分隔符与空格被拒', () => {
  assert.equal(isValidVersionLabel('v1/v2'), false);
  assert.equal(isValidVersionLabel('v1\\v2'), false);
  assert.equal(isValidVersionLabel('v 1'), false);
  assert.equal(isValidVersionLabel(''), false);
  assert.equal(isValidVersionLabel('   '), false);
});

test('checkVersionLabel：给出可读的原因', () => {
  const bad = checkVersionLabel('../evil');
  assert.equal(bad.valid, false);
  assert.ok(bad.reason && bad.reason.includes('..'), `原因要说清为什么，实际："${bad.reason}"`);

  const ok = checkVersionLabel('v1');
  assert.equal(ok.valid, true);
  assert.equal(ok.reason, null);
});

test('版本分支名派生不受影响（存量 label 照常工作）', () => {
  assert.equal(versionBranchName('v1'), 'version/v1');
  assert.equal(versionBranchName('v1.2.3'), 'version/v1.2.3');
});

// ─── 切片 id 白名单 ─────────────────────────────────────────────────────

test('isValidSliceId：常见 id 合法', () => {
  assert.equal(isValidSliceId('v1-video-processing'), true);
  assert.equal(isValidSliceId('slice_1'), true);
  assert.equal(isValidSliceId('A1'), true);
});

test('isValidSliceId：点被拒（连点一起，否则 `..` 会漏）', () => {
  // 切片 id 不允许点 —— 允许 `.` 就等于允许 `..`。
  assert.equal(isValidSliceId('..'), false);
  assert.equal(isValidSliceId('.'), false);
  assert.equal(isValidSliceId('v1.2'), false);
  assert.equal(isValidSliceId('../../evil'), false);
  assert.equal(isValidSliceId('v1/v2'), false);
});

test('checkSliceId：给出可读的原因', () => {
  const bad = checkSliceId('../evil');
  assert.equal(bad.valid, false);
  assert.ok(bad.reason && bad.reason.includes('../evil'), `原因要说清为什么，实际："${bad.reason}"`);
  // 既有 CLI 输出契约：错误信息里一直有 "Invalid slice ID" 这个说法
  assert.ok(bad.reason?.includes('Invalid slice ID'));
});

// ─── WorktreeManager：防御纵深 ───────────────────────────────────────────

test('versionPathFor：逃逸的 label 抛错，不建目录', () => {
  const repo = mkdtempSync(join(tmpdir(), 'zelto-escape-'));
  try {
    const manager = new WorktreeManager(repo);
    // 路径逃出去 → 当场抛错，绝不返回 base 之外的路径
    assert.throws(() => manager.versionPathFor('..'), PathEscapeError);
    assert.throws(() => manager.versionPathFor('../../evil'), PathEscapeError);
    // 而且**没有**在 base 之外建出任何目录
    assert.equal(existsSync(join(repo, 'evil')), false);
    assert.equal(existsSync(join(repo, '.zelto', 'evil')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('versionPathFor：合法 label 落在 version-worktrees 之下', () => {
  const repo = mkdtempSync(join(tmpdir(), 'zelto-escape-'));
  try {
    const manager = new WorktreeManager(repo);
    const p = manager.versionPathFor('v1');
    assert.equal(p, join(repo, '.zelto', 'version-worktrees', 'v1'));
    assert.ok(p.startsWith(join(repo, '.zelto', 'version-worktrees')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('versionPathFor：在版本工作目录里（检出 version/v3），基准上移到外层（ZD-055）', () => {
  // 实测 nimrtc-v14 v1-rtcp-processor-collaborator，2026-11-26：
  // 人在 `version-worktrees/v3` 里签字后跑 `zelto merge <id> --target version/v3`，
  // 拼出的是 `version-worktrees/v3/.zelto/version-worktrees/v3` —— 不存在，
  // 而那个目录**就在往上两层**。于是 merge 报「版本 v3 的工作目录不存在」，
  // 人只能手工 `cd` 到顶层 —— 但那样切片 worktree（相对 repoRoot）又找不到了。
  //
  // 判据是 **git 事实**（检出 version/<label>）+ 祖先目录里**同名且存在**的
  // `.zelto/version-worktrees/<label>`，不看目录路径。
  const top = mkdtempSync(join(tmpdir(), 'zelto-zd055-'));
  const sh = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    sh(['init', '-q', '-b', 'main'], top);
    sh(['config', 'user.email', 'test@zelto.local'], top);
    sh(['config', 'user.name', 'zelto test'], top);
    writeFileSync(join(top, 'keep.txt'), 'keep\n');
    sh(['add', '-A'], top);
    sh(['commit', '-q', '-m', 'init'], top);
    // 版本分支从 main 拉出来
    sh(['branch', 'version/v3'], top);
    const v3dir = join(top, '.zelto', 'version-worktrees', 'v3');
    sh(['worktree', 'add', '-q', v3dir, 'version/v3'], top);

    // (a) 在版本工作目录里：基准必须上移到外层
    const inV3 = new WorktreeManager(v3dir);
    assert.equal(inV3.versionPathFor('v3'), v3dir, '版本工作目录就在外层 repoRoot/.zelto/version-worktrees/v3');
    assert.equal(inV3.versionPathFor('v1'), join(top, '.zelto', 'version-worktrees', 'v1'));

    // (b) 逃逸防护不放宽：外层基准下带 `..` 的 label 仍然抛错
    assert.throws(() => inV3.versionPathFor('../../evil'), PathEscapeError);
    assert.equal(existsSync(join(top, 'evil')), false);

    // (c) 同一路径但**不在** version 分支上 → 退回子仓基准（版本上下文不成立）
    const fromTop = new WorktreeManager(top);
    assert.equal(fromTop.versionPathFor('v3'), v3dir);
    assert.equal(fromTop.versionPathFor('v9'), join(top, '.zelto', 'version-worktrees', 'v9'));
  } finally {
    try {
      sh(['worktree', 'remove', '--force', join(top, '.zelto', 'version-worktrees', 'v3')], top);
    } catch {
      /* 清理尽力而为 */
    }
    rmSync(top, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('versionPathFor：在**非版本分支**的仓库根上，基准不会上移（不上移就找不到外层的同名目录）', () => {
  // 反向用例：仓库名恰好与某个版本 label 相同（这里是 v3），但检出的是 main ——
  // 若判据只看「祖先里有同名目录」而不看 git 事实，会把 main 的版本工作目录
  // 指到**别的仓库**里去。
  const top = mkdtempSync(join(tmpdir(), 'zelto-zd055b-'));
  const sh = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    sh(['init', '-q', '-b', 'main'], top);
    sh(['config', 'user.email', 'test@zelto.local'], top);
    sh(['config', 'user.name', 'zelto test'], top);
    writeFileSync(join(top, 'keep.txt'), 'keep\n');
    sh(['add', '-A'], top);
    sh(['commit', '-q', '-m', 'init'], top);
    // 祖先之外建一个同名的「假外层」目录：它不该被选中
    const fakeOuter = join(top, 'outer', '.zelto', 'version-worktrees', 'v3');
    mkdirSync(fakeOuter, { recursive: true });

    const manager = new WorktreeManager(top);
    assert.equal(manager.versionPathFor('v3'), join(top, '.zelto', 'version-worktrees', 'v3'));
  } finally {
    rmSync(top, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('pathFor：逃逸的切片 id 抛错', () => {
  const repo = mkdtempSync(join(tmpdir(), 'zelto-escape-'));
  try {
    const manager = new WorktreeManager(repo);
    assert.throws(() => manager.pathFor('../../evil'), PathEscapeError);
    assert.equal(existsSync(join(repo, 'evil')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('谓词方法不抛错：非法 id → 不存在（false）', () => {
  // `exists` 是**判据** —— 「在不在」。抛错会让遍布 CLI 的调用方
  // 都得包 try/catch，而它们要的只是「不在」。
  const repo = mkdtempSync(join(tmpdir(), 'zelto-escape-'));
  try {
    const manager = new WorktreeManager(repo);
    assert.equal(manager.exists('../../evil'), false);
    assert.equal(manager.versionExists('..'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── SliceStore：切片文件路径不逃出 ─────────────────────────────────────

test('SliceStore：切片文件路径不逃出 .zelto/slices', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'zelto-escape-'));
  try {
    const store = new SliceStore(join(repo, '.zelto', 'slices'));
    await store.write(store.create('ok-slice', 'OK'));
    assert.equal(existsSync(join(repo, '.zelto', 'slices', 'ok-slice.json')), true);

    // 逃逸的 id → 读的时候抛错（而不是去仓库根上找一个同名文件）
    await assert.rejects(() => store.read('../../evil'), PathEscapeError);

    // 谓词返回 false，不抛错
    assert.equal(await store.exists('../../evil'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('SliceStore：正常读写的往返不受影响', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'zelto-escape-'));
  try {
    const store = new SliceStore(join(repo, '.zelto', 'slices'));
    const created = store.create('round-trip', '往返');
    await store.write(created);
    const read = await store.read('round-trip');
    assert.equal(read.id, 'round-trip');
    assert.equal(read.title, '往返');
    assert.equal(read.spec.path, 'specs/slices/round-trip.md');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

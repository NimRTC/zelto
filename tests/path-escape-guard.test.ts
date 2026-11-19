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
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';

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

test('resolveWithin：绝对路径标识符被拒', () => {
  const base = resolve('D:/tmp/repo', '.zelto/worktrees');
  // 绝对路径会直接盖掉 base
  assert.throws(() => resolveWithin(base, 'D:/tmp/elsewhere'), PathEscapeError);
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

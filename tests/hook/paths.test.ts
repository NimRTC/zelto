// 符号链接感知的路径 containment（ADR-134）
//
// 词法归一化（relativizeTarget）看不见符号链接：worktree 内一个指向外部的
// junction/symlink 就能让「词法上在 worktree 内」的路径落到 worktree 外。
// 这一组测试钉住 canonicalizeForContainment / canonicalContainment 的行为，
// 以及 judgeWriteTargets 的三条 containment 检查统一走 canonical 路径。

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalContainment,
  canonicalizeForContainment,
  createAncestorRealpathCache,
  type AncestorRealpathCache,
} from '../../src/hook/paths.js';
import { judgeWriteTargets, type PreToolContext } from '../../src/hook/pretool.js';

/** 建一个临时 worktree：base/wt（工作区）与 base/outside（外部）。 */
function makeFixture(): { base: string; wt: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'zelto-paths-'));
  const wt = join(base, 'wt');
  const outside = join(base, 'outside');
  mkdirSync(wt);
  mkdirSync(outside);
  return { base, wt, outside };
}

/** 在 worktree 内建一个指向 target 的 junction（Windows）/ symlink（POSIX）。 */
function makeLinkToDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** 在 worktree 内建一个符号链接环（ELOOP）：loopA ⇄ loopB。 */
function makeLoop(wt: string): void {
  if (process.platform === 'win32') {
    symlinkSync(join(wt, 'loopB'), join(wt, 'loopA'), 'junction');
    symlinkSync(join(wt, 'loopA'), join(wt, 'loopB'), 'junction');
  } else {
    symlinkSync('loopB', join(wt, 'loopA'));
    symlinkSync('loopA', join(wt, 'loopB'));
  }
}

function ctx(overrides: Partial<PreToolContext> = {}): PreToolContext {
  return {
    projectRoot: '/repo',
    worktreeRoot: '/repo/wt',
    sliceId: 's1',
    writes: ['**'],
    rules: null,
    policyVersion: 'sha256:test',
    ...overrides,
  };
}

describe('canonicalizeForContainment —— 符号链接感知', () => {
  it('普通存在路径 → canonical 相对路径（posix）', () => {
    const { base, wt } = makeFixture();
    try {
      mkdirSync(join(wt, 'src'));
      writeFileSync(join(wt, 'src', 'a.ts'), 'x', 'utf-8');
      assert.equal(canonicalizeForContainment(join(wt, 'src', 'a.ts'), wt), 'src/a.ts');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('普通相对路径 → 相对 worktree 解析', () => {
    const { base, wt } = makeFixture();
    try {
      mkdirSync(join(wt, 'src'));
      writeFileSync(join(wt, 'src', 'a.ts'), 'x', 'utf-8');
      assert.equal(canonicalizeForContainment('src/a.ts', wt), 'src/a.ts');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('新建文件（目标不存在，父目录存在）→ 放行', () => {
    const { base, wt } = makeFixture();
    try {
      mkdirSync(join(wt, 'src'));
      assert.equal(canonicalizeForContainment(join(wt, 'src', 'new.ts'), wt), 'src/new.ts');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('junction/symlink 指向 worktree 外 → null（逃逸）', () => {
    const { base, wt, outside } = makeFixture();
    try {
      writeFileSync(join(outside, 'secret.txt'), 's', 'utf-8');
      makeLinkToDir(outside, join(wt, 'escape'));
      const target = join(wt, 'escape', 'secret.txt');
      assert.equal(canonicalizeForContainment(target, wt), null);
      assert.equal(canonicalContainment(target, wt).kind, 'escape');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('junction 指向外部但目标文件尚不存在 → null（逃逸）', () => {
    const { base, wt, outside } = makeFixture();
    try {
      makeLinkToDir(outside, join(wt, 'escape'));
      const target = join(wt, 'escape', 'new-file.txt');
      assert.equal(canonicalizeForContainment(target, wt), null);
      assert.equal(canonicalContainment(target, wt).kind, 'escape');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('符号链接环（ELOOP）→ 无法解析（unresolvable）', () => {
    const { base, wt } = makeFixture();
    try {
      makeLoop(wt);
      const target = join(wt, 'loopA', 'x.ts');
      assert.equal(canonicalizeForContainment(target, wt), null);
      assert.equal(canonicalContainment(target, wt).kind, 'unresolvable');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('悬空链接（链接在、目标不在）→ 无法解析（unresolvable）', () => {
    const { base, wt } = makeFixture();
    try {
      makeLinkToDir(join(base, 'no-such-target'), join(wt, 'dangling'));
      const target = join(wt, 'dangling', 'x.ts');
      assert.equal(canonicalizeForContainment(target, wt), null);
      assert.equal(canonicalContainment(target, wt).kind, 'unresolvable');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('同一判定批次共享祖先 realpath 缓存', () => {
    const { base, wt } = makeFixture();
    try {
      mkdirSync(join(wt, 'src'));
      const cache: AncestorRealpathCache = createAncestorRealpathCache();
      assert.equal(canonicalizeForContainment(join(wt, 'src', 'a.ts'), wt, cache), 'src/a.ts');
      assert.equal(canonicalizeForContainment(join(wt, 'src', 'b.ts'), wt, cache), 'src/b.ts');
      // 两次调用共享缓存：`wt/src` 只 realpath 一次（键已存在）。
      assert.ok(cache.has(join(wt, 'src')));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('祖先缓存不跨调用存活（新建即空）', () => {
    assert.equal(createAncestorRealpathCache().size, 0);
  });
});

describe('judgeWriteTargets —— containment 统一走 canonical 路径', () => {
  it('junction 指向 worktree 外 → 拒绝（protected:0a）', () => {
    const { base, wt, outside } = makeFixture();
    try {
      writeFileSync(join(outside, 'secret.txt'), 's', 'utf-8');
      makeLinkToDir(outside, join(wt, 'escape'));
      const target = join(wt, 'escape', 'secret.txt');
      const verdict = judgeWriteTargets([target], ctx({ projectRoot: base, worktreeRoot: wt }));
      assert.equal(verdict.decision, 'deny');
      assert.equal(verdict.ruleId, 'protected:0a');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('junction 指向外部但词法上在写集内（**）→ 仍然拒绝（本片核心用例）', () => {
    const { base, wt, outside } = makeFixture();
    try {
      writeFileSync(join(outside, 'secret.txt'), 's', 'utf-8');
      makeLinkToDir(outside, join(wt, 'escape'));
      const target = join(wt, 'escape', 'secret.txt');
      const verdict = judgeWriteTargets([target], ctx({ projectRoot: base, worktreeRoot: wt, writes: ['**'] }));
      assert.equal(verdict.decision, 'deny');
      assert.equal(verdict.ruleId, 'protected:0a');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('词法上在写集内、且无链接的普通路径 → 放行（行为不变）', () => {
    const { base, wt } = makeFixture();
    try {
      mkdirSync(join(wt, 'src'));
      writeFileSync(join(wt, 'src', 'a.ts'), 'x', 'utf-8');
      const verdict = judgeWriteTargets(
        [join(wt, 'src', 'a.ts')],
        ctx({ projectRoot: base, worktreeRoot: wt, writes: ['src/**'] }),
      );
      assert.equal(verdict.decision, 'allow');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('新建文件（目标不存在，父目录存在）→ 放行', () => {
    const { base, wt } = makeFixture();
    try {
      mkdirSync(join(wt, 'src'));
      const verdict = judgeWriteTargets(
        [join(wt, 'src', 'new.ts')],
        ctx({ projectRoot: base, worktreeRoot: wt, writes: ['src/**'] }),
      );
      assert.equal(verdict.decision, 'allow');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('realpath 失败（符号链接环 ELOOP）→ 拒绝，reason 说明无法解析', () => {
    const { base, wt } = makeFixture();
    try {
      makeLoop(wt);
      const target = join(wt, 'loopA', 'x.ts');
      const verdict = judgeWriteTargets([target], ctx({ projectRoot: base, worktreeRoot: wt }));
      assert.equal(verdict.decision, 'deny');
      assert.equal(verdict.ruleId, 'protected:0a');
      assert.match(verdict.reason, /无法解析真实路径/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('悬空链接 → 拒绝（解析不出真实落点）', () => {
    const { base, wt } = makeFixture();
    try {
      makeLinkToDir(join(base, 'no-such-target'), join(wt, 'dangling'));
      const target = join(wt, 'dangling', 'x.ts');
      const verdict = judgeWriteTargets([target], ctx({ projectRoot: base, worktreeRoot: wt }));
      assert.equal(verdict.decision, 'deny');
      assert.equal(verdict.ruleId, 'protected:0a');
      assert.match(verdict.reason, /无法解析真实路径/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('逃逸与无法解析的 reason 能区分（审计可辨）', () => {
    const { base, wt, outside } = makeFixture();
    try {
      writeFileSync(join(outside, 'secret.txt'), 's', 'utf-8');
      makeLinkToDir(outside, join(wt, 'escape'));
      makeLoop(wt);
      const escape = judgeWriteTargets(
        [join(wt, 'escape', 'secret.txt')],
        ctx({ projectRoot: base, worktreeRoot: wt }),
      );
      const unresolvable = judgeWriteTargets(
        [join(wt, 'loopA', 'x.ts')],
        ctx({ projectRoot: base, worktreeRoot: wt }),
      );
      assert.equal(escape.decision, 'deny');
      assert.equal(escape.ruleId, 'protected:0a');
      assert.doesNotMatch(escape.reason, /无法解析真实路径/);
      assert.equal(unresolvable.decision, 'deny');
      assert.equal(unresolvable.ruleId, 'protected:0a');
      assert.match(unresolvable.reason, /无法解析真实路径/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

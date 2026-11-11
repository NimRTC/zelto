/**
 * 写集判定（ADR-042）的单元测试。
 *
 * 核心回归点：**「新建文件型写集」不能被判成阻断项**。
 *
 * 背景：门禁①原来把「写集里的路径在仓库里不存在」直接列为阻断项。
 * 对新建文件的切片来说，这在 agent 动手之前必然成立 —— 于是门禁①永远
 * 报同一个问题，agent 永远拿不到「可以跑」的结论，切片卡在 draft。
 *
 * 真实案例：nimrtc-zelto 的 v1-exception-handling 连报七次
 * 「Write-set paths not found」，一步都走不出去。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  evaluateWriteSet,
  findUnproducedWriteSetPaths,
  isInWriteSet,
  writeSetCoversDir,
  writeSetEscapesRoot,
  writeSetHitsProtectedDomain,
} from '../../../src/core/spec/write-set.js';

const TEST_ROOT = join(tmpdir(), `zelto-write-set-${Date.now()}`);

describe('core/spec/write-set — 写集判定', () => {
  before(async () => {
    await mkdir(join(TEST_ROOT, 'src', 'modules', 'demo'), { recursive: true });
    await mkdir(join(TEST_ROOT, 'policy'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'src', 'modules', 'demo', 'existing.hpp'), '// 已有文件\n');
    await writeFile(join(TEST_ROOT, 'policy', 'policy.yaml'), 'rules: []\n');
    await writeFile(join(TEST_ROOT, 'AGENTS.md'), '# rules\n');
  });

  after(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  describe('新建文件型写集 —— 回归点', () => {
    it('不存在的写集路径归为 toCreate，不进 issues', () => {
      const result = evaluateWriteSet({
        writes: ['src/modules/demo/include/nimrtc/demo/safety_check.hpp'],
        projectRoot: TEST_ROOT,
      });

      assert.deepEqual(result.issues, [], '新建文件不该被判成写集问题');
      assert.deepEqual(result.toCreate, ['src/modules/demo/include/nimrtc/demo/safety_check.hpp']);
      assert.deepEqual(result.existing, []);
    });

    it('不存在的写集路径产生提示项（不是阻断项）', () => {
      const result = evaluateWriteSet({
        writes: ['src/modules/demo/src/safety_check.cpp'],
        projectRoot: TEST_ROOT,
      });

      assert.equal(result.advisories.length, 1);
      assert.match(result.advisories[0], /will be created|does not exist/i);
      assert.match(result.advisories[0], /safety_check\.cpp/);
    });

    it('已存在的写集路径归为 existing，不产生任何提示', () => {
      const result = evaluateWriteSet({
        writes: ['src/modules/demo/existing.hpp'],
        projectRoot: TEST_ROOT,
      });

      assert.deepEqual(result.issues, []);
      assert.deepEqual(result.advisories, []);
      assert.deepEqual(result.existing, ['src/modules/demo/existing.hpp']);
      assert.deepEqual(result.toCreate, []);
    });

    it('新建与已有混合的写集：两路分流各自正确', () => {
      const result = evaluateWriteSet({
        writes: ['src/modules/demo/existing.hpp', 'src/modules/demo/src/new.cpp'],
        projectRoot: TEST_ROOT,
      });

      assert.deepEqual(result.issues, [], '混合写集也不该有阻断项');
      assert.deepEqual(result.existing, ['src/modules/demo/existing.hpp']);
      assert.deepEqual(result.toCreate, ['src/modules/demo/src/new.cpp']);
    });
  });

  describe('保护域 —— 真正该拦的', () => {
    it('写集写进 policy/ 被判为阻断项', () => {
      const result = evaluateWriteSet({
        writes: ['policy/policy.yaml'],
        projectRoot: TEST_ROOT,
      });

      assert.equal(result.issues.length, 1);
      assert.match(result.issues[0], /protected domain/i);
    });

    it('写集写进 .zelto/ 被判为阻断项', () => {
      const result = evaluateWriteSet({
        writes: ['.zelto/slices/x.json'],
        projectRoot: TEST_ROOT,
      });

      assert.equal(result.issues.length, 1);
      assert.match(result.issues[0], /protected domain/i);
    });

    it('写集写进 AGENTS.md 被判为阻断项', () => {
      const result = evaluateWriteSet({
        writes: ['AGENTS.md'],
        projectRoot: TEST_ROOT,
      });

      assert.equal(result.issues.length, 1);
      assert.match(result.issues[0], /protected domain/i);
    });

    it('glob 写集命中保护域同样被拦（policy/**）', () => {
      const result = evaluateWriteSet({
        writes: ['policy/**'],
        projectRoot: TEST_ROOT,
      });

      assert.equal(result.issues.length, 1);
      assert.match(result.issues[0], /protected domain/i);
    });

    it('保护域判定是纯函数，不依赖文件系统', () => {
      assert.equal(writeSetHitsProtectedDomain('policy/**'), true);
      assert.equal(writeSetHitsProtectedDomain('policy/policy.yaml'), true);
      assert.equal(writeSetHitsProtectedDomain('.zelto/**'), true);
      assert.equal(writeSetHitsProtectedDomain('AGENTS.md'), true);
      assert.equal(writeSetHitsProtectedDomain('.cursor/rules/**'), true);
      assert.equal(writeSetHitsProtectedDomain('src/core/**'), false);
      assert.equal(writeSetHitsProtectedDomain('docs/policy-notes.md'), false);
    });
  });

  describe('路径逃逸', () => {
    it('写到项目根之外的路径被拦', () => {
      const result = evaluateWriteSet({
        writes: ['../outside/file.cpp'],
        projectRoot: TEST_ROOT,
      });

      assert.equal(result.issues.length, 1);
      assert.match(result.issues[0], /escapes the project root/i);
    });

    it('绝对路径逃出项目根被拦', () => {
      const result = evaluateWriteSet({
        writes: ['C:/somewhere/else/file.cpp'],
        projectRoot: TEST_ROOT,
      });

      assert.equal(result.issues.length, 1);
      assert.match(result.issues[0], /escapes the project root/i);
    });

    it('逃逸判定是纯函数', () => {
      assert.equal(writeSetEscapesRoot('../x', TEST_ROOT), true);
      assert.equal(writeSetEscapesRoot('src/x', TEST_ROOT), false);
    });
  });

  describe('glob 写集', () => {
    it('glob 写集归入 globs，不当作具体路径核实', () => {
      const result = evaluateWriteSet({
        writes: ['src/modules/demo/**'],
        projectRoot: TEST_ROOT,
      });

      assert.deepEqual(result.issues, []);
      assert.deepEqual(result.globs, ['src/modules/demo/**']);
    });

    it('命中已有文件的 glob 不产生提示', () => {
      const result = evaluateWriteSet({
        writes: ['src/modules/demo/**'],
        projectRoot: TEST_ROOT,
      });

      assert.deepEqual(result.advisories, [], '命中已有文件的 glob 不该提示');
    });

    it('命中不到任何文件的 glob 产生提示', () => {
      const result = evaluateWriteSet({
        writes: ['src/modules/nonexistent/**'],
        projectRoot: TEST_ROOT,
      });

      assert.equal(result.advisories.length, 1);
      assert.match(result.advisories[0], /glob/i);
    });
  });

  describe('跑完之后：写集里该产出的文件没产出', () => {
    it('写集文件一个都没动 → 全部报为未产出', () => {
      const missing = findUnproducedWriteSetPaths(
        ['src/modules/demo/src/a.cpp', 'src/modules/demo/src/b.cpp'],
        [],
      );
      assert.deepEqual(missing, ['src/modules/demo/src/a.cpp', 'src/modules/demo/src/b.cpp']);
    });

    it('改动过的写集文件不算未产出', () => {
      const missing = findUnproducedWriteSetPaths(
        ['src/modules/demo/src/a.cpp', 'src/modules/demo/src/b.cpp'],
        ['src/modules/demo/src/a.cpp'],
      );
      assert.deepEqual(missing, ['src/modules/demo/src/b.cpp']);
    });

    it('目录式写集：目录里有改动就不算未产出', () => {
      const missing = findUnproducedWriteSetPaths(
        ['src/modules/demo/'],
        ['src/modules/demo/src/a.cpp'],
      );
      assert.deepEqual(missing, []);
    });

    it('glob 写集不逐个核实', () => {
      const missing = findUnproducedWriteSetPaths(['src/modules/demo/**'], []);
      assert.deepEqual(missing, []);
    });
  });

  describe('写集覆盖判定', () => {
    it('具体路径命中写集', () => {
      assert.equal(isInWriteSet('src/a.cpp', ['src/a.cpp']), true);
      assert.equal(isInWriteSet('src/a.cpp', ['src/']), true);
      assert.equal(isInWriteSet('src/a.cpp', ['src/**/*.cpp']), true);
      assert.equal(isInWriteSet('src/a.cpp', ['docs/**']), false);
    });

    it('目录覆盖判定', () => {
      assert.equal(writeSetCoversDir(['src/modules/demo/**'], 'src/modules/demo'), true);
      assert.equal(writeSetCoversDir(['src/modules/demo/**'], 'src/other'), false);
    });
  });
});

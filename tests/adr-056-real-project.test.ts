// ADR-056 真实项目验证（nimrtc-zelto）暴露的缺陷的回归测试
//
// 这些 bug 全都是**在真实工程里跑出来的** —— 单元测试与合成环境都测不到：
//
// 1. C++ 头文件（`.hpp`）没有工件映射 → 跨版本冲突降级成 warning
// 2. 跨版本冲突按**工件名**合并 → 「改不同头文件」也被说成「都动同一工件」
// 3. `version ship` 的工作区守卫没豁免 zelto 管理的规格文件
// 4. 未跟踪的**验收骨架**挡住 merge 与 ship —— 且 git 会把目录折叠掉
// 5. `version ship` 里 `save(旧对象)` 覆盖了 `updateVersionStatus` 写的状态
// 6. `version deliver` 一路设到 delivered，越权宣布交付

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectCrossVersionConflicts } from '../src/core/sched/cross-version.js';
import {
  isPureTodoSkeleton,
  isAcceptancePath,
  isUntouchedAcceptanceSkeleton,
} from '../src/core/project/managed-acceptance.js';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'zelto-adr056-real-'));

// ─── 缺陷 1 + 2：C++ 分类与按路径定级 ─────────────────────────────────────

describe('C++ 工件分类（真实项目验证补的）', () => {
  it('C++ 头文件判为 error 级（类型定义）', () => {
    const conflicts = detectCrossVersionConflicts([
      { version: 'v1', writes: ['src/modules/net_feedback/include/nimrtc/net_feedback/aggregator.hpp'] },
      { version: 'v3', writes: ['src/modules/net_feedback/include/nimrtc/net_feedback/aggregator.hpp'] },
    ]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].severity, 'error');
    assert.equal(conflicts[0].category, 'type_definition');
  });

  it('C++ 源文件判为 api_contract 级', () => {
    const conflicts = detectCrossVersionConflicts([
      { version: 'v1', writes: ['src/modules/net_feedback/src/aggregator.cpp'] },
      { version: 'v3', writes: ['src/modules/net_feedback/src/aggregator.cpp'] },
    ]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].category, 'api_contract');
  });

  it('真实项目的 v1/v3 重叠：头文件与源文件各出一条', () => {
    // nimrtc-zelto 的真实计划：v1 与 v3 都动 aggregator.hpp / aggregator.cpp
    const conflicts = detectCrossVersionConflicts([
      {
        version: 'v1',
        writes: [
          'src/modules/net_feedback/include/nimrtc/net_feedback/aggregator.hpp',
          'src/modules/net_feedback/src/aggregator.cpp',
        ],
      },
      {
        version: 'v3',
        writes: [
          'src/modules/net_feedback/include/nimrtc/net_feedback/aggregator.hpp',
          'src/modules/net_feedback/src/aggregator.cpp',
        ],
      },
    ]);
    assert.equal(conflicts.length, 2, '两个重叠文件应各出一条');
    assert.ok(conflicts.every((c) => c.severity === 'error'));
  });

  it('改**不同**的头文件不算冲突（不因同类而误报）', () => {
    const conflicts = detectCrossVersionConflicts([
      { version: 'v1', writes: ['src/modules/net_feedback/include/nimrtc/net_feedback/aggregator.hpp'] },
      { version: 'v3', writes: ['src/modules/net_feedback/include/nimrtc/net_feedback/safety_check.hpp'] },
    ]);
    assert.equal(conflicts.length, 0, '不同文件不重叠 → 无冲突');
  });

  it('冲突按具体路径分别报出，不合并成一条', () => {
    const conflicts = detectCrossVersionConflicts([
      { version: 'v1', writes: ['a/types.ts', 'b/types.ts'] },
      { version: 'v2', writes: ['a/types.ts', 'b/types.ts'] },
    ]);
    assert.equal(conflicts.length, 2);
    assert.ok(conflicts.every((c) => c.paths.length === 1), '每条冲突只对应一个具体路径');
  });

  it('没有映射到工件的路径仍按路径重叠报 warning', () => {
    const conflicts = detectCrossVersionConflicts([
      { version: 'v1', writes: ['some/random/file.xyz'] },
      { version: 'v2', writes: ['some/random/file.xyz'] },
    ]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].severity, 'warning');
    assert.equal(conflicts[0].artifact, '(路径重叠)');
  });
});

// ─── 缺陷 4：验收骨架豁免 ─────────────────────────────────────────────────

describe('验收骨架豁免（真实项目验证补的）', () => {
  const SKELETON = `// 验收测试骨架
const { test } = require('node:test');

test.todo("甲要成立");
test.todo("乙要成立");
`;

  it('认得验收目录下的路径', () => {
    assert.equal(isAcceptancePath('tests/acceptance/v1-x/acceptance.test.cjs'), true);
    assert.equal(isAcceptancePath('tests/acceptance/v1-x/'), true);
    assert.equal(isAcceptancePath('src/tests/acceptance/x.cjs'), false);
    assert.equal(isAcceptancePath('tests/other/x.cjs'), false);
  });

  it('纯 todo 骨架被认出来', () => {
    assert.equal(isPureTodoSkeleton(SKELETON), true);
  });

  it('有真断言的文件不算骨架', () => {
    const withAssertion = SKELETON.replace('test.todo("甲要成立");', 'test("甲要成立", () => { assert.ok(true); });');
    assert.equal(isPureTodoSkeleton(withAssertion), false);
  });

  it('test.skip / test.only 也不算纯 todo', () => {
    assert.equal(isPureTodoSkeleton('test.skip("x", () => {});'), false);
    assert.equal(isPureTodoSkeleton('test.only("x", () => {});'), false);
  });

  it('一条真断言都没有的文件不算骨架', () => {
    assert.equal(isPureTodoSkeleton('// 什么都没有\n'), false);
  });

  it('文件形态：纯 todo 骨架被豁免', () => {
    const dir = join(TEST_DIR, 'file-shape');
    const target = join(dir, 'tests', 'acceptance', 'v1-x');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'acceptance.test.cjs'), SKELETON, 'utf-8');
    assert.equal(
      isUntouchedAcceptanceSkeleton('tests/acceptance/v1-x/acceptance.test.cjs', dir),
      true,
    );
  });

  it('文件形态：agent 改成真断言后不再豁免', () => {
    const dir = join(TEST_DIR, 'file-shape-real');
    const target = join(dir, 'tests', 'acceptance', 'v1-x');
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'acceptance.test.cjs'),
      SKELETON.replace('test.todo("甲要成立");', 'test("甲要成立", () => {});'),
      'utf-8',
    );
    assert.equal(
      isUntouchedAcceptanceSkeleton('tests/acceptance/v1-x/acceptance.test.cjs', dir),
      false,
    );
  });

  it('目录形态（git 折叠未跟踪目录）：整目录只有骨架才豁免', () => {
    // git 报告未跟踪内容时把目录折叠成目录本身：
    // `?? tests/acceptance/v2-x/` 而不是逐个文件
    const dir = join(TEST_DIR, 'dir-shape');
    mkdirSync(join(dir, 'tests', 'acceptance', 'v2-x'), { recursive: true });
    writeFileSync(
      join(dir, 'tests', 'acceptance', 'v2-x', 'acceptance.test.cjs'),
      SKELETON,
      'utf-8',
    );
    assert.equal(
      isUntouchedAcceptanceSkeleton('tests/acceptance/v2-x/', dir),
      true,
      '整目录只有纯 todo 骨架 → 豁免',
    );
  });

  it('目录形态：目录里有别的文件就不豁免', () => {
    const dir = join(TEST_DIR, 'dir-shape-extra');
    const target = join(dir, 'tests', 'acceptance', 'v2-y');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'acceptance.test.cjs'), SKELETON, 'utf-8');
    writeFileSync(join(target, 'helper.test.cjs'), 'test("x", () => {});', 'utf-8');
    assert.equal(
      isUntouchedAcceptanceSkeleton('tests/acceptance/v2-y/', dir),
      false,
      '目录里有别的测试文件 → 不豁免',
    );
  });

  it('目录形态：骨架里有真断言就不豁免', () => {
    const dir = join(TEST_DIR, 'dir-shape-real');
    const target = join(dir, 'tests', 'acceptance', 'v2-z');
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'acceptance.test.cjs'),
      SKELETON.replace('test.todo("甲要成立");', 'test("甲要成立", () => {});'),
      'utf-8',
    );
    assert.equal(
      isUntouchedAcceptanceSkeleton('tests/acceptance/v2-z/', dir),
      false,
    );
  });

  it('非验收目录一律不豁免', () => {
    const dir = join(TEST_DIR, 'not-acceptance');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), SKELETON, 'utf-8');
    assert.equal(isUntouchedAcceptanceSkeleton('src/a.ts', dir), false);
  });

  it('读不到的文件不豁免（保守）', () => {
    assert.equal(
      isUntouchedAcceptanceSkeleton('tests/acceptance/nonexistent/acceptance.test.cjs', TEST_DIR),
      false,
    );
  });
});

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

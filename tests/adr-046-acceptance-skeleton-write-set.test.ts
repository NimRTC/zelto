// ADR-046 · 验收骨架必须进写集
//
// zelto 自己生成验收骨架（全是 test.todo），自己要求把它改成真断言
// （门禁②的 verifyAcceptanceRanTests），又自己禁止改（写集 + hook）。
// 三段合起来的效果是：任何走完 `zelto spec draft` 的切片都必然过不了门禁②。
//
// 这个文件钉住两件事：
//   1. 骨架路径能算出来（acceptanceSkeletonTarget）；
//   2. 骨架进了写集 —— agent 能合法改，指令也明确要求改。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { acceptanceSkeletonTarget, writeAcceptanceSkeleton } from '../src/core/spec/skeleton.js';
import { Scheduler } from '../src/core/sched/engine.js';
import type { SliceData } from '../src/core/slice/store.js';

const TEST_DIR = join(tmpdir(), `zelto-adr046-test-${Date.now()}`);

// ─── 骨架路径 ───────────────────────────────────────────────────────────────

describe('ADR-046 · 验收骨架路径', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('目录形态 → <目录>/acceptance.test.cjs', () => {
    const target = acceptanceSkeletonTarget('tests/acceptance/s1/', TEST_DIR);
    // 路径统一正斜杠（ADR-051）：不能用 join() 断言 —— Windows 上它给反斜杠。
    assert.equal(target, 'tests/acceptance/s1/acceptance.test.cjs');
  });

  it('文件形态 → 那个文件本身', () => {
    const target = acceptanceSkeletonTarget('tests/acceptance/s1.test.ts', TEST_DIR);
    assert.equal(target, 'tests/acceptance/s1.test.ts');
  });

  it('已存在的目录也算目录形态', async () => {
    const dir = join(TEST_DIR, 'tests', 'acceptance', 'existing');
    await mkdir(dir, { recursive: true });
    const target = acceptanceSkeletonTarget('tests/acceptance/existing', TEST_DIR);
    assert.equal(target, 'tests/acceptance/existing/acceptance.test.cjs');
  });

  it('算出来的路径与实际生成的文件一致', () => {
    const spec = '# Slice: s\n\n## 验收标准\n\n1. 甲要成立；验证方式：测试\n';
    const result = writeAcceptanceSkeleton('tests/acceptance/target-match/', spec, 's', TEST_DIR);
    assert.ok(result.path);
    assert.equal(result.path, acceptanceSkeletonTarget('tests/acceptance/target-match/', TEST_DIR));
  });
});

// ─── 指令里要求把 todo 改成断言 ─────────────────────────────────────────────

describe('ADR-046 · 约束包要求把 todo 改成断言', () => {
  function makeSlice(writes: string[]): SliceData {
    return {
      id: 'v1-demo',
      title: '示例',
      state: 'frozen',
      spec: { path: 'specs/slices/v1-demo.md', frozenHash: 'sha256:abc', frozenAt: null },
      acceptance: { dir: 'tests/acceptance/v1-demo/', frozenHash: null, oracleSrc: null },
      baseCommit: null,
      drift: { detected: false, reason: null, at: null },
      trace: { requirements: ['r1'], contracts: [], tests: [] },
      traceWaiver: null,
      baseline: false,
      type: 'code',
      writes,
      runs: [],
      clarifyRounds: 0,
      stall: { class: null, autoResolved: 0, gateRetries: 0 },
      createdAt: '2026-11-11T00:00:00.000Z',
      updatedAt: '2026-11-11T00:00:00.000Z',
    } as SliceData;
  }

  const scheduler = new Scheduler(
    { read: async () => makeSlice([]) } as never,
    { append: async () => {} } as never,
    { rules: [], protected: [] },
  );

  it('写集里有骨架时，指令要求把 todo 换成真断言', () => {
    const bundle = scheduler.buildConstraints(
      makeSlice(['src/demo/**', 'tests/acceptance/v1-demo/acceptance.test.cjs']),
    );
    assert.match(bundle.instructions, /test\.todo/);
    assert.match(bundle.instructions, /real assertion/);
    assert.match(bundle.instructions, /tests\/acceptance\/v1-demo\/acceptance\.test\.cjs/);
  });

  it('写集里没有骨架时，不提这件事', () => {
    const bundle = scheduler.buildConstraints(makeSlice(['src/demo/**']));
    assert.ok(!bundle.instructions.includes('test.todo'));
  });
});

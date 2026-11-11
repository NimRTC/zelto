// Tests for the scheduler's constraint bundle (ADR-045)
//
// 约束包是 zelto 给 agent 的**唯一**契约来源。它说什么，agent 就照什么做；
// 它没说的，agent 只能猜。
//
// ADR-045 的教训：门禁命令没进约束包，agent 猜错了 CMake 生成器，
// 门禁②在 agent 留下的现场上失败，而失败的报错指向「环境不对」。

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Scheduler } from '../../../src/core/sched/engine.js';
import type { SliceData } from '../../../src/core/slice/store.js';
import type { EventStream } from '../../../src/core/events/stream.js';
import type { PolicyConfig } from '../../../src/core/policy/types.js';

/** 一个够用的切片桩 —— 约束包只读这几个字段。 */
function makeSlice(overrides: Partial<SliceData> = {}): SliceData {
  return {
    id: 'v1-demo',
    title: '示例切片',
    state: 'frozen',
    spec: { path: 'specs/slices/v1-demo.md', frozenHash: 'sha256:abc', frozenAt: '2026-11-11T00:00:00.000Z' },
    acceptance: { dir: 'tests/acceptance/v1-demo/', frozenHash: null, oracleSrc: null },
    baseCommit: 'abc123',
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: ['r1'], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    type: 'code',
    writes: ['src/demo/**'],
    runs: [],
    clarifyRounds: 0,
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    agentTimeout: undefined,
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  } as SliceData;
}

/** 不做任何事的事件流 —— 约束包构建不写事件。 */
const nullEvents = {
  append: async () => {},
} as unknown as EventStream;

const emptyPolicy: PolicyConfig = { rules: [], protected: [] };

describe('Scheduler.buildConstraints — 门禁命令（ADR-045）', () => {
  it('carries the gate commands into the bundle', () => {
    const scheduler = new Scheduler({ read: async () => makeSlice() } as never, nullEvents, emptyPolicy);

    const bundle = scheduler.buildConstraints(makeSlice(), null, [
      { name: 'configure', run: 'cmake -S . -B build -G "Visual Studio 17 2022" -A x64' },
      { name: 'build', run: 'cmake --build build --config Debug' },
    ]);

    assert.ok(bundle.gateCommands);
    assert.equal(bundle.gateCommands.length, 2);
    assert.equal(bundle.gateCommands[0].name, 'configure');
  });

  it('spells the gate commands out in the instructions', () => {
    const scheduler = new Scheduler({ read: async () => makeSlice() } as never, nullEvents, emptyPolicy);

    const bundle = scheduler.buildConstraints(makeSlice(), null, [
      { name: 'configure', run: 'cmake -S . -B build -G "Visual Studio 17 2022"' },
      { name: 'test', run: 'ctest --test-dir build -C Debug -R demo' },
    ]);

    assert.match(bundle.instructions, /How the gate will verify your work/);
    assert.match(bundle.instructions, /cmake -S \. -B build -G "Visual Studio 17 2022"/);
    assert.match(bundle.instructions, /ctest --test-dir build -C Debug -R demo/);
  });

  it('warns against reconfiguring the build tree with a different generator', () => {
    const scheduler = new Scheduler({ read: async () => makeSlice() } as never, nullEvents, emptyPolicy);

    const bundle = scheduler.buildConstraints(makeSlice(), null, [
      { name: 'configure', run: 'cmake -S . -B build' },
    ]);

    // 这句提示是 ADR-045 的核心：agent 换个生成器配一遍，门禁就废了。
    assert.match(bundle.instructions, /different generator/);
    assert.match(bundle.instructions, /same/i);
  });

  it('omits the section entirely when there are no gate commands', () => {
    const scheduler = new Scheduler({ read: async () => makeSlice() } as never, nullEvents, emptyPolicy);

    const bundle = scheduler.buildConstraints(makeSlice());

    assert.equal(bundle.gateCommands, undefined);
    assert.ok(!bundle.instructions.includes('How the gate will verify your work'));
  });

  it('still contains the write-set and protected paths', () => {
    const scheduler = new Scheduler({ read: async () => makeSlice() } as never, nullEvents, emptyPolicy);

    const bundle = scheduler.buildConstraints(makeSlice(), null, [
      { name: 'build', run: 'make' },
    ]);

    assert.deepEqual(bundle.writes, ['src/demo/**']);
    assert.ok(bundle.protectedPaths.includes('.zelto/**'));
  });
});

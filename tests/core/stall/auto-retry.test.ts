import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { store, events } from '../../../src/cli/commands/shared.js';
import { handleAgentFailure } from '../../../src/cli/commands/core-slice.js';
import { markSliceStalled } from '../../../src/cli/commands/run-support.js';

describe('handleAgentFailure — auto-retry logic', () => {
  function makeSliceData(id: string, autoResolved = 0) {
    const now = new Date().toISOString();
    return {
      id,
      title: 'test-slice',
      state: 'running' as const,
      spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
      acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
      baseCommit: null,
      drift: { detected: false, reason: null, at: null },
      trace: { requirements: [], contracts: [], tests: [] },
      traceWaiver: null,
      baseline: false,
      type: 'feature' as const,
      writes: [],
      runs: [],
      stall: { class: null, autoResolved, gateRetries: 0 },
      createdAt: now,
      updatedAt: now,
    };
  }

  it('should return retry for transient_error (exit code 139)', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => makeSliceData('test-slice-1'));
    const writeMock = mock.method(store, 'write', async () => {});

    const result = await handleAgentFailure('test-slice-1', 139, { maxRetries: 2 });

    assert.equal(result.action, 'retry');
    assert.equal(result.retryCount, 1);
    assert.equal(appendMock.mock.callCount(), 1);

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });

  it('should return retry for environment_failure (exit code 66)', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => makeSliceData('test-slice-2'));
    const writeMock = mock.method(store, 'write', async () => {});

    const result = await handleAgentFailure('test-slice-2', 66, { maxRetries: 2 });

    // Exit code 66 → test_failure → environment_failure → auto-resolvable → retry
    assert.equal(result.action, 'retry');
    assert.equal(result.retryCount, 1);
    assert.equal(appendMock.mock.callCount(), 1);

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });

  it('should return stall when auto-retry exhausted', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => makeSliceData('test-slice-3', 2));
    const writeMock = mock.method(store, 'write', async () => {});

    const result = await handleAgentFailure('test-slice-3', 139, { maxRetries: 2 });

    assert.equal(result.action, 'stall');
    // ADR-047：停机现在会写两条事件 —— 先是状态迁移（running → frozen），
    // 再是停机分类。只写分类不迁状态就是「切片卡在 running」那个病灶。
    assert.equal(appendMock.mock.callCount(), 2);

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });

  it('should increment autoResolved count in slice data on retry', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    let sliceData = makeSliceData('test-slice-4', 0);
    const readMock = mock.method(store, 'read', async () => sliceData);
    const writeMock = mock.method(store, 'write', async (data: typeof sliceData) => {
      sliceData = data;
    });

    const result = await handleAgentFailure('test-slice-4', 139, { maxRetries: 3 });

    assert.equal(result.action, 'retry');
    assert.equal(sliceData.stall.autoResolved, 1);

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });

  it('should handle store read failure gracefully', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => {
      throw new Error('ENOENT');
    });
    const writeMock = mock.method(store, 'write', async () => {});

    const result = await handleAgentFailure('nonexistent-slice', 139, { maxRetries: 2 });

    // When store.read fails, falls through to stall path (also tries to write stall, which may also fail)
    assert.equal(result.action, 'stall');

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });

  it('should write stall.classified event with autoRetry flag on retry', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => makeSliceData('test-slice-5', 0));
    const writeMock = mock.method(store, 'write', async () => {});

    await handleAgentFailure('test-slice-5', 139, { maxRetries: 2 });

    const callArgs = appendMock.mock.calls[0]!.arguments;
    assert.equal(callArgs[0], 'test-slice-5');
    assert.equal(callArgs[1], 'stall.classified');
    assert.equal(callArgs[3]!.autoRetry, true);
    assert.equal(callArgs[3]!.retryCount, 1);

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });

  it('should write stall.classified event without autoRetry on retry exhausted', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => makeSliceData('test-slice-6', 2));
    const writeMock = mock.method(store, 'write', async () => {});

    await handleAgentFailure('test-slice-6', 139, { maxRetries: 2 });

    // autoResolved (2) >= maxRetries (2) → falls through to stall path
    // stall path event does NOT include autoRetry
    //
    // ADR-047：停机现在写两条事件 —— 先迁状态（slice.state.changed），
    // 再写停机分类（stall.classified）。所以这里按事件**类型**找，
    // 而不是假设「第一条就是 stall.classified」。
    const stallEvent = appendMock.mock.calls
      .map((c) => c.arguments)
      .find((args) => args[1] === 'stall.classified');
    assert.ok(stallEvent, '应当写下 stall.classified 事件');
    assert.equal(stallEvent![3]!.autoRetry, undefined);
    assert.equal(stallEvent![3]!.stateFrom, 'running');
    assert.equal(stallEvent![3]!.stateTo, 'frozen');

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });
});

// ─── ADR-047：停机时状态必须一并迁走 ─────────────────────────────────────

describe('markSliceStalled — 停机的唯一落点（ADR-047）', () => {
  function makeRunningSlice(id: string) {
    const now = new Date().toISOString();
    return {
      id,
      title: 'test-slice',
      state: 'running' as const,
      spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
      acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
      baseCommit: null,
      drift: { detected: false, reason: null, at: null },
      trace: { requirements: [], contracts: [], tests: [] },
      traceWaiver: null,
      baseline: false,
      type: 'feature' as const,
      writes: [],
      runs: [],
      stall: { class: null, autoResolved: 0, gateRetries: 0 },
      createdAt: now,
      updatedAt: now,
    };
  }

  it('停机时把 running 迁回 frozen', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => makeRunningSlice('stall-1'));
    const transitMock = mock.method(store, 'transit', async () => makeRunningSlice('stall-1'));
    const writeMock = mock.method(store, 'write', async () => {});

    const result = await markSliceStalled('stall-1', 'environment_failure', { exitCode: 1 });

    assert.equal(result.reverted, true, '应当真的迁移状态');
    assert.equal(result.from, 'running');
    assert.equal(result.to, 'frozen');

    appendMock.mock.restore();
    readMock.mock.restore();
    transitMock.mock.restore();
    writeMock.mock.restore();
  });

  it('不在 running 的切片不动状态', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => {
      const s = makeRunningSlice('stall-2');
      return { ...s, state: 'frozen' as const };
    });
    const transitMock = mock.method(store, 'transit', async () => makeRunningSlice('stall-2'));
    const writeMock = mock.method(store, 'write', async () => {});

    const result = await markSliceStalled('stall-2', 'environment_failure', { exitCode: 1 });

    assert.equal(result.reverted, false, 'frozen 的切片不该被迁移');
    assert.equal(transitMock.mock.callCount(), 0, '不该发出多余的转换');

    appendMock.mock.restore();
    readMock.mock.restore();
    transitMock.mock.restore();
    writeMock.mock.restore();
  });

  it('停机事件里带上状态迁移的起止（追溯链上看得见它从哪来）', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => makeRunningSlice('stall-3'));
    const transitMock = mock.method(store, 'transit', async () => makeRunningSlice('stall-3'));
    const writeMock = mock.method(store, 'write', async () => {});

    await markSliceStalled('stall-3', 'cognitive_stuck', { exitCode: 2 });

    const stallEvent = appendMock.mock.calls
      .map((c) => c.arguments)
      .find((args) => args[1] === 'stall.classified');
    assert.ok(stallEvent, '应当写下 stall.classified 事件');
    assert.equal(stallEvent![3]!.stateFrom, 'running');
    assert.equal(stallEvent![3]!.stateTo, 'frozen');

    appendMock.mock.restore();
    readMock.mock.restore();
    transitMock.mock.restore();
    writeMock.mock.restore();
  });
});

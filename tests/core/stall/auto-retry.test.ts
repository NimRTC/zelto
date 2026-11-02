import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { store, events } from '../../../src/cli/commands/shared.js';
import { handleAgentFailure } from '../../../src/cli/commands/core-slice.js';

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
    assert.equal(appendMock.mock.callCount(), 1);

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
    const callArgs = appendMock.mock.calls[0]!.arguments;
    assert.equal(callArgs[1], 'stall.classified');
    assert.equal(callArgs[3]!.autoRetry, undefined);

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });
});

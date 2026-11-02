import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventStream } from '../../../src/core/events/index.js';
import { handleAgentFailure } from '../../../src/cli/commands/core-slice.js';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('handleAgentFailure — auto-retry logic', () => {
  const sliceDir = join(tmpdir(), 'zelto-test-stall');

  it('should return retry for transient_error (exit code 139)', async () => {
    const events = new EventStream(sliceDir);
    const appendMock = mock.method(events, 'append', async () => {});

    const result = await handleAgentFailure(
      'test-slice-1',
      139,
      '',
      '',
      sliceDir,
      events,
      { maxRetries: 2 },
    );

    assert.equal(result.action, 'retry');
    assert.equal(result.retryCount, 1);
    assert.equal(appendMock.mock.callCount(), 1);
  });

  it('should return stall for budget_exhausted (exit code 66)', async () => {
    const events = new EventStream(sliceDir);
    const appendMock = mock.method(events, 'append', async () => {});

    const result = await handleAgentFailure(
      'test-slice-2',
      66,
      'budget exhausted for model',
      '',
      sliceDir,
      events,
      { maxRetries: 2 },
    );

    assert.equal(result.action, 'stall');
    assert.equal(appendMock.mock.callCount(), 1);
  });

  it('should return stall when auto-retry exhausted', async () => {
    const events = new EventStream(sliceDir);
    const appendMock = mock.method(events, 'append', async () => {});
    const slicePath = join(sliceDir, 'test-slice-3.json');

    await mkdir(sliceDir, { recursive: true });
    await writeFile(slicePath, JSON.stringify({
      id: 'test-slice-3',
      stall: { autoResolved: 2 },
    }));

    const result = await handleAgentFailure(
      'test-slice-3',
      139,
      '',
      '',
      sliceDir,
      events,
      { maxRetries: 2 },
    );

    assert.equal(result.action, 'stall');
    assert.equal(appendMock.mock.callCount(), 1);

    await unlink(slicePath).catch(() => {});
  });

  it('should increment autoResolved count in slice file on retry', async () => {
    const events = new EventStream(sliceDir);
    mock.method(events, 'append', async () => {});
    const slicePath = join(sliceDir, 'test-slice-4.json');

    await mkdir(sliceDir, { recursive: true });
    await writeFile(slicePath, JSON.stringify({
      id: 'test-slice-4',
      stall: { autoResolved: 0 },
    }));

    const result = await handleAgentFailure(
      'test-slice-4',
      139,
      '',
      '',
      sliceDir,
      events,
      { maxRetries: 3 },
    );

    assert.equal(result.action, 'retry');

    const raw = await import('node:fs/promises').then(m => m.readFile(slicePath, 'utf-8'));
    const data = JSON.parse(raw);
    assert.equal(data.stall.autoResolved, 1);

    await unlink(slicePath).catch(() => {});
  });

  it('should handle missing slice file gracefully', async () => {
    const events = new EventStream(sliceDir);
    const appendMock = mock.method(events, 'append', async () => {});

    const result = await handleAgentFailure(
      'nonexistent-slice',
      139,
      '',
      '',
      sliceDir,
      events,
      { maxRetries: 2 },
    );

    assert.equal(result.action, 'retry');
    assert.equal(appendMock.mock.callCount(), 1);
  });

  it('should write stall.classified event with autoRetry flag on retry', async () => {
    const events = new EventStream(sliceDir);
    const appendMock = mock.method(events, 'append', async () => {});

    await handleAgentFailure('test-slice-5', 139, '', '', sliceDir, events, { maxRetries: 2 });

    const callArgs = appendMock.mock.calls[0].arguments;
    assert.equal(callArgs[0], 'test-slice-5');
    assert.equal(callArgs[1], 'stall.classified');
    assert.equal(callArgs[3].autoRetry, true);
    assert.equal(callArgs[3].retryCount, 1);
  });

  it('should write stall.classified event without autoRetry on non-retryable', async () => {
    const events = new EventStream(sliceDir);
    const appendMock = mock.method(events, 'append', async () => {});

    await handleAgentFailure('test-slice-6', 66, 'budget exhausted', '', sliceDir, events, { maxRetries: 2 });

    const callArgs = appendMock.mock.calls[0].arguments;
    assert.equal(callArgs[3].autoRetry, false);
  });
});

// Tests for ClaudeAgentSdkAdapter
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { ClaudeAgentSdkAdapter } from '../src/adapters/claude-agent-sdk/index.js';

const _require = createRequire(import.meta.url);

/**
 * Check whether the Claude Agent SDK is importable.
 * When the SDK is not installed or configured, `startup()` will hang,
 * so tests that call it must be skipped.
 */
function hasSdk(): boolean {
  try {
    _require.resolve('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

describe('ClaudeAgentSdkAdapter', () => {
  it('has required metadata', () => {
    const adapter = new ClaudeAgentSdkAdapter();
    assert.equal(adapter.name, 'claude-agent-sdk');
    assert.equal(adapter.metadata.version, '2.0.0');
    assert.equal(adapter.metadata.capabilities.resume, true);
    assert.equal(adapter.metadata.capabilities.events, true);
    assert.equal(adapter.metadata.capabilities.modelSelection, true);
  });

  it('accepts options', () => {
    const adapter = new ClaudeAgentSdkAdapter({
      cwd: '/test',
      maxBudgetUsd: 5.0,
      maxTurns: 50,
      model: 'sonnet',
    });
    assert.equal(adapter.name, 'claude-agent-sdk');
  });

  it('accepts empty options', () => {
    const adapter = new ClaudeAgentSdkAdapter({});
    assert.equal(adapter.name, 'claude-agent-sdk');
  });

  it('accepts env option', () => {
    const adapter = new ClaudeAgentSdkAdapter({
      env: { HOME: '/home/test', PATH: '/usr/bin' },
    });
    assert.equal(adapter.name, 'claude-agent-sdk');
  });

  it('stop() on unknown session throws', async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    await assert.rejects(
      adapter.stop('nonexistent-session'),
      /not found/i,
    );
  });

  it('stop() throws with descriptive message', async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    await assert.rejects(
      adapter.stop('unknown-123'),
      /Session.*not found/i,
    );
  });

  it('events() returns iterable', async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    const events = await adapter.events('nonexistent');
    assert.ok(events);
    assert.equal(typeof events[Symbol.asyncIterator], 'function');
  });

  it('events() returns empty iterable for unknown session', async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    const events = await adapter.events('unknown-session');
    let count = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of events) {
      count++;
    }
    assert.equal(count, 0);
  });

  it('waitForExit() returns null for unknown session', async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    const code = await adapter.waitForExit('nonexistent');
    assert.equal(code, null);
  });

  it('resume() does not throw for unknown session (graceful)', { skip: !hasSdk() }, async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    await adapter.resume('nonexistent', 'patch content');
  });

  it('start() returns a session with id', { skip: !hasSdk() }, async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    const result = await adapter.start({ sliceId: 'test', prompt: 'test prompt' });
    assert.ok(result.sessionId);
  });

  it('isSessionAlive returns false for unknown session', () => {
    const adapter = new ClaudeAgentSdkAdapter();
    assert.equal(adapter.isSessionAlive('nonexistent'), false);
  });

  it('getRecentEvents returns empty for unknown session', () => {
    const adapter = new ClaudeAgentSdkAdapter();
    assert.deepEqual(adapter.getRecentEvents('nonexistent'), []);
  });
});

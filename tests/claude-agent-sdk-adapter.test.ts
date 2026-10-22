// Tests for ClaudeAgentSdkAdapter
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAgentSdkAdapter } from '../src/adapters/claude-agent-sdk/index.js';

describe('ClaudeAgentSdkAdapter', () => {
  it('has required metadata', () => {
    const adapter = new ClaudeAgentSdkAdapter();
    assert.equal(adapter.name, 'claude-agent-sdk');
    assert.equal(adapter.metadata.version, '1.0.0');
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

  it('stop() on unknown session throws', async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    await assert.rejects(
      adapter.stop('nonexistent-session'),
      /not found/i,
    );
  });

  it('events() returns iterable', async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    const events = await adapter.events('nonexistent');
    assert.ok(events);
    assert.equal(typeof events[Symbol.asyncIterator], 'function');
  });

  it('waitForExit() returns null for unknown session', async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    const code = await adapter.waitForExit('nonexistent');
    assert.equal(code, null);
  });
});

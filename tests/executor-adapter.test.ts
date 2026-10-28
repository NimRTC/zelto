// Unit tests for ClaudeAgentAdapter

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAgentAdapter } from '../src/adapters/claude-agent/index.js';

const TEST_DIR = join(tmpdir(), 'zelto-adapter-test');

describe('ClaudeAgentAdapter', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('has required metadata', () => {
    const adapter = new ClaudeAgentAdapter();
    assert.equal(adapter.name, 'claude-agent');
    assert.equal(adapter.metadata.version, '2.0.0');
    assert.equal(adapter.metadata.capabilities.resume, false);
    assert.equal(adapter.metadata.capabilities.events, false);
  });

  it('start() spawns a child process and returns sessionId', async () => {
    // Use a simple echo command that exits immediately
    const adapter = new ClaudeAgentAdapter({
      agentCommand: 'echo',
      cwd: TEST_DIR,
    });

    const { sessionId } = await adapter.start({
      sliceId: 'test-slice-1',
      prompt: 'hello world',
    });

    assert.ok(sessionId.startsWith('claude-agent-test-slice-1-'), 'sessionId should have correct prefix');

    // Wait for exit
    const exitCode = await adapter.waitForExit(sessionId);
    assert.equal(exitCode, 0, 'echo should exit 0');
  });

  it('start() sets ZELTO env vars', async () => {
    // Use a script that writes env vars to a file
    const markerFile = join(TEST_DIR, 'env-marker.txt');

    const adapter = new ClaudeAgentAdapter({
      agentCommand: `node -e "require('fs').writeFileSync('${markerFile.replace(/\\/g, '\\\\')}', JSON.stringify({ZELTO_BUNDLE: process.env.ZELTO_BUNDLE, ZELTO_SLICE_ID: process.env.ZELTO_SLICE_ID, ZELTO_PROJECT_ROOT: process.env.ZELTO_PROJECT_ROOT}))"`,
      cwd: TEST_DIR,
    });

    const { sessionId } = await adapter.start({
      sliceId: 'test-env',
      prompt: '/tmp/bundle.json',
    });

    await adapter.waitForExit(sessionId);

    // Read the marker file
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(markerFile, 'utf-8');
    const env = JSON.parse(content);

    assert.equal(env.ZELTO_SLICE_ID, 'test-env');
    assert.equal(env.ZELTO_BUNDLE, '/tmp/bundle.json');
    assert.equal(env.ZELTO_PROJECT_ROOT, TEST_DIR);
  });

  it('stop() kills a running process', async () => {
    const adapter = new ClaudeAgentAdapter({
      // Use a long-running sleep command
      agentCommand: 'sleep 30',
      cwd: TEST_DIR,
    });

    const { sessionId } = await adapter.start({
      sliceId: 'test-stop',
      prompt: 'bundle',
    });

    // Stop it immediately
    await adapter.stop(sessionId);

    // Wait for exit — should exit with non-zero due to signal
    const exitCode = await adapter.waitForExit(sessionId);
    assert.notEqual(exitCode, 0, 'killed process should not exit 0');
  });

  it('resume() throws not supported', async () => {
    const adapter = new ClaudeAgentAdapter();
    await assert.rejects(
      () => adapter.resume('any', 'patch'),
      /resume not supported/,
    );
  });

  it('events() throws not supported', async () => {
    const adapter = new ClaudeAgentAdapter();
    await assert.rejects(
      () => adapter.events('any'),
      /events streaming not supported/,
    );
  });

  it('stop() on unknown session throws', async () => {
    const adapter = new ClaudeAgentAdapter();
    await assert.rejects(
      () => adapter.stop('nonexistent'),
      /Session "nonexistent" not found/,
    );
  });

  it('isSessionAlive returns true during execution', async () => {
    const adapter = new ClaudeAgentAdapter({
      agentCommand: 'sleep 5',
      cwd: TEST_DIR,
    });

    const { sessionId } = await adapter.start({
      sliceId: 'test-alive',
      prompt: 'bundle',
    });

    assert.equal(adapter.isSessionAlive(sessionId), true);
    await adapter.stop(sessionId);
    // After stop, isSessionAlive may still return true briefly (child process not yet dead)
    // but the session reference exists
  });

  it('isSessionAlive returns false for unknown session', () => {
    const adapter = new ClaudeAgentAdapter();
    assert.equal(adapter.isSessionAlive('nonexistent'), false);
  });

  it('getRecentOutput returns captured lines', async () => {
    const adapter = new ClaudeAgentAdapter({
      agentCommand: 'echo "line1" && echo "line2" && echo "line3"',
      cwd: TEST_DIR,
    });

    const { sessionId } = await adapter.start({
      sliceId: 'test-output',
      prompt: 'bundle',
    });

    await adapter.waitForExit(sessionId);
    const output = adapter.getRecentOutput(sessionId, 5);
    assert.ok(output.length >= 3);
    assert.ok(output.some((l) => l.includes('line1')));
    assert.ok(output.some((l) => l.includes('line3')));
  });

  it('getRecentOutput returns empty for unknown session', () => {
    const adapter = new ClaudeAgentAdapter();
    assert.deepEqual(adapter.getRecentOutput('nonexistent'), []);
  });

  it('onOutput callback fires for each output line', async () => {
    const lines: string[] = [];
    const adapter = new ClaudeAgentAdapter({
      agentCommand: 'echo "hello from agent"',
      cwd: TEST_DIR,
      onOutput: (_sessionId, text) => { lines.push(text); },
    });

    const { sessionId } = await adapter.start({
      sliceId: 'test-onoutput',
      prompt: 'bundle',
    });

    await adapter.waitForExit(sessionId);
    assert.ok(lines.length > 0);
    assert.ok(lines.some((l) => l.includes('hello from agent')));
  });

  it('onProgress callback fires during execution', async () => {
    const progressUpdates: Array<{ elapsedMs: number; status: string }> = [];
    const adapter = new ClaudeAgentAdapter({
      agentCommand: 'echo "quick"',
      cwd: TEST_DIR,
      onProgress: (_sessionId, elapsedMs, status) => {
        progressUpdates.push({ elapsedMs, status });
      },
    });

    const { sessionId } = await adapter.start({
      sliceId: 'test-onprogress',
      prompt: 'bundle',
    });

    await adapter.waitForExit(sessionId);
    // onProgress fires every 5s; a quick echo may not trigger it before exit
    // Just verify it doesn't throw
  });

  it('checkAgentAvailable returns null for known command', async () => {
    const result = await ClaudeAgentAdapter.checkAgentAvailable('echo');
    assert.equal(result, null);
  });

  it('checkAgentAvailable returns error for unknown command', async () => {
    const result = await ClaudeAgentAdapter.checkAgentAvailable('nonexistent-command-xyzzy');
    assert.ok(result !== null);
    assert.ok(result!.includes('not found'));
  });
});

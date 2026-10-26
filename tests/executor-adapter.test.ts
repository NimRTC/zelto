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
});

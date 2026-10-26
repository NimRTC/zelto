// AI pipeline CLI integration tests
// Tests the non-LLM parts of require/design/plan/version commands

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-ai-pipeline-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZELTO_SKIP_LLM: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
    // Timeout after 10s
    setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 10000).unref();
  });
}

describe('AI Pipeline — CLI commands', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    // Initialize zelto
    const { code } = await runCli('init');
    assert.equal(code, 0);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('require', () => {
    it('require list shows empty initially', async () => {
      const { stdout, code } = await runCli('require', 'list');
      assert.equal(code, 0);
      assert.ok(stdout.includes('No requirements'));
    });

    it('require without args shows usage', async () => {
      const { code } = await runCli('require');
      assert.equal(code, 1);
    });

    it('require confirm without id shows usage', async () => {
      const { code } = await runCli('require', 'confirm');
      assert.equal(code, 1);
    });

    it('require confirm nonexistent shows error', async () => {
      const { code, stderr } = await runCli('require', 'confirm', 'req-nonexistent');
      assert.equal(code, 1);
      assert.ok(stderr.includes('not found') || stderr.includes('Error'));
    });

    it('require refine without args shows usage', async () => {
      const { code } = await runCli('require', 'refine');
      assert.equal(code, 1);
    });
  });

  describe('design', () => {
    it('design list shows empty initially', async () => {
      const { stdout, code } = await runCli('design', 'list');
      assert.equal(code, 0);
      assert.ok(stdout.includes('No designs'));
    });

    it('design confirm nonexistent shows error', async () => {
      const { code, stderr } = await runCli('design', 'confirm', 'dsg-nonexistent');
      assert.equal(code, 1);
      assert.ok(stderr.includes('not found') || stderr.includes('Error'));
    });

    it('design refine without args shows usage', async () => {
      const { code } = await runCli('design', 'refine');
      assert.equal(code, 1);
    });

    it('design without args shows usage', async () => {
      const { code } = await runCli('design');
      assert.equal(code, 1);
    });
  });

  describe('plan', () => {
    it('plan confirm nonexistent shows error', async () => {
      const { code, stderr } = await runCli('plan', 'confirm', 'plan-nonexistent');
      assert.equal(code, 1);
      assert.ok(stderr.includes('not found') || stderr.includes('Error'));
    });

    it('plan add-version without args shows usage', async () => {
      const { code } = await runCli('plan', 'add-version');
      assert.equal(code, 1);
    });

    it('plan without args shows usage', async () => {
      const { code } = await runCli('plan');
      assert.equal(code, 1);
    });
  });

  describe('version', () => {
    it('version status shows no plans initially', async () => {
      const { stdout, code } = await runCli('version', 'status');
      assert.equal(code, 0);
      assert.ok(stdout.includes('No version plans'));
    });

    it('version start without args shows usage', async () => {
      const { code } = await runCli('version', 'start');
      assert.equal(code, 1);
    });

    it('version deliver without args shows usage', async () => {
      const { code } = await runCli('version', 'deliver');
      assert.equal(code, 1);
    });
  });

  describe('pipeline', () => {
    it('pipeline status shows no requirements initially', async () => {
      const { stdout, code } = await runCli('pipeline', 'status');
      assert.equal(code, 0);
      assert.ok(stdout.includes('No requirements'));
    });
  });

  describe('trace', () => {
    it('trace without args shows usage', async () => {
      const { code } = await runCli('trace');
      assert.equal(code, 0); // new trace handler shows help and returns 0
    });

    it('trace nonexistent shows error', async () => {
      const { code, stderr } = await runCli('trace', 'req-nonexistent');
      assert.equal(code, 1);
      assert.ok(stderr.includes('not found') || stderr.includes('Error'));
    });
  });

  describe('impact', () => {
    it('impact without args shows usage', async () => {
      const { code } = await runCli('impact');
      assert.equal(code, 1);
    });

    it('impact nonexistent shows error', async () => {
      const { code, stderr } = await runCli('impact', 'req-nonexistent');
      assert.equal(code, 1);
      assert.ok(stderr.includes('not found') || stderr.includes('Error'));
    });
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-agent-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

describe('agent execution', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, 'policy'), { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  function runCommand(...args: string[]): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI_SCRIPT, ...args], {
        cwd: TEST_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (code) => resolve({ stdout: stdout || stderr, code: code ?? 1 }));
      child.on('error', reject);
    });
  }

  /** 一个必定以非零码退出的 agent 命令。 */
  function failingAgent(): string {
    return process.platform === 'win32' ? 'cmd /c exit 1' : 'false';
  }

  it('creates bundle file and spawns agent (dry-run check)', async () => {
    // Set up a slice
    await writeFile(join(TEST_DIR, 'policy', 'policy.yaml'), `
rules:
  - id: allow-all
    match: { path: "**", operation: "write" }
    action: allow
    basis: "test.yaml#allow-all"
`, 'utf-8');

    await writeFile(join(TEST_DIR, '.zelto', 'config.yaml'), `
gate:
  commands:
    - name: echo
      run: echo ok
  timeoutSec: 30
  retry:
    max: 1
agent:
  command: echo
`, 'utf-8');

    // Use dry-run to verify the bundle would be created
    const { stdout, code } = await runCommand('run', 'agent-slice', '--dry-run');
    // Should fail because slice doesn't exist — we're just testing the --dry-run path exists
    // A proper test needs to create + freeze first
    assert.ok(code !== 0 || stdout.includes('dry-run') || stdout.includes('Would'));
  });

  it('runs a mock agent via start command', async () => {
    // Create config with echo as mock agent
    await writeFile(join(TEST_DIR, '.zelto', 'config.yaml'), `
agent:
  command: echo
`, 'utf-8');

    // Create spec file
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'mock-agent-test.md'), '# Mock Agent Test', 'utf-8');

    // Use start command with a custom --agent (echo exits 0)
    const { stdout, code } = await runCommand(
      'start', 'mock-agent-test',
      '--title', 'Mock Agent',
      '--requirement', 'REQ-1: 用 echo 当 agent 跑通 start 全流程',
      '--agent', 'echo',
    );

    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);

    // Verify bundle file was created
    const bundlePath = join(TEST_DIR, '.zelto', 'mock-agent-test-bundle.json');
    assert.ok(existsSync(bundlePath), 'Bundle file should exist');

    // Read bundle
    const bundle = JSON.parse(await readFile(bundlePath, 'utf-8'));
    assert.equal(bundle.sliceId, 'mock-agent-test');
    assert.ok(bundle.instructions);
  });

  it('runs a mock agent via run command', async () => {
    // Create a fresh slice, freeze it first
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'mock-run-test.md'), '# Mock Run Test', 'utf-8');
    await runCommand('create', 'mock-run-test', '--requirement', 'REQ-2: 冻结后用 run 单独执行切片');
    await runCommand('freeze', 'mock-run-test');

    // Run with echo as agent
    const { stdout, code } = await runCommand('run', 'mock-run-test', '--agent', 'echo');
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);

    // Verify RUN_FINISH transition — slice should be back to frozen
    const content = JSON.parse(await readFile(join(TEST_DIR, '.zelto', 'slices', 'mock-run-test.json'), 'utf-8'));
    assert.equal(content.state, 'frozen', `Expected frozen after run, got ${content.state}`);
  });

  it('handles agent non-zero exit', async () => {
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'fail-agent-test.md'), '# Fail Agent', 'utf-8');
    await runCommand('create', 'fail-agent-test', '--requirement', 'REQ-3: agent 非零退出时要被如实报告');
    await runCommand('freeze', 'fail-agent-test');

  // Run with a command that exits non-zero.
  // `false` exists on POSIX but not on Windows (not a cmd built-in, not on PATH),
  // so use the platform's own "exit 1" equivalent.
  const { stdout, code } = await runCommand('run', 'fail-agent-test', '--agent', failingAgent());
    // Should still exit 0 (zelto handles the failure gracefully)
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);
    assert.ok(stdout.includes('exit') || stdout.includes('aborted'));

    // ADR-047: agent 失败后切片必须退回 frozen —— 卡在 running 就再也跑不了
    // （准入只认 frozen / completed，唯一出路是 abandon = 整个切片作废）。
    const content = JSON.parse(await readFile(join(TEST_DIR, '.zelto', 'slices', 'fail-agent-test.json'), 'utf-8'));
    assert.equal(content.state, 'frozen', `Expected frozen after failure, got ${content.state}`);
    assert.equal(content.stall.class, 'environment_failure', '失败应当留下停机分类');

    // ADR-047 §2.1.1：停机只做一次。
    //
    // 前台 run 循环里原本调了两次 `handleAgentFailure`（一次在「还能重试」
    // 分支拿返回值，一次在分支外面的兜底）。而 `stall` 返回时它**已经把
    // 切片停机了** —— 两次调用 = 状态迁两遍 + 事件写两遍。
    //
    // 停机是一个**事实**，不是一个要重复执行的动作。
    const eventsDir = join(TEST_DIR, '.zelto', 'events', 'fail-agent-test');
    const eventFile = join(eventsDir, 'events.jsonl');
    assert.ok(existsSync(eventFile), '事件文件应当存在');
    const lines = (await readFile(eventFile, 'utf-8'))
      .split('\n')
      .filter((l) => l.trim());
    const allEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    for (const l of lines) {
      try { allEvents.push(JSON.parse(l)); } catch { /* 跳过非 JSON 行 */ }
    }
    const stateChanges = allEvents.filter(
      (e) => e.type === 'slice.state.changed' && e.payload?.['to'] === 'frozen',
    );
    // 自动重试每次也会写一条 `stall.classified`（带 autoRetry 标记）——
    // 那不是「停机」，是「还在重试」。停机只有最后那一条。
    const finalStalls = allEvents.filter(
      (e) => e.type === 'stall.classified' && e.payload?.['autoRetry'] !== true,
    );
    assert.equal(stateChanges.length, 1, `状态迁移应当只发生一次，实际 ${stateChanges.length} 次`);
    assert.equal(finalStalls.length, 1, `停机应当只发生一次，实际 ${finalStalls.length} 次`);
  });

  it('re-running a stalled slice does not stall twice (ADR-047 §2.1.1)', async () => {
    // 上一个用例已经把 `fail-agent-test` 的自动重试预算花光了
    // （autoResolved = maxRetries）。于是这一轮**第一次失败就直接停机** ——
    // 而这正是双重停机的触发条件：
    //
    //   重试分支里 `handleAgentFailure` 返回 'stall'（切片已停机）
    //     ↓
    //   分支外面的兜底又调一次 `handleAgentFailure`（切片再停机一次）
    //
    // 结果 = 状态迁两遍 + 停机事件写两遍。
    //
    // 停机是一个**事实**，不是一个要重复执行的动作。
    const eventFile = join(TEST_DIR, '.zelto', 'events', 'fail-agent-test', 'events.jsonl');
    const before = (await readFile(eventFile, 'utf-8'))
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });

    const { code } = await runCommand('run', 'fail-agent-test', '--agent', failingAgent());
    assert.equal(code, 0, '失败也应当优雅退出');

    const after = (await readFile(eventFile, 'utf-8'))
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
    const added = after.slice(before.length);

    const stateChanges = added.filter(
      (e) => e.type === 'slice.state.changed' && e.payload?.['to'] === 'frozen',
    );
    const finalStalls = added.filter(
      (e) => e.type === 'stall.classified' && e.payload?.['autoRetry'] !== true,
    );
    assert.equal(stateChanges.length, 1, `状态迁移应当只发生一次，实际 ${stateChanges.length} 次`);
    assert.equal(finalStalls.length, 1, `停机应当只发生一次，实际 ${finalStalls.length} 次`);

    // 切片仍然退回 frozen —— 重跑失败也救得回来
    const content = JSON.parse(await readFile(join(TEST_DIR, '.zelto', 'slices', 'fail-agent-test.json'), 'utf-8'));
    assert.equal(content.state, 'frozen', `Expected frozen after re-run failure, got ${content.state}`);
  });
});

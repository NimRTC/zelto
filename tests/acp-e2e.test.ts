// ACP 端到端集成测试（ADR-133）
//
// 这个文件用**真的 ACP 子进程**（mock agent）验证 ADR-133 的核心主张：
//
//   1. zelto 能跟一个 ACP agent 建立会话、跑完一轮 prompt；
//   2. **agent 发起 `session/request_permission` 时，zelto 的写集判定真的生效** ——
//      写集内的路径放行、写集外的路径拒绝；
//   3. 每次判定都留一条 `policy.decision` 事件（C4），
//      `harness` 记成 `acp:<command>`（不硬编码成某一家）；
//   4. **永不发 `allow_always`** —— 答复里出现的 optionId 只能是 `allow-once`；
//   5. 版本不匹配 → 拒绝建会话（fail closed，不降级）。
//
// 用 mock agent 而不是真的 `cursor-agent acp` 的理由：
// 端到端测试必须**在 CI 上可复现** —— 真的 agent 要登录、要钱、
// 行为还会随版本变。而这里要验的是**zelto 这一侧**的判定逻辑，
// mock agent 正好把 agent 那一侧的变量固定住。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcpAdapter } from '../src/adapters/acp/index.js';

// 测试跑在 `dist-test/tests/` 下 —— 仓库根要上两级。
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const MOCK_AGENT = join(REPO_ROOT, 'tests', 'fixtures', 'mock-acp-agent.mjs');

let workDir: string;
let projectRoot: string;
let locksDir: string;
let eventsDir: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'zelto-acp-e2e-work-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'zelto-acp-e2e-proj-'));

  // 预约文件：`.zelto/locks/<sliceId>.json`
  locksDir = join(projectRoot, '.zelto', 'locks');
  mkdirSync(locksDir, { recursive: true });
  writeFileSync(
    join(locksDir, 'slice-1.json'),
    JSON.stringify({
      sliceId: 'slice-1',
      writes: ['src/**'],
      worktree: workDir,
      projectRoot,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }),
    'utf-8',
  );

  // 事件目录
  eventsDir = join(projectRoot, '.zelto', 'events', 'slice-1');
  mkdirSync(eventsDir, { recursive: true });
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

/** 起一个 mock ACP agent，写集外的路径。 */
async function runMock(opts: {
  path: string;
  kind?: string;
  protocolVersion?: number;
  skipPermission?: boolean;
  bundlePath?: string;
}): Promise<{ outcome: string; events: Array<Record<string, unknown>> }> {
  const outputFile = join(workDir, `out-${Math.random().toString(36).slice(2)}.txt`);

  // bundle：适配器读它拿提示词
  const bundlePath = opts.bundlePath ?? join(workDir, 'bundle.json');
  writeFileSync(
    bundlePath,
    JSON.stringify({ instructions: '请写一个文件。' }),
    'utf-8',
  );

  const agentCommand = [
    JSON.stringify(process.execPath),
    JSON.stringify(MOCK_AGENT),
    JSON.stringify(outputFile),
    String(opts.protocolVersion ?? 1),
    opts.kind ?? 'edit',
    JSON.stringify(opts.path),
  ].join(' ');

  const adapter = new AcpAdapter({
    cwd: workDir,
    agentCommand,
    projectRoot,
    timeoutMs: 15_000,
    env: {
      ...process.env,
      ...(opts.skipPermission ? { MOCK_ACP_SKIP_PERMISSION: '1' } : {}),
    },
  });

  const { sessionId } = await adapter.start({
    sliceId: 'slice-1',
    prompt: bundlePath,
    runId: 'run-test-1',
  });

  // 等这一轮跑完
  const exitCode = await adapter.waitForExit(sessionId);
  assert.notEqual(exitCode, null, 'mock agent 应该退出');

  const raw = existsSync(outputFile) ? readFileSync(outputFile, 'utf-8') : '';
  const match = raw.match(/permission-outcome: (.*)/);
  const outcome = match ? match[1].trim() : '(no-permission-request)';

  const eventFile = join(eventsDir, 'events.jsonl');
  const events: Array<Record<string, unknown>> = [];
  if (existsSync(eventFile)) {
    for (const line of readFileSync(eventFile, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line) as Record<string, unknown>);
    }
  }

  return { outcome, events };
}

describe('ACP 端到端 —— permission 回调上的写集判定（ADR-133 核心主张）', () => {
  it('写集内的路径 → 放行，且回的是 allow_once', async () => {
    const { outcome, events } = await runMock({
      path: join(workDir, 'src', 'ok.ts'),
    });

    assert.match(outcome, /allow-once/, `应放行并选 allow_once，实际：${outcome}`);
    assert.doesNotMatch(
      outcome,
      /allow-always/,
      '**永不发 allow_always** —— 写集预约是逐写判定的',
    );

    const decisions = events.filter((e) => e.type === 'policy.decision');
    assert.equal(decisions.length, 1, '每次 permission 判定都要有一条事件（C4）');
    const payload = decisions[0].payload as Record<string, unknown>;
    assert.equal(payload.decision, 'allow');
    // harness 记的是**真实来源**（`acp:<command>`），不是硬编码的某一家
    // （ADR-083 §6 的「写假账」同形状）。
    assert.match(
      String(payload.harness),
      /^acp:/,
      'harness 应记成 acp:<command>',
    );
    assert.equal(payload.sliceId, 'slice-1');
    assert.equal(payload.runId, 'run-test-1');
  });

  it('写集外的路径 → 拒绝', async () => {
    const { outcome, events } = await runMock({
      path: join(workDir, 'other', 'bad.ts'),
    });

    assert.match(outcome, /reject-once/, `应拒绝，实际：${outcome}`);

    const decisions = events.filter((e) => e.type === 'policy.decision');
    const payload = decisions[decisions.length - 1].payload as Record<string, unknown>;
    assert.equal(payload.decision, 'deny');
    assert.match(String(payload.reason), /写集/);
  });

  it('保护域 → 拒绝', async () => {
    const { outcome } = await runMock({
      path: join(projectRoot, 'policy', 'policy.yaml'),
    });
    assert.match(outcome, /reject-once/);
  });

  it('逃出 worktree → 拒绝', async () => {
    const { outcome } = await runMock({
      path: '/etc/passwd',
    });
    assert.match(outcome, /reject-once/);
  });

  it('未知工具类别且判不出写入目标 → 拒绝（fail closed）', async () => {
    const { outcome } = await runMock({
      path: '/tmp/whatever',
      kind: 'some_future_kind',
    });
    assert.match(
      outcome,
      /reject-once|cancelled/,
      `未知类别必须拒绝，实际：${outcome}`,
    );
  });

  it('只读工具 → 放行', async () => {
    const { outcome } = await runMock({
      path: join(workDir, 'other', 'readme.md'),
      kind: 'read',
    });
    assert.match(outcome, /allow-once/);
  });

  it('版本不匹配 → 拒绝建会话（fail closed，不降级）', async () => {
    const { outcome } = await runMock({
      path: join(workDir, 'src', 'ok.ts'),
      protocolVersion: 999,
    });
    // 版本不匹配时 agent 报 999，zelto 应当在 initialize 阶段就拒绝，
    // 于是根本不会走到 permission 请求 —— outcome 里不该出现 allow-once。
    assert.doesNotMatch(
      outcome,
      /allow-once/,
      `版本不匹配不得放行任何写入，实际：${outcome}`,
    );
  });

  it('agent 不请求 permission → 不产生判定事件', async () => {
    const before = readFileSync(join(eventsDir, 'events.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim()).length;
    await runMock({
      path: join(workDir, 'src', 'ok.ts'),
      skipPermission: true,
    });
    const after = readFileSync(join(eventsDir, 'events.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim()).length;
    assert.equal(after, before, '没有 permission 请求就不该有判定事件');
  });
});

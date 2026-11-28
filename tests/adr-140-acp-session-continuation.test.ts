// ACP 会话续跑测试（ADR-140）
//
// 这个文件钉住 ADR-140 的核心主张：
//
//   1. **能力位读出来** —— `sessionCapabilities.resume` /
//      `agentCapabilities.loadSession` 从 `initialize` 回包里读；
//   2. **真续** —— agent 声明了能力时，续跑发的是 `session/resume`
//      （优先）或 `session/load`，**不是** `session/new`；
//   3. **续跑不丢 `acpSessionId`** —— 请求里的 sessionId 等于上一轮的；
//   4. **退回路径要说清楚** —— agent 都不支持时退回 `session/new`，
//      且**明确告知人**「上下文丢了」（不静默退回）；
//   5. **读不到能力位 → 当作不支持**（fail closed）。
//
// 用 mock agent 固定住 agent 那一侧的变量 —— 要验的是**zelto 这一侧**
// 发对了请求（端到端测试必须在 CI 上可复现）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcpAdapter } from '../src/adapters/acp/index.js';
import {
  parseAcpSessionContinuation,
  type AcpSessionContinuation,
} from '../src/adapters/acp/protocol.js';
import {
  decideSessionMode,
  describeSessionMode,
} from '../src/adapters/acp/continuation.js';
import { ClaudeAgentAdapter } from '../src/adapters/claude-agent/index.js';
import { CursorAgentAdapter } from '../src/adapters/cursor-agent/index.js';
import { ClaudeAgentSdkAdapter } from '../src/adapters/claude-agent-sdk/index.js';

// 测试跑在 `dist-test/tests/` 下 —— 仓库根要上两级。
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const MOCK_AGENT = join(REPO_ROOT, 'tests', 'fixtures', 'mock-acp-agent.mjs');

let workDir: string;
let projectRoot: string;
let locksDir: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'zelto-acp-140-work-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'zelto-acp-140-proj-'));

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
  mkdirSync(join(projectRoot, '.zelto', 'events', 'slice-1'), { recursive: true });
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

/**
 * 起一个 mock ACP agent，跑一轮，然后**续跑**。
 *
 * 返回 agent 侧**实际收到的方法名序列** —— 这是「发了哪个请求」的唯一证据。
 */
async function runThenResume(opts: {
  capability: 'resume' | 'load' | 'new';
  sliceId?: string;
}): Promise<{ methods: string[]; mode: string | null; output: string }> {
  const sliceId = opts.sliceId ?? 'slice-1';
  const outputFile = join(workDir, `out-${Math.random().toString(36).slice(2)}.txt`);
  const logFile = join(workDir, `log-${Math.random().toString(36).slice(2)}.txt`);
  const bundlePath = join(workDir, `bundle-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(bundlePath, JSON.stringify({ instructions: '请写一个文件。' }), 'utf-8');

  const agentCommand = [
    JSON.stringify(process.execPath),
    JSON.stringify(MOCK_AGENT),
    JSON.stringify(outputFile),
    '1',
    'edit',
    JSON.stringify(join(workDir, 'src', 'ok.ts')),
  ].join(' ');

  const adapter = new AcpAdapter({
    cwd: workDir,
    agentCommand,
    projectRoot,
    timeoutMs: 20_000,
    env: {
      ...process.env,
      MOCK_ACP_CAPABILITIES: opts.capability,
      MOCK_ACP_LOG: logFile,
      MOCK_ACP_SKIP_PERMISSION: '1',
    },
  });

  // 首轮
  const first = await adapter.start({ sliceId, prompt: bundlePath, runId: 'run-140' });
  await adapter.waitForExit(first.sessionId);

  // 续跑
  const second = await adapter.resume(first.sessionId, '答案是：42');
  const mode = adapter.getSessionMode(second.sessionId);
  await adapter.waitForExit(second.sessionId);

  const methods = existsSync(logFile)
    ? readFileSync(logFile, 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
    : [];

  return { methods, mode, output: adapter.getOutput(second.sessionId) };
}

describe('ACP 会话能力位解析（ADR-140 决策三）', () => {
  it('sessionCapabilities.resume 是对象 → 支持 resume', () => {
    const cap = parseAcpSessionContinuation({
      sessionCapabilities: { resume: {} },
    });
    assert.equal(cap, 'resume');
  });

  it('agentCapabilities.loadSession === true → 支持 load', () => {
    const cap = parseAcpSessionContinuation({
      agentCapabilities: { loadSession: true },
    });
    assert.equal(cap, 'load');
  });

  it('两个都声明 → resume 优先（load 会回放历史，污染提问检测）', () => {
    const cap = parseAcpSessionContinuation({
      agentCapabilities: { loadSession: true },
      sessionCapabilities: { resume: {} },
    });
    assert.equal(cap, 'resume');
  });

  it('能力位读不到 → 当作不支持（fail closed）', () => {
    assert.equal(parseAcpSessionContinuation({}), 'new');
    assert.equal(parseAcpSessionContinuation(null), 'new');
    assert.equal(parseAcpSessionContinuation(undefined), 'new');
  });

  it('resume 是 null → 不当作支持', () => {
    const cap = parseAcpSessionContinuation({
      sessionCapabilities: { resume: null },
    });
    assert.equal(cap, 'new');
  });

  it('loadSession 是 truthy 但不是 true → 不当作支持', () => {
    // 协议说它是 boolean —— 非 boolean 的值「读不懂」，
    // 按 fail closed 当作没有，而不是「大概有」。
    const cap = parseAcpSessionContinuation({
      agentCapabilities: { loadSession: 'yes' as unknown as boolean },
    });
    assert.equal(cap, 'new');
  });
});

describe('ACP 会话通道决策（ADR-140 决策一 / 决策七）', () => {
  it('有会话 id + 支持 resume → 走 resume', () => {
    assert.equal(decideSessionMode('resume', 'sess-1'), 'resume');
  });

  it('有会话 id + 只支持 load → 走 load', () => {
    assert.equal(decideSessionMode('load', 'sess-1'), 'load');
  });

  it('有会话 id + 都不支持 → 退回 new', () => {
    assert.equal(decideSessionMode('new', 'sess-1'), 'new');
  });

  it('没有会话 id（首轮）→ new', () => {
    assert.equal(decideSessionMode('resume', null), 'new');
    assert.equal(decideSessionMode('load', null), 'new');
  });

  it('退回路径要说清楚「上下文丢了」', () => {
    const msg = describeSessionMode('new');
    assert.match(msg, /上下文已丢失/);
    assert.match(msg, /session\/resume/);
  });

  it('真续路径不打扰人', () => {
    assert.equal(describeSessionMode('resume'), '');
    assert.equal(describeSessionMode('load'), '');
  });
});

describe('ACP 续跑 —— 真续会话，不许重开（ADR-140 核心主张）', () => {
  it('agent 支持 session/resume → 续跑发 session/resume，且**不发** session/new', async () => {
    const { methods } = await runThenResume({ capability: 'resume' });

    assert.ok(
      methods.includes('session/resume'),
      `续跑应发 session/resume，实际收到：${methods.join(', ')}`,
    );
    assert.ok(
      !methods.includes('session/load'),
      `resume 优先于 load，实际收到：${methods.join(', ')}`,
    );

    // session/new 只该在**首轮**出现一次 —— 续跑不能再开新会话。
    const newCount = methods.filter((m) => m === 'session/new').length;
    assert.equal(newCount, 1, `session/new 只该在首轮出现一次，实际 ${newCount} 次：${methods.join(', ')}`);
  });

  it('agent 只支持 loadSession → 续跑发 session/load', async () => {
    const { methods } = await runThenResume({ capability: 'load' });

    assert.ok(
      methods.includes('session/load'),
      `续跑应发 session/load，实际收到：${methods.join(', ')}`,
    );
    assert.ok(
      !methods.includes('session/resume'),
      `不支持 resume 时不该发 session/resume，实际收到：${methods.join(', ')}`,
    );

    const newCount = methods.filter((m) => m === 'session/new').length;
    assert.equal(newCount, 1, `session/new 只该在首轮出现一次，实际 ${newCount} 次：${methods.join(', ')}`);
  });

  it('agent 都不支持 → 退回 session/new，且**明确告知人**「上下文丢了」', async () => {
    const { methods, mode, output } = await runThenResume({ capability: 'new' });

    const newCount = methods.filter((m) => m === 'session/new').length;
    assert.equal(newCount, 2, `退回路径应发两次 session/new（首轮 + 续跑），实际 ${newCount} 次`);
    assert.equal(mode, 'new');

    // **为什么这条不能省**：静默退回 = 人以为 agent 记得刚才讨论过什么，
    // 实际它什么都不记得 —— 人会基于错误的假设做判断。
    assert.match(output, /上下文已丢失/, '退回路径必须明确告知上下文丢了');
  });

  it('真续时通道是 resume（可追溯）', async () => {
    const { mode } = await runThenResume({ capability: 'resume' });
    assert.equal(mode, 'resume');
  });

  it('真续时通道是 load（可追溯）', async () => {
    const { mode } = await runThenResume({ capability: 'load' });
    assert.equal(mode, 'load');
  });
});

describe('AdapterMeta.sessionContinuation（ADR-140 决策六）', () => {
  it('四个 adapter 都已声明', () => {
    const adapters = [
      new AcpAdapter(),
      new ClaudeAgentAdapter(),
      new CursorAgentAdapter(),
      new ClaudeAgentSdkAdapter(),
    ];
    for (const adapter of adapters) {
      assert.ok(
        adapter.metadata.capabilities.sessionContinuation,
        `${adapter.name} 未声明 sessionContinuation`,
      );
    }
  });

  it('ACP 声明的是能力上限 load-resume（不是运行时结论）', () => {
    // **为什么不是反过来**：如果声明 'new-session'，即使实际 agent
    // 支持 load，zelto 也永远不会去试 —— 能力被静态声明卡死。
    assert.equal(
      new AcpAdapter().metadata.capabilities.sessionContinuation,
      'load-resume',
    );
  });

  it('hook 路线的三个 adapter 也是真续', () => {
    for (const adapter of [
      new ClaudeAgentAdapter(),
      new CursorAgentAdapter(),
      new ClaudeAgentSdkAdapter(),
    ]) {
      assert.equal(
        adapter.metadata.capabilities.sessionContinuation,
        'load-resume',
        `${adapter.name} 应该是真续`,
      );
    }
  });
});

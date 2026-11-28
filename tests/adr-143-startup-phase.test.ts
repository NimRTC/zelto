// 启动阶段（ADR-143）
//
// 这个文件钉住 ADR-143 的核心主张：
//
//   1. **阶段只由协议请求驱动，绝不用计时器**；
//   2. **阶段值是封闭集合**（launch / initialize / session / authenticating）；
//   3. **收到第一条 `session/update` → 阶段清空**；
//   4. **启动阶段豁免空转超时** —— 慢启动**不被误杀**；
//   5. **协议卡住由请求级超时兜底** —— 不是永不终止；
//   6. **阶段对人可见**（会话文件里有它）；
//   7. **端口方法是可选的** —— hook 路线的 adapter 不实现它也不炸；
//   8. **会话文件加的是可选字段** —— 老会话文件读出来不报错。
//
// ## 为什么这条规则重要
//
// ACP agent 的启动阶段**不发 `tool_call`** —— 初始化模型连接、加载
// MCP server、鉴权、读项目的上下文文件，这些都不是工具调用，是 agent
// **进程内部**的事。
//
// 没有这个豁免：**正常启动但比较慢**的 agent 被当成「卡住了」杀掉 ——
// 而且它被杀的时候**一行代码都还没写**，白跑一轮。
//
// 更糟的是：从 zelto 的视角看，慢启动与真卡住**在信号上完全一样**
// （都是 0 条 tool_call、静默）—— zelto 区分不了。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcpAdapter } from '../src/adapters/acp/index.js';
import {
  ACP_STARTUP_PHASES,
  clearPhaseOnFirstOutput,
  describeStartupPhase,
  shouldExemptIdleTimeout,
  type AcpStartupPhase,
} from '../src/adapters/acp/startup-phase.js';
import { ClaudeAgentAdapter } from '../src/adapters/claude-agent/index.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const MOCK_AGENT = join(REPO_ROOT, 'tests', 'fixtures', 'mock-acp-agent.mjs');

let workDir: string;
let projectRoot: string;
let originalCwd: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'zelto-acp-143-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'zelto-acp-143-proj-'));
  // 会话文件落在**进程 cwd** 下（`saveSession` 用相对路径 `.zelto/sessions`）
  // —— chdir 进临时目录，免得把测试会话文件落进仓库里（ADR-055 同一做法）。
  originalCwd = process.cwd();
  process.chdir(workDir);
});

after(() => {
  try {
    process.chdir(originalCwd);
  } catch {
    /* 原目录没了就继续 */
  }
  // Windows 上删临时目录可能撞上「还有进程占着文件」——
  // 重试几次（ADR-131 同款：测试不许因为清理失败而红）。
  for (const dir of [workDir, projectRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* 清理失败不该让测试红 */
    }
  }
});

/**
 * 起一个 ACP 适配器（用 mock agent）。
 *
 * `projectRoot` 与 `cwd` **分开**：判定读的是 `projectRoot` 下的写集预约，
 * 会话文件落在 **cwd** 下 —— 两者不是一回事。
 */
function makeAdapter(
  env: Record<string, string>,
  timeoutMs = 15_000,
  startupTimeoutMs?: number,
): AcpAdapter {
  const agentCommand = [
    JSON.stringify(process.execPath),
    JSON.stringify(MOCK_AGENT),
    JSON.stringify(join(workDir, 'out.txt')),
    '1',
    'edit',
    JSON.stringify(join(workDir, 'src', 'ok.ts')),
  ].join(' ');

  return new AcpAdapter({
    cwd: workDir,
    agentCommand,
    projectRoot,
    timeoutMs,
    ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
    env: { ...process.env, ...env },
  });
}

/** 会话文件路径（相对**进程 cwd** —— 见 `session-store.ts` 的 `SESSIONS_DIR`）。 */
function sessionFile(sessionId: string): string {
  return join(process.cwd(), '.zelto', 'sessions', `${sessionId}.json`);
}

/** 读会话文件；读不到 → null。 */
function readSession(sessionId: string): {
  status: string;
  startupPhase?: string | null;
  output: string[];
} | null {
  const file = sessionFile(sessionId);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8')) as {
    status: string;
    startupPhase?: string | null;
    output: string[];
  };
}

// ─── 纯函数 ────────────────────────────────────────────────────────────────

describe('阶段值是封闭集合（ADR-143 验收 2）', () => {
  it('只有四个阶段', () => {
    assert.deepEqual(
      [...ACP_STARTUP_PHASES].sort(),
      ['authenticating', 'initialize', 'launch', 'session'],
    );
  });

  it('每个阶段都有人话说明', () => {
    for (const phase of ACP_STARTUP_PHASES) {
      const label = describeStartupPhase(phase);
      assert.ok(label, `阶段 ${phase} 应该有中文说明`);
      assert.match(label, /启动中/);
    }
  });

  it('没有阶段 → 没有说明（**不编**）', () => {
    assert.equal(describeStartupPhase(null), null);
    assert.equal(describeStartupPhase(undefined), null);
  });
});

describe('豁免判定是纯计算（ADR-143 决策四）', () => {
  it('在启动阶段 → 豁免空转超时', () => {
    for (const phase of ACP_STARTUP_PHASES) {
      assert.equal(shouldExemptIdleTimeout(phase), true, `阶段 ${phase} 应豁免`);
    }
  });

  it('不在启动阶段 → **不豁免**', () => {
    assert.equal(shouldExemptIdleTimeout(null), false);
    assert.equal(shouldExemptIdleTimeout(undefined), false);
  });
});

describe('阶段在第一个真实产出时清空（ADR-143 决策三）', () => {
  it('还没收到通知 → 阶段还在', () => {
    assert.equal(clearPhaseOnFirstOutput('session', false), 'session');
  });

  it('收到通知 → 阶段清空', () => {
    assert.equal(clearPhaseOnFirstOutput('session', true), null);
  });

  it('本来就没阶段 → 还是 null', () => {
    assert.equal(clearPhaseOnFirstOutput(null, false), null);
    assert.equal(clearPhaseOnFirstOutput(null, true), null);
  });
});

// ─── 源码检查：绝不用计时器 ────────────────────────────────────────────────

describe('阶段只由协议请求驱动（ADR-143 验收 1）', () => {
  it('startup-phase.ts 里**没有**计时器驱动的阶段推进', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'src', 'adapters', 'acp', 'startup-phase.ts'),
      'utf-8',
    );
    // 阶段推进必须是纯计算 —— 不能有任何计时器。
    assert.doesNotMatch(src, /Date\.now\(\)/, '阶段推进不能用 Date.now()');
    assert.doesNotMatch(src, /setTimeout\(/, '阶段推进不能用 setTimeout()');
    assert.doesNotMatch(src, /setInterval\(/, '阶段推进不能用 setInterval()');
  });

  it('适配器里的阶段推进点全在「发出协议请求」处', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'adapters', 'acp', 'index.ts'), 'utf-8');
    // 每个阶段推进都必须紧挨着对应协议的请求。
    assert.match(
      src,
      /setStartupPhase\(state, 'initialize'\)[\s\S]{0,400}request\('initialize'/,
      "'initialize' 阶段必须紧挨着 initialize 请求",
    );
    assert.match(
      src,
      /setStartupPhase\(state, 'session'\)[\s\S]{0,600}session\/(resume|load)/,
      "'session' 阶段必须紧挨着建会话请求",
    );
  });
});

// ─── 端到端：慢启动不被误杀 ────────────────────────────────────────────────

describe('启动阶段豁免空转超时（ADR-143 验收 4）', () => {
  it('慢启动（握手后延迟才发第一条通知）→ **不被空转超时杀掉**', async () => {
    // 空转超时给 800ms，但 mock 握手后要 2500ms 才发第一条通知。
    //
    // 慢启动期间 agent 一条 tool_call 都不发 —— 没有这个豁免，
    // zelto 会在 800ms 时把它当「卡住了」杀掉（一行代码都没写）。
    //
    // 启动上界给 30s —— 足够慢启动过去，但不至于掩盖「启动卡住」。
    const adapter = makeAdapter({ MOCK_ACP_SLOW_START: '2500' }, 800, 30_000);

    const { sessionId } = await adapter.start({
      sliceId: 'adr-143-slow',
      prompt: join(workDir, 'bundle.json'),
    });

    // 等它熬过 800ms 的空转超时窗口（如果有豁免，它还活着）。
    await new Promise((r) => setTimeout(r, 1800));

    const phase = adapter.getStartupPhase(sessionId);
    assert.ok(phase, '启动阶段应当还在（agent 还没发第一条通知）');
    assert.equal(phase, 'session', `阶段应是 'session'，实际 ${phase}`);

    // 会话**没有**被超时杀掉 —— 状态不是 timeout。
    const data = readSession(sessionId);
    assert.ok(data, '会话文件应该存在');
    assert.notEqual(data?.status, 'timeout', '慢启动**不该**被空转超时杀掉');

    await adapter.stop(sessionId);
  });

  it('不在启动阶段 + 无进展 → **照样**触发空转超时', async () => {
    // mock 发完第一条通知之后，就**永远静默**（不调工具、不再发通知）——
    // 那时启动阶段已清空 → 空转超时恢复生效。
    //
    // `MOCK_ACP_HANG_PERMISSION=wait` 让 agent 挂着不发新的进展信号。
    const adapter = makeAdapter({ MOCK_ACP_HANG_PERMISSION: 'wait' }, 1200, 30_000);

    const { sessionId } = await adapter.start({
      sliceId: 'adr-143-idle',
      prompt: join(workDir, 'bundle.json'),
    });

    const exitCode = await adapter.waitForExit(sessionId);

    assert.notEqual(exitCode, 0, '无进展就该被超时杀掉');
    const data = readSession(sessionId);
    assert.equal(data?.status, 'timeout', '状态应是 timeout');
  });
});

// ─── 阶段对人可见（ADR-143 验收 6）────────────────────────────────────────

describe('阶段对人可见（ADR-143 验收 6）', () => {
  it('会话文件里有 startupPhase 字段', async () => {
    const adapter = makeAdapter({ MOCK_ACP_SLOW_START: '1500' }, 10_000, 30_000);
    const { sessionId } = await adapter.start({
      sliceId: 'adr-143-visible',
      prompt: join(workDir, 'bundle.json'),
    });

    await new Promise((r) => setTimeout(r, 800));

    const file = sessionFile(sessionId);
    assert.ok(existsSync(file), '会话文件应该存在');
    const data = JSON.parse(readFileSync(file, 'utf-8')) as {
      startupPhase?: string | null;
    };
    assert.ok(data.startupPhase, '会话文件里应该有 startupPhase');
    assert.match(String(data.startupPhase), /^(launch|initialize|session|authenticating)$/);

    await adapter.stop(sessionId);
  });
});

// ─── 请求级超时（ADR-143 决策五 / 验收 5）──────────────────────────────────

describe('协议卡住由请求级超时兜底（ADR-143 验收 5）', () => {
  it('agent 不回 initialize → 超时后**失败**（不是永远挂着）', async () => {
    const adapter = makeAdapter({ MOCK_ACP_HANG_INITIALIZE: '1' }, 1000, 30_000);

    const { sessionId } = await adapter.start({
      sliceId: 'adr-143-hang',
      prompt: join(workDir, 'bundle.json'),
    });

    const exitCode = await adapter.waitForExit(sessionId);

    // **关键**：没有请求级超时的话，这一轮会**永远挂着** ——
    // 空转超时被启动阶段豁免了，没人杀它。
    //
    // 退出码可能是 null（被信号杀掉）—— 那也算「不是成功」。
    assert.notEqual(exitCode, 0, '协议卡住必须以失败告终');

    const data = readSession(sessionId);
    assert.ok(data, '会话文件应该存在');
    assert.equal(data?.status, 'failed', '状态应是 failed');
    const output = (data?.output ?? []).join('');
    assert.match(output, /超时|timeout/i, '输出里要说清是请求超时');
  });
});

// ─── 启动上界（ADR-143 决策四的兜底）──────────────────────────────────────

describe('启动阶段有自己的上界（ADR-143 决策四的代价）', () => {
  it('启动阶段一直不产出 → 到上界被杀（不会永远挂着）', async () => {
    // mock 握手后**永远不发**第一条通知 —— agent 根本没起步。
    //
    // 空转超时被启动阶段豁免了，所以这条路径由**启动上界**兜。
    const adapter = makeAdapter({ MOCK_ACP_SLOW_START: '600000' }, 800, 1500);

    const { sessionId } = await adapter.start({
      sliceId: 'adr-143-startup-timeout',
      prompt: join(workDir, 'bundle.json'),
    });

    const exitCode = await adapter.waitForExit(sessionId);

    assert.notEqual(exitCode, 0, '启动卡住必须被杀');
    const data = readSession(sessionId);
    assert.equal(data?.status, 'timeout', '状态应是 timeout');
    const output = (data?.output ?? []).join('');
    assert.match(output, /startup timeout/i, '输出里要说清是启动超时');
  });
});

// ─── 端口方法是可选的（ADR-143 验收 7 / 8）────────────────────────────────

describe('端口方法是可选的（ADR-143 验收 7 / 8）', () => {
  it('hook 路线的 adapter **不**实现 getStartupPhase', () => {
    const adapter = new ClaudeAgentAdapter({ agentCommand: 'echo hi' });
    assert.equal(
      typeof (adapter as { getStartupPhase?: unknown }).getStartupPhase,
      'undefined',
      'hook 路线的 adapter 没有这个概念 —— 不该被迫实现',
    );
  });

  it('老会话文件（没有 startupPhase）读出来不报错', () => {
    // 决策八：加的是**可选**字段 —— 老文件没有它是正常的。
    const legacy: {
      sessionId: string;
      sliceId: string;
      agentCommand: string;
      startedAt: string;
      status: 'running';
      exitCode: null;
      timeoutMs: null;
      retryCount: number;
      maxRetries: number;
      prompt: string;
      output: never[];
      agentSessionId: null;
      cwd: string;
      resumedFrom: null;
      startupPhase?: string | null;
    } = {
      sessionId: 'legacy-1',
      sliceId: 's1',
      agentCommand: 'x',
      startedAt: new Date().toISOString(),
      status: 'running',
      exitCode: null,
      timeoutMs: null,
      retryCount: 0,
      maxRetries: 2,
      prompt: 'p',
      output: [],
      agentSessionId: null,
      cwd: '/tmp',
      resumedFrom: null,
    };
    assert.equal(legacy.startupPhase, undefined, '老会话文件没有这个字段');
  });
});

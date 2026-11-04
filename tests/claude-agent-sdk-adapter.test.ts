// Tests for ClaudeAgentSdkAdapter
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/**
 * 读 Claude Code 自己的设置文件，取出 `env` 块。
 *
 * 凭据不一定在进程环境变量里 —— Claude Code 允许把 `ANTHROPIC_AUTH_TOKEN`、
 * `ANTHROPIC_BASE_URL` 写在 `~/.claude/settings.json` 的 `env` 块中，
 * CLI 启动时会自己注入。SDK 拉起的正是这个 CLI，所以凭据在那儿也算数。
 *
 * 只读 `env` 块里跟认证/端点有关的键，不把整个文件读进内存。
 */
function readSettingsEnv(): Record<string, string> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (!home) return {};
  const settings = join(home, '.claude', 'settings.json');
  if (!existsSync(settings)) return {};
  try {
    const parsed = JSON.parse(readFileSync(settings, 'utf-8')) as { env?: unknown };
    if (!parsed || typeof parsed !== 'object' || typeof parsed.env !== 'object' || !parsed.env) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.env as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Check whether the SDK has usable credentials.
 *
 * The SDK is installed as a dependency, so `hasSdk()` is always true in this
 * repo. But `startup()` spawns a real Claude Code process, which — without
 * credentials — keeps retrying and holds the event loop open, hanging the
 * whole test run. Live-session tests therefore require credentials too.
 *
 * 凭据可能在三个地方，逐个查：
 *   1. 进程环境变量（CI 通常注入在这里）
 *   2. `~/.claude/settings.json` 的 `env` 块（本机 Claude Code 的默认做法）
 *   3. `~/.claude/.credentials.json`（Claude Code 自己的凭据存储）
 */
function hasCredentials(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (process.env.ANTHROPIC_AUTH_TOKEN) return true;
  if (process.env.ANTHROPIC_BASE_URL) return true;

  const settingsEnv = readSettingsEnv();
  if (settingsEnv.ANTHROPIC_API_KEY) return true;
  if (settingsEnv.ANTHROPIC_AUTH_TOKEN) return true;
  if (settingsEnv.ANTHROPIC_BASE_URL) return true;

  // Claude Code's own credential store
  const creds = join(
    process.env.USERPROFILE ?? process.env.HOME ?? '',
    '.claude',
    '.credentials.json',
  );
  return existsSync(creds);
}

/** Live-session tests only run when the SDK is importable AND credentials exist. */
const canStartSession = hasSdk() && hasCredentials();

/**
 * 活会话测试跑在临时目录里。
 *
 * 这两个测试会以 `bypassPermissions` 启动真实 agent —— 它真的能读写文件。
 * 在仓库根目录跑，它就可能改到仓库的文件。测试不该有副作用。
 */
const liveCwd = mkdtempSync(join(tmpdir(), 'zelto-sdk-live-'));

after(() => {
  // Windows 上删除目录可能因为 SDK 子进程还持有 cwd 的句柄而 EPERM。
  // 清理失败不该让整轮测试挂掉 —— 临时目录留在系统 temp 里不影响任何东西。
  try {
    rmSync(liveCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // 忽略：临时目录残留无害
  }
});

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

  it('resume() does not throw for unknown session (graceful)', { skip: !canStartSession }, async () => {
    const adapter = new ClaudeAgentSdkAdapter({ cwd: liveCwd });
    const { sessionId } = await adapter.resume('nonexistent', 'patch content');
    // resume 会真的起一个会话；不收掉它，测试进程会一直挂着等它结束
    await adapter.stop(sessionId);
  });

  it('start() returns a session with id', { skip: !canStartSession }, async () => {
    const adapter = new ClaudeAgentSdkAdapter({ cwd: liveCwd });
    const result = await adapter.start({ sliceId: 'test', prompt: 'test prompt' });
    assert.ok(result.sessionId);
    await adapter.stop(result.sessionId);
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

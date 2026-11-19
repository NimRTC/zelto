// ADR-087：运行时守卫必须按 harness 装对应的钩子
//
// 为什么这个值得单独一个文件：
//
//   C9 说「写集预约运行时强制 —— 以 PreToolUse 钩子逐写判定为主」。
//   而**「哪种 agent」决定「哪种钩子协议」**：
//
//     Claude Code → .claude/settings.local.json + hookSpecificOutput 信封
//     Cursor      → .cursor/hooks.json        + permission 信封（snake_case）
//     Codex       → .codex/hooks.json         + hookSpecificOutput 信封
//
//   装错 harness 的后果是**静默失效**：
//   hook 收到自己看不懂的载荷 → 解析失败 → 判不出写入目标 →
//   在 Cursor 的 fail-open 默认下**放行一切**（闸门形同虚设）。
//
//   而且配置文件看上去一切正常 —— 这就是「看不见的失效」。
//
// 所以这里钉住：
//   1. harness='cursor' → 装 `.cursor/hooks.json`，**不装** `.claude/`；
//   2. Cursor 那条命令里带 `--harness cursor`（判定内核才知道按哪套解）；
//   3. 钩子文件被纳入**托管文件清单**（agent 改它 = 关掉门禁 = 越界）；
//   4. 释放时撤掉对应的那一条。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installRuntimeGuard,
  MANAGED_CURSOR_HOOKS_PATH,
} from '../src/cli/commands/runtime-guard.js';

const ROOT = mkdtempSync(join(tmpdir(), 'zelto-guard-harness-'));

describe('运行时守卫按 harness 装对应的钩子', () => {
  before(() => {
    mkdirSync(join(ROOT, '.zelto'), { recursive: true });
    // 策略文件不在 → hook 判定会 fail closed，但**装钩子**这一步不受影响。
    mkdirSync(join(ROOT, 'policy'), { recursive: true });
    writeFileSync(join(ROOT, 'policy', 'policy.yaml'), 'rules: []\n', 'utf-8');
  });

  after(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('harness=cursor：装 .cursor/hooks.json，命令带 --harness cursor', async () => {
    const guard = await installRuntimeGuard({
      sliceId: 'guard-cursor-1',
      writes: ['src/**'],
      worktree: null,
      projectRoot: ROOT,
      harness: 'cursor',
    });

    const cursorHooksPath = join(ROOT, MANAGED_CURSOR_HOOKS_PATH);
    assert.ok(existsSync(cursorHooksPath), '必须装 .cursor/hooks.json');

    // 绝不能同时装 Claude Code 那份 —— 装了就说明 harness 判错了
    assert.ok(
      !existsSync(join(ROOT, '.claude', 'settings.local.json')),
      'harness=cursor 时不该装 .claude/settings.local.json',
    );

    const raw = JSON.parse(readFileSync(cursorHooksPath, 'utf-8')) as {
      hooks?: { preToolUse?: Array<{ command?: string; matcher?: string; failClosed?: boolean }> };
    };
    const entry = (raw.hooks?.preToolUse ?? []).find((e) =>
      e.command?.includes('--zelto-pretool'),
    );
    assert.ok(entry, '配置里必须有 zelto 那一条');
    assert.match(entry.command ?? '', /--harness\s+cursor/, '命令里必须带 --harness cursor');
    assert.equal(entry.failClosed, true, 'Cursor 必须显式 failClosed');
    assert.equal(entry.matcher, 'Write|Delete|Shell', 'matcher 必须是 Cursor 的真实工具名');

    // 钩子文件被纳入托管清单 —— agent 改它等于关掉门禁
    assert.ok(
      guard.managedPaths.includes(MANAGED_CURSOR_HOOKS_PATH),
      `钩子文件必须在托管清单里（实际：${guard.managedPaths.join(', ')}）`,
    );

    await guard.release();
  });

  it('harness=cursor：释放后撤掉 zelto 那一条', async () => {
    const guard = await installRuntimeGuard({
      sliceId: 'guard-cursor-2',
      writes: ['src/**'],
      worktree: null,
      projectRoot: ROOT,
      harness: 'cursor',
    });

    const cursorHooksPath = join(ROOT, MANAGED_CURSOR_HOOKS_PATH);
    assert.ok(existsSync(cursorHooksPath));

    await guard.release();

    // 释放后要么文件整个没了（zelto 留下的空壳被删掉），
    // 要么 zelto 那一条被撤了 —— **两种都算干净**。
    if (existsSync(cursorHooksPath)) {
      const raw = JSON.parse(readFileSync(cursorHooksPath, 'utf-8')) as {
        hooks?: { preToolUse?: Array<{ command?: string }> };
      };
      const remaining = (raw.hooks?.preToolUse ?? []).filter((e) =>
        e.command?.includes('--zelto-pretool'),
      );
      assert.equal(remaining.length, 0, '释放后不应残留 zelto 的钩子条目');
    }
  });

  it('harness 默认（claude-code）：装 .claude/settings.local.json，不装 .cursor', async () => {
    const guard = await installRuntimeGuard({
      sliceId: 'guard-claude-1',
      writes: ['src/**'],
      worktree: null,
      projectRoot: ROOT,
    });

    assert.ok(
      existsSync(join(ROOT, '.claude', 'settings.local.json')),
      '默认必须装 .claude/settings.local.json',
    );
    assert.ok(
      !existsSync(join(ROOT, MANAGED_CURSOR_HOOKS_PATH)),
      '默认不该装 .cursor/hooks.json',
    );
    assert.ok(guard.managedPaths.includes('.claude/settings.local.json'));

    await guard.release();
  });
});

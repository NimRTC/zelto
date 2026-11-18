// 多 harness 适配层（ADR-083）
//
// 这个文件钉住三件事：
//
//   1. **归一化**：各 harness 的输入 → 统一载荷
//      —— 工具名不同、字段名不同，但**写目标**的语义必须一致；
//   2. **渲染**：统一判决 → 各 harness 的信封
//      —— 判决内容（allow/deny 与原因）必须**一致**，只有信封形状不同；
//   3. **不认识也要判**：新工具名 → 退回找路径字段，
//      而不是「不判定」（那等于给每个新 harness 开一个绕过闸门的后门）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePayload,
  renderDecision,
  harnessFromFlag,
  flagOfHarness,
  HARNESS_NAMES,
  type HarnessName,
} from '../../src/hook/harness.js';

describe('harness 归一化 —— 各 harness 的输入必须抽出同一个写目标', () => {
  it('Claude Code 的 Write → file_path', () => {
    const p = normalizePayload('claude-code', {
      tool_name: 'Write',
      tool_input: { file_path: '/repo/src/a.ts' },
    });
    assert.equal(p.tool_name, 'Write');
    assert.equal(p.tool_input.file_path, '/repo/src/a.ts');
  });

  it('Cursor 的 edit_file → 同一个 file_path', () => {
    const p = normalizePayload('cursor', {
      hook_event_name: 'preToolUse',
      tool_name: 'edit_file',
      tool_input: { path: '/repo/src/a.ts' },
    });
    assert.equal(p.tool_name, 'Write');
    assert.equal(p.tool_input.file_path, '/repo/src/a.ts');
  });

  it('Codex 的 apply_patch → 同一个 file_path', () => {
    const p = normalizePayload('codex', {
      event: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { path: '/repo/src/a.ts' },
    });
    assert.equal(p.tool_name, 'Write');
    assert.equal(p.tool_input.file_path, '/repo/src/a.ts');
  });

  it('三种 harness 的写工具都归一化成同一组', () => {
    const names = new Set(
      HARNESS_NAMES.map((h) => {
        const toolName = h === 'cursor' ? 'edit_file' : h === 'codex' ? 'apply_patch' : 'Edit';
        return normalizePayload(h, { tool_name: toolName, tool_input: { path: '/x' } }).tool_name;
      }),
    );
    assert.equal(
      names.size,
      1,
      `三种 harness 的写工具名应归一到同一个，实际有 ${[...names].join(',')}`,
    );
  });

  it('Cursor 的 terminal → command（Bash 语义）', () => {
    const p = normalizePayload('cursor', {
      tool_name: 'terminal',
      tool_input: { command: 'echo hi > out.txt' },
    });
    assert.equal(p.tool_name, 'Bash');
    assert.equal(p.tool_input.command, 'echo hi > out.txt');
  });

  it('Codex 的 shell → command', () => {
    const p = normalizePayload('codex', {
      tool_name: 'shell',
      tool_input: { command: 'rm -rf build' },
    });
    assert.equal(p.tool_name, 'Bash');
    assert.equal(p.tool_input.command, 'rm -rf build');
  });

  it('保留原始工具名（写进事件流，供事后查「agent 当时调了什么」）', () => {
    const p = normalizePayload('cursor', {
      tool_name: 'edit_file',
      tool_input: { path: '/repo/src/a.ts' },
    });
    assert.equal(p.raw_tool_name, 'edit_file');
  });

  it('不认识的新工具名也必须判定（退回找路径字段，不是「不判定」）', () => {
    // 这是 ADR-083 §2 的核心设计点。
    //
    // 为什么：harness 改个工具名，闸门就静默失效 ——
    // 那等于给每个新 harness 开一个绕过闸门的后门。
    // 保守的做法（多拦）优于漏拦（越界写入落盘）。
    const p = normalizePayload('cursor', {
      tool_name: 'brand_new_editor_tool',
      tool_input: { file_path: '/repo/src/secret.ts' },
    });
    assert.equal(
      p.tool_input.file_path,
      '/repo/src/secret.ts',
      '新工具名也必须抽出写目标 —— 否则闸门静默失效',
    );
  });

  it('不认识的新工具名且有 path 字段时也能抽出', () => {
    const p = normalizePayload('codex', {
      tool_name: 'mystery_tool',
      tool_input: { path: '/repo/src/x.ts' },
    });
    assert.equal(p.tool_input.file_path, '/repo/src/x.ts');
  });

  it('输入不是对象时不炸（交给上层判「坏输入 → 拒绝」）', () => {
    const p = normalizePayload('cursor', null);
    assert.equal(p.tool_name, '');
    assert.deepEqual(p.tool_input, {});
  });

  it('Cursor 的 command 是数组时也能取出', () => {
    const p = normalizePayload('cursor', {
      tool_name: 'terminal',
      tool_input: { command: ['echo', 'hi'] },
    });
    assert.equal(p.tool_input.command, 'echo hi');
  });
});

describe('harness 输出渲染 —— 判决内容必须一致，信封形状可以不同', () => {
  const decision = { decision: 'deny' as const, reason: '写入目标不在切片写集内' };

  it('Claude Code 的信封', () => {
    const out = renderDecision('claude-code', decision) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, decision.reason);
  });

  it('Cursor 的信封（permission 字段，不是 hookSpecificOutput）', () => {
    const out = renderDecision('cursor', decision) as {
      permission: string;
      userMessage: string;
      agentMessage: string;
    };
    assert.equal(out.permission, 'deny');
    // 原因要同时给人看和给模型看 —— 人要知道为什么，模型要知道怎么改
    assert.equal(out.userMessage, decision.reason);
    assert.equal(out.agentMessage, decision.reason);
  });

  it('Codex 的信封与 Claude Code 同构', () => {
    const out = renderDecision('codex', decision) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, decision.reason);
  });

  it('三种 harness 的判决内容一致（allow/deny 与原因都相同）', () => {
    for (const verdict of ['allow', 'deny'] as const) {
      const d = { decision: verdict, reason: '同一个原因' };
      const claude = renderDecision('claude-code', d) as Record<string, unknown>;
      const cursor = renderDecision('cursor', d) as Record<string, unknown>;
      const codex = renderDecision('codex', d) as Record<string, unknown>;

      const claudeDecision = (
        claude['hookSpecificOutput'] as { permissionDecision: string }
      ).permissionDecision;
      const codexDecision = (
        codex['hookSpecificOutput'] as { permissionDecision: string }
      ).permissionDecision;
      const cursorDecision = cursor['permission'] as string;

      assert.equal(claudeDecision, verdict);
      assert.equal(cursorDecision, verdict);
      assert.equal(codexDecision, verdict);
    }
  });
});

describe('harness 旗标映射', () => {
  it('旗标与 harness 名一一对应', () => {
    assert.equal(harnessFromFlag('claude'), 'claude-code');
    assert.equal(harnessFromFlag('cursor'), 'cursor');
    assert.equal(harnessFromFlag('codex'), 'codex');
    assert.equal(harnessFromFlag('nope'), null);
  });

  it('每个 harness 都有旗标', () => {
    for (const h of HARNESS_NAMES) {
      assert.ok(flagOfHarness(h as HarnessName).length > 0);
    }
  });
});

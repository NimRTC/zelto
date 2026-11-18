// 端到端：三种 harness 的 hook 判定结论必须**一致**（ADR-083）
//
// 这个文件跑的是**真实的 hook 进程**（`dist/hook/index.js`），
// 不是单元测试里的函数调用 —— 因为要验的是「协议适配 + 判定内核」
// 在真实进程边界上接得对不对。
//
// 病灶背景（ADR-083）：
//   判定内核（judgeWriteTargets）与 harness 无关，
//   各 harness 的输入先归一化、判决再渲染回各自的信封。
//   如果这条链路接错了，会出现一个很坏的现象：
//   **同一个越界写入，在 Claude Code 下被拦，在 Cursor 下被放行。**
//
//   那等于「越界」变成了「取决于用什么 agent」的函数 ——
//   C9 这条不变量就名存实亡了。
//
// 所以这里断言的是**判决内容的一致性**，不是「某个信封长什么样」。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = (() => {
  let dir = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) throw new Error('找不到仓库根');
    dir = up;
  }
})();

const HOOK_ENTRY = join(REPO_ROOT, 'dist', 'hook', 'index.js');

const ROOT = mkdtempSync(join(tmpdir(), 'zelto-harness-e2e-'));

function callHook(harness: string, payload: unknown): Record<string, unknown> {
  const res = spawnSync(
    'node',
    [
      HOOK_ENTRY,
      'pretool',
      '--harness',
      harness,
      '--project-root',
      ROOT,
      '--worktree',
      ROOT,
      '--slice',
      's1',
    ],
    { input: JSON.stringify(payload), encoding: 'utf-8' },
  );
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    assert.fail(`hook 输出不是 JSON：${res.stdout} / ${res.stderr}`);
  }
  return out;
}

/** 从任意 harness 的信封里取出判决。 */
function decisionOf(out: Record<string, unknown>): string {
  const permission = out['permission'];
  if (typeof permission === 'string') return permission;
  const hso = out['hookSpecificOutput'] as { permissionDecision?: string } | undefined;
  return hso?.permissionDecision ?? '(none)';
}

describe('端到端：三种 harness 的判定结论必须一致', () => {
  before(() => {
    mkdirSync(join(ROOT, '.zelto', 'locks'), { recursive: true });
    mkdirSync(join(ROOT, 'policy'), { recursive: true });
    // policy 是**第二层**（写集是第一层）。不给 allow 的话会走「默认 deny」
    // 兜底，写集内的文件也会被拒 —— 那是正确行为，但那样测不出「写集内放行」。
    writeFileSync(
      join(ROOT, 'policy', 'policy.yaml'),
      ['rules:', '  - id: allow-src', '    match: {path: "src/**"}', '    action: allow', ''].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(ROOT, '.zelto', 'locks', 's1.json'),
      JSON.stringify({ writes: ['src/**'], releasedAt: null }),
      'utf-8',
    );
  });

  after(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('Cursor 的 edit_file：写集内放行、写集外拦下', () => {
    const inside = callHook('cursor', {
      hook_event_name: 'preToolUse',
      tool_name: 'edit_file',
      tool_input: { path: join(ROOT, 'src', 'a.ts') },
    });
    assert.equal(decisionOf(inside), 'allow', '写集内必须放行');

    const outside = callHook('cursor', {
      hook_event_name: 'preToolUse',
      tool_name: 'edit_file',
      tool_input: { path: join(ROOT, 'other', 'b.ts') },
    });
    assert.equal(decisionOf(outside), 'deny', '写集外必须拦下');
  });

  it('Cursor 的 terminal 重定向也走同一套判定', () => {
    const out = callHook('cursor', {
      tool_name: 'terminal',
      tool_input: { command: `echo x > ${join(ROOT, 'other', 'c.ts')}` },
    });
    assert.equal(decisionOf(out), 'deny', 'shell 重定向写集外必须拦下');
  });

  it('Codex 的 apply_patch：写集内放行、写集外拦下', () => {
    const inside = callHook('codex', {
      event: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { path: join(ROOT, 'src', 'd.ts') },
    });
    assert.equal(decisionOf(inside), 'allow');

    const outside = callHook('codex', {
      event: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { path: join(ROOT, 'other', 'e.ts') },
    });
    assert.equal(decisionOf(outside), 'deny');
  });

  it('Claude Code 的 Write（对照组）：写集外拦下', () => {
    const out = callHook('claude-code', {
      tool_name: 'Write',
      tool_input: { file_path: join(ROOT, 'other', 'f.ts') },
    });
    assert.equal(decisionOf(out), 'deny');
  });

  it('**未知工具名也必须判定**（不能因换了个工具名就漏拦）', () => {
    const out = callHook('cursor', {
      tool_name: 'brand_new_tool',
      tool_input: { file_path: join(ROOT, 'other', 'g.ts') },
    });
    assert.equal(decisionOf(out), 'deny', '新工具名不许成为绕过闸门的后门');
  });

  it('**三种 harness 对同一个越界写入的结论完全一致**', () => {
    const target = join(ROOT, 'other', 'same.ts');
    const verdicts = [
      decisionOf(callHook('claude-code', { tool_name: 'Write', tool_input: { file_path: target } })),
      decisionOf(callHook('cursor', { tool_name: 'edit_file', tool_input: { path: target } })),
      decisionOf(callHook('codex', { tool_name: 'apply_patch', tool_input: { path: target } })),
    ];
    assert.equal(
      new Set(verdicts).size,
      1,
      `三种 harness 的结论必须相同，实际：${verdicts.join(' / ')} —— ` +
        '否则「越界」就变成了「取决于用什么 agent」的函数',
    );
    assert.equal(verdicts[0], 'deny');
  });

  it('事件流里的 harness 字段记录**真实来源**（不硬编码）', () => {
    callHook('cursor', {
      tool_name: 'edit_file',
      tool_input: { path: join(ROOT, 'src', 'h.ts') },
    });

    const eventsPath = join(ROOT, '.zelto', 'events', 's1', 'events.jsonl');
    assert.ok(existsSync(eventsPath), '应当有事件落盘');

    const lines = readFileSync(eventsPath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]) as { type: string; payload: { harness?: string } };
    assert.equal(last.type, 'policy.decision');
    assert.equal(
      last.payload.harness,
      'cursor',
      '事件里必须记真实来源 —— 硬编码成 claude-code 就是写入假账',
    );
  });
});

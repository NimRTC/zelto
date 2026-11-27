// ACP 协议适配层（ADR-133）
//
// 这个文件钉住 ADR-133 决策四的两条硬规则，以及三个容易漏的地方：
//
//   1. **永不发 `allow_always`** —— 写集预约是逐写判定的，
//      「以后都允许」与它直接冲突；
//   2. **不认识 ≠ 放行** —— 未知的工具类别且判不出写入目标 → 拒绝；
//   3. **判定只在 `src/hook/`** —— 归一化与渲染是纯函数，不碰 I/O、不碰网络。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  judgeAcpPermission,
  normalizeAcpToolCall,
  renderAcpPermission,
  selectAllowOnceOption,
  selectRejectOption,
  type AcpPermissionOption,
} from '../../src/hook/acp.js';
import type { PreToolContext, PreToolVerdict } from '../../src/hook/pretool.js';

const CTX: PreToolContext = {
  projectRoot: '/repo',
  worktreeRoot: '/repo/wt',
  sliceId: 's1',
  writes: ['src/**'],
  rules: null,
  policyVersion: 'sha256:test',
};

const ALLOW: PreToolVerdict = {
  decision: 'allow',
  reason: '在写集与策略允许范围内。',
  basis: 'policy:allow',
  ruleId: null,
  path: 'src/a.ts',
  targets: ['src/a.ts'],
};

const DENY: PreToolVerdict = {
  decision: 'deny',
  reason: '写入目标 "other/x.txt" 不在切片 "s1" 的写集内',
  basis: 'slice:s1#writes',
  ruleId: 'writes:s1',
  path: 'other/x.txt',
  targets: ['other/x.txt'],
};

const OPTIONS: AcpPermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
];

describe('ACP 归一化 —— 工具类别映射', () => {
  it('edit / delete / move → Write', () => {
    for (const kind of ['edit', 'delete', 'move'] as const) {
      const p = normalizeAcpToolCall({ kind, rawInput: { path: '/repo/wt/src/a.ts' } });
      assert.equal(p.tool_name, 'Write', `${kind} 应映射成 Write`);
      assert.equal(p.tool_input.file_path, '/repo/wt/src/a.ts');
      assert.notEqual(p.read_only, true);
    }
  });

  it('execute → Bash（命令里的写目标靠静态分析）', () => {
    const p = normalizeAcpToolCall({ kind: 'execute', rawInput: { command: 'rm -rf out' } });
    assert.equal(p.tool_name, 'Bash');
    assert.equal(p.tool_input.command, 'rm -rf out');
  });

  it('read / search / fetch / think / switch_mode → 只读', () => {
    for (const kind of ['read', 'search', 'fetch', 'think', 'switch_mode'] as const) {
      const p = normalizeAcpToolCall({ kind, rawInput: { path: '/repo/wt/src/a.ts' } });
      assert.equal(p.read_only, true, `${kind} 应标为只读`);
    }
  });

  it('other 与规范外的类别 → 不标只读（保守）', () => {
    // 保守的方向很重要：把未知类别当只读 = 给未知写工具开后门。
    assert.notEqual(normalizeAcpToolCall({ kind: 'other' }).read_only, true);
    assert.notEqual(normalizeAcpToolCall({ kind: 'some_future_kind' }).read_only, true);
  });

  it('kind 缺失 → 不标只读', () => {
    assert.notEqual(normalizeAcpToolCall({}).read_only, true);
    assert.notEqual(normalizeAcpToolCall(undefined).read_only, true);
  });
});

describe('ACP 归一化 —— 路径与命令的提取', () => {
  it('path 字段', () => {
    const p = normalizeAcpToolCall({ kind: 'edit', rawInput: { path: '/x/a.ts' } });
    assert.equal(p.tool_input.file_path, '/x/a.ts');
  });

  it('file_path / filePath / target_file / absolute_path 都认', () => {
    for (const key of ['file_path', 'filePath', 'target_file', 'absolute_path']) {
      const p = normalizeAcpToolCall({ kind: 'edit', rawInput: { [key]: '/x/a.ts' } });
      assert.equal(p.tool_input.file_path, '/x/a.ts', `${key} 应被认出`);
    }
  });

  it('嵌套对象里的 path 也能找到', () => {
    const p = normalizeAcpToolCall({ kind: 'edit', rawInput: { file: { path: '/x/a.ts' } } });
    assert.equal(p.tool_input.file_path, '/x/a.ts');
  });

  it('locations 是兜底来源', () => {
    const p = normalizeAcpToolCall({
      kind: 'edit',
      rawInput: { somethingElse: 1 },
      locations: [{ path: '/x/a.ts', line: 3 }],
    });
    assert.equal(p.tool_input.file_path, '/x/a.ts');
  });

  it('command 是数组时拼成字符串', () => {
    const p = normalizeAcpToolCall({ kind: 'execute', rawInput: { command: ['git', 'rm', 'a'] } });
    assert.equal(p.tool_input.command, 'git rm a');
  });

  it('rawInput 不是对象时不炸', () => {
    const p = normalizeAcpToolCall({ kind: 'edit', rawInput: 'oops' });
    assert.deepEqual(p.tool_input, {});
  });

  it('raw_tool_name 记下 agent 自报的名字（供事后查）', () => {
    const p = normalizeAcpToolCall({ kind: 'edit', name: 'my_editor', rawInput: { path: '/x/a' } });
    assert.equal(p.raw_tool_name, 'my_editor');
  });
});

describe('ACP 判定 —— 归一化只做翻译，判定内核一字不改', () => {
  it('写集内的写入 → 放行', () => {
    const v = judgeAcpPermission(
      { kind: 'edit', rawInput: { path: '/repo/wt/src/a.ts' } },
      CTX,
    );
    assert.equal(v.decision, 'allow');
  });

  it('写集外的写入 → 拒绝（理由取自判定内核）', () => {
    const v = judgeAcpPermission(
      { kind: 'edit', rawInput: { path: '/repo/wt/other/x.txt' } },
      CTX,
    );
    assert.equal(v.decision, 'deny');
    assert.equal(v.basis, 'slice:s1#writes');
  });

  it('保护域 → 拒绝', () => {
    const v = judgeAcpPermission(
      { kind: 'edit', rawInput: { path: '/repo/wt/policy/policy.yaml' } },
      CTX,
    );
    assert.equal(v.decision, 'deny');
  });

  it('逃出 worktree → 拒绝', () => {
    const v = judgeAcpPermission(
      { kind: 'edit', rawInput: { path: '/etc/passwd' } },
      CTX,
    );
    assert.equal(v.decision, 'deny');
  });

  it('只读工具 → 放行（哪怕路径在写集外）', () => {
    const v = judgeAcpPermission(
      { kind: 'read', rawInput: { path: '/repo/wt/other/readme.md' } },
      CTX,
    );
    assert.equal(v.decision, 'allow');
    assert.equal(v.basis, 'acp:read-only');
  });

  it('未知类别且判不出写入目标 → 拒绝（fail closed）', () => {
    // 这是 ACP 路线独有的一道闸门：
    // hook 路线下「不认识的工具名」会走「找路径字段」兜底，
    // 找不到就放行（空目标）；ACP 的 kind 是封闭集合 ——
    // 落到 other 意味着这次调用**可能**在写东西，而我们看不出它写什么。
    const v = judgeAcpPermission({ kind: 'other', rawInput: { foo: 1 } }, CTX);
    assert.equal(v.decision, 'deny');
    assert.equal(v.basis, 'acp:unknown-tool');
  });

  it('未知类别但能找出路径 → 按写集判（不是直接拒）', () => {
    const v = judgeAcpPermission(
      { kind: 'other', rawInput: { path: '/repo/wt/src/a.ts' } },
      CTX,
    );
    assert.equal(v.decision, 'allow');
  });

  it('没有写集预约 → 拒绝（预约缺失 fail closed）', () => {
    const v = judgeAcpPermission(
      { kind: 'edit', rawInput: { path: '/repo/wt/src/a.ts' } },
      { ...CTX, writes: null },
    );
    assert.equal(v.decision, 'deny');
  });
});

describe('ACP 输出渲染 —— 永不发 allow_always（ADR-133 决策四硬规则 1）', () => {
  it('放行时选 allow_once', () => {
    const out = renderAcpPermission(ALLOW, OPTIONS);
    assert.equal(out.outcome.outcome, 'selected');
    assert.equal(
      out.outcome.outcome === 'selected' ? out.outcome.optionId : null,
      'allow-once',
    );
  });

  it('拒绝时选 reject_once', () => {
    const out = renderAcpPermission(DENY, OPTIONS);
    assert.equal(out.outcome.outcome, 'selected');
    assert.equal(
      out.outcome.outcome === 'selected' ? out.outcome.optionId : null,
      'reject-once',
    );
  });

  it('**任何情况下**都不会选中 allow_always', () => {
    // 穷举所有选项组合 —— 只要 allow_always 在候选里，就绝不能被选中。
    const onlyAlways: AcpPermissionOption[] = [
      { optionId: 'a', kind: 'allow_always' },
      { optionId: 'r', kind: 'reject_once' },
    ];
    const allowOut = renderAcpPermission(ALLOW, onlyAlways);
    assert.notEqual(
      allowOut.outcome.outcome === 'selected' ? allowOut.outcome.optionId : null,
      'a',
      '只有 allow_always 时绝不能放行',
    );

    const denyOut = renderAcpPermission(DENY, onlyAlways);
    assert.notEqual(
      denyOut.outcome.outcome === 'selected' ? denyOut.outcome.optionId : null,
      'a',
    );
  });

  it('没有 allow_once 选项时 → 不放行（fail closed）', () => {
    const noOnce: AcpPermissionOption[] = [
      { optionId: 'a', kind: 'allow_always' },
      { optionId: 'r', kind: 'reject_once' },
    ];
    const out = renderAcpPermission(ALLOW, noOnce);
    assert.equal(out.outcome.outcome, 'selected');
    assert.equal(
      out.outcome.outcome === 'selected' ? out.outcome.optionId : null,
      'r',
      '没有只允许一次的选项就该拒绝',
    );
  });

  it('一个选项都没有 → cancelled', () => {
    const out = renderAcpPermission(DENY, []);
    assert.equal(out.outcome.outcome, 'cancelled');
  });

  it('options 是 undefined → cancelled', () => {
    const out = renderAcpPermission(ALLOW, undefined);
    assert.equal(out.outcome.outcome, 'cancelled');
  });
});

describe('ACP 选项挑选', () => {
  it('selectAllowOnceOption 只认 allow_once', () => {
    assert.equal(selectAllowOnceOption(OPTIONS), 'allow-once');
    assert.equal(
      selectAllowOnceOption([{ optionId: 'x', kind: 'allow_always' }]),
      null,
    );
  });

  it('selectRejectOption 优先 reject_once，退而 reject_always', () => {
    assert.equal(selectRejectOption(OPTIONS), 'reject-once');
    assert.equal(
      selectRejectOption([{ optionId: 'x', kind: 'reject_always' }]),
      'x',
    );
  });

  it('reject_always 是允许的 —— 拒绝只会收紧，不会放宽', () => {
    // 与 allow_always 相反的方向：记住「拒绝」不会造成越界。
    const onlyAlways: AcpPermissionOption[] = [
      { optionId: 'a', kind: 'allow_always' },
      { optionId: 'r', kind: 'reject_always' },
    ];
    assert.equal(selectRejectOption(onlyAlways), 'r');
  });
});

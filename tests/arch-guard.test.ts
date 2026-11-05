// 架构护栏判定测试（ADR-027）
//
// 分三层：
//   1. 判定层（judgeArchGuard / judgeSliceArchGuard）—— 直接测 core/arch，纯计算
//   2. 接线层（sliceGuardIssue / describeGuardKinds / loadWholeGraphGuard）—— 测 cli/arch-guard.ts
//   3. 校验层（validatePolicyConfig 的 arch 段）—— kind 非法 / 重复 / 缺 basis 必须报错
//
// C3: 判定确定 —— 同样的输入永远得到同样的结论

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  judgeArchGuard,
  judgeSliceArchGuard,
  isDeviationRelevantToSlice,
  type ArchitectureReport,
  type Deviation,
  type GuardRule,
  type ModuleSpec,
} from '../src/core/arch/index.js';
import {
  describeGuardKinds,
  loadWholeGraphGuard,
  sliceGuardForWrites,
  sliceGuardIssue,
} from '../src/cli/commands/arch-guard.js';
import { validatePolicyConfig } from '../src/core/policy/validator.js';

/** 最小的空报告骨架，只填要测的偏离 */
function makeReport(deviations: Deviation[]): ArchitectureReport {
  return { modules: [], declaredEdges: [], actualEdges: [], deviations, cycles: [], ok: false };
}

function dev(kind: Deviation['kind'], from = 'a', to = 'b'): Deviation {
  return { kind, from, to, detail: `文件 "${to}" 测试` };
}

const MODULES: ModuleSpec[] = [
  { name: 'a', description: '', filePatterns: ['src/a/**'], dependencies: [] },
  { name: 'b', description: '', filePatterns: ['src/b/**'], dependencies: [] },
];

// ─── judgeArchGuard ──────────────────────────────────────────────────────────

describe('judgeArchGuard — 整图结论', () => {
  it('缺 arch 段时全按 deny（与旧 --strict 一致）', () => {
    const v = judgeArchGuard(makeReport([dev('undeclared_dependency')]));
    assert.equal(v.blocked, true);
    const kind = v.perKind.find((k) => k.kind === 'undeclared_dependency')!;
    assert.equal(kind.action, 'deny');
    assert.equal(kind.count, 1);
    assert.equal(kind.blocked, true);
  });

  it('ask 只待确认、不拦', () => {
    const guard: GuardRule[] = [
      { kind: 'undeclared_dependency', action: 'ask', basis: 'policy.yaml#test' },
    ];
    const v = judgeArchGuard(makeReport([dev('undeclared_dependency')]), guard);
    assert.equal(v.blocked, false);
    assert.equal(v.needsConfirm, true);
  });

  it('allow 不计入结论，但计数仍在（证据不丢）', () => {
    const guard: GuardRule[] = [
      { kind: 'undeclared_dependency', action: 'allow', basis: 'policy.yaml#test' },
    ];
    const report = makeReport([dev('undeclared_dependency')]);
    const v = judgeArchGuard(report, guard);
    assert.equal(v.blocked, false);
    assert.equal(v.needsConfirm, false);
    assert.equal(report.deviations.length, 1);
    const kind = v.perKind.find((k) => k.kind === 'undeclared_dependency')!;
    assert.equal(kind.count, 1);
  });

  it('软偏离永不计入结论', () => {
    const v = judgeArchGuard(makeReport([dev('unverifiable_dependency')]));
    assert.equal(v.blocked, false);
    assert.equal(v.needsConfirm, false);
  });

  it('未知 kind 永不计入结论', () => {
    const v = judgeArchGuard(
      makeReport([{ kind: 'no_such_kind' as Deviation['kind'], from: 'a', to: 'b', detail: '' }]),
    );
    assert.equal(v.blocked, false);
  });

  it('同输入必得同输出（确定性）', () => {
    const report = makeReport([dev('undeclared_dependency'), dev('cycle', 'a', 'a → b')]);
    const guard: GuardRule[] = [{ kind: 'cycle', action: 'allow', basis: 'policy.yaml#test' }];
    assert.deepEqual(judgeArchGuard(report, guard), judgeArchGuard(report, guard));
  });

  it('干净报告不拦也不待确认', () => {
    const v = judgeArchGuard({ ...makeReport([]), ok: true });
    assert.equal(v.blocked, false);
    assert.equal(v.needsConfirm, false);
  });
});

// ─── 切片级过滤 ──────────────────────────────────────────────────────────────

describe('judgeSliceArchGuard — 只看与本片写集相关的偏离', () => {
  const report = makeReport([
    dev('undeclared_dependency', 'a', 'b'),
    { kind: 'unmapped_file', from: '(none)', to: 'src/loose.ts', detail: '文件 "src/loose.ts" 无归属' },
  ]);

  it('写集命中相关模块时拦', () => {
    const { verdict, relevant } = judgeSliceArchGuard(report, MODULES, ['src/a/**']);
    assert.equal(verdict.blocked, true);
    assert.ok(relevant.some((d) => d.kind === 'undeclared_dependency'));
  });

  it('无关模块的漂移不拦干净切片', () => {
    const { verdict, relevant } = judgeSliceArchGuard(report, MODULES, ['src/zzz/**']);
    assert.equal(verdict.blocked, false);
    assert.equal(relevant.length, 0);
  });

  it('unmapped_file 落在写集内才相关', () => {
    const { verdict } = judgeSliceArchGuard(report, MODULES, ['src/loose.ts']);
    assert.equal(verdict.blocked, true);
  });

  it('原报告不被改动（返回新数组）', () => {
    const before = report.deviations.length;
    judgeSliceArchGuard(report, MODULES, ['src/zzz/**']);
    assert.equal(report.deviations.length, before);
  });
});

describe('isDeviationRelevantToSlice — 逐类相关性', () => {
  it('cycle：环上任一成员与写集相交即相关', () => {
    const cycle = dev('cycle', 'a', 'a → b');
    assert.equal(isDeviationRelevantToSlice(cycle, new Set(['b']), []), true);
    assert.equal(isDeviationRelevantToSlice(cycle, new Set(['zzz']), []), false);
  });

  it('unknown_module：只看 from 端（to 在设计里不存在）', () => {
    const unknown = dev('unknown_module', 'a', 'ghost');
    assert.equal(isDeviationRelevantToSlice(unknown, new Set(['a']), []), true);
    assert.equal(isDeviationRelevantToSlice(unknown, new Set(['b']), []), false);
  });

  it('ambiguous_module：detail 里引用的文件落在写集内才相关', () => {
    const ambig: Deviation = {
      kind: 'ambiguous_module',
      from: 'a',
      to: 'b',
      detail: '文件 "src/shared/x.ts" 同时落在多个模块的负责范围里',
    };
    assert.equal(isDeviationRelevantToSlice(ambig, new Set(['a']), ['src/shared/**']), true);
    assert.equal(isDeviationRelevantToSlice(ambig, new Set(['a']), ['src/other/**']), false);
  });

  it('软偏离与未知 kind 永不相关', () => {
    assert.equal(
      isDeviationRelevantToSlice(dev('unverifiable_dependency'), new Set(['a', 'b']), ['src/**']),
      false,
    );
  });
});

// ─── 接线层 ──────────────────────────────────────────────────────────────────

describe('sliceGuardIssue — 单片结论转准入问题', () => {
  it('deny → error，code 固定', () => {
    const v = judgeArchGuard(makeReport([dev('undeclared_dependency')]));
    const issue = sliceGuardIssue('s1', v);
    assert.ok(issue);
    assert.equal(issue.sliceId, 's1');
    assert.equal(issue.severity, 'error');
    assert.equal(issue.code, 'arch_guard_blocked');
  });

  it('ask → warning，只提示不阻断', () => {
    const v = judgeArchGuard(makeReport([dev('undeclared_dependency')]), [
      { kind: 'undeclared_dependency', action: 'ask', basis: 'policy.yaml#test' },
    ]);
    const issue = sliceGuardIssue('s1', v);
    assert.ok(issue);
    assert.equal(issue.severity, 'warning');
    assert.equal(issue.code, 'arch_guard_confirm');
  });

  it('干净 → null', () => {
    const v = judgeArchGuard({ ...makeReport([]), ok: true });
    assert.equal(sliceGuardIssue('s1', v), null);
  });
});

describe('describeGuardKinds — 一行摘要', () => {
  it('带出种类、计数与动作', () => {
    const v = judgeArchGuard(
      makeReport([dev('undeclared_dependency'), dev('undeclared_dependency')]),
    );
    const text = describeGuardKinds(v, 'blocked');
    assert.ok(text.includes('未声明依赖'));
    assert.ok(text.includes('2'));
    assert.ok(text.includes('deny'));
  });
});

describe('loadWholeGraphGuard — 整图上下文', () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'zelto-guard-'));
    await mkdir(join(root, '.zelto', 'design'), { recursive: true });
    await mkdir(join(root, 'src', 'a'), { recursive: true });
    await mkdir(join(root, 'src', 'b'), { recursive: true });
    await writeFile(join(root, 'src', 'a', 'index.ts'), "import { b } from '../b';\n", 'utf-8');
    await writeFile(join(root, 'src', 'b', 'index.ts'), 'export const b = 1;\n', 'utf-8');
    await writeFile(
      join(root, '.zelto', 'design', 'dsg-guard.json'),
      JSON.stringify({
        id: 'dsg-guard',
        requirementId: 'req-test',
        title: '护栏测试设计',
        body: '',
        modules: [
          { name: 'a', description: '', filePatterns: ['src/a/**'], dependencies: [] },
          { name: 'b', description: '', filePatterns: ['src/b/**'], dependencies: [] },
        ],
        status: 'confirmed',
        supersedes: null,
        createdAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString(),
      }, null, 2),
      'utf-8',
    );
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('扫图并按默认全 deny 定级', async () => {
    // guardRules: [] —— 显式走默认全 deny，不依赖测试进程 cwd 的 policy 文件
    const ctx = await loadWholeGraphGuard({ designRoot: root, scanRoot: root, guardRules: [] });
    assert.ok(ctx);
    assert.equal(ctx.designId, 'dsg-guard');
    assert.ok(ctx.report.deviations.some((d) => d.kind === 'undeclared_dependency'));
    assert.equal(ctx.guard.blocked, true);
  });

  it('切片级：相关写集拦、无关写集放', async () => {
    const ctx = await loadWholeGraphGuard({ designRoot: root, scanRoot: root, guardRules: [] });
    assert.ok(ctx);
    assert.equal(sliceGuardForWrites(ctx, ['src/a/**']).verdict.blocked, true);
    assert.equal(sliceGuardForWrites(ctx, ['src/zzz/**']).verdict.blocked, false);
  });

  it('显式 ask 规则下只待确认、不拦', async () => {
    const ctx = await loadWholeGraphGuard({
      designRoot: root,
      scanRoot: root,
      guardRules: [{ kind: 'undeclared_dependency', action: 'ask', basis: 'policy.yaml#test' }],
    });
    assert.ok(ctx);
    assert.equal(ctx.guard.blocked, false);
    assert.equal(ctx.guard.needsConfirm, true);
  });

  it('无确认设计时返回 null（调用方直接跳过）', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'zelto-guard-empty-'));
    try {
      assert.equal(await loadWholeGraphGuard({ designRoot: empty, scanRoot: empty }), null);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

// ─── 校验层 ──────────────────────────────────────────────────────────────────

describe('validatePolicyConfig — arch 段', () => {
  const rule = {
    id: 'r1',
    match: { path: '**', operation: 'read' },
    action: 'allow',
    basis: 'test',
  };

  it('合法的 arch 规则通过', () => {
    const result = validatePolicyConfig({
      rules: [rule],
      arch: [{ kind: 'unmapped_file', action: 'ask', basis: 'policy.yaml#test' }],
    });
    assert.equal(result.valid, true);
  });

  it('缺 arch 段也通过（默认全 deny）', () => {
    const result = validatePolicyConfig({ rules: [rule] });
    assert.equal(result.valid, true);
  });

  it('kind 非法报错', () => {
    const result = validatePolicyConfig({
      rules: [rule],
      arch: [{ kind: 'unverifiable_dependency', action: 'allow', basis: 'test' }],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === 'arch[0].kind' && e.code === 'E_ENUM'));
  });

  it('重复 kind 报错', () => {
    const result = validatePolicyConfig({
      rules: [rule],
      arch: [
        { kind: 'cycle', action: 'deny', basis: 'test' },
        { kind: 'cycle', action: 'allow', basis: 'test' },
      ],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === 'E_DUPLICATE'));
  });

  it('缺 basis 报错', () => {
    const result = validatePolicyConfig({
      rules: [rule],
      arch: [{ kind: 'cycle', action: 'deny' }],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === 'arch[0].basis'));
  });
});

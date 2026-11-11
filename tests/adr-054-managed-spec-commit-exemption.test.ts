// zelto 托管的规格文件在提交时刻被豁免（ADR-054）
//
// 问题：`specs/slices/*.md` 是 zelto 自己写的（人批准规格 → 隔离运行复制
// 进 worktree → 合并时提交回主干），但策略里没有覆盖它的规则 ——
// scanner 刻意把 `specs/` 排除在模块之外（免得治理目录被登记成可写模块）。
// 于是它落到 default: deny，每合并一个切片就报一次
// 「⚠️ specs/slices/xxx.md 不在策略允许范围内（默认拒绝）」。
//
// 这条豁免只放开**提交时刻的策略判定**。更细的边界没有放松：
//   - agent 能不能写它，由写集预约管（judgeWriteTargets 第 3 步，在策略判定之前）；
//   - worktree 里的规格副本被改动，由托管文件哈希审计报篡改。
//
// 三件事在这里锁住：
//   1. core 与 hook 两份口径一致（hook 不能 import core，只能靠测试守）；
//   2. 提交时刻的判定放行托管规格文件；
//   3. 别的东西照旧按 default deny 处理（豁免不能扩大成「specs/ 整棵树都能写」）。

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isZeltoManagedSpecPath as coreIsZeltoManagedSpecPath } from '../src/core/project/managed-paths.js';
import { isZeltoManagedSpecPath as hookIsZeltoManagedSpecPath } from '../src/hook/managed-spec.js';
import { evaluatePolicy } from '../src/core/policy/engine.js';
import { evaluateRules, parsePolicyRules } from '../src/hook/pretool.js';
import type { PolicyConfig } from '../src/core/policy/types.js';

const HOOK_BIN = join(process.cwd(), 'dist', 'hook', 'index.js');

/** 一份不含任何写规则的策略 —— 托管规格文件的豁免必须在这种策略下也生效。 */
const EMPTY_POLICY = `rules:
  - id: allow-read-all
    match:
      path: "**"
      operation: "read"
    action: allow
    basis: "policy.yaml#allow-read-all"
    priority: 0
`;

/** 跑一次真实 hook 进程，拿到它的判定。
 *
 *  必须把 `ZELTO_PROJECT_ROOT` 指向这个临时目录：hook 进程用它去找
 * `policy/policy.yaml`（src/hook/index.ts）。父进程里带着这个变量时
 * （zelto 装着 git hook 的机器上就有），子进程会读到**别人的**策略文件，
 * 而不是这里造的那份 —— 判定就成了「测环境」而不是「测代码」。 */
function runHook(policyYaml: string, path: string, operation = 'write') {
  const root = mkdtempSync(join(tmpdir(), 'zelto-managed-spec-'));
  mkdirSync(join(root, 'policy'), { recursive: true });
  writeFileSync(join(root, 'policy', 'policy.yaml'), policyYaml);

  const stdout = execFileSync(process.execPath, [HOOK_BIN], {
    input: JSON.stringify({ path, operation, harness: 'test' }),
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, ZELTO_PROJECT_ROOT: root },
  });
  return JSON.parse(stdout.trim()) as {
    decision: string;
    basis: string;
    matched_rule: string | null;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// core 与 hook 的口径一致
// ─────────────────────────────────────────────────────────────────────────

describe('托管规格文件口径：core 与 hook 一致', () => {
  const probes = [
    'specs/slices/v1-foo.md',
    'specs/slices/nested/deep.md',
    'specs/slices/',
    'specs/slices',
    'specs',
    './specs/slices/a.md',
    'specs\\slices\\a.md',
    // 不该被认成托管文件的
    'src/specs/slices/a.md',
    'specs/slicesX/a.md',
    'docs/specs/slices/a.md',
    'src/a.ts',
    'tests/acceptance/x/acceptance.test.cjs',
  ];

  it('两边对同一批路径给出相同结论', () => {
    for (const p of probes) {
      assert.equal(
        hookIsZeltoManagedSpecPath(p),
        coreIsZeltoManagedSpecPath(p),
        `托管口径不一致：${p}`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 提交时刻的判定
// ─────────────────────────────────────────────────────────────────────────

describe('提交时刻：托管规格文件被放行', () => {
  it('core 引擎放行 specs/slices 下的文件', () => {
    const config: PolicyConfig = {
      rules: parsePolicyRules(EMPTY_POLICY) as never,
      protected: [],
    };
    const d = evaluatePolicy(config, 'specs/slices/v1-foo.md', 'write', 'v1');
    assert.equal(d.decision, 'allow');
    assert.equal(d.ruleId, 'zelto:managed-spec');
  });

  it('hook 进程放行 specs/slices 下的文件', () => {
    const out = runHook(EMPTY_POLICY, 'specs/slices/v1-foo.md');
    assert.equal(out.decision, 'allow');
    assert.equal(out.matched_rule, 'zelto:managed-spec');
  });

  it('pretool 的规则评估同样放行（与提交时刻同口径）', () => {
    const rules = parsePolicyRules(EMPTY_POLICY);
    const r = evaluateRules(rules, 'specs/slices/v1-foo.md', 'write');
    assert.equal(r.action, 'allow');
    assert.equal(r.ruleId, 'zelto:managed-spec');
  });
});

describe('提交时刻：豁免没有扩大', () => {
  it('非托管路径仍按 default deny 处理', () => {
    const out = runHook(EMPTY_POLICY, 'src/a.ts');
    assert.equal(out.decision, 'deny');
    assert.equal(out.matched_rule, 'default');
  });

  it('specs/ 树下的其它目录不被豁免', () => {
    const out = runHook(EMPTY_POLICY, 'specs/other/a.md');
    assert.equal(out.decision, 'deny');
    assert.equal(out.matched_rule, 'default');
  });

  it('嵌套目录里的同名 specs 不被豁免', () => {
    const out = runHook(EMPTY_POLICY, 'src/specs/slices/a.md');
    assert.equal(out.decision, 'deny');
    assert.equal(out.matched_rule, 'default');
  });

  it('读取操作不受影响（本来就读得了）', () => {
    const out = runHook(EMPTY_POLICY, 'specs/slices/v1-foo.md', 'read');
    assert.equal(out.decision, 'allow');
  });
});

describe('提交时刻：显式 deny 规则仍然拦得住', () => {
  const POLICY_WITH_DENY = `${EMPTY_POLICY}
  - id: deny-specs
    match:
      path: "specs/slices/**"
      operation: "write"
    action: deny
    basis: "AGENTS.md#禁区"
`;

  it('core 引擎里显式 deny 仍然生效', () => {
    const config: PolicyConfig = {
      rules: parsePolicyRules(POLICY_WITH_DENY) as never,
      protected: [],
    };
    const d = evaluatePolicy(config, 'specs/slices/v1-foo.md', 'write', 'v1');
    assert.equal(d.decision, 'deny');
    assert.equal(d.ruleId, 'deny-specs');
  });

  it('hook 进程里显式 deny 仍然生效', () => {
    const out = runHook(POLICY_WITH_DENY, 'specs/slices/v1-foo.md');
    assert.equal(out.decision, 'deny');
    assert.equal(out.matched_rule, 'deny-specs');
  });
});

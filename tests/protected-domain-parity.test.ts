// 保护域一致性（ADR-028 配套）
//
// 保护域是硬约束（C5 / C8）：不可被任何策略规则覆盖。
//
// 它在两处定义 —— core/policy/engine.ts（提交时判定、CLI）与
// src/hook/protected.ts（运行时逐写判定）—— 因为 hook 是**可独立编译的
// 判定进程**，不能 import core。
//
// 「有意复制」不等于「可以漂移」：漂移的后果是「本该拦住的文件被放行」。
// 这个测试锁住两份定义逐项相同，也锁住 glob 语义一致。

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  PROTECTED_PATTERNS as CORE_PROTECTED_PATTERNS,
  isProtectedPath as coreIsProtectedPath,
  matchPath as coreMatchPath,
} from '../src/core/policy/engine.js';
import {
  PROTECTED_PATTERNS as HOOK_PROTECTED_PATTERNS,
  isProtectedPath as hookIsProtectedPath,
  matchPath as hookMatchPath,
} from '../src/hook/protected.js';

describe('保护域定义一致', () => {
  it('core 与 hook 的保护域列表逐项相同', () => {
    assert.deepEqual(
      [...HOOK_PROTECTED_PATTERNS].sort(),
      [...CORE_PROTECTED_PATTERNS].sort(),
    );
  });

  it('两边的 isProtectedPath 对同一批路径给出相同结论', () => {
    const probes = [
      'policy/policy.yaml',
      'policy/lock.json',
      '.zelto/state.yaml',
      '.zelto/slices/a.json',
      'AGENTS.md',
      '.cursor/rules/zelto.mdc',
      'zelto-hook',
      'zelto-hook.exe',
      'src/core/policy/engine.ts',
      'tests/policy-engine.test.ts',
      'docs/zelto-技术架构.md',
      // 边界：看起来像保护域但不是
      'policy-not-really/x.ts',
      'my-AGENTS.md',
      'src/.zelto/x.ts',
      'a/policy/b/c.ts',
    ];

    for (const p of probes) {
      assert.equal(
        hookIsProtectedPath(p),
        coreIsProtectedPath(p),
        `保护域判定不一致：${p}`,
      );
    }
  });

  it('保护域条目确实拦住了该拦的', () => {
    for (const p of [
      'policy/policy.yaml',
      '.zelto/config.yaml',
      'AGENTS.md',
      '.cursor/rules/x.md',
    ]) {
      assert.equal(coreIsProtectedPath(p), true, `${p} 应在保护域内`);
      assert.equal(hookIsProtectedPath(p), true, `${p} 应在保护域内`);
    }
  });
});

describe('glob 语义一致', () => {
  it('core 与 hook 的 matchPath 对同一批模式给出相同结论', () => {
    const patterns = [
      'src/**',
      'src/**/*.ts',
      '**',
      '**/*.ts',
      'tests/acceptance/**',
      'policy/**',
      '.zelto/**',
      'AGENTS.md',
      '*.ts',
      'src/*/a.ts',
      'src/**/a.ts',
    ];
    const paths = [
      'src/a.ts',
      'src/core/policy/engine.ts',
      'src/core/a.ts',
      'tests/acceptance/001/test.ts',
      'policy/policy.yaml',
      '.zelto/state.yaml',
      'AGENTS.md',
      'a.ts',
      'src/b/a.ts',
      'src/x/y/a.ts',
      'other/file.txt',
    ];

    for (const pattern of patterns) {
      for (const path of paths) {
        assert.equal(
          hookMatchPath(pattern, path),
          coreMatchPath(pattern, path),
          `glob 判定不一致：pattern=${pattern} path=${path}`,
        );
      }
    }
  });
});

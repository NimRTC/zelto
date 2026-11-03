// 写集匹配的两份实现必须逐字等价 —— ADR-014 §4
//
// `pathInWriteSet` 在两处各有一份：
//   - src/core/sched/paths.ts    —— 准入、合并冲突、运行后审计
//   - src/hook/pretool.ts        —— agent 运行时的 PreToolUse 判定
//
// hook 那份刻意不 import core/（hook 要能单独编译分发），所以两份必然并存。
// 但「两份规则相同」这句话不能只写在 ADR 里 —— 规则一旦漂移，
// 准入层认为不重叠的两个写集，运行时会互相踩；或者反过来，
// 运行时以为在写集内、审计却判它越界。两边必须给出同一个答案。
//
// 这个测试就是那个对齐点：跑一批有代表性的 pattern × path 组合，
// 逐个比较两边的结论。任何一个组合不一致就红。

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  pathInWriteSet as admissionPathInWriteSet,
  pathMatches,
} from '../src/core/sched/paths.js';
import { pathInWriteSet as hookPathInWriteSet } from '../src/hook/pretool.js';
import { matchPath as policyMatchPath } from '../src/core/policy/engine.js';

/** 写集里可能出现的各种写法 */
const PATTERNS = [
  'src/**',
  'src/core/**',
  'src/**/*.ts',
  '**/a.ts',
  '**/*.ts',
  'docs/*.md',
  'src/core',
  'src/core/',
  'src/core/a.ts',
  'src/**/test.ts',
  'a/**/b/c.ts',
  'tests/acceptance/**',
  '.zelto/**',
  'AGENTS.md',
];

/** 可能被写的各种路径 */
const PATHS = [
  'src/core/a.ts',
  'src/core/deep/a.ts',
  'src/a.ts',
  'a.ts',
  'x/y/a.ts',
  'src/core/test.ts',
  'src/core/deep/test.ts',
  'src/core-extra/a.ts',
  'docs/a.md',
  'docs/sub/a.md',
  'a/b/c.ts',
  'a/b/x/c.ts',
  'src/core',
  'tests/acceptance/e2e.test.ts',
  '.zelto/events/s1/events.jsonl',
  'AGENTS.md',
  'src/core/a.tsx',
  'src/core/a.js',
];

describe('write-set matching parity (ADR-014 §4)', () => {
  it('the admission layer and the runtime hook agree on every combination', () => {
    const mismatches: string[] = [];
    for (const pattern of PATTERNS) {
      for (const path of PATHS) {
        const admission = admissionPathInWriteSet(path, [pattern]);
        const runtime = hookPathInWriteSet(path, [pattern]);
        if (admission !== runtime) {
          mismatches.push(`pattern="${pattern}" path="${path}" admission=${admission} runtime=${runtime}`);
        }
      }
    }
    assert.deepEqual(mismatches, [], `写集匹配两份实现结论不一致:\n${mismatches.join('\n')}`);
  });

  it('the write-set glob semantics are the policy engine semantics', () => {
    // policy.yaml 的规则匹配用的是 policy engine 的 matchPath。
    // 写集若用另一套 glob，同一个路径在「规则层」和「写集层」的答案会打架。
    const mismatches: string[] = [];
    for (const pattern of PATTERNS) {
      for (const path of PATHS) {
        const viaWriteSet = pathMatches(path, pattern);
        const viaPolicy = policyMatchPath(pattern, path);
        if (viaWriteSet !== viaPolicy) {
          mismatches.push(`pattern="${pattern}" path="${path}" writeSet=${viaWriteSet} policy=${viaPolicy}`);
        }
      }
    }
    assert.deepEqual(mismatches, [], `写集 glob 与策略 glob 语义不一致:\n${mismatches.join('\n')}`);
  });

  it('"**/" matches zero directory levels, like the policy engine', () => {
    // 这条是上一条的具体化：`**/a.ts` 必须覆盖根目录下的 `a.ts`。
    // 旧实现把 `**` 直接翻成 `.*`，于是 `**/a.ts` 至少要一层目录，
    // 准入层会漏判「两个切片都写 src/a.ts」这种冲突。
    assert.equal(policyMatchPath('**/a.ts', 'a.ts'), true);
    assert.equal(pathMatches('a.ts', '**/a.ts'), true);
    assert.equal(admissionPathInWriteSet('a.ts', ['**/a.ts']), true);
    assert.equal(hookPathInWriteSet('a.ts', ['**/a.ts']), true);
  });

  it('a glob write-set still covers a concrete sibling path', () => {
    // `src/**/*.ts` 覆盖 `src/a.ts`（零层）—— 准入层与运行时层都要认。
    assert.equal(admissionPathInWriteSet('src/a.ts', ['src/**/*.ts']), true);
    assert.equal(hookPathInWriteSet('src/a.ts', ['src/**/*.ts']), true);
    assert.equal(admissionPathInWriteSet('src/core/a.ts', ['src/**/*.ts']), true);
    assert.equal(admissionPathInWriteSet('docs/a.md', ['src/**/*.ts']), false);
  });
});

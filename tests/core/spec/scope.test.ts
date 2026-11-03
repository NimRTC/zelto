import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseScopePaths, parseAcceptanceCriteria } from '../../../src/core/spec/scope.js';

describe('parseScopePaths', () => {
  it('parses backticked paths from a 「范围」 section', () => {
    const spec = [
      '# Slice: demo',
      '',
      '## 目的',
      '',
      '随便写点什么。',
      '',
      '## 范围',
      '',
      '- `src/core/worktree/`（新建）',
      '- `src/cli/commands/shared.ts` — 增加 cwd 参数',
      '- `docs/adr-011.md`',
      '',
      '## 验收标准',
      '',
      '1. 应该通过',
    ].join('\n');

    assert.deepEqual(parseScopePaths(spec), [
      'src/core/worktree/',
      'src/cli/commands/shared.ts',
      'docs/adr-011.md',
    ]);
  });

  it('matches the English "Scope" heading too', () => {
    const spec = ['## Scope', '', '- `src/**`', '- `docs/**`'].join('\n');
    assert.deepEqual(parseScopePaths(spec), ['src/**', 'docs/**']);
  });

  it('ignores backticked paths outside the scope section', () => {
    const spec = [
      '## 目的',
      '',
      '- `not/a/write/path.ts`',
      '',
      '## 范围',
      '',
      '- `src/real.ts`',
    ].join('\n');

    assert.deepEqual(parseScopePaths(spec), ['src/real.ts']);
  });

  it('deduplicates repeated paths and preserves order', () => {
    const spec = ['## 范围', '', '- `b.ts`', '- `a.ts`', '- `b.ts`'].join('\n');
    assert.deepEqual(parseScopePaths(spec), ['b.ts', 'a.ts']);
  });

  it('ignores nested sub-bullets that describe the previous entry', () => {
    const spec = [
      '## 范围',
      '',
      '- `src/core/worktree/`（新建，仅用 Node 内置）：',
      '  - `manager.ts` — 创建 / 查询 / 移除 worktree。',
      '  - `index.ts` — 导出。',
      '- `src/cli/commands/core-slice.ts`：',
      '  - `run` 与 `runParallel` 不再在主仓库 `git checkout`。',
    ].join('\n');

    assert.deepEqual(parseScopePaths(spec), [
      'src/core/worktree/',
      'src/cli/commands/core-slice.ts',
    ]);
  });

  it('returns an empty array when there is no scope section', () => {
    assert.deepEqual(parseScopePaths('# Slice\n\n## 目的\n\n内容\n'), []);
  });
});

describe('parseAcceptanceCriteria', () => {
  it('parses numbered items from the acceptance section', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. 第一个标准',
      '2. 第二个标准',
      '',
      '## 不包含',
      '',
      '1. 不该被解析',
    ].join('\n');

    assert.deepEqual(parseAcceptanceCriteria(spec), ['第一个标准', '第二个标准']);
  });

  it('returns an empty array when there is no acceptance section', () => {
    assert.deepEqual(parseAcceptanceCriteria('## 目的\n\n内容\n'), []);
  });
});

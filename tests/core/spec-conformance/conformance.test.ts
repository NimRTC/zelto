import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  evaluateConformance,
  extractMentionedPaths,
  extractRequirements,
} from '../../../src/core/spec-conformance/index.js';

const SPEC = [
  '## 目的',
  '',
  '给切片加一道规格符合性检查。',
  '',
  '## 范围',
  '',
  '- `src/core/spec-conformance/conformance.ts` — 判定逻辑',
  '',
  '## 验收标准',
  '',
  '1. `evaluateConformance` 能算出「规格要求的」与「代码里有的」两条清单。',
  '2. 规格里提到但改动里没有的路径要报成 missing。',
  '3. 改动里有、规格没提到的路径要报成范围蔓延。',
].join('\n');

describe('extractRequirements', () => {
  it('extracts numbered acceptance criteria', () => {
    const reqs = extractRequirements(SPEC);
    assert.equal(reqs.length, 3);
    assert.match(reqs[0].text, /evaluateConformance/);
  });

  it('prefers acceptance criteria over a requirements section', () => {
    const spec = [
      '## 需求',
      '',
      '1. 需求条目',
      '',
      '## 验收标准',
      '',
      '1. 验收条目',
    ].join('\n');
    const reqs = extractRequirements(spec);
    assert.equal(reqs.length, 1);
    assert.match(reqs[0].text, /验收条目/);
  });

  it('falls back to the requirements section when acceptance criteria are absent', () => {
    const spec = ['## 需求', '', '1. 需求条目', '2. 第二条'].join('\n');
    const reqs = extractRequirements(spec);
    assert.equal(reqs.length, 2);
  });

  it('joins continuation lines into the same item', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. 第一条',
      '   续行说明。',
      '2. 第二条',
    ].join('\n');
    const reqs = extractRequirements(spec);
    assert.equal(reqs.length, 2);
    assert.match(reqs[0].text, /续行说明/);
  });

  it('returns an empty array when there is no requirement section', () => {
    assert.deepEqual(extractRequirements('## 目的\n\n内容\n'), []);
  });

  it('extracts paths and symbols as anchors', () => {
    const reqs = extractRequirements(SPEC);
    // 第一条里的 `evaluateConformance` 是标识符（不是路径）
    assert.deepEqual(reqs[0].symbols, ['evaluateConformance']);
    assert.deepEqual(reqs[0].paths, []);
  });

  it('extracts identifiers from a command-shaped anchor', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. `zelto policy edit existing-rule --action deny` 将规则 action 改为 deny',
    ].join('\n');

    const reqs = extractRequirements(spec);
    // 命令里的标识符是可核对锚点；旗标名（--action）不算
    assert.ok(reqs[0].symbols.includes('zelto'));
    assert.ok(reqs[0].symbols.includes('policy'));
    assert.ok(reqs[0].symbols.includes('deny'));
    assert.ok(!reqs[0].symbols.some((s) => s.startsWith('--')));
  });

  it('does not treat a phrase in backticks as an anchor', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. `不变量必须成立` 这条要求',
    ].join('\n');

    const reqs = extractRequirements(spec);
    assert.deepEqual(reqs[0].symbols, []);
    assert.deepEqual(reqs[0].paths, []);
  });
});

describe('extractMentionedPaths', () => {
  it('extracts backticked paths', () => {
    const paths = extractMentionedPaths(SPEC);
    assert.ok(paths.includes('src/core/spec-conformance/conformance.ts'));
  });

  it('extracts bare paths with a known extension', () => {
    const paths = extractMentionedPaths('改 src/core/foo/bar.ts 就行');
    assert.ok(paths.includes('src/core/foo/bar.ts'));
  });

  it('does not treat identifiers as paths', () => {
    const paths = extractMentionedPaths('调用 `evaluateConformance` 即可');
    assert.deepEqual(paths, []);
  });
});

describe('evaluateConformance', () => {
  it('reports implemented requirements when the touched file holds the symbol', () => {
    // 第 1 条要求的锚点是**标识符** `evaluateConformance`（不是路径），
    // 所以证据来自文件内容 —— 改动过、且内容里出现了那个符号。
    const contents = new Map([
      [
        'src/core/spec-conformance/conformance.ts',
        'export function evaluateConformance() { /* ... */ }',
      ],
    ]);

    const report = evaluateConformance(
      SPEC,
      [{ path: 'src/core/spec-conformance/conformance.ts', status: 'M', added: 10, deleted: 2 }],
      contents,
    );

    assert.equal(report.totalRequirements, 3);
    assert.equal(report.implemented, 1);
    assert.deepEqual(report.requirements[0].evidence, ['src/core/spec-conformance/conformance.ts']);
    assert.equal(report.scopeCreep.length, 0);
  });

  it('reports implemented requirements when the touched path is the anchor', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. `src/core/required.ts` 应当存在。',
    ].join('\n');

    const report = evaluateConformance(
      spec,
      [{ path: 'src/core/required.ts', status: 'M', added: 10, deleted: 2 }],
      new Map(),
    );

    assert.equal(report.implemented, 1);
    assert.equal(report.missing, 0);
  });

  it('reports missing when a required path was not touched', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. `src/core/required.ts` 应当存在。',
    ].join('\n');

    const report = evaluateConformance(
      spec,
      [{ path: 'src/core/other.ts', status: 'M', added: 1, deleted: 0 }],
      new Map(),
    );

    assert.equal(report.missing, 1);
    assert.equal(report.implemented, 0);
    assert.equal(report.requirements[0].status, 'missing');
  });

  it('reports scope creep for files the spec never mentions', () => {
    const report = evaluateConformance(
      SPEC,
      [{ path: 'src/core/unexpected.ts', status: 'A', added: 5, deleted: 0 }],
      new Map(),
    );

    assert.equal(report.scopeCreep.length, 1);
    assert.equal(report.scopeCreep[0].path, 'src/core/unexpected.ts');
    assert.ok(report.unmentionedFiles.includes('src/core/unexpected.ts'));
  });

  it('does not report zelto managed files as scope creep', () => {
    const report = evaluateConformance(
      SPEC,
      [
        { path: '.zelto/slices/s1.json', status: 'M', added: 5, deleted: 0 },
        { path: 'specs/slices/s1.md', status: 'M', added: 5, deleted: 0 },
        { path: 'tests/acceptance/s1/acceptance.test.cjs', status: 'A', added: 5, deleted: 0 },
        { path: 'src/core/unexpected.ts', status: 'A', added: 5, deleted: 0 },
      ],
      new Map(),
      {
        managedPaths: [
          '.zelto/slices/s1.json',
          'specs/slices/s1.md',
          'tests/acceptance/s1/',
        ],
      },
    );

    // 只有真正超出规格的那个算蔓延
    assert.equal(report.scopeCreep.length, 1);
    assert.equal(report.scopeCreep[0].path, 'src/core/unexpected.ts');
  });

  it('does not report a managed directory prefix as scope creep', () => {
    const report = evaluateConformance(
      SPEC,
      [{ path: 'tests/acceptance/s1/deep/nested.test.cjs', status: 'A', added: 5, deleted: 0 }],
      new Map(),
      { managedPaths: ['tests/acceptance/s1/'] },
    );

    assert.equal(report.scopeCreep.length, 0);
  });

  it('marks a requirement without anchors as undetermined, not missing', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. 解析器应当健壮。',
    ].join('\n');

    const report = evaluateConformance(spec, [], new Map());

    assert.equal(report.missing, 0);
    assert.equal(report.unknown, 1);
    assert.equal(report.requirements[0].status, 'unknown');
    assert.match(report.requirements[0].reason ?? '', /无法用确定性判据核实/);
  });

  it('uses symbol evidence from file contents', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. `SliceStore` 应当能读出切片。',
    ].join('\n');

    const contents = new Map([['src/core/slice/store.ts', 'export class SliceStore {}']]);

    const report = evaluateConformance(
      spec,
      [{ path: 'src/core/slice/store.ts', status: 'M', added: 3, deleted: 0 }],
      contents,
    );

    assert.equal(report.implemented, 1);
    assert.deepEqual(report.requirements[0].evidence, ['src/core/slice/store.ts']);
  });

  it('does not use symbol evidence from files that were not touched', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. `SliceStore` 应当能读出切片。',
    ].join('\n');

    const contents = new Map([['src/core/slice/store.ts', 'export class SliceStore {}']]);

    const report = evaluateConformance(
      spec,
      [{ path: 'src/core/other.ts', status: 'M', added: 1, deleted: 0 }],
      contents,
    );

    assert.equal(report.implemented, 0);
    assert.equal(report.missing, 1);
  });

  it('matches symbols on word boundaries, not bare substrings', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. `action` 应当被支持。',
    ].join('\n');

    // `transaction` 里含有 `action` —— 但不是同一个符号
    const contents = new Map([['src/core/x.ts', 'const transaction = begin();']]);

    const report = evaluateConformance(
      spec,
      [{ path: 'src/core/x.ts', status: 'M', added: 1, deleted: 0 }],
      contents,
    );

    assert.equal(report.implemented, 0);
    assert.equal(report.missing, 1);
  });

  it('matches a symbol with a dollar prefix on the correct boundary', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. `scope` 应当被支持。',
    ].join('\n');

    const contents = new Map([['src/core/x.ts', 'const $scope = 1;']]);

    const report = evaluateConformance(
      spec,
      [{ path: 'src/core/x.ts', status: 'M', added: 1, deleted: 0 }],
      contents,
    );

    assert.equal(report.implemented, 1);
  });

  it('handles an empty spec without throwing', () => {
    const report = evaluateConformance('', [], new Map());
    assert.equal(report.totalRequirements, 0);
    assert.equal(report.implemented, 0);
    assert.equal(report.missing, 0);
    assert.equal(report.unknown, 0);
  });

  it('is deterministic — the same input gives the same output', () => {
    const files = [{ path: 'src/core/x.ts', status: 'M' as const, added: 1, deleted: 0 }];
    const a = evaluateConformance(SPEC, files, new Map());
    const b = evaluateConformance(SPEC, files, new Map());
    assert.deepEqual(a, b);
  });
});

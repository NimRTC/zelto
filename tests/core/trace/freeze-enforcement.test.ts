// 追溯准入闸门的单元测试（ADR-032）
//
// 这次把追溯判据从「建议」变成「闸门」：冻结、版本流水线冻结、调度准入三处都拦。
// 本文件锁住三件事：
//   1. 追溯引用的来源与优先级（声明 > 规格物化 > 空即阻断）；
//   2. 严重分级（需求为空阻断、契约/测试为空只提示）；
//   3. 门禁①的退出码语义（有问题 = 1）。
//
// C3: 判定确定 —— 同样的输入永远得到同样的结论。

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  evaluateFreezeTrace,
  extractAcceptanceCriteria,
  extractRequirements,
  materializeRequirements,
} from '../../../src/core/spec/trace-extract.js';
import { blockingViolations, advisoryViolations } from '../../../src/core/trace/index.js';
import { Scheduler } from '../../../src/core/sched/engine.js';
import { SliceStore } from '../../../src/core/slice/store.js';
import { EventStream } from '../../../src/core/events/stream.js';
import type { PolicyConfig } from '../../../src/core/policy/types.js';

const SPEC_WITH_AC = [
  '# 切片规格',
  '',
  '## Summary',
  '',
  '做一件事',
  '',
  '## Acceptance Criteria',
  '',
  '1. 端到端跑通',
  '2. 失败时有人被拦下',
].join('\n');

const SPEC_WITH_REQUIREMENTS = [
  '# 切片规格',
  '',
  '## Summary',
  '',
  '做一件事',
  '',
  '## Requirements',
  '',
  '- 上游要能查到这条',
  '- 下游能拿到这条',
].join('\n');

const baseSlice = {
  trace: { requirements: [] as string[], contracts: [] as string[], tests: [] as string[] },
  traceWaiver: null as string | null,
  baseline: false,
};

describe('追溯引用的来源与优先级（ADR-032 §3.3）', () => {
  it('规格里的「验收标准」编号条目会被物化成需求追溯', () => {
    const items = extractAcceptanceCriteria(SPEC_WITH_AC);
    assert.equal(items.length, 2);
    assert.equal(items[0].text, '端到端跑通');
    assert.equal(items[0].source, 'acceptance');
  });

  it('「需求」章节的无序条目也能提取', () => {
    const items = extractRequirements(SPEC_WITH_REQUIREMENTS);
    assert.equal(items.length, 2);
    assert.equal(items[0].text, '上游要能查到这条');
    assert.equal(items[0].source, 'requirements');
  });

  it('人已经声明过的追溯不被规格物化覆盖', () => {
    const merged = materializeRequirements(['R1: 人声明的出处'], SPEC_WITH_AC);
    assert.deepEqual(merged, ['R1: 人声明的出处']);
  });

  it('没有声明时用规格物化', () => {
    const merged = materializeRequirements([], SPEC_WITH_AC);
    assert.deepEqual(merged, ['端到端跑通', '失败时有人被拦下']);
  });

  it('验收标准为空时退到「需求」章节', () => {
    const merged = materializeRequirements([], SPEC_WITH_REQUIREMENTS);
    assert.deepEqual(merged, ['上游要能查到这条', '下游能拿到这条']);
  });
});

describe('冻结准入的追溯闸门（ADR-032 §3.1 / §3.2）', () => {
  it('追溯为空时阻断冻结', () => {
    const gate = evaluateFreezeTrace(baseSlice, '');
    assert.equal(gate.blocking.length, 1);
    assert.equal(gate.blocking[0].code, 'no_requirements');
  });

  it('规格里有验收标准时放行，并把物化结果带出来', () => {
    const gate = evaluateFreezeTrace(baseSlice, SPEC_WITH_AC);
    assert.equal(gate.blocking.length, 0);
    assert.deepEqual(gate.requirements, ['端到端跑通', '失败时有人被拦下']);
  });

  it('已声明的追溯让没有规格的切片也能冻结', () => {
    const gate = evaluateFreezeTrace(
      { ...baseSlice, trace: { ...baseSlice.trace, requirements: ['R1: 人声明的出处'] } },
      '',
    );
    assert.equal(gate.blocking.length, 0);
  });

  it('豁免理由非空时整体放行', () => {
    const gate = evaluateFreezeTrace({ ...baseSlice, traceWaiver: '基线切片 — 不改代码' }, '');
    assert.equal(gate.blocking.length, 0);
  });

  it('豁免理由是空白时不生效', () => {
    const gate = evaluateFreezeTrace({ ...baseSlice, traceWaiver: '   ' }, '');
    assert.equal(gate.blocking.length, 1);
  });

  it('基线切片不参与追溯链，不阻断', () => {
    const gate = evaluateFreezeTrace({ ...baseSlice, baseline: true }, '');
    assert.equal(gate.blocking.length, 0);
  });

  it('契约与测试追溯为空只提示、不阻断', () => {
    const gate = evaluateFreezeTrace(
      { ...baseSlice, trace: { requirements: ['R1'], contracts: [], tests: [] } },
      '',
    );
    assert.equal(gate.blocking.length, 0);
  });
});

describe('调度准入也拦追溯不合格的切片（ADR-032 §3.1）', () => {
  const TEST_DIR = join(tmpdir(), `zelto-trace-gate-${Date.now()}`);
  const SLICES_DIR = join(TEST_DIR, 'slices');
  const EVENTS_DIR = join(TEST_DIR, 'events');

  const policy: PolicyConfig = {
    rules: [
      { id: 'allow-src', match: { path: 'src/**/*.ts', operation: 'write' }, action: 'allow', basis: 'policy.yaml' },
    ],
    protected: [],
  };

  let store: SliceStore;
  let events: EventStream;
  let scheduler: Scheduler;

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    store = new SliceStore(SLICES_DIR);
    events = new EventStream(EVENTS_DIR);
    scheduler = new Scheduler(store, events, policy);
  });

  it('追溯不合格的切片不予准入', async () => {
    const slice = store.create('trace-empty', '没有出处');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc';
    await store.write(slice);

    const result = await scheduler.admit('trace-empty');
    assert.equal(result.decision, 'blocked');
    assert.ok(result.reason && result.reason.includes('Trace incomplete'));
  });

  it('有需求追溯的切片照常准入', async () => {
    const slice = store.create('trace-ok', '有出处', {
      trace: { requirements: ['R1: 出处'], contracts: [], tests: [] },
    });
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc';
    await store.write(slice);

    const result = await scheduler.admit('trace-ok');
    assert.equal(result.decision, 'admitted');
  });

  it('有豁免理由的切片照常准入', async () => {
    const slice = store.create('trace-waived', '豁免', { traceWaiver: '基线切片 — 不改代码' });
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc';
    await store.write(slice);

    const result = await scheduler.admit('trace-waived');
    assert.equal(result.decision, 'admitted');
  });
});

describe('门禁①的退出码（ADR-032 §3.4）', () => {
  const TEST_DIR = join(tmpdir(), `zelto-check-exit-${Date.now()}`);
  const originalCwd = process.cwd();

  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  /** 跑一条 CLI 命令，返回退出码与合并后的输出 */
  async function runCli(...args: string[]): Promise<{ code: number; output: string }> {
    const { runCLI } = await import('../../../src/cli/commands/index.js');
    const lines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...parts: unknown[]) => lines.push(parts.join(' '));
    console.error = (...parts: unknown[]) => lines.push(parts.join(' '));
    try {
      const code = await runCLI(args);
      return { code, output: lines.join('\n') };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  it('追溯为空时冻结被拒，退出码非 0，并给出补法', async () => {
    process.chdir(TEST_DIR);

    const created = await runCli('create', 'gate-empty', '--title', '没有出处的切片');
    assert.equal(created.code, 0);

    const frozen = await runCli('freeze', 'gate-empty');
    assert.notEqual(frozen.code, 0, `冻结本应被拒：${frozen.output}`);
    assert.ok(frozen.output.includes('追溯不合格'), frozen.output);
    assert.ok(frozen.output.includes('--requirement') || frozen.output.includes('trace.requirements'), frozen.output);
  });

  it('声明了需求追溯时冻结放行', async () => {
    process.chdir(TEST_DIR);

    const created = await runCli('create', 'gate-declared', '--title', '有出处的切片', '--requirement', 'R1: 人批准的出处');
    assert.equal(created.code, 0);

    const frozen = await runCli('freeze', 'gate-declared');
    assert.equal(frozen.code, 0, `冻结本应放行：${frozen.output}`);
  });

  it('规格里写了验收标准时冻结放行（物化路径）', async () => {
    process.chdir(TEST_DIR);

    await writeFile(
      join(TEST_DIR, 'specs', 'slices', 'gate-spec.md'),
      '# 规格\n\n## Acceptance Criteria\n\n1. 端到端跑通\n',
      'utf-8',
    );
    const created = await runCli('create', 'gate-spec', '--title', '有规格的切片');
    assert.equal(created.code, 0);

    const frozen = await runCli('freeze', 'gate-spec');
    assert.equal(frozen.code, 0, `冻结本应放行：${frozen.output}`);
  });

  it('check 有问题时退出码是 1，没问题时是 0', async () => {
    process.chdir(TEST_DIR);

    const bad = await runCli('check', 'gate-empty');
    assert.equal(bad.code, 1, `check 应当报问题：${bad.output}`);

    // gate-spec 有规格文件、追溯已物化、哈希一致 → 没有阻断项
    const good = await runCli('check', 'gate-spec');
    assert.equal(good.code, 0, `check 应当通过：${good.output}`);
  });
});

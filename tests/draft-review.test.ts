// 草稿评审（规划确认体验 G-5）测试
//
// 分两层：
//   1. 判定层（diff / 决策点 / 对齐 / 评审结论）—— 直接测 core/review
//   2. 命令层（zelto require show）—— 跑真实 CLI 进程，验证「读草稿 → 评审 → 渲染」
//
// C3: 判定确定 —— 同样的输入永远得到同样的结论

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import {
  buildDraftReview,
  comparePoints,
  diffOps,
  extractPoints,
  renderUnifiedDiff,
  renderFacts,
  summarizeOps,
  RevisionStore,
} from '../src/core/review/index.js';
import type { DesignFacts, PlanFacts, RequirementFacts } from '../src/core/review/index.js';

// ─── 事实夹具 ────────────────────────────────────────────────────────────────

function requirement(overrides: Partial<RequirementFacts> = {}): RequirementFacts {
  return {
    title: '导出报表',
    userInput: '我要能把订单导成 CSV',
    spec: '# 目标\n\n导出订单。\n\n# 非目标\n\n不做 PDF。\n',
    acceptanceCriteria: ['导出的 CSV 列与订单一致', '导出失败要给出明确原因'],
    ...overrides,
  };
}

function design(overrides: Partial<DesignFacts> = {}): DesignFacts {
  return {
    title: '导出模块设计',
    body: '## 方案\n\n流式写出。\n',
    modules: [
      { name: 'exporter', description: '负责导出', filePatterns: ['src/export/**'], dependencies: ['db'] },
      { name: 'db', description: '负责读取', filePatterns: ['src/db/**'], dependencies: [] },
    ],
    ...overrides,
  };
}

function plan(overrides: Partial<PlanFacts> = {}): PlanFacts {
  return {
    title: 'v1 计划',
    versions: [
      {
        version: 'v1',
        description: '第一个版本',
        dependsOn: [],
        slices: [{ id: 's-1', title: '导出切片', module: 'exporter', writes: ['src/export/a.ts'] }],
      },
    ],
    ...overrides,
  };
}

// ─── diff ────────────────────────────────────────────────────────────────────

describe('diff — 行级差异', () => {
  it('文本相同时没有增删', () => {
    const ops = diffOps('a\nb\nc', 'a\nb\nc');
    const summary = summarizeOps(ops);
    assert.equal(summary.added, 0);
    assert.equal(summary.removed, 0);
    assert.equal(summary.changed, false);
  });

  it('新增一行会被识别', () => {
    const summary = summarizeOps(diffOps('a\nc', 'a\nb\nc'));
    assert.equal(summary.added, 1);
    assert.equal(summary.removed, 0);
    assert.equal(summary.changed, true);
  });

  it('删掉一行会被识别', () => {
    const summary = summarizeOps(diffOps('a\nb\nc', 'a\nc'));
    assert.equal(summary.removed, 1);
    assert.equal(summary.added, 0);
  });

  it('改写一行算一增一删', () => {
    const summary = summarizeOps(diffOps('a\nold\nc', 'a\nnew\nc'));
    assert.equal(summary.added, 1);
    assert.equal(summary.removed, 1);
  });

  it('渲染出的差异带 +/- 前缀', () => {
    const unified = renderUnifiedDiff(diffOps('a\nb', 'a\nnew\nb'));
    assert.ok(unified.includes('+new'));
    assert.ok(unified.includes('@@'));
  });

  it('hunk 头带真实的旧/新行号', () => {
    const unified = renderUnifiedDiff(diffOps('a\nb\nc', 'a\nx\nc'));
    assert.ok(unified.includes('@@ -1,3 +1,3 @@'), unified);
  });

  it('同样的输入永远给同样的输出', () => {
    const a = diffOps('x\ny', 'x\nz');
    const b = diffOps('x\ny', 'x\nz');
    assert.deepEqual(a, b);
  });
});

// ─── 决策点 ──────────────────────────────────────────────────────────────────

describe('决策点抽取', () => {
  it('需求的决策点 = 验收标准 + 规格章节', () => {
    const points = extractPoints('requirement', requirement());
    const acs = points.filter((p) => p.kind === 'acceptance');
    const sections = points.filter((p) => p.kind === 'section');
    assert.equal(acs.length, 2);
    assert.equal(sections.length, 2);
    assert.equal(acs[0].label, '导出的 CSV 列与订单一致');
  });

  it('设计的决策点 = 模块 + 模块依赖边', () => {
    const points = extractPoints('design', design());
    const modules = points.filter((p) => p.kind === 'module');
    const deps = points.filter((p) => p.kind === 'dependency');
    assert.equal(modules.length, 2);
    assert.equal(deps.length, 1);
    assert.equal(deps[0].label, 'exporter → db');
  });

  it('计划的决策点 = 版本 + 切片', () => {
    const points = extractPoints('plan', plan());
    assert.equal(points.filter((p) => p.kind === 'version').length, 1);
    assert.equal(points.filter((p) => p.kind === 'slice').length, 1);
  });

  it('同一份草稿两次抽取得到同样的 id', () => {
    const a = extractPoints('requirement', requirement()).map((p) => p.id);
    const b = extractPoints('requirement', requirement()).map((p) => p.id);
    assert.deepEqual(a, b);
  });
});

// ─── 跨版本对齐 ──────────────────────────────────────────────────────────────

describe('决策点对齐', () => {
  it('没有上一版时全部算新增', () => {
    const points = extractPoints('requirement', requirement());
    const marked = comparePoints([], points);
    assert.ok(marked.every((p) => p.status === 'added'));
  });

  it('文案变了算变更，消失的算移除', () => {
    const before = extractPoints('requirement', requirement());
    const after = extractPoints('requirement', requirement({
      acceptanceCriteria: ['导出的 CSV 列与订单一致', '导出失败要给出明确原因', '新的一条'],
      spec: '# 目标\n\n导出订单。\n',
    }));
    const marked = comparePoints(before, after);
    const changed = marked.find((p) => p.label === '新的一条');
    assert.equal(changed?.status, 'added');
    const removed = marked.find((p) => p.label === '非目标');
    assert.equal(removed?.status, 'removed');
  });
});

// ─── 评审结论 ────────────────────────────────────────────────────────────────

describe('buildDraftReview', () => {
  it('没有上一版时 diff 为 null', () => {
    const review = buildDraftReview('requirement', 'req-1', 'draft', requirement(), null, 0);
    assert.equal(review.diff, null);
    assert.equal(review.changedCount, 0);
    assert.ok(review.summary.some((s) => s.includes('第一版')));
  });

  it('有上一版时给出差异与变化计数', () => {
    const before = requirement();
    const after = requirement({ acceptanceCriteria: [...before.acceptanceCriteria, '新的一条'] });
    const review = buildDraftReview('requirement', 'req-1', 'draft', after, before, 1);
    assert.notEqual(review.diff, null);
    assert.equal((review.diff?.added ?? 0) > 0, true);
    assert.equal(review.changedCount, 1);
  });

  it('摘要里有决策点统计', () => {
    const review = buildDraftReview('design', 'dsg-1', 'draft', design(), null, 0);
    assert.ok(review.summary.some((s) => s.includes('决策点')));
    assert.ok(review.summary.some((s) => s.includes('模块')));
  });

  it('渲染出的文本对同样的事实稳定', () => {
    const a = renderFacts('requirement', requirement());
    const b = renderFacts('requirement', requirement());
    assert.equal(a, b);
  });
});

// ─── 修订快照 ────────────────────────────────────────────────────────────────

describe('RevisionStore — 修订快照', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zelto-revision-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('快照落盘并能读回', async () => {
    const store = new RevisionStore(dir);
    const meta = await store.snapshot('requirement', 'req-1', { title: 'v1' });
    assert.ok(meta.id.length > 0);

    const list = await store.list('requirement', 'req-1');
    assert.equal(list.length, 1);

    const payload = (await store.latestPayload('requirement', 'req-1')) as { title: string };
    assert.equal(payload.title, 'v1');
  });

  it('多次快照不互相覆盖', async () => {
    const store = new RevisionStore(dir);
    await store.snapshot('requirement', 'req-2', { title: 'a' });
    await store.snapshot('requirement', 'req-2', { title: 'b' });
    const list = await store.list('requirement', 'req-2');
    assert.equal(list.length, 2);
    const payload = (await store.latestPayload('requirement', 'req-2')) as { title: string };
    assert.equal(payload.title, 'b');
  });

  it('没有快照时 latestPayload 为 null', async () => {
    const store = new RevisionStore(dir);
    assert.equal(await store.latestPayload('requirement', 'req-none'), null);
  });
});

// ─── 命令层 ──────────────────────────────────────────────────────────────────

const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCli(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZELTO_SKIP_LLM: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 10000).unref();
  });
}

function requirementMarkdown(id: string): string {
  return [
    '---',
    `id: ${id}`,
    'title: 导出报表',
    'status: draft',
    'supersedes: ',
    'createdAt: 2026-01-01T00:00:00.000Z',
    'confirmedAt: ',
    '---',
    '',
    '# 导出报表',
    '',
    '## 用户输入',
    '',
    '我要能把订单导成 CSV',
    '',
    '## 验收标准',
    '',
    '- 导出的 CSV 列与订单一致',
    '- 导出失败要给出明确原因',
    '',
    '## AI 生成规格',
    '',
    '# 目标',
    '',
    '导出订单。',
    '',
  ].join('\n');
}

describe('zelto require show — 规划确认视图', () => {
  let testDir: string;

  before(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'zelto-show-'));
    await mkdir(join(testDir, '.zelto', 'requirements'), { recursive: true });
    await writeFile(join(testDir, '.zelto', 'requirements', 'req-demo.md'), requirementMarkdown('req-demo'), 'utf-8');
  });

  after(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('show 输出摘要与决策点', async () => {
    const { stdout, code } = await runCli(testDir, 'require', 'show', 'req-demo');
    assert.equal(code, 0);
    assert.ok(stdout.includes('摘要'));
    assert.ok(stdout.includes('决策点'));
    assert.ok(stdout.includes('验收标准'));
  });

  it('show 不存在的草稿返回 1', async () => {
    const { code } = await runCli(testDir, 'require', 'show', 'req-nope');
    assert.equal(code, 1);
  });

  it('show 缺 id 时给出用法', async () => {
    const { code } = await runCli(testDir, 'require', 'show');
    assert.equal(code, 1);
  });
});

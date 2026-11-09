// token-report 脚本的口径测试 —— 开销对比的结论必须可复算。
//
// 这个脚本是内部自查工具，不进产品、不进 CHANGELOG —— 基线是个假设，一旦写进产品
// 文档就成了一句对外承诺。但它跑出来的数字会被人直接拿去判断 zelto 值不值，
// 所以口径必须锁死：
//
//   - 基线是「直接用 agent」：每片 1 次成功会话、规格同样要读、无规划期 LLM、无手动重试
//   - 规格上下文两边都要吃（zelto 读 bundle，人把规格贴进去），所以 bundle token
//     不从基线里扣，只是单列 —— 这是最容易算错的一处
//   - 失败重试烧的 token 不在事件流里，只能估算，且必须在输出里标成估算
//   - 「成功但没记账」的老格式切片既不是零花费，也不是失败会话
//   - 完全没有记账样本时，基线与差额报「无法计算」，不报 0
//   - BOM 文件（Windows PowerShell 写出来的 UTF-8）必须能解析
//   - 规划期 LLM 的 token 只算一次（llm.called 与 budget.spent 是同一笔账的两面）

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'token-report.mjs');

let workdir: string;

function writeEvents(
  sliceId: string,
  events: Array<Record<string, unknown>>,
  options: { bom?: boolean } = {},
): void {
  const dir = join(workdir, '.zelto', 'events', sliceId);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e, i) =>
    JSON.stringify({
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      runSeq: i + 1,
      slice: sliceId,
      run: null,
      type: e.type,
      actor: e.actor ?? 'zelto',
      payload: e.payload ?? {},
    }),
  );
  const body = lines.join('\n') + '\n';
  writeFileSync(join(dir, 'events.jsonl'), options.bom ? `\uFEFF${body}` : body, 'utf-8');
}

function writeBundle(sliceId: string, instructions: string): void {
  const dir = join(workdir, '.zelto');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sliceId}-bundle.json`),
    `\uFEFF${JSON.stringify({ sliceId, instructions, writes: [] })}`,
    'utf-8',
  );
}

interface Report {
  tool: string;
  internal: boolean;
  eventLines: number;
  malformed: number;
  agent: {
    measuredSessions: number;
    measuredTokens: number;
    measuredCostUsd: number;
    unmeasuredSessions: number;
    unmeasuredCostUsd: number;
    sessionsStarted: number;
    sessionsSucceeded: number;
    failedSessions: number;
    failedTokensEst: number | null;
    failedCostEst: number | null;
  };
  planningLlm: { calls: number; tokens: number; costUsd: number };
  bundleInjection: { tokens: number; slices: number };
  comparison: {
    zeltoTotalTokens: number | null;
    zeltoTotalCost: number | null;
    directTokens: number | null;
    directCost: number | null;
    directTokensEstimated: boolean;
    deltaTokens: number | null;
    deltaCost: number | null;
  };
  perSlice: Array<{
    id: string;
    sessionsStarted: number;
    sessionsSucceeded: number;
    measuredSessions: number;
    measuredTokens: number;
    unmeasuredSessions: number;
    llmTokens: number;
  }>;
}

function run(extraArgs: string[] = []): Report {
  const out = execFileSync(process.execPath, [SCRIPT, workdir, '--json', ...extraArgs], {
    encoding: 'utf-8',
  });
  return JSON.parse(out) as Report;
}

/** 记账的一次成功会话：12 万 token，5 毛钱 */
const AGENT_SPENT = {
  type: 'budget.spent',
  payload: { amount: 0.5, source: 'agent', inputTokens: 100000, outputTokens: 20000 },
};

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'zelto-token-report-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('token-report 口径', () => {
  it('agent 会话与规划期 LLM 的 token 分得开', () => {
    writeEvents('s1', [
      AGENT_SPENT,
      {
        type: 'llm.called',
        payload: { model: 'deepseek', promptTokens: 5000, completionTokens: 1000, totalTokens: 6000 },
      },
      { type: 'budget.spent', payload: { amount: 0.002, reason: 'llm:deepseek' } },
    ]);

    const r = run();
    assert.equal(r.agent.measuredSessions, 1);
    assert.equal(r.agent.measuredTokens, 120000);
    assert.equal(r.agent.measuredCostUsd, 0.5);
    assert.equal(r.planningLlm.calls, 1);
    assert.equal(r.planningLlm.tokens, 6000);
    assert.equal(r.planningLlm.costUsd, 0.002);
  });

  it('基线是「每片 1 次成功会话」，差额来自重试与规划期 LLM', () => {
    writeEvents('s1', [
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.aborted', payload: { sliceId: 's1', exitCode: 1 } },
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.finished', payload: { sliceId: 's1', exitCode: 0 } },
      AGENT_SPENT,
      {
        type: 'llm.called',
        payload: { model: 'deepseek', promptTokens: 5000, completionTokens: 1000, totalTokens: 6000 },
      },
    ]);

    const r = run();
    // 基线 = 这片 1 次成功会话 = 120000 tokens
    assert.equal(r.comparison.directTokens, 120000);
    // 用 zelto = 成功会话 120000 + 失败会话估算 120000 + 规划期 6000
    assert.equal(r.comparison.zeltoTotalTokens, 246000);
    assert.equal(r.comparison.deltaTokens, 126000);
    assert.equal(r.planningLlm.tokens, 6000);
  });

  it('失败会话不在账上，按记账会话均值估算并单列', () => {
    writeEvents('s1', [
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.aborted', payload: { sliceId: 's1', exitCode: 1 } },
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.finished', payload: { sliceId: 's1', exitCode: 0 } },
      AGENT_SPENT,
    ]);

    const r = run();
    assert.equal(r.agent.sessionsStarted, 2);
    assert.equal(r.agent.sessionsSucceeded, 1);
    assert.equal(r.agent.failedSessions, 1);
    assert.equal(r.agent.failedTokensEst, 120000);
    assert.equal(r.agent.failedCostEst, 0.5);
  });

  it('run.aborted 重复写不会把失败次数数两遍', () => {
    // core-slice 与 handleAgentFailure 会各写一条 run.aborted
    writeEvents('s1', [
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.aborted', payload: { sliceId: 's1', exitCode: 1 } },
      { type: 'run.aborted', payload: { sliceId: 's1', exitCode: 1 } },
      { type: 'run.aborted', payload: { sliceId: 's1', exitCode: 1 } },
    ]);

    const r = run();
    assert.equal(r.agent.sessionsStarted, 1);
    assert.equal(r.agent.sessionsSucceeded, 0);
    assert.equal(r.agent.failedSessions, 1);
  });

  it('老格式切片（成功但没记账）既不算零花费，也不算失败会话', () => {
    writeEvents('s2', [
      { type: 'run.started', payload: { sliceId: 's2' } },
      { type: 'run.finished', payload: { sliceId: 's2', exitCode: 0, costUsd: 0.25 } },
    ]);

    const r = run();
    assert.equal(r.agent.unmeasuredSessions, 1);
    assert.equal(r.agent.unmeasuredCostUsd, 0.25);
    assert.equal(r.agent.measuredTokens, 0);
    // 成功的会话不算失败会话
    assert.equal(r.agent.sessionsSucceeded, 1);
    assert.equal(r.agent.failedSessions, 0);
    assert.equal(r.perSlice[0].unmeasuredSessions, 1);
  });

  it('bundle token 只单列，不从基线里扣（两边都要读规格）', () => {
    writeEvents('s1', [
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.finished', payload: { sliceId: 's1', exitCode: 0 } },
      AGENT_SPENT,
    ]);
    writeBundle('s1', 'x'.repeat(400));

    const r = run();
    // 400 个 ASCII 字符 ≈ 100 token，每次会话读一遍
    assert.equal(r.bundleInjection.tokens, 100);
    assert.equal(r.bundleInjection.slices, 1);
    // 基线仍然是这片的 1 次成功会话全额 —— bundle 不扣
    assert.equal(r.comparison.directTokens, 120000);
  });

  it('带 BOM 的事件流与 bundle 都能解析', () => {
    writeEvents('s1', [AGENT_SPENT], { bom: true });
    writeBundle('s1', 'x'.repeat(400));

    const r = run();
    assert.equal(r.malformed, 0);
    assert.equal(r.eventLines, 1);
    assert.equal(r.agent.measuredTokens, 120000);
    assert.equal(r.bundleInjection.tokens, 100);
  });

  it('--no-estimate 时不估算账外支出', () => {
    writeEvents('s1', [
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.aborted', payload: { sliceId: 's1', exitCode: 1 } },
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.finished', payload: { sliceId: 's1', exitCode: 0 } },
      AGENT_SPENT,
    ]);

    const r = run(['--no-estimate']);
    assert.equal(r.agent.failedSessions, 1);
    assert.equal(r.agent.failedTokensEst, 0);
    assert.equal(r.agent.failedCostEst, 0);
    // 基线不受影响
    assert.equal(r.comparison.directTokens, 120000);
  });

  it('没有任何记账样本时，基线与差额报「无法计算」而不是 0', () => {
    writeEvents('s1', [
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.finished', payload: { sliceId: 's1', exitCode: 0 } },
    ]);

    const r = run();
    assert.equal(r.agent.measuredSessions, 0);
    assert.equal(r.comparison.directTokens, null);
    assert.equal(r.comparison.deltaTokens, null);
    assert.equal(r.agent.failedTokensEst, null);
  });

  it('输出标明了它是内部工具，不是对外承诺', () => {
    writeEvents('s1', [AGENT_SPENT]);

    const r = run();
    assert.equal(r.internal, true);
    assert.equal(r.tool, 'zelto-internal-cost-report');
  });

  it('没有事件目录时报错退出，不静默给出 0', () => {
    assert.throws(() => run(), /找不到事件目录/);
  });
});

// ─── 发布边界 ─────────────────────────────────────────────────────────────
//
// 这个脚本留在仓库里供内部自查，但它**不能随产品发布**。原因不是"太大"，
// 而是「用 zelto 比直接用 agent 多花多少」这个对比一旦出现在用户能拿到的地方，
// 就成了一句对外承诺 —— 而基线是个假设，假设一变结论就翻。
//
// 闸门在 package.json 的 files 白名单：白名单里没有 scripts/，npm pack 就不会
// 把它打进去。下面这组用例守的是这条边界 —— 有人往 files 里加 "scripts/" 时
// 会在这里失败。

describe('开销对比不随产品发布', () => {
  const pkg = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
  ) as { files?: string[]; scripts?: Record<string, string> };
  const files = pkg.files ?? [];

  it('package.json 声明了 files 白名单', () => {
    assert.ok(Array.isArray(pkg.files), '没有 files 白名单 = 整个仓库都会被发布');
    assert.ok(files.length > 0);
  });

  it('白名单里没有 scripts / tests / docs / specs —— 内部材料与开销对比脚本都不外发', () => {
    const leaked = files.filter((f) => /^(scripts|tests|docs|specs|src)\//.test(f));
    assert.deepEqual(leaked, [], `这些目录不该进发布包：${leaked.join(', ')}`);
  });

  it('白名单里没有 .cursor / AGENTS.md / CLAUDE.md 等内部协作材料', () => {
    const leaked = files.filter(
      (f) => f.startsWith('.') || /^(AGENTS|CLAUDE|CONTRIBUTING|GIT-STATE-NOTICE)/.test(f),
    );
    assert.deepEqual(leaked, [], `这些不该进发布包：${leaked.join(', ')}`);
  });

  it('npm scripts 里没有开销对比的入口', () => {
    const scripts = Object.keys(pkg.scripts ?? {});
    assert.equal(
      scripts.some((s) => /token-report|cost-report/i.test(s)),
      false,
      'npm script 是用户看得见的入口，不该暴露内部自查工具',
    );
  });

  it('npm pack 的实际产物里不含开销对比脚本', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    });
    const pack = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const paths = pack[0].files.map((f) => f.path);
    const leaked = paths.filter((p) => /token-report/i.test(p));
    assert.deepEqual(leaked, [], `发布包里混进了：${leaked.join(', ')}`);
    // 顺带守住另一头：产物里也不该有 docs / specs
    assert.equal(paths.some((p) => p.startsWith('docs/')), false);
    assert.equal(paths.some((p) => p.startsWith('specs/')), false);
  });
});

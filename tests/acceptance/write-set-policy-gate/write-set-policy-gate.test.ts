// Acceptance test: write-set-policy-gate
//
// 验证「写集不在 policy 允许范围内」在**会改变状态的路径**上真的拦住。
//
// 病灶（实测于 nimrtc-zelto v2-ai-decision，2026-11-17）：
//   切片写集声明 `demo-agent-realtime/**`，policy.yaml 的 allow 规则
//   不覆盖它 → agent 起跑 → 第一次写文件就被 hook 按 `policy.yaml#default`
//   拒绝 → 换路径再试 → 再被拒 → 30 分钟超时耗尽，
//   **worktree 里一个字节代码都没留下**。
//
// `zelto check` 早就报出了这句话，但它**只是一个命令** —— 人不跑它，
// 判定就只是屏幕上的一段字。这条测试锁死的是：**闸门接上了**，
// 判定不再是「知道了但没人管」。
//
// 覆盖三条会改变状态的路径：
//   1. zelto run    —— 最后一道，最贵的一道（agent 已经要烧 token 了）
//   2. zelto freeze —— 把规格钉成基线的那一刻
//   3. zelto check  —— 门禁①的口径必须与前两者一致
//
// C1: 状态只落在文件里。测试用真实 CLI 进程，不 mock。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

/** nimrtc-zelto 的 policy.yaml 简化版（真实结构：allow 清单 + 保护域）。 */
const POLICY_YAML = `rules:
  - id: allow-src
    match: { path: "src/**", operation: "write" }
    action: allow
    basis: "test#src"
  - id: allow-tests
    match: { path: "tests/**", operation: "write" }
    action: allow
    basis: "test#tests"
  - id: protect-policy
    match: { path: "policy/**" }
    action: deny
    basis: "test#protect"
`;

const SPEC_MD = `# Slice: bad-write-set

## 目的
测试「写集不在 policy 允许范围内」会被拦住。

## 范围
- demo-agent-realtime/**
- tests/acceptance/bad-write-set/acceptance.test.cjs

## 验收标准
1. 写集被拒时，run 与 freeze 都必须退出码 1。
2. 拒绝信息要说清「第一次写文件就会被拒」，并给出修法。
`;

function zelto(cwd: string, ...args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync('node', [CLI_SCRIPT, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? 1,
  };
}

async function makeProject(dir: string, writes: string[]): Promise<void> {
  await mkdir(join(dir, '.zelto', 'slices'), { recursive: true });
  await mkdir(join(dir, 'policy'), { recursive: true });
  await mkdir(join(dir, 'specs', 'slices'), { recursive: true });
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'policy', 'policy.yaml'), POLICY_YAML, 'utf-8');
  await writeFile(join(dir, 'specs', 'slices', 'bad-write-set.md'), SPEC_MD, 'utf-8');

  // 切片状态文件 —— 直接落盘，绕开 create 命令（这里要的不是创建流程）。
  const slice = {
    id: 'bad-write-set',
    title: '写集不在 policy 覆盖内的切片',
    state: 'draft',
    spec: { path: 'specs/slices/bad-write-set.md', frozenHash: null, frozenAt: null },
    acceptance: { dir: 'tests/acceptance/bad-write-set', frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: ['R1: 拒绝'], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes,
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(
    join(dir, '.zelto', 'slices', 'bad-write-set.json'),
    JSON.stringify(slice, null, 2),
    'utf-8',
  );
}

describe('acceptance: write-set-policy-gate', { concurrency: false }, () => {
  let badDir: string;
  let goodDir: string;

  before(async () => {
    badDir = join(tmpdir(), `zelto-ws-gate-bad-${Date.now()}`);
    goodDir = join(tmpdir(), `zelto-ws-gate-good-${Date.now()}`);
    await mkdir(badDir, { recursive: true });
    await mkdir(goodDir, { recursive: true });
    // 写集落在 policy 允许清单之外（病灶现场）
    await makeProject(badDir, ['demo-agent-realtime/**']);
    // 写集落在 policy 允许清单之内（对照组）
    await makeProject(goodDir, ['src/**']);
  });

  after(async () => {
    await rm(badDir, { recursive: true, force: true });
    await rm(goodDir, { recursive: true, force: true });
  });

  // ─── run：最后一道闸门 ─────────────────────────────────────────────────────

  it('zelto run 拒绝写集不在 policy 覆盖内的切片（退出码 1）', () => {
    const r = zelto(badDir, 'run', 'bad-write-set');
    assert.equal(r.code, 1, `run 应该退出 1。stdout: ${r.stdout} stderr: ${r.stderr}`);
  });

  it('拒绝信息说清「第一次写文件就会被拒」，并给出修法', () => {
    const r = zelto(badDir, 'run', 'bad-write-set');
    const out = r.stdout + r.stderr;
    assert.match(out, /第一次写文件就会被拒/);
    assert.match(out, /policy\.yaml/);
    // 修法要具体到可执行的命令
    assert.match(out, /zelto policy add|zelto set/);
  });

  it('拒绝发生在预算扣除之前（不占额度）', () => {
    const r = zelto(badDir, 'run', 'bad-write-set');
    const out = r.stdout + r.stderr;
    // 预算检查在预检之后，被拒时不该出现预算相关的话
    assert.doesNotMatch(out, /budget|预算/i);
  });

  it('控制组：写集在 policy 允许内 → run 不被这个原因拦下', () => {
    const r = zelto(goodDir, 'run', 'bad-write-set');
    const out = r.stdout + r.stderr;
    // 它可能因为别的原因失败（切片没冻结等），但**不能**是写集策略的原因
    assert.doesNotMatch(out, /不在 policy\.yaml 的任何允许规则覆盖范围内/);
  });

  // ─── freeze：把「注定跑不起来」钉成基线前就该拦 ───────────────────────────

  it('zelto freeze 拒绝写集不在 policy 覆盖内的切片（退出码 1）', () => {
    const r = zelto(badDir, 'freeze', 'bad-write-set');
    assert.equal(r.code, 1, `freeze 应该退出 1。stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = r.stdout + r.stderr;
    assert.match(out, /第一次写文件就会被拒/);
  });

  it('被拒的 freeze 不会把切片置为 frozen（状态没被改）', async () => {
    const raw = await readFile(join(badDir, '.zelto', 'slices', 'bad-write-set.json'), 'utf-8');
    const slice = JSON.parse(raw);
    assert.notEqual(slice.state, 'frozen');
  });

  // ─── check：口径必须与 run / freeze 一致 ──────────────────────────────────

  it('zelto check 报出同一个阻断项（口径一致）', () => {
    const r = zelto(badDir, 'check', 'bad-write-set');
    const out = r.stdout + r.stderr;
    assert.match(out, /第一次写文件就会被拒/);
    assert.equal(r.code, 1);
  });

  // ─── 判定要留痕 ───────────────────────────────────────────────────────────

  it('拒绝会写进事件流（事后可查：为什么没跑）', async () => {
    const evtPath = join(badDir, '.zelto', 'events', 'bad-write-set', 'events.jsonl');
    assert.ok(existsSync(evtPath), '应当有事件文件');
    const lines = (await readFile(evtPath, 'utf-8')).trim().split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    const checked = events.filter((e) => e.type === 'spec.checked');
    assert.ok(checked.length > 0, '应当有 spec.checked 事件');
    assert.ok(
      checked.some((e) => JSON.stringify(e.payload?.details ?? '').includes('第一次写文件就会被拒')),
      '事件里应当记着阻断原因',
    );
  });

  // ─── 没有项目策略时不该阻断 ───────────────────────────────────────────────
  //
  // 「项目还没写 policy.yaml」和「策略不允许写这个路径」是两件事。
  // 前者不该拦人 —— 否则一个刚起步的项目（还没写策略）连第一片都跑不了。
  //
  // 之所以会误判：没有 policy.yaml 时 `loadPolicyConfig` 回落到 **zelto 自己**
  // 的兜底策略（`src/**/*.ts` / `tests/**/*.ts`，给 TypeScript 项目用的）。
  // 拿它去判 C++ 项目的 `src/engine/src/foo.cpp` → 「不在任何允许规则覆盖范围内」
  // → 纯误判。

  describe('项目没有 policy.yaml 时', () => {
    let noPolicyDir: string;

    before(async () => {
      noPolicyDir = join(tmpdir(), `zelto-ws-gate-nopolicy-${Date.now()}`);
      await mkdir(noPolicyDir, { recursive: true });
      await mkdir(join(noPolicyDir, '.zelto', 'slices'), { recursive: true });
      await mkdir(join(noPolicyDir, 'specs', 'slices'), { recursive: true });
      await writeFile(
        join(noPolicyDir, 'specs', 'slices', 'bad-write-set.md'),
        SPEC_MD,
        'utf-8',
      );
      // 只有切片与规格，**没有** policy/policy.yaml
      const slice = {
        id: 'bad-write-set',
        title: '没有策略的切片',
        state: 'draft',
        spec: { path: 'specs/slices/bad-write-set.md', frozenHash: null, frozenAt: null },
        acceptance: { dir: 'tests/acceptance/bad-write-set', frozenHash: null, oracleSrc: null },
        baseCommit: null,
        drift: { detected: false, reason: null, at: null },
        trace: { requirements: ['R1: 拒绝'], contracts: [], tests: [] },
        traceWaiver: null,
        baseline: false,
        writes: ['src/engine/src/rtp_packetizer.cpp'],
        runs: [],
        stall: { class: null, autoResolved: 0, gateRetries: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeFile(
        join(noPolicyDir, '.zelto', 'slices', 'bad-write-set.json'),
        JSON.stringify(slice, null, 2),
        'utf-8',
      );
    });

    after(async () => {
      await rm(noPolicyDir, { recursive: true, force: true });
    });

    it('run 不因「写集不在策略覆盖内」被拦（没策略 ≠ 策略不允许）', () => {
      const r = zelto(noPolicyDir, 'run', 'bad-write-set');
      const out = r.stdout + r.stderr;
      assert.doesNotMatch(out, /不在 policy\.yaml 的任何允许规则覆盖范围内/);
    });

    it('freeze 不因「写集不在策略覆盖内」被拦', () => {
      const r = zelto(noPolicyDir, 'freeze', 'bad-write-set');
      const out = r.stdout + r.stderr;
      assert.doesNotMatch(out, /不在 policy\.yaml 的任何允许规则覆盖范围内/);
    });

    it('check 也不报这个阻断项', () => {
      const r = zelto(noPolicyDir, 'check', 'bad-write-set');
      const out = r.stdout + r.stderr;
      assert.doesNotMatch(out, /不在 policy\.yaml 的任何允许规则覆盖范围内/);
    });
  });
});

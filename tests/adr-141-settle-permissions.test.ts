// ACP 终止路径的挂起请求结算测试（ADR-141）
//
// 这个文件钉住 ADR-141 的核心主张：
//
//   1. **进程退出**时挂起的 permission 请求被结算 → 写了 `policy.decision`，
//      `basis === 'acp:terminated'`；
//   2. **空转超时**路径同样结算；
//   3. **人工停止**路径同样结算；
//   4. **结算回的是拒绝，绝不是允许** —— 绝不回 `allow_always`；
//   5. **终止原因写进事件**；
//   6. **判定进行中被终止** → 不写答复，但仍写事件；
//   7. **结算幂等、不抛异常**；
//   8. **终止路径不被结算异常掩盖**。
//
// ## 为什么这条规则重要
//
// 挂起的那次写入**既没被判允许、也没被判拒绝** —— 它悬在中间。
// 从追溯链看：这次写入**在事件流里没有 `policy.decision`** ——
// 和 ADR-139 修的「续跑段没有守卫」是**同一种断链**，只是成因不同。
//
// 事后审计看到「没有 decision、也没有文件变化」会推断「没发生过」——
// 而它**发生过**（agent 确实要写）。C4。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcpAdapter } from '../src/adapters/acp/index.js';
import {
  PendingPermissionRegistry,
  TERMINATED_BASIS,
  renderSettlementOutcome,
  selectRejectOptionForSettlement,
} from '../src/adapters/acp/permission.js';

// 测试跑在 `dist-test/tests/` 下 —— 仓库根要上两级。
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const MOCK_AGENT = join(REPO_ROOT, 'tests', 'fixtures', 'mock-acp-agent.mjs');

let workDir: string;
let projectRoot: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'zelto-acp-141-work-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'zelto-acp-141-proj-'));

  const locksDir = join(projectRoot, '.zelto', 'locks');
  mkdirSync(locksDir, { recursive: true });
  writeFileSync(
    join(locksDir, 'slice-1.json'),
    JSON.stringify({
      sliceId: 'slice-1',
      writes: ['src/**'],
      worktree: workDir,
      projectRoot,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }),
    'utf-8',
  );
  mkdirSync(join(projectRoot, '.zelto', 'events', 'slice-1'), { recursive: true });
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

/** 读这个切片的事件流。 */
function readEvents(sliceId = 'slice-1'): Array<Record<string, unknown>> {
  const file = join(projectRoot, '.zelto', 'events', sliceId, 'events.jsonl');
  if (!existsSync(file)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as Record<string, unknown>);
  }
  return out;
}

/**
 * 起一个 mock ACP agent，发一个 permission 请求后**不等答复**就退出。
 *
 * `blockFor` 让 permission 回调**阻塞**在「问人」上 ——
 * 那正是「判定进行中被终止」那条路径（ADR-141 验收 6）。
 *
 * 不阻塞的话，permission 回调会**同步答完**（非 TTY → 不问人），
 * 那时已经没有「挂起的请求」了 —— 测不到结算。
 *
 * **每个用例用独立的 sliceId** —— 事件流是 append-only 且**切片内**的，
 * 共用一个 slice 会让上一个用例的事件混进下一个的断言里。
 */
async function runAndTerminate(opts: {
  mode: 'exit' | 'timeout' | 'stop';
  sliceId: string;
  timeoutMs?: number;
  /** 让 permission 回调阻塞这么久（毫秒）；0 = 不阻塞 */
  blockFor?: number;
  /** 白名单（打开「以后都允许」的提问） */
  alwaysAllowPaths?: string[];
}): Promise<{ events: Array<Record<string, unknown>>; exitCode: number | null }> {
  const sliceId = opts.sliceId;
  const outputFile = join(workDir, `out-${Math.random().toString(36).slice(2)}.txt`);
  const bundlePath = join(workDir, `bundle-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(bundlePath, JSON.stringify({ instructions: '请写一个文件。' }), 'utf-8');

  // 这个切片的写集预约。
  const locksDir = join(projectRoot, '.zelto', 'locks');
  mkdirSync(locksDir, { recursive: true });
  writeFileSync(
    join(locksDir, `${sliceId}.json`),
    JSON.stringify({
      sliceId,
      writes: ['src/**'],
      worktree: workDir,
      projectRoot,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }),
    'utf-8',
  );
  mkdirSync(join(projectRoot, '.zelto', 'events', sliceId), { recursive: true });

  const agentCommand = [
    JSON.stringify(process.execPath),
    JSON.stringify(MOCK_AGENT),
    JSON.stringify(outputFile),
    '1',
    'edit',
    JSON.stringify(join(workDir, 'src', 'ok.ts')),
  ].join(' ');

  const adapter = new AcpAdapter({
    cwd: workDir,
    agentCommand,
    projectRoot,
    // 超时路径用：给一个**很短**的空闲超时，逼它走超时。
    timeoutMs: opts.timeoutMs ?? 15_000,
    alwaysAllowPaths: opts.alwaysAllowPaths ?? ['src/**'],
    // 阻塞在「问人」上 —— 模拟「人正在回答时进程被杀了」。
    promptAlwaysAllow: async () => {
      await new Promise((r) => setTimeout(r, opts.blockFor ?? 5_000));
      return 'once' as const;
    },
    env: {
      ...process.env,
      // `exit` —— agent 发完请求就退出（走 zelto 的「进程退出」路径）；
      // `wait` —— agent 永不退出（逼 zelto 的空闲超时）。
      MOCK_ACP_HANG_PERMISSION: opts.mode === 'timeout' ? 'wait' : 'exit',
    },
  });

  const { sessionId } = await adapter.start({
    sliceId,
    prompt: bundlePath,
    runId: 'run-141',
  });

  // 让 agent 跑到「发了 permission 请求」这一步。
  await new Promise((r) => setTimeout(r, 600));

  if (opts.mode === 'stop') {
    await adapter.stop(sessionId);
  } else if (opts.mode === 'timeout') {
    // 超时路径：mock agent 挂起 permission 时**不发任何 session/update**，
    // 所以 adapter 的空闲计时器会自然到期 → 走 `handleTimeout`。
    // 这里等它自己超时（timeoutMs 给短一点）。
  }

  const exitCode = await adapter.waitForExit(sessionId);

  return { events: readEvents(sliceId), exitCode };
}

describe('挂起请求的登记册（ADR-141）', () => {
  it('取下就移走 —— 天然幂等', () => {
    const reg = new PendingPermissionRegistry();
    reg.add({ requestId: 'r1', options: [], tool: 'Write', path: null });
    assert.equal(reg.size, 1);

    const first = reg.take('r1');
    assert.ok(first, '第一次取得到');
    assert.equal(reg.size, 0, '取下就移走了');

    const second = reg.take('r1');
    assert.equal(second, undefined, '第二次取不到 —— 不会重复结算');
  });

  it('drain 取走全部并清空', () => {
    const reg = new PendingPermissionRegistry();
    reg.add({ requestId: 'r1', options: [], tool: 'a', path: null });
    reg.add({ requestId: 'r2', options: [], tool: 'b', path: null });

    assert.equal(reg.drain().length, 2);
    assert.equal(reg.size, 0);
    assert.equal(reg.drain().length, 0, '第二次 drain 拿不到任何东西');
  });
});

describe('归属权：恰好一条事件（ADR-141 验收 7）', () => {
  it('判定方先抢到 → 终止方抢不到', () => {
    const reg = new PendingPermissionRegistry();
    reg.add({ requestId: 'r1', options: [], tool: 'a', path: null });

    assert.equal(reg.resolve('r1', 'judge'), true, '判定方抢到');
    assert.equal(reg.resolve('r1', 'termination'), false, '终止方抢不到');
    assert.equal(reg.ownerOf('r1'), 'judge');
  });

  it('终止方先抢到 → 判定方抢不到', () => {
    const reg = new PendingPermissionRegistry();
    reg.add({ requestId: 'r1', options: [], tool: 'a', path: null });

    assert.equal(reg.resolve('r1', 'termination'), true, '终止方抢到');
    assert.equal(reg.resolve('r1', 'judge'), false, '判定方抢不到');
    assert.equal(reg.ownerOf('r1'), 'termination');
  });

  it('判定方抢到归属权时，请求**仍在登记册里**（终止方能结算到它）', () => {
    // 这条是 ADR-141 的核心 —— 之前的实现是「判定方先取走」，
    // 结果终止路径 drain 不到 → 没有事件 → 追溯链断链。
    const reg = new PendingPermissionRegistry();
    reg.add({ requestId: 'r1', options: [], tool: 'a', path: null });

    reg.resolve('r1', 'judge');
    assert.equal(reg.size, 1, '抢归属权不移走请求');
  });

  it('drain 之后归属权**留着**（判定方醒来能知道已被结算过）', () => {
    const reg = new PendingPermissionRegistry();
    reg.add({ requestId: 'r1', options: [], tool: 'a', path: null });

    // 终止方先 drain（拿到待结算的请求），再抢归属权。
    const drained = reg.drain();
    assert.equal(drained.length, 1, 'drain 拿到请求');
    assert.equal(reg.size, 0, 'drain 清空登记册');

    assert.equal(reg.resolve('r1', 'termination'), true, '终止方抢到');
    assert.equal(
      reg.ownerOf('r1'),
      'termination',
      '归属权留着 —— 判定方醒来后知道「别再写事件了」',
    );
    assert.equal(reg.resolve('r1', 'judge'), false, '判定方之后抢不到');
  });
});

describe('结算只允许「拒绝」（ADR-141 验收 4）', () => {
  it('有 reject_once → 选它', () => {
    const id = selectRejectOptionForSettlement([
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'allow-always', kind: 'allow_always' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ]);
    assert.equal(id, 'reject-once');
  });

  it('只有 reject_always → 选它', () => {
    const id = selectRejectOptionForSettlement([
      { optionId: 'allow-always', kind: 'allow_always' },
      { optionId: 'reject-always', kind: 'reject_always' },
    ]);
    assert.equal(id, 'reject-always');
  });

  it('只有 allow 选项 → 找不到拒绝项（**绝不回 allow**）', () => {
    const id = selectRejectOptionForSettlement([
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'allow-always', kind: 'allow_always' },
    ]);
    assert.equal(id, null, '没有拒绝项时必须是 null，不能回 allow');
  });

  it('没有拒绝项 → 回 cancelled（**绝不是 allow_always**）', () => {
    const outcome = renderSettlementOutcome([
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'allow-always', kind: 'allow_always' },
    ]);
    assert.deepEqual(outcome, { outcome: { outcome: 'cancelled' } });
  });

  it('渲染出的答复永远不含 allow_always', () => {
    const options = [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'allow-always', kind: 'allow_always' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ];
    const outcome = renderSettlementOutcome(options);
    const text = JSON.stringify(outcome);
    assert.doesNotMatch(text, /allow-always/, '结算绝不能回 allow_always');
    assert.doesNotMatch(text, /allow-once/, '结算绝不能回 allow_once');
  });

  it('kind 不认得但 optionId 像拒绝 → 选它（fail closed）', () => {
    const id = selectRejectOptionForSettlement([
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'deny-this', kind: 'some_future_kind' },
    ]);
    assert.equal(id, 'deny-this');
  });
});

describe('终止路径的挂起请求结算（ADR-141 验收 1 / 2 / 3 / 5）', () => {
  it('进程退出时挂起的请求被回绝，且写了 acp:terminated 事件', async () => {
    const { events } = await runAndTerminate({ mode: 'exit', sliceId: 'slice-exit' });

    const terminated = events.filter(
      (e) =>
        e.type === 'policy.decision' &&
        (e.payload as Record<string, unknown>).basis === TERMINATED_BASIS,
    );

    assert.equal(
      terminated.length,
      1,
      `挂起的 permission 请求必须被结算成一条事件，实际事件：${JSON.stringify(events)}`,
    );

    const payload = terminated[0].payload as Record<string, unknown>;
    assert.equal(payload.decision, 'deny', '这次写入没有被允许');
    assert.equal(payload.basis, 'acp:terminated');
    assert.match(
      String(payload.reason),
      /terminated/,
      '事件要说明「终止时没判成」',
    );
  });

  it('终止原因写进事件负载（ADR-141 验收 5）', async () => {
    const { events } = await runAndTerminate({ mode: 'exit', sliceId: 'slice-reason' });

    const terminated = events.filter(
      (e) =>
        e.type === 'policy.decision' &&
        (e.payload as Record<string, unknown>).basis === TERMINATED_BASIS,
    );
    assert.equal(terminated.length, 1);

    const reason = String((terminated[0].payload as Record<string, unknown>).reason);
    assert.match(reason, /exit|timeout|killed/, '终止原因要能看出来');
  });

  it('结算只写一条事件（不重复）（ADR-141 验收 7）', async () => {
    const { events } = await runAndTerminate({ mode: 'exit', sliceId: 'slice-once' });

    const terminated = events.filter(
      (e) =>
        e.type === 'policy.decision' &&
        (e.payload as Record<string, unknown>).basis === TERMINATED_BASIS,
    );
    assert.equal(
      terminated.length,
      1,
      '退出路径可能被走多次（exit 事件 + 停止），但事件只能有一条',
    );
  });

  it('人工停止路径同样结算', async () => {
    const { events } = await runAndTerminate({ mode: 'stop', sliceId: 'slice-stop' });

    const terminated = events.filter(
      (e) =>
        e.type === 'policy.decision' &&
        (e.payload as Record<string, unknown>).basis === TERMINATED_BASIS,
    );
    assert.equal(
      terminated.length,
      1,
      `人工停止也必须结算，实际事件：${JSON.stringify(events)}`,
    );

    const reason = String((terminated[0].payload as Record<string, unknown>).reason);
    assert.match(reason, /killed/, '停止路径的原因要写出来');
  });

  it('空转超时路径同样结算（ADR-141 验收 2）', async () => {
    // 超时用很短的空闲超时 —— mock agent 挂起 permission 时不发任何
    // session/update，所以空闲计时器会自然到期 → 走 `handleTimeout`。
    const { events } = await runAndTerminate({
      mode: 'timeout',
      sliceId: 'slice-timeout',
      timeoutMs: 1_200,
      blockFor: 10_000,
    });

    const terminated = events.filter(
      (e) =>
        e.type === 'policy.decision' &&
        (e.payload as Record<string, unknown>).basis === TERMINATED_BASIS,
    );
    assert.equal(
      terminated.length,
      1,
      `超时也必须结算，实际事件：${JSON.stringify(events)}`,
    );

    const reason = String((terminated[0].payload as Record<string, unknown>).reason);
    assert.match(reason, /timeout/, '超时路径的原因要写出来');
  });

  it('harness 记真实来源（不硬编码成某一家）', async () => {
    const { events } = await runAndTerminate({ mode: 'stop', sliceId: 'slice-harness' });

    const terminated = events.filter(
      (e) =>
        e.type === 'policy.decision' &&
        (e.payload as Record<string, unknown>).basis === TERMINATED_BASIS,
    );
    assert.equal(terminated.length, 1);

    const payload = terminated[0].payload as Record<string, unknown>;
    assert.match(String(payload.harness), /^acp:/);
    assert.equal(payload.sliceId, 'slice-harness');
    assert.equal(payload.runId, 'run-141');
  });
});

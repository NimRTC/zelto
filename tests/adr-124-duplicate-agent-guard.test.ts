// ADR-124 修法二 · 重复 agent 守卫：stale 且无 pid 不得升级成「拒绝起跑」
//
// 病灶（实测 nimrtc-v14 `v4-d5-audio-dtx`，2026-11-26）：
//
//   监督进程无收尾死亡 → 任务文件停在 running（有 lastActivityAt、
//   有 supervisorPid，**没有 pid**）；会话文件被覆盖写成 0 字节。
//
//   旧口径（`readSliceLivenessRecord` 会话优先）读会话目录 → null →
//   退到任务目录 → 看到那条 running 记录 → 判 `active` → 拒绝起跑。
//   人想重跑却被弹回去，而且每次都写一条 `run.aborted` ——
//   「人想重跑」和「agent 已死」被混成同一种痕迹。
//
// 新口径（ADR-124 修法二）：
//   - `active`                        → 拒绝
//   - `stale` **且有** pid            → 拒绝（可能只是长时间构建，不下死手）
//   - `stale` **且无** pid            → 放行 + 收尾那条残留记录
//   - `dead`                          → 放行
//
// C1/C3：只读文件、纯计算；状态只落在文件里。

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  judgeDuplicateAgent,
  readRunningRecordFiles,
  closeRunningRecord,
} from '../src/cli/commands/orphan-records.js';

const ROOT = join(tmpdir(), `zelto-adr124-m2-${Date.now()}`);
const SESSIONS = join(ROOT, '.zelto', 'sessions');
const TASKS = join(ROOT, '.zelto', 'tasks');

const TWO_HOURS = 2 * 3600_000;

before(async () => {
  await mkdir(SESSIONS, { recursive: true });
  await mkdir(TASKS, { recursive: true });
});

after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const dir of [SESSIONS, TASKS]) {
    const { readdir } = await import('node:fs/promises');
    for (const f of await readdir(dir)) {
      await rm(join(dir, f), { force: true });
    }
  }
});

async function writeSession(id: string, data: Record<string, unknown>) {
  await writeFile(join(SESSIONS, `claude-agent-${id}.json`), JSON.stringify(data), 'utf-8');
}

async function writeTask(id: string, data: Record<string, unknown>) {
  await writeFile(join(TASKS, `task-${id}.json`), JSON.stringify(data), 'utf-8');
}

/** 一条「没有 pid 可查、很久没动静」的 running 记录（d5 的现场形状）。 */
function staleNoPidRecord(id: string) {
  return {
    sliceId: id,
    status: 'running',
    startedAt: new Date(Date.now() - TWO_HOURS).toISOString(),
    lastActivityAt: new Date(Date.now() - TWO_HOURS).toISOString(),
    supervisorPid: 999999,
  };
}

describe('ADR-124 修法二 · 守卫判据', () => {
  it('stale 且无 pid → 放行（不再是「拒绝起跑」）', async () => {
    await writeTask('d5-shape', staleNoPidRecord('d5-shape'));

    const v = await judgeDuplicateAgent(ROOT, 'd5-shape');
    assert.equal(v.decision, 'pass', '没有 pid 可查的 stale 记录不得挡住重跑');
    assert.ok(v.decision === 'pass' && v.staleNoPid, '放行时必须带出那条残留记录');
  });

  it('stale 且无 pid → 放行时把那条记录收尾成 failed（现场不删）', async () => {
    await writeTask('d5-close', staleNoPidRecord('d5-close'));

    await judgeDuplicateAgent(ROOT, 'd5-close');

    const raw = JSON.parse(readFileSync(join(TASKS, 'task-d5-close.json'), 'utf-8')) as Record<string, unknown>;
    assert.equal(raw.status, 'failed', '残留记录必须被收尾，否则下一轮守卫又撞上它');
    assert.ok(raw.completedAt, '收尾要写时间戳');
    assert.ok(String(raw.reason).includes('没有 pid 可查'), '收尾理由要说清为什么');
    // 文件本身还在 —— 现场是证据（C4）
    assert.ok(existsSync(join(TASKS, 'task-d5-close.json')), '不得删文件');
  });

  it('stale 且**有** pid → 仍然拒绝（不下死手）', async () => {
    await writeTask('has-pid', {
      sliceId: 'has-pid',
      status: 'running',
      // 用本进程 pid —— 它**真的还活着**，只是很久没动静。
      // 这正是「长时间构建」的样子：不能当尸体。
      pid: process.pid,
      lastActivityAt: new Date(Date.now() - TWO_HOURS).toISOString(),
    });

    const v = await judgeDuplicateAgent(ROOT, 'has-pid');
    assert.equal(v.decision, 'blocked', '有 pid 可查 = 判活确定，不能当尸体');
    assert.ok(v.decision === 'blocked' && v.reason.includes('已经有一个 agent 在运行'));
  });

  it('有 pid 且进程已经不在 → 判 dead → 放行（死透了的现场不挡路）', async () => {
    await writeTask('dead-pid', {
      sliceId: 'dead-pid',
      status: 'running',
      pid: 4242, // 几乎不可能还活着
      lastActivityAt: new Date(Date.now() - TWO_HOURS).toISOString(),
    });

    const v = await judgeDuplicateAgent(ROOT, 'dead-pid');
    assert.equal(v.decision, 'pass', '进程确实没了 —— 放行，让人能重跑');
  });

  it('有 pid 的记录**不被**收尾（拒绝时现场原样保留）', async () => {
    await writeTask('keep-pid', {
      sliceId: 'keep-pid',
      status: 'running',
      pid: process.pid,
      lastActivityAt: new Date(Date.now() - TWO_HOURS).toISOString(),
    });

    await judgeDuplicateAgent(ROOT, 'keep-pid');

    const raw = JSON.parse(readFileSync(join(TASKS, 'task-keep-pid.json'), 'utf-8')) as Record<string, unknown>;
    assert.equal(raw.status, 'running', '拒绝时不得动现场 —— 它可能是活着的 agent');
  });

  it('一条 active 记录 → 拒绝（哪怕同目录还有别的 stale 无 pid 记录）', async () => {
    await writeSession('mixed-active', {
      sliceId: 'mixed-active', status: 'running', pid: process.pid,
      lastActivityAt: new Date().toISOString(),
    });
    await writeTask('mixed-active', staleNoPidRecord('mixed-active'));

    const v = await judgeDuplicateAgent(ROOT, 'mixed-active');
    assert.equal(v.decision, 'blocked', '任何一条活着就不能起第二个');
  });

  it('两个目录合并判定：会话文件 0 字节 + 任务文件无 pid → 放行', async () => {
    // d5 的真实形状：会话文件被覆盖写成 0 字节
    await writeFile(join(SESSIONS, 'claude-agent-d5-two-dirs.json'), '', 'utf-8');
    await writeTask('d5-two-dirs', staleNoPidRecord('d5-two-dirs'));

    const v = await judgeDuplicateAgent(ROOT, 'd5-two-dirs');
    assert.equal(v.decision, 'pass', '会话文件坏掉不该让人重跑不了');
  });

  it('没有任何 running 记录 → 放行（没人管这一轮）', async () => {
    await writeSession('only-completed', {
      sliceId: 'only-completed', status: 'completed', exitCode: 0,
    });

    const v = await judgeDuplicateAgent(ROOT, 'only-completed');
    assert.equal(v.decision, 'pass');
  });

  it('别的切片的记录不算数（按 sliceId 过滤）', async () => {
    await writeTask('other-slice', staleNoPidRecord('other-slice'));

    const v = await judgeDuplicateAgent(ROOT, 'unrelated-slice');
    assert.equal(v.decision, 'pass');
    assert.ok(v.decision === 'pass' && v.staleNoPid === null, '别人的残留记录不该被收尾');
  });
});

describe('ADR-124 修法二 · 记录读取与收尾', () => {
  it('readRunningRecordFiles 合并两个目录，且只收 running', async () => {
    await writeSession('both', { sliceId: 'both', status: 'running', pid: 1 });
    await writeTask('both', { sliceId: 'both', status: 'running', pid: 2 });
    await writeSession('both-done', { sliceId: 'both', status: 'completed' });

    const recs = readRunningRecordFiles(ROOT, 'both');
    assert.equal(recs.length, 2, '两个目录各一条');
    assert.deepEqual(
      recs.map((r) => r.kind).sort(),
      ['session', 'task'],
    );
    assert.ok(recs.every((r) => r.hasPid));
  });

  it('onlyNoPid 只留没有 pid 的记录', async () => {
    await writeSession('mix-pid', { sliceId: 'mix-pid', status: 'running', pid: 1 });
    await writeTask('mix-pid', staleNoPidRecord('mix-pid'));

    const recs = readRunningRecordFiles(ROOT, 'mix-pid', { onlyNoPid: true });
    assert.equal(recs.length, 1);
    assert.equal(recs[0].kind, 'task');
    assert.equal(recs[0].hasPid, false);
  });

  it('坏文件（0 字节 / 非法 JSON）跳过，不当成「有人管」', async () => {
    await writeFile(join(SESSIONS, 'claude-agent-broken.json'), '', 'utf-8');
    await writeFile(join(SESSIONS, 'claude-agent-broken2.json'), '{not json', 'utf-8');

    const recs = readRunningRecordFiles(ROOT, 'broken');
    assert.equal(recs.length, 0);
  });

  it('closeRunningRecord 只改状态字段，其他字段原样保留', async () => {
    await writeTask('preserve', {
      sliceId: 'preserve', status: 'running', pid: 42,
      exitCode: null, output: ['第一行'],
    });

    const recs = readRunningRecordFiles(ROOT, 'preserve');
    assert.equal(recs.length, 1);
    assert.equal(closeRunningRecord(recs[0], '收尾原因'), true);

    const raw = JSON.parse(readFileSync(join(TASKS, 'task-preserve.json'), 'utf-8')) as Record<string, unknown>;
    assert.equal(raw.status, 'failed');
    assert.equal(raw.reason, '收尾原因');
    assert.equal(raw.pid, 42, 'pid 要留着 —— 它是现场的证据');
    assert.deepEqual(raw.output, ['第一行']);
  });

  it('坏文件收尾返回 false（不抛）', async () => {
    const rec = {
      kind: 'session' as const,
      path: join(SESSIONS, 'claude-agent-nope.json'),
      file: 'claude-agent-nope.json',
      record: { sliceId: 'nope' },
      hasPid: false,
    };
    assert.equal(closeRunningRecord(rec, 'x'), false);
  });
});

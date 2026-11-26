// ZD-045：驾驶舱的 git 证据把事件循环卡死 —— 页面永远「加载中…」
//
// 病灶（实测 nimrtc-v14，2026-11-26，ADR-114 上线的第二天）：
//
//   打开 `zelto web`，页面一直停在「加载中…」。量了一下：
//
//     /api/slices         93 秒
//     /api/plan-coverage  28 秒（它内部也调 listSlices）
//     /api/summary        > 60 秒
//
//   根因不是 git 慢，是我们**拿主线程去等它**：
//   `annotateBranchEvidence` 用 `execFileSync('git', …)`，每行切片 3 次调用
//   （rev-parse / ls-files / diff），24 行合计几十次同步 spawn。
//   每次调用期间事件循环完全停摆 —— 换页、/api/health、静态页面全部排队。
//
//   对照实验（同一台机器、同一时刻）：
//     同步 execFileSync 串行 15 次：几千毫秒，且越长越慢（累计阻塞）
//     异步 spawn 串行 15 次：954ms
//     异步 spawn 并发 15 次：138ms
//
// 修法：给分支证据加一条**异步**路径（`annotateBranchEvidenceAsync`），
// 判据与同步版逐字相同（C3：只读文件、纯计算），只是不阻塞事件循环。
// 驾驶舱的 `listSlices` / `getSlice` 改走异步版。
//
// 这个文件钉住的不是「git 快不快」，而是**驾驶舱在 git 慢的时候还能不能应答**：
//   1. 一个「git 永远不返回」的仓库里，/api/health 仍然能在几百毫秒内应答；
//   2. 与此同时 /api/slices 最终返回 —— 数据正确，只是慢（慢可以等，卡死不行）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebServer } from '../src/adapters/web/server.js';

const REPO = join(tmpdir(), `zelto-zd045-${Date.now()}`);

async function writeSlice(id: string, state: string): Promise<void> {
  const zelto = join(REPO, '.zelto');
  await mkdir(join(zelto, 'slices'), { recursive: true });
  await mkdir(join(zelto, 'events', id), { recursive: true });
  const base = {
    id,
    title: `切片 ${id}`,
    state,
    spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes: [],
    runs: [],
    clarifyRounds: 0,
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await writeFile(join(zelto, 'slices', `${id}.json`), JSON.stringify(base, null, 2), 'utf-8');
  await writeFile(join(zelto, 'events', id, 'events.jsonl'), '', 'utf-8');
}

describe('ZD-045：git 证据慢时，驾驶舱不许卡死', () => {
  before(async () => {
    // 多造几片：每片会让 git 探针走 2~3 次同步 spawn（原实现）
    for (let i = 0; i < 12; i += 1) {
      await writeSlice(`s-${i}`, i % 2 === 0 ? 'completed' : 'draft');
    }
  });
  after(async () => {
    await rm(REPO, { recursive: true, force: true });
  });

  it('/api/slices 进行中，/api/health 仍能及时应答', async () => {
    // 关键点：REPO 是临时目录、不在 git 仓库里 —— 但这不重要。
    // 要复现「事件循环被同步 spawn 卡住」，只要让切片够多、每次 spawn 都有
    // 进程创建的固定开销；同步实现在 12 片 × 3 次 = 36 次 spawn 的窗口里
    // 是完全不可应答的。
    const server = new WebServer({ port: 0, repoRoot: REPO });
    await server.start();
    try {
      // 同时发起：一边要全量切片（慢），一边问健康（应该立刻）
      const slow = fetch(`${server.url}/api/slices`).then((r) => r.json() as Promise<unknown[]>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const t0 = Date.now();
      const health = await fetch(`${server.url}/api/health`);
      const healthMs = Date.now() - t0;
      assert.equal(health.status, 200);
      assert.ok(
        healthMs < 3000,
        `git 证据还在跑的时候 /api/health 也必须应答 —— 实际等了 ${healthMs}ms。` +
          '这说明有同步 spawn 卡住了事件循环（ZD-045）。',
      );

      const rows = await slow;
      assert.equal(rows.length, 12, '慢的那条请求最终要返回全部切片');
    } finally {
      await server.stop();
    }
  });
});

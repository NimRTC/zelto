// 驾驶舱性能守卫 —— 防止「同一件事问很多遍」回潮
//
// ── 为什么要有这个 ────────────────────────────────────────────────────
//
// 2026-11-27 实测本仓库（149 片、214 份事件流、CPU 满载）：
//
//   首屏 **52 秒白屏**。拆开看：
//
//   ① `/api/plan-coverage` 一次 spawn **63 个 git 进程**、68 秒。
//      其中 25 次 `rev-parse --is-inside-work-tree` 问的是**同一个目录**。
//   ② `/api/summary` 读事件流 **248 次**，而只有 149 片
//      —— 每片读两遍（判基线一遍、算成本一遍）。
//   ③ 首屏三个请求**串行**等：3.2s + 42s + 7s。
//   ④ 轮询**自我拥塞**：每轮要等三段，5 秒的定时器却在上一轮
//      没跑完时就又发一轮 —— 请求越堆越多。
//
// 这些都不是「机器慢」，是**同一份事实被反复问**。
//
// ── 为什么用「读源码断言」而不是跑端到端 ──────────────────────────────
//
// 端到端测这些要真的 clone 一个仓库、真的开 git 进程 —— 慢且不稳
//（本机 git 启动 30–200ms 且会抖，测出来的数字会飘）。
//
// 真正要守的是**结构**：同一轮判定里同一个 git 事实只问一次、
// 同一片的事件流只读一次、三个请求并发发、轮询不重叠。
// 这些都能从源码上看出来 —— 而且**比端到端更快、更不会假绿**。
//
// 但只看源码有个风险：断言写错了也会绿。所以每条断言都指向
// 一段**具体的、可读的**代码形状，不是脆弱的字符串匹配。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function readSrc(...parts: string[]): string {
  let dir = here;
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(join(dir, 'package.json'));
      return readFileSync(join(dir, 'src', ...parts), 'utf-8');
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('找不到仓库根');
}

const APP_JS = readSrc('adapters', 'web', 'frontend', 'app.js');
const API_TS = readSrc('adapters', 'web', 'api.ts');
const ARTIFACT_TS = readSrc('core', 'project', 'artifact-evidence.ts');
const COLLECTOR_TS = readSrc('core', 'budget', 'collector.ts');

/** 去掉注释，免得注释里的代码形状被误当成真代码。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('驾驶舱性能守卫', () => {
  describe('① 一轮判定内的 git 事实复用', () => {
    it('ArtifactGitMemo 存在，且按 (cwd, args) 备忘', () => {
      assert.ok(
        ARTIFACT_TS.includes('class ArtifactGitMemo'),
        '必须有一个「一轮判定内」的 git 备忘 —— 否则同一目录会被问几十遍',
      );
      assert.ok(
        /run\(\s*cwd[^)]*args[^)]*\)[\s\S]{0,600}?this\.seen\.get\(/.test(ARTIFACT_TS),
        '备忘必须按 (cwd, args) 查 —— 只按 args 查会把不同目录搞混',
      );
    });

    it('探针的每个 git 调用都走备忘，不再直接 execAsync', () => {
      const body = stripComments(ARTIFACT_TS);
      // 探针实现体里每个 git 调用都要经由 memo.run ——
      // 「没有备忘时直接跑」那条兜底分支是允许的（探针可以单独用），
      // 但探针**内部**不许有绕过备忘的直接调用。
      const probeStart = body.indexOf('export const defaultArtifactProbe');
      assert.ok(probeStart > 0, '找不到 defaultArtifactProbe');
      const probeBody = body.slice(probeStart);

      // 每个探针方法都要先把 execAsync 包成 run，再只调 run
      const runDefs = probeBody.match(/const run = memo/g) ?? [];
      assert.ok(
        runDefs.length >= 2,
        `探针里只有 ${runDefs.length} 处「包成 run」—— findSliceCommits 与 findSliceCommitsOnAncestors 都得有`,
      );
      // 包好之后，探针**内部**不许有绕过备忘的直接调用 ——
      // 唯一允许的是「没有备忘时的兜底」那一条（探针可以被单独用）。
      const fallback = probeBody.match(
        /:\s*\(args:\s*string\[\],\s*budgetMs:\s*number\)\s*=>\s*execAsync\(/g,
      ) ?? [];
      const direct = probeBody.match(/execAsync\(/g) ?? [];
      assert.equal(
        direct.length,
        fallback.length,
        `探针里有 ${direct.length} 处 execAsync，只有 ${fallback.length} 处是「无备忘时的兜底」—— 其余都是绕过备忘的直接调用`,
      );
    });

    it('备忘只在一轮判定内有效（不是跨请求的全局缓存）', () => {
      const api = stripComments(API_TS);
      assert.ok(
        /new ArtifactGitMemo\(\)/.test(api),
        '备忘必须由调用方按轮创建 —— 跨轮复用会让「分支状态变了」看不到',
      );
      // 不能出现模块级的单例备忘
      assert.ok(
        !/^(const|let|var)\s+\w*memo\w*\s*=\s*new ArtifactGitMemo/m.test(api),
        '备忘不能是模块级单例 —— 那就变成跨请求的过期事实缓存了',
      );
    });
  });

  describe('② 一轮判定内的事件流复用', () => {
    it('getSpentDetail 接受已读好的事件流', () => {
      assert.ok(
        /getSpentDetail\(\s*sliceId[^)]*preloaded/.test(COLLECTOR_TS),
        'getSpentDetail 必须能接收「已经读好的事件流」—— 否则同一片还是读两遍',
      );
      assert.ok(
        /preloaded\s*\?\?\s*\(await this\.events\.read\(sliceId\)\)/.test(COLLECTOR_TS),
        '没给 preloaded 时才读文件 —— 给了就绝不能再读一遍',
      );
    });

    it('toSummary 只读一次事件流，并把同一份传给基线判定与成本判定', () => {
      const api = stripComments(API_TS);
      const toSummaryStart = api.indexOf('async function toSummary');
      assert.ok(toSummaryStart > 0, '找不到 toSummary');
      const body = api.slice(toSummaryStart, api.indexOf('\nfunction ', toSummaryStart + 10));

      const reads = body.match(/await loadEvents\(\)/g) ?? [];
      assert.equal(
        reads.length,
        1,
        `toSummary 里读事件流 ${reads.length} 次 —— 必须只读一次（实测 248 次 → 149 次）`,
      );
      assert.ok(
        /getSpentDetail\([^)]*events/.test(body),
        '成本判定必须用「同一份」事件流，而不是重新读',
      );
    });
  });

  describe('③ 首屏三个请求并发', () => {
    it('viewOverview 用 Promise.all 并发取三份数据', () => {
      const app = stripComments(APP_JS);
      const start = app.indexOf('async function viewOverview');
      assert.ok(start > 0, '找不到 viewOverview');
      const body = app.slice(start, app.indexOf('\nasync function ', start + 10));

      assert.ok(
        /Promise\.all\(\s*\[/.test(body),
        'viewOverview 必须用 Promise.all —— 串行 await 会让首屏耗时变成三段之和',
      );
      // 三份数据都得在同一个 Promise.all 里
      const all = body.match(/Promise\.all\(\s*\[([\s\S]*?)\]\s*\)/);
      assert.ok(all, '找不到 Promise.all 的数组');
      // 概况走共享的 getSummary（它内部才是真正发请求的那一处），
      // 另两个直接打各自的端点。
      assert.ok(
        all[1].includes('getSummary('),
        '概况必须在同一个 Promise.all 里（走共享的 getSummary）—— 否则还是串行',
      );
      for (const ep of ['/api/plan-coverage', '/api/pending-actions']) {
        assert.ok(
          all[1].includes(ep),
          `${ep} 必须在同一个 Promise.all 里 —— 否则还是串行`,
        );
      }
    });
  });

  describe('④ 轮询不自我拥塞', () => {
    it('有「在飞」标记，且上一轮没跑完就不发起新一轮', () => {
      const app = stripComments(APP_JS);
      assert.ok(
        /let pollInFlight = false/.test(app),
        '必须有一个「轮询在飞」标记',
      );
      const timer = app.slice(app.indexOf('pollTimer = setInterval'));
      assert.ok(
        /if \(pollInFlight\) return;/.test(timer),
        '上一轮没跑完必须跳过这一轮 —— 否则请求越堆越多（自我拥塞）',
      );
    });

    it('概况只取一次，两处渲染共用', () => {
      const app = stripComments(APP_JS);
      assert.ok(
        /function getSummary/.test(app),
        '必须有一个共享的取数函数',
      );
      // 直接取概况的地方只能是 getSummary 内部那一个
      const direct = app.match(/apiGet\('\/api\/summary'\)/g) ?? [];
      assert.equal(
        direct.length,
        1,
        `直接取概况的地方有 ${direct.length} 处 —— 只该剩 getSummary 内部那一处（一轮轮询取两次）`,
      );
      // 两处渲染都要走共享的那一个
      assert.ok(
        /const \[s, coverage, pending\] = await Promise\.all\(\s*\[[\s\S]*?getSummary\(/.test(app),
        '总览的三个请求里，概况必须走 getSummary（共享）',
      );
      assert.ok(
        /const s = await getSummary\(/.test(app),
        '顶栏那行字也必须走 getSummary（共享）',
      );
    });
  });
});

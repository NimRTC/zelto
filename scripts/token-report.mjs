#!/usr/bin/env node
// zelto 开销对比 —— 「用 zelto 做」比「直接用 agent 做」多花多少 token。
//
// 用途：只读的分析工具。它读事件流，不写任何文件、不调模型、不触网，
// 所以放在 `scripts/` 里随仓库走，但不属于产品运行时的一部分。
//
// 读的是 `<root>/.zelto/events/<sliceId>/events.jsonl` 里的几类账：
//   - budget.spent (source=agent) —— agent 会话的真实花费与 token（每次成功会话一条）
//   - llm.called                    —— 规划期 LLM 草稿的 token
//   - budget.spent (reason=llm:*)  —— 规划期 LLM 草稿的钱
//   - run.started / run.finished / run.aborted —— 会话轮次，用来算重试放大
//   - <root>/.zelto/<sliceId>-bundle.json —— zelto 让 agent 先读的固定说明
//
// 四个必须先说清的事实（不然结论会骗人）：
//
//   1. **失败重试烧的 token 不在账上。** `settleRunCost` 只在 exitCode===0 的成功
//      路径上调用，失败会话从来不记账。所以事件里的 agent 用量 = 成功会话的用量，
//      失败那几次是「账外支出」。脚本用「已记账会话的平均 token」去估这部分，
//      并在输出里明确标成估算。
//
//   2. **旧格式事件里 agent 会话可能完全没记账。** ADR-035 落地之前跑的切片，
//      事件里只有 run.finished，token 与花费都拿不到。这类会话按「花了钱但没测到」
//      单独统计（`costOnlySessions`），不混进 token 账里 —— 没测到不等于零。
//
//   3. **「直接用」基线是个假设。** 基线 = 每片跑 1 次成功会话、不读 bundle、
//      不用规划期 LLM、人不再手动重试。你手动重试几次，基线就再乘几倍。
//
//   4. **token 估算只用于 bundle 指令**（agent 自己的用量是 SDK 上报的实测值）。
//      bundle 的 token 用字符启发式估：中文约 1.5 字/token，其余约 4 字/token。
//
// 用法：
//   node scripts/token-report.mjs [项目根目录] [--json] [--top N] [--no-estimate]
//
//   项目根目录默认当前工作目录。示例：
//   node scripts/token-report.mjs D:/some/project --top 15
//   node scripts/token-report.mjs --json > report.json

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ─── 参数 ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const topIdx = args.indexOf('--top');
const topArg = topIdx >= 0 ? args[topIdx + 1] : undefined;
const topN = topArg && !topArg.startsWith('-') ? Number(topArg) : 10;

// 「--top N」的 N 不是位置参数，不能被当成项目根目录
const positional = args.filter(
  (a, i) => !a.startsWith('-') && !(topIdx >= 0 && i === topIdx + 1),
);
const root = positional[0] ? positional[0] : process.cwd();

const asJson = args.includes('--json');
const estimate = !args.includes('--no-estimate');

if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      'zelto 开销对比 —— 只读事件流，算「用 zelto」相对「直接用 agent」的额外开销。',
      '',
      '用法：node scripts/token-report.mjs [项目根目录] [选项]',
      '',
      '选项：',
      '  --json          输出 JSON（便于接入别处分析）',
      '  --top N         明细表显示前 N 片（默认 10）',
      '  --no-estimate   不估算账外（失败重试）的 token 与花费',
      '  --help, -h      显示这段说明',
      '',
      '项目根目录默认当前工作目录；脚本会读 <root>/.zelto/ 下的事件流与 bundle。',
    ].join('\n'),
  );
  process.exit(0);
}

// ─── 工具 ────────────────────────────────────────────────────────────────

/**
 * 粗略 token 估算：中文 ~1.5 字/token，其余 ~4 字/token。只用于 bundle 指令。
 */
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    }
  }
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}

function fmtTokens(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtCost(n) {
  if (n === null || n === undefined) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(2)}`;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 解析 JSON 文件，去掉 UTF-8 BOM。
 *
 * Windows 上用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 写出的文件带 BOM，
 * `JSON.parse` 会直接抛 "Unexpected token '﻿'"。事件流是 append-only 的，
 * 里面混进一个坏行不该让整份账消失，所以这里统一先剥 BOM 再解析。
 */
function parseJsonFile(path) {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

// ─── 读事件流 ────────────────────────────────────────────────────────────

const eventsDir = join(root, '.zelto', 'events');
const perSlice = new Map();

function sliceOf(id) {
  if (!perSlice.has(id)) {
    perSlice.set(id, {
      id,
      agentSessions: 0,
      agentTokens: 0,
      agentInput: 0,
      agentOutput: 0,
      agentCost: 0,
      // 旧格式切片：只有 run.finished 带 costUsd，没有 budget.spent。
      // 这些会话「花了钱但 token 没测到」，单独记，不混进 token 账。
      costOnlySessions: 0,
      costOnlyUsd: 0,
      llmTokens: 0,
      llmInput: 0,
      llmOutput: 0,
      llmCost: 0,
      llmCalls: 0,
      runsStarted: 0,
      runsFinished: 0,
      runsAborted: 0,
      finishedCostUsd: [],
    });
  }
  return perSlice.get(id);
}

if (!existsSync(eventsDir)) {
  console.error(`找不到事件目录：${eventsDir}`);
  console.error('这个项目没有 .zelto/events —— 没用过 zelto 的切片流程，或状态目录被清掉了。');
  process.exit(1);
}

let eventLines = 0;
let malformed = 0;
for (const entry of readdirSync(eventsDir)) {
  const file = join(eventsDir, entry, 'events.jsonl');
  if (!existsSync(file) || !statSync(file).isFile()) continue;
  const lines = readFileSync(file, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed.charCodeAt(0) === 0xfeff ? trimmed.slice(1) : trimmed);
    } catch {
      malformed++;
      continue;
    }
    eventLines++;
    const sliceId = ev.slice ?? ev.payload?.sliceId ?? entry;
    const s = sliceOf(sliceId);
    const p = ev.payload ?? {};

    switch (ev.type) {
      case 'run.started':
        s.runsStarted++;
        break;
      case 'run.finished':
        s.runsFinished++;
        if (num(p.costUsd) !== null) s.finishedCostUsd.push(p.costUsd);
        break;
      case 'run.aborted':
        s.runsAborted++;
        break;
      case 'llm.called': {
        // 规划期 LLM 的 token 真源（budget.spent 里只有钱，没有 token）
        const t = num(p.totalTokens);
        const pi = num(p.promptTokens);
        const po = num(p.completionTokens);
        if (t !== null) s.llmTokens += t;
        if (pi !== null) s.llmInput += pi;
        if (po !== null) s.llmOutput += po;
        s.llmCalls++;
        break;
      }
      case 'budget.spent': {
        const amount = num(p.amount);
        if (p.source === 'agent') {
          // agent 会话：钱与 token 都在这一条里
          s.agentSessions++;
          if (amount !== null) s.agentCost += amount;
          const it = num(p.inputTokens);
          const ot = num(p.outputTokens);
          if (it !== null) s.agentInput += it;
          if (ot !== null) s.agentOutput += ot;
          s.agentTokens += (it ?? 0) + (ot ?? 0);
        } else if (typeof p.reason === 'string' && p.reason.startsWith('llm:')) {
          // 规划期 LLM 的钱（与上面那条 llm.called 是同一笔，别重复计 token）
          if (amount !== null) s.llmCost += amount;
        }
        break;
      }
      default:
        break;
    }
  }
}

// 旧格式切片补账：有 run.finished 的花费、但整片没有一条 budget.spent(source=agent)
// —— 说明这片的 agent 会话花了钱，但 token 没被记下来。
for (const s of perSlice.values()) {
  if (s.agentSessions > 0) continue;
  if (s.finishedCostUsd.length === 0) continue;
  s.costOnlySessions = s.finishedCostUsd.length;
  s.costOnlyUsd = s.finishedCostUsd.reduce((a, b) => a + b, 0);
}

// ─── bundle 固定开销 ────────────────────────────────────────────────────
// zelto 让 agent 先读一个 bundle 文件才拿到任务说明。这是 zelto 独有的固定开销，
// 「直接用 agent」时不需要（人直接把规格贴进去）。

const bundleTokens = new Map();
const zeltoDir = join(root, '.zelto');
if (existsSync(zeltoDir)) {
  for (const name of readdirSync(zeltoDir)) {
    if (!name.endsWith('-bundle.json')) continue;
    const id = name.slice(0, -'-bundle.json'.length);
    try {
      const bundle = parseJsonFile(join(zeltoDir, name));
      bundleTokens.set(id, estimateTokens(bundle.instructions ?? ''));
    } catch {
      /* 坏 bundle 忽略 —— 它的 token 估不出来就不估，不猜 */
    }
  }
}

// ─── 汇总与对比 ──────────────────────────────────────────────────────────

const slices = [...perSlice.values()].filter(
  (s) =>
    s.runsStarted > 0 ||
    s.agentSessions > 0 ||
    s.costOnlySessions > 0 ||
    s.llmCalls > 0,
);

let agentTokens = 0;
let agentCost = 0;
let agentSessions = 0;
let costOnlySessions = 0;
let costOnlyUsd = 0;
let llmTokens = 0;
let llmCost = 0;
let llmCalls = 0;
let runsStarted = 0;
let runsAborted = 0;
let bundleTotal = 0;
let bundleMeasuredSlices = 0;

for (const s of slices) {
  agentTokens += s.agentTokens;
  agentCost += s.agentCost;
  agentSessions += s.agentSessions;
  costOnlySessions += s.costOnlySessions;
  costOnlyUsd += s.costOnlyUsd;
  llmTokens += s.llmTokens;
  llmCost += s.llmCost;
  llmCalls += s.llmCalls;
  runsStarted += s.runsStarted;
  runsAborted += s.runsAborted;

  const bt = bundleTokens.get(s.id);
  if (bt !== undefined) {
    // 每次会话都要读一遍 bundle（重试也重读）
    bundleTotal += bt * Math.max(s.runsStarted, s.agentSessions);
    bundleMeasuredSlices++;
  }
}

// 失败会话的估算：用「已记账成功会话的平均 token」当每次失败的代价
const failedSessions = Math.max(0, runsStarted - agentSessions);
const avgTokensPerSession = agentSessions > 0 ? agentTokens / agentSessions : 0;
const costPerToken = agentTokens > 0 ? agentCost / agentTokens : 0;
const failedTokensEst = estimate ? Math.round(failedSessions * avgTokensPerSession) : 0;
const failedCostEst = failedTokensEst * costPerToken;

const zeltoTotalTokens = agentTokens + llmTokens + failedTokensEst;
const zeltoTotalCost = agentCost + llmCost + failedCostEst;

// 直接用基线：每片 1 次成功会话、规格同样要读、但不用读 bundle、没有规划期 LLM、人不手动重试
const directTokens = Math.max(0, agentTokens - bundleTotal);
const directCost = Math.max(0, agentCost - bundleTotal * costPerToken);

const deltaTokens = zeltoTotalTokens - directTokens;
const deltaCost = zeltoTotalCost - directCost;
const deltaPct = directTokens > 0 ? (deltaTokens / directTokens) * 100 : null;

// ─── 输出 ────────────────────────────────────────────────────────────────

if (asJson) {
  console.log(
    JSON.stringify(
      {
        root,
        eventLines,
        malformed,
        slices: slices.length,
        agent: {
          sessions: agentSessions,
          tokens: agentTokens,
          costUsd: agentCost,
          runsStarted,
          failedSessions,
          failedTokensEst,
          failedCostEst,
          costOnlySessions,
          costOnlyUsd,
        },
        planningLlm: { calls: llmCalls, tokens: llmTokens, costUsd: llmCost },
        bundleOverhead: { tokens: bundleTotal, slices: bundleMeasuredSlices },
        comparison: {
          zeltoTotalTokens,
          zeltoTotalCost,
          directTokens,
          directCost,
          deltaTokens,
          deltaCost,
          deltaPct,
          assumptions: [
            '失败会话不记账，其 token 按已记账会话均值估算',
            '基线 = 每片 1 次成功会话、不读 bundle、无规划期 LLM、人不手动重试',
            'bundle token 为字符启发式估算（中文 1.5 字/token，其余 4 字/token）',
            'costOnlySessions = 旧格式切片：花了钱但 token 未记账，不计入 token 账',
          ],
        },
        perSlice: slices.map((s) => ({
          id: s.id,
          runsStarted: s.runsStarted,
          agentSessions: s.agentSessions,
          agentTokens: s.agentTokens,
          agentCost: s.agentCost,
          costOnlySessions: s.costOnlySessions,
          costOnlyUsd: s.costOnlyUsd,
          llmCalls: s.llmCalls,
          llmTokens: s.llmTokens,
          llmCost: s.llmCost,
          bundleTokens: bundleTokens.get(s.id) ?? null,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log('');
console.log(`zelto 开销对比 —— ${root}`);
console.log('='.repeat(72));
console.log(`事件行 ${eventLines} 条（坏行 ${malformed}）｜参与统计的切片 ${slices.length} 片`);

console.log('');
console.log('【已记账】');
console.log(`  agent 会话（成功）  ${agentSessions} 次，${fmtTokens(agentTokens)} tokens，${fmtCost(agentCost)}`);
console.log(`  规划期 LLM 草稿      ${llmCalls} 次，${fmtTokens(llmTokens)} tokens，${fmtCost(llmCost)}`);
console.log(`  bundle 固定开销      ${fmtTokens(bundleTotal)} tokens（${bundleMeasuredSlices} 片可测，zelto 独有）`);

console.log('');
console.log('【账外支出（估算）】');
console.log(`  agent 启动 ${runsStarted} 次，成功记账 ${agentSessions} 次 → 未记账会话 ${failedSessions} 次`);
if (agentSessions === 0) {
  console.log('  没有成功会话的 token 样本，无法估算账外支出 —— 这一项显示为 0 不代表真的没花');
} else {
  console.log(`  估算每次失败会话 ≈ ${fmtTokens(avgTokensPerSession)} tokens（按成功会话均值）`);
  console.log(`  合计 ≈ ${fmtTokens(failedTokensEst)} tokens，${fmtCost(failedCostEst)}`);
}

if (costOnlySessions > 0) {
  console.log('');
  console.log('【花了钱但没测到 token】');
  console.log(`  旧格式切片：${costOnlySessions} 次会话，${fmtCost(costOnlyUsd)}`);
  console.log('  这些会话的事件里没有 token 字段，token 账里查不到（不是零）');
}

console.log('');
console.log('【对比：zelto vs 直接用】');
console.log(`  直接用（基线）  ${fmtTokens(directTokens)} tokens，${fmtCost(directCost)}`);
console.log(`  用 zelto        ${fmtTokens(zeltoTotalTokens)} tokens，${fmtCost(zeltoTotalCost)}`);
console.log(
  `  差额            ${deltaTokens >= 0 ? '+' : ''}${fmtTokens(deltaTokens)} tokens` +
    (deltaPct !== null ? `（${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%）` : '') +
    `，${deltaCost >= 0 ? '+' : ''}${fmtCost(deltaCost)}`,
);
console.log('  其中：重试放大是主要项，规划期 LLM 次之，bundle 是省下来的一部分');

console.log('');
console.log('【基线假设】');
console.log('  · 直接用 = 每片 1 次成功会话、规格同样要读、不读 bundle、无规划期 LLM、人不手动重试');
console.log('  · 你手动重试 N 次，基线乘 (1+N)，差额会相应缩小');
console.log('  · 失败会话的 token 不在账上（失败路径不记账），上面的估算可能偏低或偏高');
console.log('');

if (slices.length > 0) {
  console.log(`【按切片明细（前 ${topN} 片，按 agent token 排序）】`);
  const rows = [...slices]
    .sort((a, b) => b.agentTokens - a.agentTokens || b.agentCost - a.agentCost)
    .slice(0, topN);
  console.log(
    `  ${'切片'.padEnd(28)}${'会话'.padStart(6)}${'未记账'.padStart(8)}${'agent tok'.padStart(12)}${'花费'.padStart(10)}${'LLM tok'.padStart(10)}`,
  );
  for (const s of rows) {
    const failed = Math.max(0, s.runsStarted - s.agentSessions);
    console.log(
      `  ${s.id.slice(0, 27).padEnd(28)}${String(s.agentSessions).padStart(6)}${String(failed).padStart(8)}` +
        `${fmtTokens(s.agentTokens).padStart(12)}${fmtCost(s.agentCost).padStart(10)}${fmtTokens(s.llmTokens).padStart(10)}`,
    );
  }
  console.log('');
}

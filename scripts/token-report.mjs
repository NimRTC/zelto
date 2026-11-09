#!/usr/bin/env node
// zelto 开销对比 —— 「用 zelto 做」比「直接用 agent 做」多花多少 token。
//
// 用途：只读的分析工具。它读事件流，不写任何文件、不调模型、不触网，
// 所以放在 `scripts/` 里随仓库走，但不属于产品运行时的一部分。
//
// ── 读的账 ────────────────────────────────────────────────────────────────
// `<root>/.zelto/events/<sliceId>/events.jsonl`：
//   - run.started   —— 起了几次会话
//   - run.finished  —— 会话成功结束（CLI 只在成功路径上写它）
//   - run.aborted   —— 会话失败。注意它会重复写（core-slice 写一次，
//                      handleAgentFailure 再写一次），所以失败次数不从它数，
//                      而是从「起了几次」减「成功几次」推出来。
//   - budget.spent (source=agent) —— agent 会话的真实花费与 token
//   - llm.called                    —— 规划期 LLM 草稿的 token
//   - budget.spent (reason=llm:*)  —— 规划期 LLM 草稿的钱
// `<root>/.zelto/<sliceId>-bundle.json` —— zelto 注入给 agent 的上下文
//
// ── 基线口径（决定结论正负的关键）────────────────────────────────────────
//
//   **直接用 agent = 每片 1 次成功会话、规格同样要读、不用规划期 LLM、人不手动重试。**
//
//   「规格同样要读」这条最容易被算错：zelto 让 agent 读 bundle（bundle 里装着
//   规格正文），直接用时人也会把规格交给 agent —— 两边都要吃这份上下文，
//   在差额上互相抵消。所以 bundle 的 token 不从基线里扣，只单列出来，
//   让人看得见 zelto 每次注入多少上下文。
//
//   真正的差额只有两处来源：**重试放大**（失败会话不在账上，只能估）与
//   **规划期 LLM 草稿**。
//
// ── 三个必须先说清的事实（不然结论会骗人）────────────────────────────────
//
//   1. **失败重试烧的 token 不在账上。** `settleRunCost` 只在 exitCode===0 的成功
//      路径上调用，失败会话从来不记账。所以事件里的 agent 用量 = 成功会话的用量，
//      失败那几次是「账外支出」。脚本用「已记账会话的平均 token」去估这部分，
//      并在输出里明确标成估算。
//
//   2. **老格式切片里 agent 会话可能完全没记账。** ADR-035 落地之前跑的切片，
//      事件里只有 run.finished，token 与花费都拿不到。这类会话按
//      「成功了但没测到」单独统计（`unmeasuredSessions`），不混进 token 账 ——
//      没测到不等于零，也不等于失败。
//
//   3. **token 估算只用于 bundle 指令**（agent 自己的用量是 SDK 上报的实测值）。
//      bundle 的 token 用字符启发式估：中文约 1.5 字/token，其余约 4 字/token。
//
// ── 拿不到数时怎么办 ─────────────────────────────────────────────────────
//
//   宁可报「算不出来」，也不报一个看起来像结论的数字。
//   全项目没有任何 agent 用量样本时，基线与差额一律输出「无法计算」，
//   而不是「0」—— 0 会被读成「没花钱」，那是骗人。
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
      '',
      '基线：直接用 agent = 每片 1 次成功会话、规格同样要读、无规划期 LLM、无手动重试。',
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
  if (n === null || n === undefined) return '无法计算';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtCost(n) {
  if (n === null || n === undefined) return '无法计算';
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
      sessionsStarted: 0,
      sessionsSucceeded: 0,
      sessionsAborted: 0,
      // 记账了的成功会话：token 与花费都在
      measuredSessions: 0,
      measuredTokens: 0,
      measuredInput: 0,
      measuredOutput: 0,
      measuredCost: 0,
      // 成功但没记账的会话（老格式切片）：token 拿不到，
      // 花费有时能从 run.finished.costUsd 拿到
      unmeasuredSessions: 0,
      unmeasuredCost: 0,
      llmTokens: 0,
      llmInput: 0,
      llmOutput: 0,
      llmCost: 0,
      llmCalls: 0,
      // run.finished 里带的花费合计（ADR-035 之后才有 costUsd）
      finishedCost: 0,
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
        s.sessionsStarted++;
        break;
      case 'run.finished':
        // CLI 只在成功路径上写 run.finished（exitCode 0）
        s.sessionsSucceeded++;
        {
          const cost = num(p.costUsd);
          if (cost !== null) s.finishedCost += cost;
        }
        break;
      case 'run.aborted':
        // 失败标记。会重复写，所以只作参考，不用来数失败次数
        s.sessionsAborted++;
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
          s.measuredSessions++;
          if (amount !== null) s.measuredCost += amount;
          const it = num(p.inputTokens);
          const ot = num(p.outputTokens);
          if (it !== null) s.measuredInput += it;
          if (ot !== null) s.measuredOutput += ot;
          s.measuredTokens += (it ?? 0) + (ot ?? 0);
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

// ─── 补账：成功但没记账的会话 ────────────────────────────────────────────
//
// run.finished 说明会话成功了，但老格式切片里没有 budget.spent(source=agent)
// —— 也就是「成功了，但 token 和花费都没记下来」。
//
// 这里要把它们跟「失败会话」分开：失败会话是账外支出，成功但没记账的会话是
// 「账上缺一块」。两者混在一起，重试放大会被高估。
//
// 花费还有救：run.finished 的 costUsd 字段（ADR-035 之后才有）记着。
// 记账会话的花费已经记在 budget.spent 里了，所以要从 finishedCost 里扣掉，
// 免得同一笔钱数两遍。

for (const s of perSlice.values()) {
  s.unmeasuredSessions = Math.max(0, s.sessionsSucceeded - s.measuredSessions);
  s.unmeasuredCost = Math.max(0, s.finishedCost - s.measuredCost);
}

// ─── bundle 注入量（信息项，不进差额）────────────────────────────────────
//
// zelto 让 agent 先读一个 bundle 文件才拿到任务说明。bundle 里装着规格正文，
// 「直接用 agent」时人也要把规格交给 agent —— 两边都要吃这份上下文，
// 所以它在差额上互相抵消，这里只单列出来让人看 zelto 每次注入多少。

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

// ─── 汇总 ────────────────────────────────────────────────────────────────

const slices = [...perSlice.values()].filter(
  (s) =>
    s.sessionsStarted > 0 ||
    s.sessionsSucceeded > 0 ||
    s.measuredSessions > 0 ||
    s.unmeasuredSessions > 0 ||
    s.llmCalls > 0,
);

let measuredTokens = 0;
let measuredCost = 0;
let measuredSessions = 0;
let unmeasuredSessions = 0;
let unmeasuredCost = 0;
let llmTokens = 0;
let llmCost = 0;
let llmCalls = 0;
let sessionsStarted = 0;
let sessionsSucceeded = 0;
let bundleTotal = 0;
let bundleMeasuredSlices = 0;

for (const s of slices) {
  measuredTokens += s.measuredTokens;
  measuredCost += s.measuredCost;
  measuredSessions += s.measuredSessions;
  unmeasuredSessions += s.unmeasuredSessions;
  unmeasuredCost += s.unmeasuredCost;
  llmTokens += s.llmTokens;
  llmCost += s.llmCost;
  llmCalls += s.llmCalls;
  sessionsStarted += s.sessionsStarted;
  sessionsSucceeded += s.sessionsSucceeded;

  const bt = bundleTokens.get(s.id);
  if (bt !== undefined) {
    // 每次会话都要读一遍 bundle（重试也重读）。
    // 会话数取三个来源的最大值：起过的、成功过的、记账过的 ——
    // 老格式切片可能只有 run.finished，只有 budget.spent 的又是另一种情况。
    const sessions = Math.max(s.sessionsStarted, s.sessionsSucceeded, s.measuredSessions);
    bundleTotal += bt * sessions;
    bundleMeasuredSlices++;
  }
}

// 失败会话 = 起了几次 - 成功几次。
// 不从 run.aborted 数：core-slice 与 handleAgentFailure 会各写一条，
// 同一次失败会被数成两次。
const failedSessions = slices.reduce(
  (sum, s) => sum + Math.max(0, s.sessionsStarted - s.sessionsSucceeded),
  0,
);

// 全局均值（拿不到单片样本时的兜底）。没有记账样本时是 null —— 不是 0。
const globalAvgTokens = measuredSessions > 0 ? measuredTokens / measuredSessions : null;
const globalAvgCost = measuredSessions > 0 ? measuredCost / measuredSessions : null;

// ─── 基线：直接用 agent ──────────────────────────────────────────────────
//
// 每片 1 次成功会话。这次会话同样要读规格（zelto 读 bundle，人把规格贴进去），
// 所以上下文成本两边相同，不做扣减。

let directTokens = 0;
let directCost = 0;
let directTokensEstimated = false;
let directCostEstimated = false;

for (const s of slices) {
  if (s.measuredSessions > 0) {
    // 这片有自己的样本：用它自己的均值
    directTokens += s.measuredTokens / s.measuredSessions;
    directCost += s.measuredCost / s.measuredSessions;
    continue;
  }
  // 这片没有记账样本（老格式切片，或一次都没成功）
  if (s.unmeasuredSessions > 0) {
    // 成功过但没记账：基线仍按「1 次成功会话」算，花费用这一片已知的均值
    if (s.unmeasuredCost > 0) directCost += s.unmeasuredCost / s.unmeasuredSessions;
    else if (globalAvgCost !== null) {
      directCost += globalAvgCost;
      directCostEstimated = true;
    }
  } else if (globalAvgCost !== null) {
    // 一次都没成功过：基线假设「人直接做时一次就对」
    directCost += globalAvgCost;
    directCostEstimated = true;
  }
  // token：这一片没有记账样本，只能用全局均值
  if (globalAvgTokens !== null) {
    directTokens += globalAvgTokens;
    directTokensEstimated = true;
  }
}

// 没有任何记账样本 → 基线算不出来，报「无法计算」而不是 0
if (measuredSessions === 0) {
  directTokens = null;
  directCost = null;
}

// ─── 用 zelto 的实际开销 ─────────────────────────────────────────────────
//
// 记账的成功会话 + 成功但没记账的会话（token 未知，只记花费）+ 规划期 LLM
// + 估算的失败会话。

// --no-estimate 时直接给 0（明说没估），没有样本时给 null（算不出来）
const failedTokensEst = !estimate
  ? 0
  : globalAvgTokens !== null
    ? Math.round(failedSessions * globalAvgTokens)
    : null;
const costPerToken =
  globalAvgTokens !== null && globalAvgTokens > 0 && globalAvgCost !== null
    ? globalAvgCost / globalAvgTokens
    : 0;
const failedCostEst =
  failedTokensEst !== null ? failedTokensEst * costPerToken : null;

// token 总账：记账的 + 估算的失败会话 + 规划期 LLM。
// 若有「成功但没记账」的会话，真实总量比这个数大 —— 标成下界。
// failedTokensEst 为 null（没有样本可估）时，总账也给不出 —— 只报已知部分。
const zeltoKnownTokens = measuredTokens + llmTokens;
const zeltoKnownCost = measuredCost + unmeasuredCost + llmCost;
const zeltoTotalTokens = failedTokensEst === null ? null : zeltoKnownTokens + failedTokensEst;
const zeltoTotalCost = failedCostEst === null ? null : zeltoKnownCost + failedCostEst;

const deltaTokens =
  directTokens === null || zeltoTotalTokens === null ? null : zeltoTotalTokens - directTokens;
const deltaCost =
  directCost === null || zeltoTotalCost === null ? null : zeltoTotalCost - directCost;
const deltaPct =
  directTokens !== null && directTokens > 0 && deltaTokens !== null
    ? (deltaTokens / directTokens) * 100
    : null;

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
          measuredSessions,
          measuredTokens,
          measuredCostUsd: measuredCost,
          unmeasuredSessions,
          unmeasuredCostUsd: unmeasuredCost,
          sessionsStarted,
          sessionsSucceeded,
          failedSessions,
          failedTokensEst,
          failedCostEst,
        },
        planningLlm: { calls: llmCalls, tokens: llmTokens, costUsd: llmCost },
        bundleInjection: { tokens: bundleTotal, slices: bundleMeasuredSlices },
        comparison: {
          zeltoTotalTokens,
          zeltoTotalCost,
          zeltoKnownTokens,
          zeltoKnownCost,
          directTokens,
          directCost,
          directTokensEstimated,
          directCostEstimated,
          deltaTokens,
          deltaCost,
          deltaPct,
          assumptions: [
            '基线 = 直接用 agent：每片 1 次成功会话、规格同样要读、无规划期 LLM、人不手动重试',
            '规格上下文两边都要吃（zelto 读 bundle，人贴规格），bundle token 不从基线扣减',
            '失败会话不记账，其 token 按已记账会话均值估算',
            'bundle token 为字符启发式估算（中文 1.5 字/token，其余 4 字/token）',
            'unmeasuredSessions = 成功但没记账的会话（老格式切片）：token 未知，不计入 token 账',
            '无记账样本时基线与差额报「无法计算」，不报 0',
          ],
        },
        perSlice: slices.map((s) => ({
          id: s.id,
          sessionsStarted: s.sessionsStarted,
          sessionsSucceeded: s.sessionsSucceeded,
          measuredSessions: s.measuredSessions,
          measuredTokens: s.measuredTokens,
          measuredCost: s.measuredCost,
          unmeasuredSessions: s.unmeasuredSessions,
          unmeasuredCost: s.unmeasuredCost,
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
console.log(
  `  agent 会话（成功）  ${measuredSessions} 次，${fmtTokens(measuredTokens)} tokens，${fmtCost(measuredCost)}`,
);
console.log(`  规划期 LLM 草稿      ${llmCalls} 次，${fmtTokens(llmTokens)} tokens，${fmtCost(llmCost)}`);
console.log(
  `  bundle 注入量        ${fmtTokens(bundleTotal)} tokens（${bundleMeasuredSlices} 片可测）｜` +
    '两边都要读规格，差额上抵消',
);

console.log('');
console.log('【账外支出（估算）】');
console.log(
  `  agent 启动 ${sessionsStarted} 次，成功 ${sessionsSucceeded} 次 → 失败会话 ${failedSessions} 次`,
);
if (globalAvgTokens === null) {
  console.log('  没有记账成功的会话做样本，无法估算账外支出 —— 这一项显示为「无法计算」');
} else {
  console.log(`  估算每次失败会话 ≈ ${fmtTokens(globalAvgTokens)} tokens（按记账会话均值）`);
  console.log(`  合计 ≈ ${fmtTokens(failedTokensEst)} tokens，${fmtCost(failedCostEst)}`);
}

if (unmeasuredSessions > 0) {
  console.log('');
  console.log('【成功了但没记账】');
  console.log(`  ${unmeasuredSessions} 次会话，${fmtCost(unmeasuredCost)}（花费来自 run.finished.costUsd）`);
  console.log('  这些会话的事件里没有 token 字段 —— token 账里查不到（不是零，也不是失败）');
  console.log('  所以下面的 token 总账与差额是「下界」，真实值更高');
}

console.log('');
console.log('【对比：zelto vs 直接用】');
console.log(`  直接用（基线）  ${fmtTokens(directTokens)} tokens，${fmtCost(directCost)}`);
console.log(
  `  用 zelto        ${zeltoTotalTokens === null ? `${fmtTokens(zeltoKnownTokens)}（已知部分）` : fmtTokens(zeltoTotalTokens)} tokens，` +
    `${zeltoTotalCost === null ? `${fmtCost(zeltoKnownCost)}（已知部分）` : fmtCost(zeltoTotalCost)}`,
);
console.log(
  `  差额            ${deltaTokens === null ? '无法计算' : `${deltaTokens >= 0 ? '+' : ''}${fmtTokens(deltaTokens)} tokens`}` +
    (deltaPct !== null ? `（${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%）` : '') +
    `，${deltaCost === null ? '无法计算' : `${deltaCost >= 0 ? '+' : ''}${fmtCost(deltaCost)}`}`,
);
if (directTokensEstimated || directCostEstimated) {
  console.log('  （基线里有几片没有自己的记账样本，用了全局均值 —— 标为估算）');
}
if (measuredSessions === 0) {
  console.log('  （本项目没有任何 agent 用量记账，基线与差额算不出来 —— 不报 0）');
}
console.log('  差额来源：重试放大 + 规划期 LLM；规格上下文两边相同，已抵消');

console.log('');
console.log('【基线假设】');
console.log('  · 直接用 = 每片 1 次成功会话、规格同样要读、无规划期 LLM、人不手动重试');
console.log('  · bundle 里装着规格正文，直接用时人也要把规格交给 agent —— 两边都要吃这份上下文');
console.log('  · 你手动重试 N 次，基线乘 (1+N)，差额会相应缩小');
console.log('  · 失败会话的 token 不在账上（失败路径不记账），上面的估算可能偏低或偏高');
console.log('');

if (slices.length > 0) {
  console.log(`【按切片明细（前 ${topN} 片，按 agent token 排序）】`);
  const rows = [...slices]
    .sort((a, b) => b.measuredTokens - a.measuredTokens || b.measuredCost - a.measuredCost)
    .slice(0, topN);
  console.log(
    `  ${'切片'.padEnd(26)}${'成功'.padStart(6)}${'失败'.padStart(6)}${'agent tok'.padStart(12)}${'花费'.padStart(10)}${'LLM tok'.padStart(10)}`,
  );
  for (const s of rows) {
    const failed = Math.max(0, s.sessionsStarted - s.sessionsSucceeded);
    console.log(
      `  ${s.id.slice(0, 25).padEnd(26)}${String(s.sessionsSucceeded).padStart(6)}${String(failed).padStart(6)}` +
        `${fmtTokens(s.measuredTokens).padStart(12)}${fmtCost(s.measuredCost).padStart(10)}${fmtTokens(s.llmTokens).padStart(10)}`,
    );
  }
  console.log('');
}

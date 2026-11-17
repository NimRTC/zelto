// 记账回填 —— 把「花了钱但账本里没有」的历史记录补回来
//
// 为什么需要这个（ADR-035 §3.5 的同一原则）：
// `budget.spent` 事件是成本的**唯一**权威来源（`core/budget/collector.ts`）。
// 解析器出 bug 时（见演练记录 §11.18），agent 明明报出了 `total_cost_usd`，
// 但事件从没写进 `.zelto/events/` —— 于是账本上「查不到这一片」。
//
// 三条硬规矩：
//
// 1. **只追加，不改不删**（C4）。回填是往事件流尾巴上追加，
//    已有事件一个字节都不动。
// 2. **金额必须来自真实会话文件**，不能算、不能估、不能填默认值。
//    拿不到就是拿不到 —— 那就写「核查过但拿不到金额」的标记，
//    而不是写 0（写 0 等于宣称「测过了，确实没花钱」—— 那是假账）。
// 3. **时间戳用原始会话时间**，不是补记时刻。
//    事件时间就是事实发生的时间。补记时刻会让人以为这笔钱是刚花的。
//
// 用法：
//   node scripts/backfill-cost.mjs            # 干跑，只报告不写
//   node scripts/backfill-cost.mjs --apply    # 真写

import { readdirSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();
const ZELTO = join(ROOT, '.zelto');
const EVENTS = join(ZELTO, 'events');
const SESSIONS = join(ZELTO, 'sessions');

// 成本证据的类型 —— 与 core/budget/collector.ts 的判据保持一致。
const COST_TYPES = new Set(['budget.spent', 'llm.called']);

// ─── 从会话文件里读成本 ─────────────────────────────────────────────────────

/**
 * 从一段 stdout 里提取用量。
 *
 * 用的是 `adapters/usage-parse.ts` 的同一套逻辑 —— 不另写一份解析，
 * 否则「回填时算出来的」和「运行时记下来的」会差一点点，账就对不上了。
 */
async function parseUsage(stdout) {
  // Windows 上绝对路径不能直接 import —— ESM 只认 file:// URL。
  const modUrl = new URL(`file://${join(ROOT, 'dist/adapters/usage-parse.js').replace(/\\/g, '/')}`);
  const { extractClaudeJson, parseClaudeUsage } = await import(modUrl.href);
  const json = extractClaudeJson(stdout);
  if (!json) return null;
  return parseClaudeUsage(json);
}

/** 收集所有会话文件，按切片分组。 */
function loadSessions() {
  const bySlice = new Map();
  if (!existsSync(SESSIONS)) return bySlice;

  for (const f of readdirSync(SESSIONS)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(SESSIONS, f), 'utf8').replace(/^\uFEFF/, ''));
      if (!j.sliceId) continue;
      const arr = bySlice.get(j.sliceId) ?? [];
      arr.push({ file: f, data: j });
      bySlice.set(j.sliceId, arr);
    } catch {
      // 会话文件坏了 —— 跳过，不让一个坏文件挡住整个回填
    }
  }
  return bySlice;
}

/** 读事件流里已经有的成本证据。 */
function loadMeasured() {
  const measured = new Set();
  if (!existsSync(EVENTS)) return measured;

  for (const d of readdirSync(EVENTS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = join(EVENTS, d.name, 'events.jsonl');
    if (!existsSync(f)) continue;
    try {
      for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
        const e = JSON.parse(line.replace(/^\uFEFF/, ''));
        if (COST_TYPES.has(e.type)) {
          measured.add(d.name);
          break;
        }
      }
    } catch {
      // 文件坏了 —— 当作没测到
    }
  }
  return measured;
}

// ─── 事件流写入 ─────────────────────────────────────────────────────────────

/**
 * 追加一条事件。
 *
 * 不走 `EventStream.append()` —— 它把 `ts` 硬编码成 `new Date()`，
 * 而回填要用**原始会话时间**。`runSeq` 仍按全局最大值往后接，
 * 保证单调（C4 的追溯链靠它定位）。
 */
let seq = 0;
function currentMaxSeq() {
  let max = 0;
  if (!existsSync(EVENTS)) return 0;
  for (const d of readdirSync(EVENTS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = join(EVENTS, d.name, 'events.jsonl');
    if (!existsSync(f)) continue;
    try {
      const content = readFileSync(f, 'utf8');
      const lines = content.trimEnd().split('\n').filter(Boolean);
      for (const line of lines) {
        const e = JSON.parse(line.replace(/^\uFEFF/, ''));
        if (typeof e.runSeq === 'number' && e.runSeq > max) max = e.runSeq;
      }
    } catch {
      // 读不了就当它没有
    }
  }
  return max;
}

function appendEvent(sliceId, event) {
  const dir = join(EVENTS, sliceId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf-8');
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────

const sessions = loadSessions();
const measured = loadMeasured();
seq = currentMaxSeq();

const sliceIds = existsSync(join(ZELTO, 'slices'))
  ? readdirSync(join(ZELTO, 'slices'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
  : [];

const withRealCost = [];
const unavailable = [];

for (const id of sliceIds) {
  if (measured.has(id)) continue; // 已有成本证据 —— 不碰

  const ss = sessions.get(id) ?? [];

  // 找有没有带真实成本的会话
  let real = null;
  for (const { file, data } of ss) {
    const stdout = (data.output ?? []).join('');
    if (!stdout) continue;
    const usage = await parseUsage(stdout);
    if (usage && usage.costUsd > 0) {
      real = { file, data, usage };
      break;
    }
  }

  if (real) {
    withRealCost.push({ id, ...real });
  } else {
    unavailable.push({ id, sessions: ss.length });
  }
}

console.log('═══ 记账回填 ═══');
console.log(`模式：${APPLY ? '真写（--apply）' : '干跑（不写）'}`);
console.log('');
console.log(`切片总数            ${sliceIds.length}`);
console.log(`已有成本证据        ${measured.size}`);
console.log(`需回填（真实金额）  ${withRealCost.length}`);
console.log(`需回填（拿不到金额）${unavailable.length}`);
console.log('');

let totalAmount = 0;
for (const r of withRealCost) {
  totalAmount += r.usage.costUsd;
  console.log(`  [金额] ${r.id}`);
  console.log(`         $${r.usage.costUsd.toFixed(6)}  tokens ${r.usage.inputTokens}/${r.usage.outputTokens}`);
  console.log(`         会话 ${r.file}  startedAt=${r.data.startedAt}`);
}
console.log('');
console.log(`  真实金额合计: $${totalAmount.toFixed(6)}`);
console.log('');
console.log(`  [无金额] ${unavailable.length} 片 —— 核查过但 agent 没报出用量`);

if (!APPLY) {
  console.log('');
  console.log('干跑结束 —— 加 --apply 真写。');
  process.exit(0);
}

// ─── 真写 ───────────────────────────────────────────────────────────────────

const written = [];

for (const r of withRealCost) {
  seq++;
  const event = {
    // 原始会话时间 —— 事件时间就是事实发生的时间（规矩 3）
    ts: r.data.startedAt,
    runSeq: seq,
    slice: r.id,
    run: null,
    type: 'budget.spent',
    actor: 'zelto',
    payload: {
      amount: r.usage.costUsd,
      source: 'agent',
      adapter: 'claude-agent',
      sessionId: r.data.sessionId,
      model: r.usage.model,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      // 标记这是回填来的 —— 以后查账时分得清「实时记的」和「补的」
      backfilled: true,
      backfilledAt: new Date().toISOString(),
      sourceSessionFile: r.file,
    },
  };
  appendEvent(r.id, event);
  written.push({ id: r.id, amount: r.usage.costUsd });
}

for (const u of unavailable) {
  seq++;
  // 时间戳用切片状态文件的 updatedAt —— 那是最接近「这片最后一次动作」的事实时间。
  // 取不到就用现在（但要在 payload 里标出来）。
  let ts = new Date().toISOString();
  let tsSource = 'now';
  try {
    const state = JSON.parse(readFileSync(join(ZELTO, 'slices', u.id + '.json'), 'utf8'));
    if (typeof state.updatedAt === 'string') {
      ts = state.updatedAt;
      tsSource = 'slice.updatedAt';
    }
  } catch {
    // 读不到就用现在
  }

  const event = {
    ts,
    runSeq: seq,
    slice: u.id,
    run: null,
    type: 'budget.spent',
    actor: 'zelto',
    payload: {
      // 金额是 0，但**不是**「测到了 0」—— measured: false 明确说「拿不到」。
      // 界面据此显示「未测到」而不是「$0.0000」。
      amount: 0,
      measured: false,
      source: 'agent',
      backfilled: true,
      backfilledAt: new Date().toISOString(),
      tsSource,
      reason: 'agent 未报出用量（输出为空或解析失败）',
      sessionCount: u.sessions,
    },
  };
  appendEvent(u.id, event);
  written.push({ id: u.id, amount: 0, unavailable: true });
}

console.log('');
console.log('═══ 写入完成 ═══');
console.log(`追加事件 ${written.length} 条`);
console.log(`真实金额 ${withRealCost.length} 条，合计 $${totalAmount.toFixed(6)}`);
console.log(`无金额标记 ${unavailable.length} 条`);
